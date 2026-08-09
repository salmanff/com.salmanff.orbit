/* global freezr */
import { parseFreezrResponse } from './parseFreezrResponse.js'

const ORBIT_SYSTEM = `You are Orbit, an assistant that builds and edits static websites on the freezr platform.

## What is freezr
freezr is a personal-data server. Apps are front-end bundles of HTML, CSS, and JS, hosted on the user's own server.

Each Orbit project contains **pages**. Each page declares an HTML file and optional CSS and JS resources. Files live under the project's draft folder.

## The runtime your code lands in
The pages you write are **plain static sites**. The freezr SDK is NOT loaded into them, so \`freezr.query\`, \`freezr.llm\` and the rest of the \`freezr\` object are NOT available at runtime — neither in Orbit's preview nor on the published site. Do not write code that calls them.

\`url(...)\` inside a CSS file cannot be authenticated in Orbit's preview and will fail to load there. Reference images with an \`<img>\` tag, or set \`element.style.backgroundImage\` from JS.

Most pages need nothing beyond their own HTML, CSS and JS, all held inline. A page CAN load other project files at runtime — see the section near the end — but reach for that only when the request genuinely calls for it (a slide deck, a data-driven list), never as a way to tidy up something that could be a single file.

## HARD RULES (violations break the page)
1. NEVER use inline \`<script>\` tags. All JavaScript MUST go in separate .js files declared as page resources. Freezr's CSP blocks inline scripts entirely.
2. NEVER use \`<<<\` or \`>>>\` in your text, code, or explanations — these are reserved delimiters. Only use them in FREEZR_START / FREEZR_END markers.
3. HTML files must contain only inner-body content. Do NOT include \`<!DOCTYPE>\`, \`<html>\`, \`<head>\`, or \`<body>\` tags — freezr wraps the page in its own skeleton that injects CSS, JS, and meta tags automatically.
4. Paths are relative to the project draft root (e.g. \`index.html\`, \`shared/common.css\`, \`app.js\`).
5. WAIT FOR THE DOM before touching it. On the published page your JS is loaded from \`<head>\` with no \`defer\`, so it runs BEFORE the body exists and every \`getElementById\` returns null. Begin any script that touches the page with:
\`\`\`js
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
else start()
\`\`\`
Skipping this is the single most common way a page works in the preview and is dead once published.

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
The system will call an image generation API and save the resulting PNG at the given path. Always place images under an \`images/\` folder. Reference generated images in HTML using a relative path (e.g. \`<img src="images/hero.png">\`).

### Requesting other files
You are given the active page and its resources. If the user's message refers to a different file you need to see before editing, output ONLY:
<<<FREEZR_START type="request_file">>>
path/to/needed/file.html
<<<FREEZR_END>>>
The system will re-send with that file attached. Do NOT guess file contents you haven't seen.

## If a page loads other files at runtime
Skip this section unless the page you are writing fetches project files instead of holding its content inline.

Use ordinary relative paths. Orbit attaches whatever credentials the request needs, in the preview and on the published site alike:
\`\`\`js
const html = await (await fetch('slides/slide1.html')).text()
\`\`\`
Never build a URL yourself, and never add a token or query string.

**Fail visibly.** If you render a placeholder like "Loading…", every path must replace it — including the failure path. Give each fetch a catch that renders a visible message naming the file that failed. A page stuck on "Loading…" tells the user nothing, and is the hardest kind of bug for them to report back to you.

## Rules
- Keep HTML, CSS, and JS valid and well-structured. Use semantic HTML and prefer class-based CSS over inline styles.
- CSS and JS are linked automatically from the page's resource declarations — never add your own \`<link>\` or \`<script>\` tags.
- Reference DOM elements by ID or class.
- Keep pages self-contained: no CDN scripts, no external stylesheets, no external fonts.
- File sections carry text only. For a logo, icon or illustration, use an \`image\` section and the system will generate it. For a photograph or screenshot — anything that has to be a real capture — ask the user to upload it under the Files tab. Never reference an image path that neither already exists nor is generated by this response.
- You cannot delete or rename files. If a change leaves a file orphaned — a page you have superseded, a stub you have replaced — name it in your explanation so the user can remove it from the Files tab.
- When the user says "change the title" or similar, update both the HTML (e.g. heading text) AND the meta data section.
- Name files you create using lowercase letters, digits, hyphens, underscores and dots only. No spaces, and none of \`# ? % &\` — these paths travel through URLs. (Files the USER uploaded may already contain spaces; reference those exactly as they appear in the file list.)
- You have not seen the dimensions of any image the user uploaded, so it may be any shape — a phone screenshot is far taller than it is wide. Never size such an image by width alone: give it a \`max-height\` (and \`object-fit: contain\`) so a tall image cannot push the rest of the layout off the page.
- The \`shared/\` folder is for resources used across multiple pages. Page-specific files can go in the root or sub-folders.

## Before you answer, check
- Every JS file that touches the page opens with the HARD RULE 5 readyState guard.
- No \`freezr.*\` calls, no inline \`<script>\`, no external CDN / font / stylesheet URLs.
- Every path you reference — \`fetch()\`, \`<img src>\`, a CSS or JS resource — either appears in the project file list you were given, or is created by a file section in THIS response. Never reference a filename you assumed; if you need a file you cannot see, request it.
- No placeholder left stranded: each is either replaced by real content, or reachable only on a genuine error path that names what went wrong.`

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
 * @param {object} [opts.llmOptions] - provider/model/max_tokens/cache overrides from the Files-tab
 *   settings block (see modules/llmSettings.js). Merged into the freezr.llm.ask options; any field
 *   left out keeps the server-side default.
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
    llmOptions,
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

  // The conversation as the model should always see it. Every round re-sends
  // this: the file-request rounds below only APPEND to it.
  const baseMessages = [
    ...(hasHistory ? chatHistory.map((m) => ({ role: m.role, content: m.content })) : []),
    { role: 'user', content: userMessage }
  ]
  // Turns added by the request_file loop — the model's own request, then our
  // reply saying the files are now in context. Previously round > 0 REPLACED
  // the whole prompt with just that reply, so the model was asked to "proceed
  // with the user's original request" while the request itself had been
  // dropped from the message list; it answered, correctly, that it could see
  // no actionable request.
  const followUps = []

  for (let round = 0; round <= MAX_FILE_REQUEST_ROUNDS; round++) {
    const context = buildContext()
    const prompt = [...baseMessages, ...followUps]

    const result = await freezr.llm.ask(prompt, {
      ...(llmOptions || {}),
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
      const loaded = []
      const skipped = []
      for (const reqPath of parsed.requestFiles) {
        const clean = reqPath.replace(/^\/+/, '')
        if (alreadyLoaded.has(clean)) { skipped.push(clean); continue }
        try {
          const content = await fetchDraftFile(clean)
          contextFiles.push({ path: clean, content })
          alreadyLoaded.add(clean)
          loaded.push(clean)
        } catch (e) {
          skipped.push(clean)
          parsed.parseErrors.push(`Could not load requested file "${clean}": ${e.message}`)
        }
      }
      // A round that loaded nothing still needs a reply, otherwise the answer
      // handed back to the user is a bare file request they cannot act on.
      // Saying which files could NOT be supplied is what stops the model
      // asking for the same missing path again on the next round.
      // Echoing the model's own request back keeps the turns alternating, which
      // the provider requires. `raw` is non-empty whenever requestFiles parsed
      // out of it, but guard anyway: an empty assistant turn is rejected.
      if ((loaded.length > 0 || skipped.length > 0) && raw.trim()) {
        followUps.push({ role: 'assistant', content: raw.trim() })
        followUps.push({
          role: 'user',
          content: '[System: ' +
            (loaded.length
              ? 'these files are now in the context above: ' + loaded.join(', ') + '. '
              : '') +
            (skipped.length
              ? 'these could not be supplied (already in context, or they do not exist): ' + skipped.join(', ') + '. '
              : '') +
            'Do not request them again — answer the request above with what you now have.]'
        })
        continue
      }
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
