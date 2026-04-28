/* global freezr */
import { parseFreezrResponse } from './parseFreezrResponse.js'

const ORBIT_SYSTEM = `You are Orbit, an assistant that builds and edits static websites on the freezr platform.

## What is freezr
freezr is a personal-data server. Apps are front-end bundles of HTML, CSS, and JS. There is no server-side code — all backend functionality (database, files, permissions, LLM) is accessed via the freezr API through the global \`freezr\` object, which is automatically available.

Each Orbit project contains **pages**. Each page declares an HTML file and optional CSS and JS resources. Files live under the project's draft folder.

## HARD RULES (violations break the page)
1. NEVER use inline \`<script>\` tags. All JavaScript MUST go in separate .js files declared as page resources. Freezr's CSP blocks inline scripts entirely.
2. NEVER use \`<<<\` or \`>>>\` in your text, code, or explanations — these are reserved delimiters. Only use them in FREEZR_START / FREEZR_END markers.
3. HTML files must contain only inner-body content. Do NOT include \`<!DOCTYPE>\`, \`<html>\`, \`<head>\`, or \`<body>\` tags — freezr wraps the page in its own skeleton that injects CSS, JS, and meta tags automatically.
4. Paths are relative to the project draft root (e.g. \`index.html\`, \`shared/common.css\`, \`app.js\`).
5. The \`shared/\` folder is for resources used across multiple pages. Page-specific files can go in the root or sub-folders.

## Output format

Return your response as clearly delimited sections. You may output multiple sections.

### Explanation (required)
<<<FREEZR_START type="explanation">>>
Concise developer-focused note: what you changed and why. Avoid restating the user's request.
Use \\\`code\\\` for inline references. Use \\\`\\\`\\\`lang ... \\\`\\\`\\\` for code snippets.
<<<FREEZR_END>>>

### File edits (one section per file)
<<<FREEZR_START type="file" path="relative/path.ext" action="upsert">>>
full file contents
<<<FREEZR_END>>>

You can create, replace, or add files. Use action="upsert" for all file operations. Always output the COMPLETE file contents — never use placeholders like "... rest unchanged ...".

**Creating new CSS or JS files**: Simply output a file section with the new path. The system will automatically register it as a resource for the active page. If the file belongs in the shared folder, use a \`shared/\` prefix (e.g. \`shared/theme.css\`).

### Meta data updates
If the user's request implies the page title, description, or social sharing image should change, output:
<<<FREEZR_START type="meta">>>
{"title": "New Title", "description": "New description", "image": "https://..."}
<<<FREEZR_END>>>
Only include fields that should change. Omit unchanged fields.

### Image generation
When the user asks for a logo, icon, illustration, hero image, or any visual asset, output:
<<<FREEZR_START type="image" path="images/hero.png">>>
A detailed description of the image to generate. Be specific about style, colors, composition, and content.
<<<FREEZR_END>>>
The system will call an image generation API and save the resulting PNG at the given path. Always place images under an \`images/\` folder. Reference generated images in HTML using a relative path (e.g. \`<img src="images/hero.png">\`) — the preview resolves paths relative to the draft root automatically.

### Requesting other files
You are given the active page and its resources. If the user's message refers to a different file you need to see before editing, output ONLY:
<<<FREEZR_START type="request_file">>>
path/to/needed/file.html
<<<FREEZR_END>>>
The system will re-send with that file attached. Do NOT guess file contents you haven't seen.

## Rules
- Keep HTML, CSS, and JS valid and well-structured.
- Do not invent binary assets; only produce text files. If the user asks for something like a jpg, tell them they need to generate it elsewhere and upload it under the files tab
- When returning a file, always return the FULL content, not a diff or partial update.
- If the user asks about a file you don't have, request it rather than guessing.
- When the user says "change the title" or similar, update both the HTML (e.g. heading text) AND the meta data section.
- Use semantic HTML. Prefer class-based CSS over inline styles.
- For interactivity, put JS in a separate file and reference DOM elements by ID or class.
- Remember: the HTML you produce is injected inside \`<body>\` — you don't control \`<head>\`. CSS and JS are linked automatically from the page's resource declarations.
- You can reference the freezr API (\`freezr.query\`, \`freezr.create\`, etc.) in JS files if the page needs to read/write data. The \`freezr\` and \`freezrMeta\` globals are always available.`

const MAX_FILE_REQUEST_ROUNDS = 3

function mimeForPath(rel) {
  if (/\.html?$/i.test(rel)) return 'text/html'
  if (/\.css$/i.test(rel)) return 'text/css'
  if (/\.js$/i.test(rel)) return 'text/javascript'
  if (/\.json$/i.test(rel)) return 'application/json'
  if (/\.svg$/i.test(rel)) return 'image/svg+xml'
  return 'text/plain'
}

function buildFileContext(files) {
  if (!files || !files.length) return ''
  return files
    .map((f) => `--- FILE: ${f.path} ---\n${f.content}\n--- END FILE ---`)
    .join('\n\n')
}

export async function hasLlmPermission() {
  try {
    const perms = await freezr.perms.getAppPermissions()
    const list = Array.isArray(perms) ? perms : []
    const p = list.find((x) => x.name === 'use_llm')
    return !!(p && p.granted)
  } catch (_) {
    return false
  }
}

/**
 * @param {object} opts
 * @param {string} opts.userMessage
 * @param {Array<{role: string, content: string}>} [opts.chatHistory] - previous messages in thread for context
 * @param {object} opts.project - projects row
 * @param {object} opts.page - active page object { name, html_file, css_files, js_files, meta }
 * @param {Array<{path: string, content: string}>} opts.fileContents - pre-fetched file contents
 * @param {string[]} opts.projectFileList - all file paths in the project (relative to draft root)
 * @param {(fullPath: string, text: string, mime?: string) => Promise<void>} opts.uploadText
 * @param {(fullPath: string, file: File) => Promise<void>} opts.uploadFile - upload a binary File object
 * @param {(relPath: string) => Promise<string>} opts.fetchDraftFile - fetch a draft file by relative path
 * @param {(s: string) => void} [opts.onDelta]
 * @param {(s: string) => void} [opts.onThinking]
 * @param {(status: {path: string, status: string}) => void} [opts.onImageStatus] - image gen progress
 */
export async function sendOrbitChatMessage(opts) {
  const {
    userMessage,
    chatHistory,
    project,
    page,
    fileContents,
    projectFileList,
    uploadText,
    uploadFile,
    fetchDraftFile,
    onDelta,
    onThinking,
    onImageStatus
  } = opts

  const meta = page?.meta || {}
  const metaStr = JSON.stringify(meta)

  const pagesOverview = (project.pages || [])
    .map((p) => {
      const res = [p.html_file, ...(p.css_files || []), ...(p.js_files || [])]
      return `  ${p.name} (${p.published ? 'published' : 'draft'}): ${res.join(', ')}`
    })
    .join('\n')

  const fileMapStr = (projectFileList || []).join('\n')

  let contextFiles = [...(fileContents || [])]
  const alreadyLoaded = new Set(contextFiles.map((f) => f.path))

  const buildContext = () => {
    return (
      ORBIT_SYSTEM +
      `\n\n## Current project context` +
      `\nProject: ${project.name} (${project.display_name || project.name})` +
      `\nActive page: "${page?.name || 'index'}" (html: ${page?.html_file || 'index.html'})` +
      `\nPage resources: css=[${(page?.css_files || []).join(', ')}] js=[${(page?.js_files || []).join(', ')}]` +
      `\nPage meta: ${metaStr}` +
      `\n\nAll pages in project:\n${pagesOverview}` +
      `\n\nAll files in project draft folder:\n${fileMapStr}` +
      `\n\n## File contents provided\n\n${buildFileContext(contextFiles)}`
    )
  }

  const useStream = typeof onDelta === 'function' || typeof onThinking === 'function'

  let finalResult = null

  const hasHistory = Array.isArray(chatHistory) && chatHistory.length > 0

  for (let round = 0; round <= MAX_FILE_REQUEST_ROUNDS; round++) {
    const context = buildContext()

    let prompt
    if (round > 0) {
      prompt = `[System: the requested file(s) have been added to the context above. Please proceed with the user's original request.]`
    } else if (hasHistory) {
      prompt = [
        ...chatHistory.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: userMessage }
      ]
    } else {
      prompt = userMessage
    }

    const result = await freezr.llm.ask(prompt, {
      context,
      streamBack: useStream,
      onDelta: typeof onDelta === 'function' ? (chunk) => onDelta(chunk) : undefined,
      onThinking: typeof onThinking === 'function' ? (chunk) => onThinking(chunk) : undefined
    })

    if (!result?.success) {
      throw new Error(result?.error || result?.message || 'LLM request failed')
    }

    const raw = typeof result.response === 'string' ? result.response : ''
    const parsed = parseFreezrResponse(raw)

    if (parsed.requestFiles.length > 0 && round < MAX_FILE_REQUEST_ROUNDS) {
      let loaded = 0
      for (const reqPath of parsed.requestFiles) {
        const clean = reqPath.replace(/^\/+/, '')
        if (alreadyLoaded.has(clean)) continue
        try {
          const content = await fetchDraftFile(clean)
          contextFiles.push({ path: clean, content })
          alreadyLoaded.add(clean)
          loaded++
        } catch (e) {
          parsed.parseErrors.push(`Could not load requested file "${clean}": ${e.message}`)
        }
      }
      if (loaded > 0) continue
    }

    finalResult = { raw, parsed }
    break
  }

  if (!finalResult) {
    throw new Error('Too many file-request rounds')
  }

  const { parsed } = finalResult
  const changed = []
  const newResources = []

  const existingPaths = new Set([
    page?.html_file,
    ...(page?.css_files || []),
    ...(page?.js_files || [])
  ].filter(Boolean))

  for (const f of parsed.files) {
    const rel = (f.path || '').replace(/^\/+/, '')
    if (!rel || rel.includes('..')) {
      parsed.parseErrors.push('Skipped unsafe path: ' + f.path)
      continue
    }
    const full = `projects/${project.name}/draft/${rel}`
    await uploadText(full, f.content, mimeForPath(rel))
    changed.push(rel)

    if (!existingPaths.has(rel)) {
      if (/\.html?$/i.test(rel)) newResources.push({ path: rel, type: 'html' })
      else if (/\.css$/i.test(rel)) newResources.push({ path: rel, type: 'css' })
      else if (/\.js$/i.test(rel)) newResources.push({ path: rel, type: 'js' })
    }
  }

  if (parsed.images && parsed.images.length > 0 && uploadFile) {
    for (const img of parsed.images) {
      const rel = (img.path || '').replace(/^\/+/, '')
      if (!rel || rel.includes('..')) {
        parsed.parseErrors.push('Skipped unsafe image path: ' + img.path)
        continue
      }
      if (onImageStatus) onImageStatus({ path: rel, status: 'generating' })
      try {
        const genResult = await freezr.llm.generateImage(img.prompt, { outputFormat: 'png' })
        if (genResult?.success && genResult.b64Data) {
          const binary = atob(genResult.b64Data)
          const bytes = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
          const blob = new Blob([bytes], { type: 'image/png' })
          const fileName = rel.split('/').pop() || 'image.png'
          const file = new File([blob], fileName, { type: 'image/png' })
          const full = `projects/${project.name}/draft/${rel}`
          await uploadFile(full, file)
          changed.push(rel)
          if (onImageStatus) onImageStatus({ path: rel, status: 'done' })
        } else {
          const errMsg = genResult?.error || 'No image data returned'
          parsed.parseErrors.push(`Image generation failed for "${rel}": ${errMsg}`)
          if (onImageStatus) onImageStatus({ path: rel, status: 'error' })
        }
      } catch (err) {
        parsed.parseErrors.push(`Image generation error for "${rel}": ${err.message}`)
        if (onImageStatus) onImageStatus({ path: rel, status: 'error' })
      }
    }
  }

  return {
    raw: finalResult.raw,
    parsed,
    filesChanged: changed,
    newResources,
    explanation: parsed.explanation || finalResult.raw,
    metaUpdate: parsed.meta || null
  }
}
