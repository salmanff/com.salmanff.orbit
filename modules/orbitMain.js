import { createEditor } from './editorLoader.js'
import {
  publishProjectSite,
  unpublishProjectSite,
  unpublishSingleFile,
  isFilePublished,
  defaultPublicIdForPage,
  canonicalPublicIdForFilePath,
  browseUrlToPublicId
} from './publishService.js'
import { sendOrbitChatMessage } from './orbitChat.js'
import { extractStreamDisplay } from './parseFreezrResponse.js'
// Permissions are loaded via reloadPermissions() (below) and cached on
// state.permissions — NOT via the per-call helpers in publishService /
// orbitChat, which silently swallow errors.

function normalizeQueryRows(rows) {
  if (Array.isArray(rows)) return rows
  if (rows && Array.isArray(rows.data)) return rows.data
  return []
}

/** @type {import('./editorLoader.js').createEditor | null} */
let editorApi = null

const LS_KEY_LEFT_W = 'orbitLeftPanelWidthPx'

function readLeftPanelWidth() {
  try {
    const n = parseInt(localStorage.getItem(LS_KEY_LEFT_W), 10)
    if (Number.isFinite(n) && n >= 200 && n <= 560) return n
  } catch (_) {}
  return 300
}

const state = {
  projects: [],
  currentProject: null,
  activePageIndex: 0,
  leftTab: 'chat',
  /** 'preview' = default. 'editor' = code (Files tab only). 'image' = image preview. */
  rightMode: 'preview',
  leftPanelWidth: readLeftPanelWidth(),
  /** Path the user has selected (may differ from what the editor currently has loaded). */
  currentFilePath: null,
  /** Path that the live editorApi instance is actually displaying (null when no editor). */
  loadedEditorPath: null,
  editorText: '',
  dirty: false,

  /**
   * Map of draft full path → boolean indicating whether the corresponding
   * public file is currently shared. Populated by loadPublishedFileStatus().
   * Key: "projects/{name}/draft/{rel}"  Value: true if public equivalent is shared.
   */
  publishedFiles: {},

  fileList: [],
  /** From read_user_file_tree when maxFiles or truncation applies */
  fileListIncomplete: false,
  fileListFileCount: 0,
  fileListMaxFiles: 0,
  fileListMaxDepth: 0,
  /** Map of relative file path → mtimeMs from last file tree fetch */
  fileMtimes: {},
  /** Currently expanded folder in Files tab (relative to draft, e.g. 'shared') or null for tree root */
  expandedFolder: null,
  /** Set of folder paths that are collapsed in the tree view */
  collapsedFolders: new Set(),
  chatThreads: [],
  activeThreadId: null,
  chatBusy: false,
  chatStreaming: null,
  chatStreamingThinking: null,
  chatStreamingFiles: null,
  /** Full paths of files currently being written by an in-flight LLM request */
  chatLockedFiles: new Set(),
  /**
   * Cached app permission flags. Populated once in initOrbit() and refreshable
   * via reloadPermissions(). Historically we re-asked the server on every
   * render with a silent `catch (_) => false`, which both slowed the UI and
   * masked real failures (e.g. network/API errors → buttons stuck disabled).
   * Now the state is explicit and inspectable at `window.__orbit.state`.
   */
  permissions: {
    loaded: false,
    raw: null, // full array returned by freezr.perms.getAppPermissions()
    canPublish: false,
    canLlm: false,
    canIframePreview: false,
    sessionExpired: false,
    lastError: null
  }
}

const starterIndexHtml = `<header class="orbit-header">
  <h1>Placeholder web page</h1>
  <main>
    <p>Edit or replace this page in Orbit, or ask your LLM to replace it with exactly what you would like.. then publish it.</p>
  </main>
`

const starterCss = `/* Shared styles — assigned to pages in the Pages tab */
body {
  font-family: system-ui, sans-serif;
  margin: 0;
  padding: 1.5rem;
  line-height: 1.5;
}
.orbit-header {
  margin-bottom: 2rem;
}
h1 { font-size: 1.5rem; }
`

async function loadProjects() {
  try {
    const rows = await freezr.query('projects', {}, {})
    state.projects = normalizeQueryRows(rows)
  } catch (e) {
    console.warn('Orbit: could not load projects', e)
    state.projects = []
  }
}

/**
 * Load the publish status of files for the current project.
 * Checks all files in state.fileList to see if their public equivalents are shared.
 * Populates state.publishedFiles.
 */
async function loadPublishedFileStatus() {
  if (!state.currentProject || !state.fileList.length) {
    state.publishedFiles = {}
    return
  }
  const base = draftBasePath()
  const result = {}
  // Check files in parallel (up to 8 at a time to avoid flooding)
  const rels = state.fileList
    .map(f => f.startsWith(base + '/') ? f.slice(base.length + 1) : null)
    .filter(Boolean)
  const CHUNK = 8
  for (let i = 0; i < rels.length; i += CHUNK) {
    const chunk = rels.slice(i, i + CHUNK)
    await Promise.all(chunk.map(async (rel) => {
      const publicFull = `projects/${state.currentProject.name}/public/${rel}`
      const draftFull = `${base}/${rel}`
      try {
        result[draftFull] = await isFilePublished(publicFull)
      } catch (_) {
        result[draftFull] = false
      }
    }))
  }
  state.publishedFiles = result
}

async function refreshCurrentProjectFromDb() {
  const name = state.currentProject?.name
  if (!name) return
  try {
    const rows = await freezr.query('projects', { name }, {})
    const list = normalizeQueryRows(rows)
    if (list[0]) state.currentProject = list[0]
  } catch (e) {
    console.warn('Orbit: refresh project failed', e)
  }
}

function generateThreadId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

function getActiveThread() {
  if (!state.activeThreadId) return null
  return state.chatThreads.find((t) => t.id === state.activeThreadId) || null
}

function startNewThread(pageIndex) {
  const id = generateThreadId()
  state.activeThreadId = id
  state.chatThreads.push({
    id,
    messages: [],
    startedAt: Date.now(),
    /** Page index that was active when this thread was created — used to
     *  keep file context stable across replies even if the user navigates. */
    pageIndex: pageIndex != null ? pageIndex : state.activePageIndex
  })
  return id
}

async function loadChatHistoryForProject() {
  if (!state.currentProject) {
    state.chatThreads = []
    state.activeThreadId = null
    return
  }
  try {
    const rows = await freezr.query(
      'chat_history',
      { project_name: state.currentProject.name },
      { sort: { _date_modified: 1 }, count: 200 }
    )
    const list = normalizeQueryRows(rows)
    const threadMap = new Map()
    for (const r of list) {
      const tid = r.thread_id || '_legacy'
      if (!threadMap.has(tid)) threadMap.set(tid, [])
      threadMap.get(tid).push({
        role: r.role,
        content: r.content || '',
        timestamp: r.timestamp || r._date_modified || null,
        filesChanged: r.files_changed || [],
        thinking: r.thinking || null,
        fileSnippets: r.file_snippets || null
      })
    }
    state.chatThreads = []
    for (const [tid, msgs] of threadMap) {
      state.chatThreads.push({
        id: tid,
        messages: msgs,
        startedAt: msgs[0]?.timestamp || null
      })
    }
    const last = state.chatThreads[state.chatThreads.length - 1]
    state.activeThreadId = last ? last.id : null
  } catch (e) {
    console.warn('Orbit: chat history load failed', e)
    state.chatThreads = []
    state.activeThreadId = null
  }
}

async function appendChatHistory(threadId, role, content, filesChanged = [], thinking = null, fileSnippets = null) {
  if (!state.currentProject) return
  const timestamp = Date.now()
  try {
    await freezr.create(
      'chat_history',
      {
        project_name: state.currentProject.name,
        thread_id: threadId,
        role,
        content,
        timestamp,
        active_page: getActivePage()?.name || '',
        files_changed: filesChanged,
        thinking,
        file_snippets: fileSnippets
      },
      {}
    )
  } catch (e) {
    console.warn('Orbit: chat_history save failed', e)
  }
  return timestamp
}

async function uploadText(path, text, mime) {
  const last = path.lastIndexOf('/')
  const folder = last >= 0 ? path.slice(0, last) : ''
  const fileName = last >= 0 ? path.slice(last + 1) : path
  const blob = new Blob([text], { type: mime || 'text/plain' })
  const file = new File([blob], fileName, { type: mime || 'text/plain' })
  await freezr.upload(file, { targetFolder: folder, overwrite: true })
}

async function uploadFile(path, file) {
  const last = path.lastIndexOf('/')
  const folder = last >= 0 ? path.slice(0, last) : ''
  await freezr.upload(file, { targetFolder: folder, overwrite: true })
}

async function ensureDefaultProject() {
  if (state.projects.length > 0) return

  const name = 'default-site'
  const base = `projects/${name}/draft`

  try {
    await uploadText(`${base}/index.html`, starterIndexHtml, 'text/html')
    await uploadText(`${base}/shared/common.css`, starterCss, 'text/css')

    const record = {
      name,
      display_name: 'Default site',
      description: '',
      published: false,
      public_url: null,
      entry_page: 'index',
      pages: [
        {
          name: 'index',
          html_file: 'index.html',
          css_files: ['shared/common.css'],
          js_files: [],
          published: false,
          public_url: null
        }
      ]
    }

    await freezr.create('projects', record, {})
    await loadProjects()
  } catch (e) {
    console.warn('Orbit: ensureDefaultProject failed (will continue with empty state)', e)
    // Non-fatal — the UI renders an empty state and the user can create a project manually.
  }
}

// async function fixLegacyProject() {
//   const LEGACY_NAME = 'freezrsite'
//   const draftPrefix = `projects/${LEGACY_NAME}/draft`
//   const publicPrefix = `projects/${LEGACY_NAME}/public`

//   const existingProject = state.projects.find((p) => p.name === LEGACY_NAME)

//   const appName = typeof freezrMeta !== 'undefined' && freezrMeta.appName ? freezrMeta.appName : null
//   if (!appName) {
//     window.alert('Cannot determine app name.')
//     return
//   }

//   const statusEl = document.getElementById('orbit-legacy-status')
//   const setStatus = (msg) => { if (statusEl) statusEl.textContent = msg }

//   try {
//     setStatus('Reading legacy file tree…')
//     const url = '/feps/read_user_file_tree/' + encodeURIComponent(appName)

//     const [draftResult, publicResult] = await Promise.all([
//       freezr.apiRequest('POST', url, {
//         subPath: draftPrefix,
//         readSubFolders: true,
//         maxFiles: 8000,
//         maxDepth: 5,
//         includeMetadata: true
//       }),
//       freezr.apiRequest('POST', url, {
//         subPath: publicPrefix,
//         readSubFolders: true,
//         maxFiles: 8000,
//         maxDepth: 5,
//         includeMetadata: true
//       }).catch(() => ({ tree: [] }))
//     ])

//     const draftTree = Array.isArray(draftResult?.tree) ? draftResult.tree : []
//     const publicTree = Array.isArray(publicResult?.tree) ? publicResult.tree : []

//     const paths = collectScopedTreeFilePaths(draftTree, draftPrefix)
//     const publicPaths = collectScopedTreeFilePaths(publicTree, publicPrefix)

//     // Collect all unique relative paths from both draft and public folders
//     const publicRelPaths = new Set(publicPaths.map((f) => f.replace(`${publicPrefix}/`, '')))

//     // If draft is empty, fall back to treating public files as the source
//     const allRelPaths = paths.length
//       ? paths.map((f) => f.replace(`${draftPrefix}/`, ''))
//       : [...publicRelPaths]

//     if (!allRelPaths.length) {
//       setStatus('No files found in projects/freezrsite/draft/ or projects/freezrsite/public/. Make sure at least one folder exists.')
//       return
//     }

//     // Merge: start from draft, add any public-only files
//     const relPathSet = new Set(allRelPaths)
//     for (const p of publicRelPaths) relPathSet.add(p)
//     const relPaths = [...relPathSet].sort()

//     const htmlFiles = relPaths.filter((f) => f.endsWith('.html'))
//     const cssFiles = relPaths.filter((f) => f.endsWith('.css'))
//     const jsFiles = relPaths.filter((f) => f.endsWith('.js'))

//     const action = existingProject ? 'Updating' : 'Creating'
//     setStatus(`Found ${relPaths.length} files (${htmlFiles.length} HTML, ${cssFiles.length} CSS, ${jsFiles.length} JS). ${action} project…`)

//     const pages = htmlFiles.map((htmlFile) => {
//       const pageName = htmlFile
//         .replace(/\.html?$/i, '')
//         .replace(/\//g, '-')
//         .replace(/\s+/g, '-')
//       const isPublished = publicRelPaths.has(htmlFile)
//       return {
//         name: pageName,
//         html_file: htmlFile,
//         css_files: [...cssFiles],
//         js_files: [...jsFiles],
//         published: isPublished,
//         public_url: null
//       }
//     })

//     const entryPage = pages.find((p) => p.name === 'main' || p.name === 'index')?.name || pages[0]?.name || 'index'

//     const anyPublished = pages.some((p) => p.published)

//     if (existingProject) {
//       await freezr.updateFields('projects', { name: LEGACY_NAME }, { pages, published: anyPublished, entry_page: entryPage })
//     } else {
//       await freezr.create('projects', {
//         name: LEGACY_NAME,
//         display_name: 'freezr.info (legacy)',
//         description: 'Recovered legacy freezrsite files',
//         published: anyPublished,
//         public_url: null,
//         entry_page: entryPage,
//         pages
//       }, {})
//     }
//     await loadProjects()

//     state.currentProject = state.projects.find((p) => p.name === LEGACY_NAME) || null
//     state.activePageIndex = 0
//     state.expandedFolder = null
//     state.rightMode = 'preview'
//     await refreshFileList()
//     if (state.currentProject) {
//       const pg = getActivePage()
//       state.currentFilePath = pg ? `projects/${LEGACY_NAME}/draft/${pg.html_file}` : null
//       await loadChatHistoryForProject()
//     }
//     await render()

//     const verb = existingProject ? 'Updated' : 'Created'
//     setStatus(`${verb} project "${LEGACY_NAME}" with ${pages.length} page(s).`)
//   } catch (e) {
//     console.error('fixLegacyProject failed', e)
//     setStatus('Error: ' + (e.message || String(e)))
//   }
// }

/**
 * Fetch app permissions, log the full response, and cache the derived flags
 * onto `state.permissions`. Any failure is logged AND retained in
 * `state.permissions.lastError` so the user can inspect it from the console.
 *
 * This replaces the previous per-render `hasPublishPermission().catch(()=>false)`
 * pattern, which silently masked errors and made "always disabled" buttons
 * undebuggable.
 */
async function reloadPermissions() {
  try {
    const raw = await freezr.perms.getAppPermissions()
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : [])
    const pub = list.find((p) => p && p.name === 'publish_site')
    const llm = list.find((p) => p && p.name === 'use_llm')
    const iframePerm = list.find((p) => p && p.name === 'allow_iframe_preview')
    state.permissions = {
      loaded: true,
      raw: list,
      canPublish: !!(pub && pub.granted),
      canLlm: !!(llm && llm.granted),
      canIframePreview: !!(iframePerm && iframePerm.granted),
      sessionExpired: false,
      lastError: null
    }
    console.log('[Orbit perms] loaded', {
      canPublish: state.permissions.canPublish,
      canLlm: state.permissions.canLlm,
      canIframePreview: state.permissions.canIframePreview,
      raw: list
    })
    if (!state.permissions.canPublish) {
      console.warn(
        '[Orbit perms] publish_site is NOT granted. Publish / Re-publish / Unpublish ' +
        'buttons will be disabled. Grant it from the app menu > Permissions.',
        { matchedPermission: pub || null }
      )
    }
  } catch (e) {
    // Detect session / token expiry (401 Unauthorized).
    // In this case we must NOT silently report "no permissions granted" — the
    // permissions may well be granted but the session token has simply expired.
    const isSessionExpired = e.status === 401 ||
      (typeof e.message === 'string' && /401|unauthorized/i.test(e.message))
    state.permissions = {
      loaded: true,
      raw: null,
      canPublish: false,
      canLlm: false,
      canIframePreview: false,
      sessionExpired: isSessionExpired,
      lastError: e
    }
    if (isSessionExpired) {
      console.warn('[Orbit perms] Session expired (401). Permissions state is unknown — refresh the page to re-authenticate.')
    } else {
      console.error('[Orbit perms] getAppPermissions() failed — buttons will be disabled.', e)
    }
  }
  return state.permissions
}

/**
 * Clear in-memory UI state that could plausibly be "stuck" from a previous
 * session or a bug (dirty flags, editor refs, cached file lists, expanded
 * folders, open page-card details, permissions cache). Then re-derive
 * everything from the server. Exposed via window.__orbit.reset() so you
 * can run it from the console if buttons ever look wrong.
 */
async function resetLocalState() {
  console.log('[Orbit] resetLocalState — clearing UI caches and reloading from server')
  if (editorApi) {
    try { editorApi.destroy() } catch (_) {}
    editorApi = null
  }
  state.dirty = false
  state.editorText = ''
  state.loadedEditorPath = null
  state.collapsedFolders = new Set()
  state.expandedFolder = null
  state.fileList = []
  state.fileMtimes = {}
  state.fileListIncomplete = false
  state.fileListFileCount = 0
  state.fileListMaxFiles = 0
  state.fileListMaxDepth = 0
  state.rightMode = 'preview'
  state.permissions = { loaded: false, raw: null, canPublish: false, canLlm: false, canIframePreview: false, sessionExpired: false, lastError: null }

  await reloadPermissions()
  await loadProjects()
  state.currentProject = state.projects.find((p) => p.name === state.currentProject?.name) || state.projects[0] || null
  state.activePageIndex = 0
  if (state.currentProject) {
    await refreshFileList()
    const pg = getActivePage()
    state.currentFilePath = pg ? `${draftBasePath()}/${pg.html_file}` : null
    await loadChatHistoryForProject()
  }
  await render()
  console.log('[Orbit] resetLocalState — done', { state })
}

/**
 * Returns false if user has unsaved edits and declines to discard them.
 * When the user *does* confirm discard, we actively clear the dirty flag and
 * forget the cached editor content so the next openFile() re-fetches from
 * the server (otherwise the editor would silently resurrect the "discarded"
 * edits next time the file was opened).
 */
function confirmDiscardChanges(msg = 'You have unsaved changes. Discard them?') {
  if (!state.dirty) return true
  if (!window.confirm(msg)) return false
  state.dirty = false
  state.editorText = ''
  state.loadedEditorPath = null
  const saveBtn = document.getElementById('orbit-save')
  if (saveBtn) saveBtn.classList.add('orbit-save-clean')
  return true
}

/**
 * Single source of truth for flipping the dirty flag. Updates the Save button
 * label and, if the Pages panel is visible, refreshes it so the "Re-publish" /
 * "Up to date" indicator on each page card reflects the current edit state.
 */
function setDirty(isDirty) {
  const next = !!isDirty
  if (state.dirty === next) return
  state.dirty = next
  const saveBtn = document.getElementById('orbit-save')
  if (saveBtn) saveBtn.classList.toggle('orbit-save-clean', !next)
  if (state.leftTab === 'pages') {
    refreshPagesPanel().catch((e) => console.warn('Orbit: pages refresh failed', e))
  }
}

/** Re-render only the left panel (cheap, no file re-fetch, no editor re-mount). */
async function refreshPagesPanel() {
  if (state.leftTab !== 'pages') return
  await renderLeftPanel({
    canLlm: state.permissions.canLlm,
    canPublish: state.permissions.canPublish
  })
}

function getActivePage() {
  const p = state.currentProject
  if (!p || !Array.isArray(p.pages) || !p.pages.length) return null
  return p.pages[state.activePageIndex] || p.pages[0]
}

function draftBasePath() {
  return `projects/${state.currentProject.name}/draft`
}

async function fetchText(relPath) {
  const path = freezr.getFileUrl(relPath)
  const url = path.startsWith('http') ? path : (window.location.origin + path)
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) throw new Error(`Failed to load ${relPath}: ${res.status}`)
  return res.text()
}

function langFromPath(path) {
  if (path.endsWith('.css')) return 'css'
  if (path.endsWith('.js')) return 'javascript'
  return 'html'
}

/** Match Creator file-system tree paths (Windows may use backslashes). */
function normalizeAppFsPath(p) {
  return String(p || '').replace(/\\/g, '/')
}

/**
 * Walk tree from POST /feps/read_user_file_tree with subPath = scopePrefix.
 * Node paths are relative to that scope; we join to full user-file paths.
 */
function collectScopedTreeFilePaths(tree, scopePrefix) {
  const base = normalizeAppFsPath(scopePrefix).replace(/\/+$/, '')
  const out = []
  const walk = (nodes) => {
    if (!Array.isArray(nodes)) return
    for (const node of nodes) {
      if (!node) continue
      if (node.type === 'file') {
        const rel = normalizeAppFsPath(node.path)
        const full = base ? `${base}/${rel}` : rel
        out.push(full)
      } else if (node.type === 'folder' && node.children) {
        walk(node.children)
      }
    }
  }
  walk(tree)
  return [...new Set(out)].sort()
}

/** Every file path in the tree (for debugging path / prefix mismatches). */
function collectAllTreeFilePaths(tree) {
  const out = []
  const walk = (nodes) => {
    if (!Array.isArray(nodes)) return
    for (const node of nodes) {
      if (!node) continue
      if (node.type === 'file') {
        out.push(normalizeAppFsPath(node.path))
      } else if (node.type === 'folder' && node.children) {
        walk(node.children)
      }
    }
  }
  walk(tree)
  return out.sort()
}

async function refreshFileList() {
  const log = (msg, data) => {
    console.log(`[Orbit files] ${msg}`, data != null ? data : '')
  }

  state.fileListIncomplete = false
  state.fileListFileCount = 0
  state.fileListMaxFiles = 0
  state.fileListMaxDepth = 0

  if (!state.currentProject) {
    state.fileList = []
    log('skip: no current project')
    return
  }
  const appName = typeof freezrMeta !== 'undefined' && freezrMeta.appName ? freezrMeta.appName : null
  if (!appName) {
    console.warn('Orbit: no app name — cannot list files')
    state.fileList = []
    log('skip: freezrMeta.appName missing', { freezrMeta })
    return
  }
  const draftPrefix = draftBasePath()
  try {
    const url = '/feps/read_user_file_tree/' + encodeURIComponent(appName)
    const body = {
      subPath: draftPrefix,
      readSubFolders: true,
      maxFiles: 8000,
      maxDepth: 5,
      includeMetadata: true
    }
    log('request', { url, appName, projectName: state.currentProject.name, body })
    const result = await freezr.apiRequest('POST', url, body)
    const tree = Array.isArray(result?.tree) ? result.tree : []
    const paths = collectScopedTreeFilePaths(tree, draftPrefix)
    state.fileList = paths
    state.fileListIncomplete = !!result?.incomplete
    state.fileListFileCount = typeof result?.fileCount === 'number' ? result.fileCount : paths.length
    state.fileListMaxFiles = typeof result?.maxFiles === 'number' ? result.maxFiles : 8000
    state.fileListMaxDepth = typeof result?.maxDepth === 'number' ? result.maxDepth : 5

    const mtimes = {}
    const collectMtimes = (nodes, prefix) => {
      for (const n of nodes) {
        if (n.type === 'file' && typeof n.mtimeMs === 'number') {
          const rel = prefix ? `${prefix}/${n.name}` : n.name
          mtimes[rel] = n.mtimeMs
        } else if (n.type === 'folder' && n.children) {
          collectMtimes(n.children, prefix ? `${prefix}/${n.name}` : n.name)
        }
      }
    }
    collectMtimes(tree, '')
    state.fileMtimes = mtimes

    const allFiles = collectAllTreeFilePaths(tree)
    log('response', {
      success: result?.success,
      error: result?.error,
      incomplete: result?.incomplete,
      fileCount: result?.fileCount,
      maxFiles: result?.maxFiles,
      maxDepth: result?.maxDepth,
      treeTopLevelCount: tree.length,
      treeTotalFiles: allFiles.length,
      pathCount: paths.length
    })
    if (tree.length) {
      log('tree sample (first nodes)', tree.slice(0, 8).map((n) => ({ type: n?.type, name: n?.name, path: n?.path })))
    }
    if (allFiles.length) {
      log('scoped paths sample (first 15)', allFiles.slice(0, 15))
    }
    if (paths.length) {
      log('full draft paths', paths)
    }
    if (result?.incomplete) {
      log('list truncated — increase maxFiles/maxDepth or narrow subPath', {
        fileCount: result.fileCount,
        maxFiles: result.maxFiles,
        maxDepth: result.maxDepth
      })
    }
  } catch (e) {
    console.warn('Orbit: read_user_file_tree failed', e)
    log('apiRequest threw', { message: e?.message, status: e?.status, stack: e?.stack })
    state.fileList = []
  }
}

/** True iff `editorApi` is still attached to a live DOM node. */
function editorIsLive() {
  if (!editorApi) return false
  const dom = editorApi.view?.dom
  return !!(dom && dom.isConnected)
}

/**
 * Load a file into the right-hand editor.
 *
 * This function is called both from explicit user actions (clicking a file)
 * and as a side-effect of render(). Because render() rewrites the entire
 * `#orbit-root` subtree, the previous editorApi may still exist in memory
 * while its DOM is detached. We handle four cases:
 *
 *   1. Live editor already on `relPath` and we're not forcing → no-op.
 *   2. Live editor on a different path → tear down + refetch.
 *   3. Editor detached after a re-render, same path, user had unsaved edits →
 *      re-mount with the in-memory `state.editorText` so edits survive.
 *   4. Editor detached, different path OR clean → refetch from server.
 *
 * Pass `force: true` to bypass case 1/3 and always reload from server
 * (e.g. after save, so the editor reflects server-side normalization).
 */
/**
 * Capture just enough of the current CodeMirror view to visually restore
 * the user's scroll + selection after an unavoidable re-mount (e.g. when
 * render() has wiped the editor DOM). Returns null when there's nothing
 * meaningful to restore.
 */
function captureEditorViewState() {
  if (!editorApi) return null
  try {
    const view = editorApi.view
    if (!view) return null
    const sel = view.state.selection?.main
    return {
      scrollTop: view.scrollDOM ? view.scrollDOM.scrollTop : 0,
      scrollLeft: view.scrollDOM ? view.scrollDOM.scrollLeft : 0,
      anchor: sel ? sel.anchor : null,
      head: sel ? sel.head : null
    }
  } catch (_) {
    return null
  }
}

function restoreEditorViewState(snapshot) {
  if (!snapshot || !editorApi) return
  try {
    const view = editorApi.view
    if (!view) return
    const docLen = view.state.doc.length
    if (snapshot.anchor != null && snapshot.head != null) {
      const anchor = Math.min(snapshot.anchor, docLen)
      const head = Math.min(snapshot.head, docLen)
      view.dispatch({ selection: { anchor, head } })
    }
    if (view.scrollDOM) {
      view.scrollDOM.scrollTop = snapshot.scrollTop || 0
      view.scrollDOM.scrollLeft = snapshot.scrollLeft || 0
    }
  } catch (_) { /* best-effort only */ }
}

async function openFile(relPath, { force = false } = {}) {
  state.currentFilePath = relPath

  const samePath = state.loadedEditorPath === relPath

  if (!force && samePath && editorIsLive()) {
    return
  }

  const el = document.getElementById('orbit-editor-mount')
  if (!el) return

  // If we're re-mounting for the *same* path (e.g. because render() wiped
  // the DOM), preserve the user's scroll + selection so saves / publishes
  // don't feel like they jump the view back to the top.
  const viewSnapshot = samePath ? captureEditorViewState() : null

  const preserveDirty = !force && samePath && state.dirty
  let text
  if (preserveDirty) {
    text = state.editorText
  } else {
    text = await fetchText(relPath)
    state.editorText = text
    state.dirty = false
  }
  state.loadedEditorPath = relPath

  if (editorApi) {
    try { editorApi.destroy() } catch (_) { /* detached DOM — ignore */ }
    editorApi = null
  }
  el.innerHTML = ''
  editorApi = await createEditor(el, {
    content: text,
    language: langFromPath(relPath),
    onChange: (s) => {
      state.editorText = s
      setDirty(true)
    }
  })

  if (viewSnapshot) restoreEditorViewState(viewSnapshot)

  const saveBtn = document.getElementById('orbit-save')
  if (saveBtn) saveBtn.classList.toggle('orbit-save-clean', !state.dirty)
}

function updateLockOverlay() {
  const overlay = document.getElementById('orbit-editor-locked')
  if (!overlay) return
  const isLocked = state.rightMode === 'editor' && !!state.currentFilePath && state.chatLockedFiles.has(state.currentFilePath)
  overlay.classList.toggle('hidden', !isLocked)
}

async function saveCurrentFile() {
  if (!state.currentFilePath || !editorApi) return
  if (state.chatLockedFiles.has(state.currentFilePath)) {
    window.alert('This file is currently being edited by the AI. Please wait for the response to complete before saving.')
    return
  }
  const text = editorApi.getContent()
  try {
    await uploadText(state.currentFilePath, text, 'text/plain')
  } catch (e) {
    const msg = e.status === 401
      ? 'Your session has expired — please log in again, then retry saving.'
      : `Save failed: ${e.message || String(e)}`
    window.alert(msg)
    // Keep the dirty flag so the user knows the file was NOT saved.
    return
  }
  state.editorText = text

  // Update the saved file's mtime in local state so isPageDirty() /
  // the "Re-publish" indicator stays accurate without another round-trip.
  const base = state.currentProject ? draftBasePath() : null
  if (base && state.currentFilePath.startsWith(base + '/')) {
    const rel = state.currentFilePath.slice(base.length + 1)
    state.fileMtimes[rel] = Date.now()
  }

  setDirty(false)

  // Preview only needs refreshing if the user is actually looking at it.
  if (state.rightMode === 'preview') {
    await refreshPreview()
  }
}

/**
 * Re-fetch permissions and return true iff publish_site is granted. If not,
 * alert the user AND update the cached state so the UI reflects it (buttons
 * stay disabled). This is called from the publish/unpublish actions so that
 * a permission granted mid-session is picked up without reloading the page.
 */
async function ensurePublishPermissionFresh() {
  await reloadPermissions()
  if (state.permissions.canPublish) return true
  const errPart = state.permissions.lastError
    ? ' (last error: ' + (state.permissions.lastError.message || state.permissions.lastError) + ')'
    : ''
  window.alert('The publish_site permission is not granted for this app. Grant it from the app menu > Permissions, then try again.' + errPart)
  // Make sure any open pages panel reflects the (unchanged) state.
  if (state.leftTab === 'pages') refreshPagesPanel().catch(() => {})
  return false
}

/**
 * Returns true if the user has unsaved edits to a file that belongs to the
 * given page. Used to prompt "save before publishing?" since publish reads
 * from the draft folder on the server, not from the in-memory editor.
 */
function hasUnsavedEditsForPage(page) {
  if (!state.dirty || !state.currentFilePath || !state.currentProject || !page) return false
  const base = draftBasePath()
  if (!state.currentFilePath.startsWith(base + '/')) return false
  const editingRel = state.currentFilePath.slice(base.length + 1)
  const files = [page.html_file, ...(page.css_files || []), ...(page.js_files || [])]
  return files.includes(editingRel)
}

/**
 * If the user has unsaved edits to a file that belongs to `page`, prompt:
 *   - OK      → save them now, then proceed with publish
 *   - Cancel  → abort the whole publish (we do NOT silently publish stale content)
 * Returns true iff the caller may proceed.
 */
async function ensureSavedBeforePublish(page) {
  if (!hasUnsavedEditsForPage(page)) return true
  const proceed = window.confirm(
    'You have unsaved changes to this page. Publish uses the saved draft on the ' +
    'server, so your latest edits would NOT be included.\n\n' +
    'OK = save changes first, then publish.\nCancel = stop and keep editing.'
  )
  if (!proceed) return false
  try {
    await saveCurrentFile()
    return true
  } catch (e) {
    console.error('Orbit: save-before-publish failed', e)
    window.alert('Save failed — aborting publish. ' + (e.message || e))
    return false
  }
}

/**
 * `skipUiRefresh` is used by the re-publish flow (which does unpublish+publish
 * back-to-back) to avoid re-rendering the pages panel between the two halves.
 * We deliberately use refreshPagesPanel() instead of the full render() — that
 * keeps the editor DOM intact so scroll + cursor survive a publish click.
 */
const PUBLIC_ID_TAKEN_MARKER = 'Another entity already has the id'

/**
 * Wraps publishProjectSite. If the server reports the chosen publicid is
 * already in use by another (possibly orphaned) entry, prompt the user and
 * retry once with forcePublicIdTakeover so the orphaned public record is
 * deleted and \u2014 if it lives in this same collection \u2014 its source record
 * is also marked as unshared.
 */
async function publishWithTakeoverPrompt(proj, page, baseOpts) {
  try {
    return await publishProjectSite(proj, page, baseOpts)
  } catch (e) {
    if (!e || typeof e.message !== 'string' || !e.message.includes(PUBLIC_ID_TAKEN_MARKER)) throw e
    const proceed = window.confirm(
      'The public URL path you chose is already in use by another published entry ' +
      '(possibly an old/orphaned record).\n\n' +
      'OK = delete the existing public record and publish this page in its place.\n' +
      'Cancel = abort and pick a different URL path.'
    )
    if (!proceed) throw e
    return await publishProjectSite(proj, page, { ...baseOpts, forcePublicIdTakeover: true })
  }
}

async function runPublishPage(pageIndex, { skipUiRefresh = false } = {}) {
  if (!state.currentProject) return
  if (!(await ensurePublishPermissionFresh())) return
  const proj = state.currentProject
  const page = proj.pages?.[pageIndex]
  if (!page?.html_file) {
    window.alert('Page must have an html_file.')
    return
  }
  if (!(await ensureSavedBeforePublish(page))) return
  try {
    const customId = page.custom_public_id || null
    const previousId = page.last_published_id || null
    const meta = page.meta || null
    const url = await publishWithTakeoverPrompt(proj, page, {
      customPublicId: customId,
      previousPublicId: previousId,
      meta
    })
    page.published = true
    page.public_url = url || null
    page.last_published_id = customId || defaultPublicIdForPage(proj.name, page)
    page.last_published_at = Date.now()
    await persistProjectPages(proj)
    if (!skipUiRefresh && state.leftTab === 'pages') await refreshPagesPanel()
  } catch (e) {
    console.error(e)
    window.alert(e.message || 'Publish failed')
  }
}

async function runUnpublishPage(pageIndex, { skipUiRefresh = false } = {}) {
  if (!state.currentProject) return
  if (!(await ensurePublishPermissionFresh())) return
  const proj = state.currentProject
  const page = proj.pages?.[pageIndex]
  if (!page?.html_file) return
  try {
    // Pass forcePublicIdCleanup so any leftover orphan public records (e.g. file record was
    // deleted manually) are removed too. Backend ACL still requires data_owner match or admin.
    await unpublishProjectSite(proj, page, { forcePublicIdCleanup: true })
    page.published = false
    page.public_url = null
    await persistProjectPages(proj)
    if (!skipUiRefresh && state.leftTab === 'pages') await refreshPagesPanel()
  } catch (e) {
    console.error(e)
    window.alert(e.message || 'Unpublish failed')
  }
}

function isPageDirty(page) {
  if (!page?.published || !page.last_published_at) return true
  const pubAt = page.last_published_at
  const files = [page.html_file, ...(page.css_files || []), ...(page.js_files || [])]
  for (const f of files) {
    const mt = state.fileMtimes[f]
    if (mt && mt > pubAt) return true
  }
  // If we're currently editing one of this page's files and have unsaved changes, treat as dirty
  if (state.dirty && state.currentFilePath && state.currentProject) {
    const base = draftBasePath()
    const editingRel = state.currentFilePath.startsWith(base + '/')
      ? state.currentFilePath.slice(base.length + 1)
      : null
    if (editingRel && files.includes(editingRel)) return true
  }
  return false
}



async function persistProjectPages(proj) {
  await freezr.updateFields(
    'projects',
    { name: proj.name },
    { pages: proj.pages }
  )
  await refreshCurrentProjectFromDb()
}

async function addResourceToPage(pageIndex, resourcePath, resourceType) {
  const proj = state.currentProject
  if (!proj) return
  const page = proj.pages?.[pageIndex]
  if (!page) return
  const arr = resourceType === 'css' ? 'css_files' : 'js_files'
  if (!page[arr]) page[arr] = []
  if (page[arr].includes(resourcePath)) return
  page[arr].push(resourcePath)
  await persistProjectPages(proj)
  await render()
}

async function removeResourceFromPage(pageIndex, resourcePath, resourceType) {
  const proj = state.currentProject
  if (!proj) return
  const page = proj.pages?.[pageIndex]
  if (!page) return
  const arr = resourceType === 'css' ? 'css_files' : 'js_files'
  if (!page[arr]) return
  page[arr] = page[arr].filter((f) => f !== resourcePath)
  await persistProjectPages(proj)
  await render()
}

let previewObjectUrl = null

function buildDraftBaseUrl() {
  const userId = freezrMeta.userId
  const appName = freezrMeta.appName
  return `${window.location.origin}/feps/userfiles/${appName}/${userId}/${draftBasePath()}/`
}

function buildFullDraftHtml(rawHtml, page) {
  const base = buildDraftBaseUrl()
  const cssLinks = (page.css_files || [])
    .map((f) => `<link rel="stylesheet" href="${base}${f}" />`)
    .join('\n')
  const jsScripts = (page.js_files || [])
    .map((f) => `<script src="${base}${f}"></script>`)
    .join('\n')
  const title = page.meta?.title || page.name || ''

  const hasHead = /<head[\s>]/i.test(rawHtml)
  if (hasHead) {
    let html = rawHtml
    const inject = `<base href="${base}" />\n  ${cssLinks}`
    html = html.replace(/<head([^>]*)>/i, (m) => `${m}\n  ${inject}`)
    html = html.replace(/<\/body>/i, `${jsScripts}\n</body>`)
    return html
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <base href="${base}" />
  <title>${escapeHtml(title)}</title>
  ${cssLinks}
</head>
<body>
${rawHtml}
${jsScripts}
</body>
</html>`
}

async function refreshPreview() {
  const page = getActivePage()
  if (!page || !state.currentProject) return

  // If allow_iframe_preview hasn't been granted, don't try to load the iframe —
  // it will hit a CSP error. The panel renders a friendly notice instead.
  if (!state.permissions.canIframePreview) return

  const iframe = document.getElementById('orbit-preview-frame')
  if (!iframe) return

  const htmlPath = `${draftBasePath()}/${page.html_file}`
  const rawHtml = await fetchText(htmlPath)
  const html = buildFullDraftHtml(rawHtml, page)

  if (previewObjectUrl) {
    URL.revokeObjectURL(previewObjectUrl)
    previewObjectUrl = null
  }
  const blob = new Blob([html], { type: 'text/html' })
  previewObjectUrl = URL.createObjectURL(blob)
  iframe.src = previewObjectUrl
}

function isImagePath(p) {
  return /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i.test(p)
}

// Files the code editor can usefully open. Anything else (images, PDFs,
// fonts, audio/video, archives, …) is treated as an asset and routed to
// the asset preview pane so the user can grab its URL.
function isTextEditablePath(p) {
  return /\.(html?|css|js|mjs|cjs|jsx|ts|tsx|json|md|markdown|txt|xml|yml|yaml|csv|log|sh|py|rb|go|rs|java|c|h|cpp|sql|env|gitignore|map)$/i.test(p) || !/\.[^./\\]+$/.test(p)
}

function assetUrlsForDraftPath(fullDraftPath) {
  if (!fullDraftPath) return { privateUrl: '', publicUrl: '', isPublished: false }
  const rawPrivate = freezr.getFileUrl(fullDraftPath) || ''
  const privateUrl = rawPrivate.startsWith('http') ? rawPrivate : (window.location.origin + rawPrivate)

  const isPublished = !!state.publishedFiles[fullDraftPath]
  let publicUrl = ''
  if (isPublished) {
    const publicFullPath = fullDraftPath.replace('/draft/', '/public/')
    publicUrl = browseUrlToPublicId(canonicalPublicIdForFilePath(publicFullPath)) || ''
  }
  return { privateUrl, publicUrl, isPublished }
}

function buildFileTree(fileList, basePath) {
  const root = { name: 'Project Folder', children: {}, files: [] }
  for (const fullPath of fileList) {
    const rel = fullPath.replace(`${basePath}/`, '')
    const parts = rel.split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.children[parts[i]]) {
        node.children[parts[i]] = { name: parts[i], children: {}, files: [] }
      }
      node = node.children[parts[i]]
    }
    node.files.push({ name: parts[parts.length - 1], fullPath, rel })
  }
  return root
}

function collectFolderPaths(tree, prefix) {
  const out = [prefix || '']
  for (const [name, child] of Object.entries(tree.children || {})) {
    const p = prefix ? `${prefix}/${name}` : name
    out.push(p)
    out.push(...collectFolderPaths(child, p).filter((x) => x !== p))
  }
  return out
}

function getFilesInFolder(tree, folderRel) {
  if (!folderRel) return tree.files
  const parts = folderRel.split('/')
  let node = tree
  for (const p of parts) {
    node = node.children?.[p]
    if (!node) return []
  }
  return node.files
}

async function renameFileOnServer(oldFullPath, newFullPath) {
  const res = await fetch(freezr.getFileUrl(oldFullPath).startsWith('http')
    ? freezr.getFileUrl(oldFullPath)
    : window.location.origin + freezr.getFileUrl(oldFullPath), { credentials: 'include' })
  if (!res.ok) throw new Error(`Could not read ${oldFullPath}: ${res.status}`)
  const blob = await res.blob()
  const last = newFullPath.lastIndexOf('/')
  const folder = last >= 0 ? newFullPath.slice(0, last) : ''
  const fileName = last >= 0 ? newFullPath.slice(last + 1) : newFullPath
  const file = new File([blob], fileName, { type: blob.type || 'application/octet-stream' })
  await freezr.upload(file, { targetFolder: folder, overwrite: true })
  try { await freezr.deleteFile(oldFullPath) } catch (_) {}
}

function updateProjectFileReferences(proj, oldRel, newRel) {
  let changed = false
  for (const page of proj.pages || []) {
    if (page.html_file === oldRel) { page.html_file = newRel; changed = true }
    const cssIdx = (page.css_files || []).indexOf(oldRel)
    if (cssIdx >= 0) { page.css_files[cssIdx] = newRel; changed = true }
    const jsIdx = (page.js_files || []).indexOf(oldRel)
    if (jsIdx >= 0) { page.js_files[jsIdx] = newRel; changed = true }
  }
  return changed
}

async function deleteFileOnServer(fullPath) {
  try { await freezr.deleteFile(fullPath) } catch (_) {}
}

/**
 * If the draft file has a published public equivalent that is currently shared,
 * un-share it first, then delete both draft and public copies.
 */
async function deleteFileWithUnpublish(fullDraftPath) {
  if (!state.currentProject) return
  const base = draftBasePath()
  if (!fullDraftPath.startsWith(base + '/')) {
    await deleteFileOnServer(fullDraftPath)
    return
  }
  const rel = fullDraftPath.slice(base.length + 1)
  const publicFull = `projects/${state.currentProject.name}/public/${rel}`

  // Un-share the public copy if it is currently published
  if (state.publishedFiles[fullDraftPath]) {
    try {
      await unpublishSingleFile(publicFull)
    } catch (e) {
      console.warn('deleteFileWithUnpublish: un-share failed', e)
    }
  }

  // Delete draft
  await deleteFileOnServer(fullDraftPath)
  // Also delete public copy (best-effort)
  try { await freezr.deleteFile(publicFull) } catch (_) {}
}

function removeFileFromProjectReferences(proj, rel) {
  let changed = false
  for (const page of proj.pages || []) {
    if (page.css_files) {
      const before = page.css_files.length
      page.css_files = page.css_files.filter((f) => f !== rel)
      if (page.css_files.length !== before) changed = true
    }
    if (page.js_files) {
      const before = page.js_files.length
      page.js_files = page.js_files.filter((f) => f !== rel)
      if (page.js_files.length !== before) changed = true
    }
  }
  return changed
}

async function publishImageFile(fullPath) {
  if (!(await ensurePublishPermissionFresh())) return
  try {
    const draftFullPath = fullPath
    const publicFullPath = fullPath.replace('/draft/', '/public/')
    const res = await fetch(
      freezr.getFileUrl(draftFullPath).startsWith('http')
        ? freezr.getFileUrl(draftFullPath)
        : window.location.origin + freezr.getFileUrl(draftFullPath),
      { credentials: 'include' }
    )
    if (!res.ok) throw new Error(`Could not read file: ${res.status}`)
    const blob = await res.blob()
    const last = publicFullPath.lastIndexOf('/')
    const folder = last >= 0 ? publicFullPath.slice(0, last) : ''
    const fileName = last >= 0 ? publicFullPath.slice(last + 1) : publicFullPath
    const file = new File([blob], fileName, { type: blob.type || 'application/octet-stream' })
    await freezr.upload(file, { targetFolder: folder, overwrite: true })
    await freezr.perms.shareFilePublicly(publicFullPath, {
      name: 'publish_site',
      grant: true,
      doNotList: true
    })
    state.publishedFiles[fullPath] = true
    await render()
  } catch (e) {
    console.error(e)
    window.alert(e.message || 'Publish failed')
  }
}

async function unpublishImageFile(fullPath) {
  if (!(await ensurePublishPermissionFresh())) return
  try {
    const publicFullPath = fullPath.replace('/draft/', '/public/')
    let rows = await freezr.query('files', { _id: publicFullPath }, {})
    let rec = (Array.isArray(rows) ? rows : (rows?.data || []))[0] || null
    if (rec && rec._id) {
      await freezr.perms.shareFilePublicly(rec._id, {
        name: 'publish_site',
        action: 'deny',
        grant: false
      })
    } else {
      const canonicalPid = '@' + freezrMeta.userId + '/' + freezrMeta.appName + '.files/' + publicFullPath
      await freezr.perms.unshareByPublicId(canonicalPid, {
        name: 'publish_site',
        table_id: freezrMeta.appName + '.files',
        grantees: ['_public'],
        forcePublicIdCleanup: true
      })
    }
    state.publishedFiles[fullPath] = false
    await render()
  } catch (e) {
    console.error(e)
    window.alert(e.message || 'Unpublish failed')
  }
}

function leftPanelStyleAttr() {
  const w = state.leftPanelWidth
  return `style="flex:0 0 ${w}px;width:${w}px;min-width:200px;max-width:560px"`
}

// On narrow screens (≤ 800px) the panels stack vertically — the right panel
// sits below the fold, so after the user clicks something that loads new
// content into it (Preview, page name, file name, resource link) we scroll
// the right panel into view. CSS already gives .orbit-right min-height: 90vh
// at this breakpoint so scrollIntoView has somewhere to scroll to.
function scrollToRightPanelIfNeeded () {
  if (window.innerWidth > 800) return
  requestAnimationFrame(() => {
    document.querySelector('.orbit-right')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
}

async function render() {
  const root = document.getElementById('orbit-root')
  if (!root) return

  // Permissions come from the cached state.permissions; they're loaded once
  // in initOrbit() and refreshed explicitly via reloadPermissions().
  // If we never completed the initial load (e.g. boot race), do it now.
  if (!state.permissions.loaded) {
    await reloadPermissions()
  }
  const { canPublish, canLlm, canIframePreview, sessionExpired } = state.permissions

  const proj = state.currentProject
  const page = getActivePage()

  // Session-expired banner (shown once at top of left panel)
  const sessionBanner = sessionExpired
    ? `<div class="orbit-perm-banner orbit-session-expired-banner" role="alert">
        <strong>Session expired.</strong>
        Your login token has expired — permissions cannot be verified.
        <button type="button" class="orbit-btn-sm orbit-btn-secondary" id="orbit-session-refresh">Refresh session</button>
      </div>`
    : ''

  // Build preview panel HTML (iframe vs. permission notice)
  const previewPanelHtml = canIframePreview
    ? `<iframe id="orbit-preview-frame" class="orbit-preview-frame" title="Draft preview"></iframe>`
    : `<div class="orbit-no-preview-notice">
        <div class="orbit-no-preview-inner">
          <p><strong>In-app preview unavailable</strong></p>
          <p>Grant the <code>allow_iframe_preview</code> permission in App Settings to enable the live preview panel.</p>
          <div class="orbit-no-preview-actions">
            <a class="orbit-btn orbit-btn-secondary orbit-btn-sm"
               href="/account/app/settings/${typeof freezrMeta !== 'undefined' ? freezrMeta.appName : 'orbit'}"
               target="_blank" rel="noopener">Open App Settings ↗</a>
            <button type="button" class="orbit-btn orbit-btn-sm" id="orbit-open-draft-preview">Open draft in new tab</button>
          </div>
        </div>
      </div>`

  root.innerHTML = `
    <div class="orbit-body">
      <aside class="orbit-left" id="orbit-left-panel" ${leftPanelStyleAttr()}>
        ${sessionBanner}
        <div class="orbit-left-toolbar">
          <div class="globe-toolbar${state.chatBusy ? '' : ' orbit-globe-idle'}"><div class="sphere"></div><div class="orbit-ring"><div class="orbit-dot"></div></div></div>
          <select id="orbit-project-select" class="orbit-select">
            ${state.projects.map((p) => `<option value="${p.name}" ${proj && p.name === proj.name ? 'selected' : ''}>${p.display_name || p.name}</option>`).join('')}
            <option value="__new_project__">+ New project…</option>
          </select>
        </div>
        <nav class="orbit-tabs">
          <button type="button" data-left-tab="chat" class="${state.leftTab === 'chat' ? 'active' : ''}">Chat</button>
          <button type="button" data-left-tab="pages" class="${state.leftTab === 'pages' ? 'active' : ''}">Pages</button>
          <button type="button" data-left-tab="files" class="${state.leftTab === 'files' ? 'active' : ''}">Files</button>
        </nav>
        <div class="orbit-left-body" id="orbit-left-body"></div>
      </aside>
      <div class="orbit-splitter" id="orbit-splitter" role="separator" aria-orientation="vertical" aria-label="Resize side panel"></div>
      <section class="orbit-right">
        ${state.rightMode === 'editor' ? `<div class="orbit-right-toolbar">
          <span class="orbit-meta">${state.currentFilePath ? state.currentFilePath.split('/').pop() : ''}</span>
          <button type="button" id="orbit-save" class="orbit-btn${state.dirty ? '' : ' orbit-save-clean'}">Save</button>
        </div>` : ''}
        ${state.rightMode === 'image' ? (() => {
          const fp = state.currentFilePath
          const { privateUrl, publicUrl, isPublished } = assetUrlsForDraftPath(fp)
          return `<div class="orbit-right-toolbar">
            <span class="orbit-meta">${fp ? fp.split('/').pop() : ''}</span>
            <button type="button" id="orbit-img-publish" class="orbit-btn orbit-btn-sm" ${canPublish ? '' : 'disabled'}>Publish</button>
            <button type="button" id="orbit-img-unpublish" class="orbit-btn orbit-btn-sm orbit-btn-secondary" ${canPublish ? '' : 'disabled'}>Unpublish</button>
          </div>
          <div class="orbit-asset-urls">
            <div class="orbit-asset-url-row">
              <button type="button" class="orbit-btn orbit-btn-sm" data-copy-url="private">Copy private URL</button>
              <input type="text" class="orbit-asset-url-input" data-asset-url="private" readonly value="${escapeHtml(privateUrl)}" />
            </div>
            ${isPublished ? `<div class="orbit-asset-url-row">
              <button type="button" class="orbit-btn orbit-btn-sm" data-copy-url="public">Copy public URL</button>
              <input type="text" class="orbit-asset-url-input" data-asset-url="public" readonly value="${escapeHtml(publicUrl)}" />
            </div>` : `<div class="orbit-asset-url-hint">Publish to get a public URL.</div>`}
          </div>`
        })() : ''}
        <div class="orbit-right-body">
          <div id="orbit-panel-editor" class="orbit-panel ${state.rightMode === 'editor' ? '' : 'hidden'}">
            <div id="orbit-editor-mount" class="orbit-editor-mount"></div>
            <div id="orbit-editor-locked" class="orbit-editor-locked${(state.rightMode === 'editor' && state.currentFilePath && state.chatLockedFiles.has(state.currentFilePath)) ? '' : ' hidden'}">
              <div class="orbit-editor-locked-msg">
                <span class="orbit-spinner-inline"></span>
                AI is editing this file — editing locked until the response completes.
              </div>
            </div>
          </div>
          <div id="orbit-panel-preview" class="orbit-panel ${state.rightMode === 'preview' ? '' : 'hidden'}">
            ${previewPanelHtml}
          </div>
          <div id="orbit-panel-image" class="orbit-panel ${state.rightMode === 'image' ? '' : 'hidden'}">
            <div class="orbit-image-preview" id="orbit-image-preview"></div>
          </div>
        </div>
      </section>
    </div>
  `

  bindChrome()
  bindSplitter()

  // Session-expired refresh button
  document.getElementById('orbit-session-refresh')?.addEventListener('click', async () => {
    await reloadPermissions()
    await render()
  })

  // Open draft in new tab when iframe preview is unavailable
  document.getElementById('orbit-open-draft-preview')?.addEventListener('click', async () => {
    const pg = getActivePage()
    if (!pg) return
    try {
      const rawHtml = await fetchText(`${draftBasePath()}/${pg.html_file}`)
      const fullHtml = buildFullDraftHtml(rawHtml, pg)
      const blob = new Blob([fullHtml], { type: 'text/html' })
      const url = URL.createObjectURL(blob)
      window.open(url, '_blank')
    } catch (e) {
      console.warn('Could not open draft', e)
      window.open(buildDraftBaseUrl() + pg.html_file, '_blank')
    }
  })

  await renderLeftPanel({ canLlm, canPublish })
  if (state.rightMode === 'editor') {
    if (state.currentFilePath) {
      await openFile(state.currentFilePath)
    } else if (page) {
      await openFile(`${draftBasePath()}/${page.html_file}`)
    }
  }
  if (state.rightMode === 'preview') {
    await refreshPreview()
  }
  if (state.rightMode === 'image' && state.currentFilePath) {
    const imgEl = document.getElementById('orbit-image-preview')
    if (imgEl) {
      const fp = state.currentFilePath
      const url = freezr.getFileUrl(fp)
      const fullUrl = url.startsWith('http') ? url : (window.location.origin + url)
      const name = fp.split('/').pop()
      if (isImagePath(fp)) {
        imgEl.innerHTML = `<img src="${fullUrl}" alt="${escapeHtml(name)}" class="orbit-image-preview-img" />`
      } else {
        imgEl.innerHTML = `<div class="orbit-asset-placeholder">
          <div class="orbit-asset-placeholder-icon">&#128196;</div>
          <div class="orbit-asset-placeholder-name">${escapeHtml(name)}</div>
          <a class="orbit-asset-placeholder-link" href="${escapeHtml(fullUrl)}" target="_blank" rel="noopener">Open in new tab ↗</a>
        </div>`
      }
    }
    document.getElementById('orbit-img-publish')?.addEventListener('click', () => publishImageFile(state.currentFilePath))
    document.getElementById('orbit-img-unpublish')?.addEventListener('click', () => unpublishImageFile(state.currentFilePath))

    document.querySelectorAll('[data-copy-url]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const which = btn.getAttribute('data-copy-url')
        const input = document.querySelector(`[data-asset-url="${which}"]`)
        const value = input?.value || ''
        if (!value) return
        const originalLabel = btn.textContent
        try {
          await navigator.clipboard.writeText(value)
        } catch (_) {
          input?.select()
          try { document.execCommand('copy') } catch (_) {}
        }
        btn.textContent = 'Copied!'
        setTimeout(() => { btn.textContent = originalLabel }, 1200)
      })
    })
  }
}

/** Call when external chat/LLM finishes a turn — refresh draft preview. */
export async function orbitAfterChatResponse() {
  state.rightMode = 'preview'
  await refreshFileList()
  await render()
  await refreshPreview()
}

async function renderLeftPanel(opts = {}) {
  const { canLlm = false, canPublish = false } = opts
  const body = document.getElementById('orbit-left-body')
  if (!body) return

  // Page-details open/closed state is kept in sync live via 'toggle' listeners
  // bound in bindPageDetailsState(), so no pre-wipe snapshot is needed.

  if (state.leftTab === 'chat') {
    const formatTs = (ts) => {
      if (!ts) return ''
      try {
        const d = new Date(ts)
        const now = new Date()
        const sameDay = d.toDateString() === now.toDateString()
        if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      } catch (_) { return '' }
    }

    const firstLine = (s) => {
      const line = (s || '').split('\n')[0].trim()
      return line.length > 60 ? line.slice(0, 57) + '…' : line
    }

    const renderFileItem = (f, snippet) => {
      const snippetHtml = snippet
        ? `<span class="orbit-file-snippet">${escapeHtml(snippet)}</span>`
        : ''
      return `<div class="orbit-file-item"><span class="orbit-file-icon">✓</span><span class="orbit-file-name">${escapeHtml(f)}</span>${snippetHtml}</div>`
    }

    const renderAssistantMsg = (m) => {
      const ts = formatTs(m.timestamp)
      const thinkingHtml = m.thinking
        ? `<details class="orbit-thinking"><summary>Thinking…</summary><pre class="orbit-thinking-pre">${escapeHtml(m.thinking)}</pre></details>`
        : ''
      let filesHtml = ''
      if (m.filesChanged?.length) {
        const snippets = m.fileSnippets || {}
        filesHtml = `<div class="orbit-file-items">${m.filesChanged.map((f) => renderFileItem(f, snippets[f])).join('')}</div>`
      }
      return `<div class="orbit-msg-assistant">
        ${thinkingHtml}
        <div class="orbit-msg-explanation">${escapeHtml(m.content)}</div>
        ${filesHtml}
        <span class="orbit-msg-ts">${ts}</span>
      </div>`
    }

    const renderExchange = (m, idx, arr, isActiveThread) => {
      const ts = formatTs(m.timestamp)
      const next = arr[idx + 1]
      const assistant = (next && next.role === 'assistant') ? next : null
      const assistantHtml = assistant ? renderAssistantMsg(assistant) : ''
      const fileCount = assistant?.filesChanged?.length || 0
      const filesBadge = fileCount > 0
        ? `<span class="orbit-thread-file-count">${fileCount} file${fileCount > 1 ? 's' : ''}</span>`
        : ''
      const userPreview = firstLine(m.content)

      const isLast = isActiveThread && (idx >= arr.length - 2)

      if (isLast) {
        return `<div class="orbit-msg">
          <div class="orbit-msg-user">
            <span class="orbit-msg-user-label">You</span>
            <span class="orbit-msg-user-text">${escapeHtml(m.content)}</span>
            <span class="orbit-msg-ts">${ts}</span>
          </div>
          ${assistantHtml}
        </div>`
      }

      return `<details class="orbit-exchange">
        <summary class="orbit-exchange-summary">
          <span class="orbit-exchange-q">${escapeHtml(userPreview)}</span>
          <span class="orbit-exchange-meta">${filesBadge}<span class="orbit-msg-ts">${ts}</span></span>
        </summary>
        <div class="orbit-msg">
          <div class="orbit-msg-user">
            <span class="orbit-msg-user-label">You</span>
            <span class="orbit-msg-user-text">${escapeHtml(m.content)}</span>
          </div>
          ${assistantHtml}
        </div>
      </details>`
    }

    const renderThread = (thread, isActive) => {
      const msgs = thread.messages || []
      if (!msgs.length) return ''

      const firstUserMsg = msgs.find((m) => m.role === 'user')
      const preview = firstLine(firstUserMsg?.content || msgs[0]?.content || 'Chat')
      const ts = formatTs(thread.startedAt)
      const totalFiles = msgs.reduce((n, m) => n + (m.filesChanged?.length || 0), 0)
      const filesBadge = totalFiles > 0
        ? `<span class="orbit-thread-file-count">${totalFiles} file${totalFiles > 1 ? 's' : ''}</span>`
        : ''
      const exchangeCount = msgs.filter((m) => m.role === 'user').length
      const countLabel = exchangeCount > 1
        ? `<span class="orbit-thread-count">${exchangeCount}</span>`
        : ''

      const exchangeHtmls = []
      for (let i = 0; i < msgs.length; i++) {
        if (msgs[i].role === 'user') {
          exchangeHtmls.push(renderExchange(msgs[i], i, msgs, isActive))
          if (msgs[i + 1]?.role === 'assistant') i++
        }
      }
      const bodyHtml = exchangeHtmls.join('')

      if (isActive) {
        return `<div class="orbit-thread orbit-thread--active" data-thread="${thread.id}">
          <div class="orbit-thread-body">${bodyHtml}</div>
          <div id="orbit-active-thread-tail"></div>
        </div>`
      }

      return `<details class="orbit-thread" data-thread="${thread.id}">
        <summary class="orbit-thread-summary">
          <span class="orbit-thread-preview">
            <span class="orbit-thread-q">${escapeHtml(preview)}</span>
          </span>
          <span class="orbit-thread-meta">${countLabel}${filesBadge}<span class="orbit-thread-ts">${ts}</span></span>
        </summary>
        <div class="orbit-thread-body">${bodyHtml}</div>
      </details>`
    }

    const streamingHtml = state.chatBusy
      ? `<div class="orbit-streaming-wrap">
          <details class="orbit-thinking" id="orbit-stream-thinking-wrap" ${state.chatStreamingThinking && !state.chatStreaming ? 'open' : ''} ${state.chatStreamingThinking ? '' : 'hidden'}>
            <summary>Thinking…</summary>
            <pre class="orbit-thinking-pre" id="orbit-stream-thinking">${escapeHtml(state.chatStreamingThinking || '')}</pre>
          </details>
          <div class="orbit-msg-explanation" id="orbit-stream-content">${escapeHtml(state.chatStreaming || '')}</div>
          <div id="orbit-stream-files" class="orbit-file-items"></div>
          <span class="orbit-spinner-inline"></span>
        </div>`
      : ''

    const disChat = !canLlm || state.chatBusy ? 'disabled' : ''

    const threadsHtml = state.chatThreads
      .map((t) => renderThread(t, t.id === state.activeThreadId))
      .join('')

    body.innerHTML = `
      <div class="orbit-chat">
        <div class="orbit-chat-log" id="orbit-chat-log">
          ${threadsHtml}
        </div>
        ${!canLlm ? '<p class="orbit-muted orbit-chat-perm" style="color:#f85149"><a href="/account/app/settings/com.salmanff.orbit" target="_blank" rel="noopener" style="color:#f85149">Grant <strong>use_llm</strong> in app settings</a> to enable chat.</p>' : ''}
        <div class="orbit-chat-bottom">
          <textarea id="orbit-chat-input" class="orbit-chat-input" rows="2" placeholder="Start a new conversation…" ${disChat}></textarea>
          <button type="button" id="orbit-chat-new" class="orbit-btn" ${disChat}>New Chat</button>
        </div>
      </div>
    `

    const tail = document.getElementById('orbit-active-thread-tail')
    if (tail) {
      tail.innerHTML = `
        ${streamingHtml}
        ${canLlm ? `<div class="orbit-reply-box">
          <textarea id="orbit-reply-input" class="orbit-chat-input orbit-reply-input" rows="2" placeholder="Follow up…" ${disChat}></textarea>
          <button type="button" id="orbit-reply-send" class="orbit-btn orbit-btn-sm" ${disChat}>Reply</button>
        </div>` : ''}
      `
    }

    const log = document.getElementById('orbit-chat-log')
    if (log) log.scrollTop = log.scrollHeight

    document.getElementById('orbit-reply-send')?.addEventListener('click', async () => {
      await handleChatSend(canLlm, false)
    })
    const replyInput = document.getElementById('orbit-reply-input')
    if (replyInput) {
      bindAutoGrowTextarea(replyInput)
      replyInput.addEventListener('keydown', async (ev) => {
        if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
          ev.preventDefault()
          await handleChatSend(canLlm, false)
        }
      })
    }
    document.getElementById('orbit-chat-new')?.addEventListener('click', async () => {
      await handleChatSend(canLlm, true)
    })
    const chatInput = document.getElementById('orbit-chat-input')
    if (chatInput) {
      bindAutoGrowTextarea(chatInput)
      chatInput.addEventListener('keydown', async (ev) => {
        if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
          ev.preventDefault()
          await handleChatSend(canLlm, true)
        }
      })
    }
  } else if (state.leftTab === 'pages') {
    const proj = state.currentProject
    if (!proj || !proj.pages) {
      body.innerHTML = '<p class="orbit-muted">No project</p>'
      return
    }

    const sharedFiles = state.fileList
      .map((f) => f.replace(`${draftBasePath()}/`, ''))
      .filter((f) => f.endsWith('.css') || f.endsWith('.js'))

    const isAdmin = !!(typeof freezrMeta !== 'undefined' && (freezrMeta.adminUser || freezrMeta.publisherUser))

    const permBanner = !canPublish
      ? `<div class="orbit-perm-banner" role="alert">
          You need to grant the <strong style="display:inline;width:auto;margin:0">publish_site</strong> permission to be able to publish. Go to the app settings to grant the permission.
          <div style="display:flex;gap:0.5rem;margin-top:0.4rem;flex-wrap:wrap">
            <button type="button" class="orbit-btn-sm orbit-btn-secondary" id="orbit-perm-recheck">Re-check</button>
            <a class="orbit-btn-sm orbit-btn-secondary" href="/account/app/settings/com.salmanff.orbit" target="_blank" rel="noopener">App Settings ↗</a>
          </div>
        </div>`
      : ''

    // ── Top list ──────────────────────────────────────────────────────────────
    const listItems = proj.pages.map((pg, i) => {
      const isActive = i === state.activePageIndex
      const isPub = !!pg.published
      const dirty = isPub ? isPageDirty(pg) : false
      const statusClass = isPub
        ? (dirty ? 'orbit-page-status--dirty' : 'orbit-page-status--pub')
        : 'orbit-page-status--draft'
      const statusLabel = isPub ? (dirty ? 'Modified' : 'Published') : 'Draft'
      return `
        <div class="orbit-page-item${isActive ? ' orbit-page-item--active' : ''}" data-page-select="${i}" role="button" tabindex="0">
          <span class="orbit-page-item-name">${escapeHtml(pg.name)}</span>
          <span class="orbit-page-status ${statusClass}">${statusLabel}</span>
        </div>`
    }).join('')

    // ── Bottom detail panel ───────────────────────────────────────────────────
    const selPg = proj.pages[state.activePageIndex]
    let detailHtml = '<p class="orbit-muted orbit-detail-empty">Select a page above to view settings.</p>'
    if (selPg) {
      const i = state.activePageIndex
      const isPub = !!selPg.published
      const pubUrl = selPg.public_url || null
      const dirty = isPub ? isPageDirty(selPg) : false
      const cssFiles = selPg.css_files || []
      const jsFiles = selPg.js_files || []
      const defaultPid = defaultPublicIdForPage(proj.name, selPg)
      const customPid = selPg.custom_public_id || ''
      const displayUrl = customPid || defaultPid
      const meta = selPg.meta || {}
      // Show the user's saved title verbatim. If they haven't entered one,
      // leave the input empty so the placeholder (page name) is visible —
      // that way it's obvious the field is unset and the publish flow will
      // fall back to the page name automatically.
      const metaTitle = meta.title || ''

      // All .html files in the draft folder, used to populate the
      // "change main html page" dropdown. Always include the page's current
      // html_file (it may not yet be in state.fileList, e.g. right after upload).
      const allHtmlFiles = state.fileList
        .map((f) => f.replace(`${draftBasePath()}/`, ''))
        .filter((f) => /\.html?$/i.test(f))
      const htmlChoiceSet = new Set(allHtmlFiles)
      if (selPg.html_file) htmlChoiceSet.add(selPg.html_file)
      const htmlChoices = [...htmlChoiceSet].sort()
      const htmlOptions = [
        `<option value="">— pick another html file —</option>`,
        ...htmlChoices
          .filter((f) => f !== selPg.html_file)
          .map((f) => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`)
      ].join('')

      const resourceRows = []
      resourceRows.push(
        `<li class="orbit-res-row orbit-res-html">` +
          `<button type="button" class="orbit-res-link" data-page="${i}" data-res-open="${escapeHtml(selPg.html_file)}">html: ${escapeHtml(selPg.html_file)}</button>` +
          ` <button type="button" class="orbit-res-html-change" data-page-html-change="${i}" title="Change main HTML page">change</button>` +
          `<select class="orbit-res-html-select orbit-hidden" data-page-html="${i}">${htmlOptions}</select>` +
        `</li>`
      )
      cssFiles.forEach((f) => {
        resourceRows.push(`<li class="orbit-res-row"><button type="button" class="orbit-res-link" data-page="${i}" data-res-open="${escapeHtml(f)}">css: ${escapeHtml(f)}</button> <button type="button" class="orbit-res-remove" data-page="${i}" data-res="${escapeHtml(f)}" data-res-type="css" title="Remove">&times;</button></li>`)
      })
      jsFiles.forEach((f) => {
        resourceRows.push(`<li class="orbit-res-row"><button type="button" class="orbit-res-link" data-page="${i}" data-res-open="${escapeHtml(f)}">js: ${escapeHtml(f)}</button> <button type="button" class="orbit-res-remove" data-page="${i}" data-res="${escapeHtml(f)}" data-res-type="js" title="Remove">&times;</button></li>`)
      })

      const usedPaths = new Set([selPg.html_file, ...cssFiles, ...jsFiles])
      const availableShared = sharedFiles.filter((f) => !usedPaths.has(f))
      const addOptions = [
        '<option value="">+ Add resource…</option>',
        ...availableShared.map((f) => `<option value="existing:${escapeHtml(f)}">${escapeHtml(f)}</option>`),
        '<option value="__new_css__">New CSS file…</option>',
        '<option value="__new_js__">New JS file…</option>',
        '<option value="__new_shared_css__">New shared CSS…</option>',
        '<option value="__new_shared_js__">New shared JS…</option>'
      ].join('')

      const isPreviewing = state.rightMode === 'preview'
      detailHtml = `
        <div class="orbit-detail-inner">
          <div class="orbit-detail-header">
            <button type="button" class="orbit-detail-page-name orbit-detail-page-name-btn" data-page-preview="${i}" title="Preview this page">${escapeHtml(selPg.name)}</button>
            <div class="orbit-detail-links">
              <button type="button" class="orbit-page-open orbit-link" data-page-open-draft="${i}">Draft ↗</button>
              ${isPub && pubUrl ? `<a class="orbit-page-open" href="${escapeHtml(pubUrl)}" target="_blank" rel="noopener">Live ↗</a>` : ''}
            </div>
          </div>

          <div class="orbit-detail-actions">
            <button type="button" class="orbit-btn-sm orbit-btn-secondary" data-page-preview="${i}" ${isPreviewing ? 'disabled' : ''}>${isPreviewing ? 'Previewing' : 'Preview'}</button>
            ${isPub
              ? `<button type="button" class="orbit-btn-sm${dirty ? '' : ' orbit-btn-secondary'}" data-page-republish="${i}" ${canPublish && dirty ? '' : 'disabled'}>${dirty ? 'Re-publish' : 'Up to date'}</button>
                 <button type="button" class="orbit-btn-sm orbit-btn-secondary" data-page-unpublish="${i}" ${canPublish ? '' : 'disabled'}>Unpublish</button>`
              : `<button type="button" class="orbit-btn-sm" data-page-publish="${i}" ${canPublish ? '' : 'disabled'}>Publish</button>`
            }
          </div>

          <div class="orbit-detail-section">
            <label class="orbit-meta-label">Resources (${1 + cssFiles.length + jsFiles.length})</label>
            <ul class="orbit-res-list">${resourceRows.join('')}</ul>
            <select class="orbit-res-add" data-page-add-res="${i}">${addOptions}</select>
          </div>

          <div class="orbit-detail-section">
            <label class="orbit-meta-label">Public URL path</label>
            <input type="text" class="orbit-page-url-input" data-page-url="${i}"
              value="${escapeHtml(displayUrl)}"
              placeholder="${escapeHtml(defaultPid)}"
              ${isAdmin ? '' : 'readonly'}
              title="${isAdmin ? 'Custom public URL path (admin/publisher only)' : 'Public URL path'}">
          </div>

          <div class="orbit-detail-section">
            <label class="orbit-meta-label">Title</label>
            <input type="text" class="orbit-meta-input" data-page-meta="${i}" data-meta-field="title"
              value="${escapeHtml(metaTitle)}" placeholder="${escapeHtml(selPg.name)}">
            <label class="orbit-meta-label">Description</label>
            <textarea class="orbit-meta-input orbit-detail-textarea" data-page-meta="${i}" data-meta-field="description"
              placeholder="Page description for search engines and social sharing">${escapeHtml(meta.description || '')}</textarea>
            <label class="orbit-meta-label">Social image URL</label>
            <input type="text" class="orbit-meta-input" data-page-meta="${i}" data-meta-field="image"
              value="${escapeHtml(meta.image || '')}" placeholder="https://…">
          </div>

          <div class="orbit-detail-danger">
            <button type="button" class="orbit-btn-sm orbit-delete-page-btn" data-page-delete="${i}">Delete Page</button>
          </div>
        </div>
      `
    }

    body.innerHTML = `
      <div class="orbit-pages-split">
        <div class="orbit-pages-list-wrap">
          ${permBanner}
          <div class="orbit-pages-list">
            ${listItems}
          </div>
          <div class="orbit-pages-list-footer">
            <button type="button" class="orbit-btn orbit-btn-secondary orbit-new-page-btn" id="orbit-add-page">+ New page</button>
          </div>
        </div>
        <div class="orbit-pages-detail-wrap">
          ${detailHtml}
        </div>
      </div>
    `

    // ── Page list click: select + preview ──────────────────────────────────
    body.querySelectorAll('[data-page-select]').forEach((item) => {
      const activate = async () => {
        if (!confirmDiscardChanges()) return
        const idx = parseInt(item.getAttribute('data-page-select'), 10)
        state.activePageIndex = idx
        const pg = proj.pages[idx]
        if (pg) state.currentFilePath = `${draftBasePath()}/${pg.html_file}`
        state.rightMode = 'preview'
        await render()
        scrollToRightPanelIfNeeded()
      }
      item.addEventListener('click', activate)
      item.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate() } })
    })

    // ── Preview action (page name + Preview button) ────────────────────────
    body.querySelectorAll('[data-page-preview]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirmDiscardChanges()) return
        const idx = parseInt(btn.getAttribute('data-page-preview'), 10)
        state.activePageIndex = idx
        const pg = proj.pages[idx]
        if (pg) state.currentFilePath = `${draftBasePath()}/${pg.html_file}`
        state.rightMode = 'preview'
        await render()
        scrollToRightPanelIfNeeded()
      })
    })

    // ── Publish actions ────────────────────────────────────────────────────
    body.querySelectorAll('[data-page-publish]').forEach((btn) => {
      btn.addEventListener('click', () => runPublishPage(parseInt(btn.getAttribute('data-page-publish'), 10)))
    })
    body.querySelectorAll('[data-page-republish]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const idx = parseInt(btn.getAttribute('data-page-republish'), 10)
        await runUnpublishPage(idx, { skipUiRefresh: true })
        await runPublishPage(idx)
      })
    })
    body.querySelectorAll('[data-page-unpublish]').forEach((btn) => {
      btn.addEventListener('click', () => runUnpublishPage(parseInt(btn.getAttribute('data-page-unpublish'), 10)))
    })

    // ── Open draft in new tab ──────────────────────────────────────────────
    body.querySelectorAll('[data-page-open-draft]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const idx = parseInt(btn.getAttribute('data-page-open-draft'), 10)
        const pg = state.currentProject?.pages?.[idx]
        if (!pg) return
        try {
          const rawHtml = await fetchText(`${draftBasePath()}/${pg.html_file}`)
          const fullHtml = buildFullDraftHtml(rawHtml, pg)
          const blob = new Blob([fullHtml], { type: 'text/html' })
          const url = URL.createObjectURL(blob)
          window.open(url, '_blank')
        } catch (e) {
          console.warn('Could not open draft', e)
          window.open(buildDraftBaseUrl() + pg.html_file, '_blank')
        }
      })
    })

    // ── Resource links ─────────────────────────────────────────────────────
    body.querySelectorAll('.orbit-res-link').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const relPath = btn.getAttribute('data-res-open')
        if (!relPath) return
        if (!confirmDiscardChanges()) return
        state.rightMode = 'editor'
        state.currentFilePath = `${draftBasePath()}/${relPath}`
        await render()
        scrollToRightPanelIfNeeded()
      })
    })
    body.querySelectorAll('.orbit-res-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-page'), 10)
        const res = btn.getAttribute('data-res')
        const type = btn.getAttribute('data-res-type')
        removeResourceFromPage(idx, res, type)
      })
    })
    // Main html page: clicking "change" reveals a dropdown to swap the
    // backing file. The previous html file is left on disk (the user can
    // still open it via the Files tab and assign it to another page).
    body.querySelectorAll('.orbit-res-html-change').forEach((btn) => {
      btn.addEventListener('click', () => {
        const row = btn.closest('.orbit-res-html')
        if (!row) return
        const sel = row.querySelector('.orbit-res-html-select')
        const link = row.querySelector('.orbit-res-link')
        if (!sel) return
        sel.classList.remove('orbit-hidden')
        btn.classList.add('orbit-hidden')
        if (link) link.classList.add('orbit-hidden')
        sel.focus()
      })
    })
    body.querySelectorAll('.orbit-res-html-select').forEach((sel) => {
      const restore = () => {
        const row = sel.closest('.orbit-res-html')
        if (!row) return
        sel.classList.add('orbit-hidden')
        row.querySelector('.orbit-res-html-change')?.classList.remove('orbit-hidden')
        row.querySelector('.orbit-res-link')?.classList.remove('orbit-hidden')
        sel.value = ''
      }
      sel.addEventListener('change', async () => {
        const idx = parseInt(sel.getAttribute('data-page-html'), 10)
        const page = proj.pages?.[idx]
        if (!page) { restore(); return }
        const newHtml = sel.value
        if (!newHtml || newHtml === page.html_file) { restore(); return }
        if (!confirmDiscardChanges()) { restore(); return }
        page.html_file = newHtml
        await persistProjectPages(proj)
        if (idx === state.activePageIndex) {
          state.currentFilePath = `${draftBasePath()}/${newHtml}`
        }
        await render()
      })
      sel.addEventListener('blur', () => {
        if (!sel.value) restore()
      })
    })
    body.querySelectorAll('.orbit-res-add').forEach((sel) => {
      sel.addEventListener('change', async () => {
        const idx = parseInt(sel.getAttribute('data-page-add-res'), 10)
        const val = sel.value
        if (!val) return
        sel.value = ''
        if (val.startsWith('existing:')) {
          const filePath = val.slice(9)
          const type = filePath.endsWith('.css') ? 'css' : 'js'
          await addResourceToPage(idx, filePath, type)
        } else if (
          val === '__new_css__' || val === '__new_shared_css__' ||
          val === '__new_js__' || val === '__new_shared_js__'
        ) {
          const picked = (val === '__new_css__' || val === '__new_shared_css__') ? 'css' : 'js'
          const shared = (val === '__new_shared_css__' || val === '__new_shared_js__')
          const raw = window.prompt(picked === 'css' ? 'CSS filename (e.g. styles.css):' : 'JS filename (e.g. app.js):')
          const trimmed = raw && raw.trim()
          if (!trimmed) return
          // If the user typed an explicit .css or .js extension, honour it
          // (they may have picked "New JS" but typed "styles.css" — let it
          // become a CSS file rather than producing "styles.css.js").
          const hasCss = trimmed.toLowerCase().endsWith('.css')
          const hasJs = trimmed.toLowerCase().endsWith('.js')
          const type = hasCss ? 'css' : hasJs ? 'js' : picked
          const name = (hasCss || hasJs) ? trimmed : `${trimmed}.${type}`
          const path = shared ? `shared/${name}` : name
          const stub = type === 'css' ? `/* ${name} */\n` : `// ${name}\n`
          const mime = type === 'css' ? 'text/css' : 'text/javascript'
          await uploadText(`${draftBasePath()}/${path}`, stub, mime)
          await addResourceToPage(idx, path, type)
          await refreshFileList()
        }
      })
    })

    // ── URL & meta ─────────────────────────────────────────────────────────
    body.querySelectorAll('.orbit-page-url-input').forEach((input) => {
      input.addEventListener('change', async () => {
        const idx = parseInt(input.getAttribute('data-page-url'), 10)
        const page = proj.pages?.[idx]
        if (!page) return
        page.custom_public_id = input.value.trim() || null
        await persistProjectPages(proj)
      })
    })
    body.querySelectorAll('[data-page-meta]').forEach((el) => {
      el.addEventListener('change', async () => {
        const idx = parseInt(el.getAttribute('data-page-meta'), 10)
        const field = el.getAttribute('data-meta-field')
        const page = proj.pages?.[idx]
        if (!page || !field) return
        if (!page.meta) page.meta = {}
        page.meta[field] = el.value.trim() || null
        await persistProjectPages(proj)
      })
    })

    // ── Delete page ────────────────────────────────────────────────────────
    // If the page is currently published, we must unpublish it first so the
    // live URL is taken down before we forget about the page in the project
    // record (otherwise the published files become orphaned and there's no
    // UI affordance left to retract them).
    body.querySelectorAll('[data-page-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const idx = parseInt(btn.getAttribute('data-page-delete'), 10)
        const page = proj.pages?.[idx]
        if (!page) return
        const files = [page.html_file, ...(page.css_files || []), ...(page.js_files || [])].filter(Boolean)
        const fileList = files.map((f) => `  • ${f}`).join('\n')
        const wasPublished = !!page.published
        const unpublishNote = wasPublished
          ? '\n\nThis page is currently published — it will be unpublished first.'
          : ''
        const msg = `Delete page "${page.name}" from the project?${unpublishNote}\n\nThis removes it from the page list but does NOT delete its draft files. Please delete these manually afterwards:\n\n${fileList}`
        if (!window.confirm(msg)) return
        if (wasPublished) {
          await runUnpublishPage(idx, { skipUiRefresh: true })
          // runUnpublishPage may have failed (e.g. permission denied); bail
          // out rather than orphan the published files.
          if (proj.pages?.[idx]?.published) {
            window.alert('Could not unpublish the page; deletion aborted.')
            await refreshPagesPanel()
            return
          }
        }
        proj.pages.splice(idx, 1)
        if (state.activePageIndex >= proj.pages.length) {
          state.activePageIndex = Math.max(0, proj.pages.length - 1)
        }
        await persistProjectPages(proj)
        await renderLeftPanel(opts)
      })
    })

    // ── Add page / fix legacy ──────────────────────────────────────────────
    document.getElementById('orbit-add-page')?.addEventListener('click', async () => {
      if (!confirmDiscardChanges()) return
      const name = window.prompt('Page name (e.g. about):')
      if (!name || !/^[-a-z0-9_]+$/i.test(name)) return
      if (proj.pages.some((p) => p.name === name)) {
        window.alert('A page with that name already exists.')
        return
      }
      const htmlFile = `${name}.html`
      // If a file with this name already exists in the draft folder, reuse
      // it as-is. Previously we always uploadText()'d a blank stub, which
      // silently overwrote any pre-existing page (e.g. one the user
      // uploaded via the Files tab and was about to register here).
      const htmlAlreadyExists = state.fileList.includes(`${draftBasePath()}/${htmlFile}`)
      if (!htmlAlreadyExists) {
        await uploadText(`${draftBasePath()}/${htmlFile}`, `<h1>${name}</h1>\n`, 'text/html')
      }
      proj.pages.push({ name, html_file: htmlFile, css_files: [], js_files: [], published: false, public_url: null })
      await persistProjectPages(proj)
      await refreshFileList()
      state.activePageIndex = proj.pages.length - 1
      state.currentFilePath = `${draftBasePath()}/${htmlFile}`
      state.rightMode = 'preview'
      await render()
    })
    // document.getElementById('orbit-fix-legacy')?.addEventListener('click', () => {
    //   if (!confirmDiscardChanges()) return
    //   fixLegacyProject()
    // })
    document.getElementById('orbit-perm-recheck')?.addEventListener('click', async () => {
      await reloadPermissions()
      await refreshPagesPanel()
    })
  } else {
    const base = draftBasePath()
    const tree = buildFileTree(state.fileList, base)
    const allFolders = collectFolderPaths(tree, '')
    const truncHint = state.fileListIncomplete
      ? `<p class="orbit-muted orbit-files-trunc">List may be incomplete (${state.fileListFileCount} files, limit ${state.fileListMaxFiles}; depth limit ${state.fileListMaxDepth}).</p>`
      : ''

    if (state.expandedFolder !== null) {
      const folderFiles = getFilesInFolder(tree, state.expandedFolder)
      const folderLabel = state.expandedFolder || 'Project Folder'
      const moveTargets = allFolders.filter((f) => f !== state.expandedFolder)

      const renderFileRow = (f) => {
        const isPub = !!state.publishedFiles[f.fullPath]
        const pubBadge = isPub
          ? `<span class="orbit-file-pub-badge" title="File is publicly shared">✓</span>`
          : ''
        const unpubBtn = isPub
          ? `<button type="button" class="orbit-btn-icon orbit-btn-unpub" data-unpublish="${escapeHtml(f.rel)}" title="Unpublish this file">↓</button>`
          : ''
        return `
          <li class="orbit-file-row" data-file-rel="${escapeHtml(f.rel)}">
            <button type="button" class="orbit-link orbit-file-open" data-file="${escapeHtml(f.fullPath)}">${escapeHtml(f.name)}</button>
            ${pubBadge}
            <span class="orbit-file-actions">
              ${unpubBtn}
              <button type="button" class="orbit-btn-icon" data-rename="${escapeHtml(f.rel)}" title="Rename">&#9998;</button>
              <button type="button" class="orbit-btn-icon orbit-btn-danger" data-delete="${escapeHtml(f.rel)}" title="Delete">&times;</button>
              <select class="orbit-move-select" data-move="${escapeHtml(f.rel)}">
                <option value="">Move…</option>
                ${moveTargets.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t || '(root)')}</option>`).join('')}
              </select>
            </span>
          </li>`
      }

      body.innerHTML = `
        <div class="orbit-folder-header">
          <button type="button" class="orbit-link orbit-back-btn" id="orbit-folder-back">&larr; Back</button>
          <span class="orbit-folder-name">${escapeHtml(folderLabel)}</span>
        </div>
        <ul class="orbit-files orbit-folder-files">
          ${folderFiles.length
            ? folderFiles.map(renderFileRow).join('')
            : '<li class="orbit-muted">Empty folder.</li>'
          }
        </ul>
        ${truncHint}
        <div class="orbit-upload-section">
          <label class="orbit-upload-label" id="orbit-upload-drop">
            <input type="file" multiple id="orbit-upload-input" class="orbit-upload-input" />
            <span class="orbit-upload-text">Drop files here or click to upload</span>
          </label>
          <div id="orbit-upload-status" class="orbit-upload-status"></div>
          <button type="button" class="orbit-btn orbit-btn-secondary orbit-btn-sm" id="orbit-create-folder" style="margin-top:0.5rem;width:100%">+ New folder</button>
        </div>
      `

      document.getElementById('orbit-folder-back')?.addEventListener('click', async () => {
        state.expandedFolder = null
        await renderLeftPanel(opts)
      })

      // Unpublish individual file
      body.querySelectorAll('[data-unpublish]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const rel = btn.getAttribute('data-unpublish')
          const proj = state.currentProject
          if (!proj) return
          if (!window.confirm(`Unpublish "${rel}"? The file will remain in your draft but will no longer be publicly accessible.`)) return
          const publicFull = `projects/${proj.name}/public/${rel}`
          const draftFull = `${base}/${rel}`
          const result = await unpublishSingleFile(publicFull)
          if (result.success) {
            state.publishedFiles[draftFull] = false
            await renderLeftPanel(opts)
          } else {
            window.alert('Unpublish failed: ' + (result.error || 'unknown error'))
          }
        })
      })

      body.querySelectorAll('.orbit-file-open').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const fp = btn.getAttribute('data-file')
          if (!confirmDiscardChanges()) return
          state.currentFilePath = fp
          state.rightMode = isTextEditablePath(fp) ? 'editor' : 'image'
          await render()
          scrollToRightPanelIfNeeded()
        })
      })

      body.querySelectorAll('[data-rename]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const rel = btn.getAttribute('data-rename')
          const row = body.querySelector(`[data-file-rel="${CSS.escape(rel)}"]`)
          if (!row) return
          const openBtn = row.querySelector('.orbit-file-open')
          if (!openBtn) return
          const oldName = rel.split('/').pop()
          openBtn.outerHTML = `<input type="text" class="orbit-rename-input" data-rename-input="${escapeHtml(rel)}" value="${escapeHtml(oldName)}" /><button type="button" class="orbit-btn-icon orbit-btn-save" data-rename-save="${escapeHtml(rel)}" title="Save">&#10003;</button>`
          const inp = row.querySelector('.orbit-rename-input')
          inp?.focus()
          inp?.select()
          row.querySelector('[data-rename-save]')?.addEventListener('click', async () => {
            const newName = inp.value.trim()
            if (!newName || newName === oldName) return
            const oldRel = rel
            const parts = oldRel.split('/')
            parts[parts.length - 1] = newName
            const newRel = parts.join('/')
            const oldFull = `${base}/${oldRel}`
            const newFull = `${base}/${newRel}`
            try {
              await renameFileOnServer(oldFull, newFull)
              const proj = state.currentProject
              if (proj && updateProjectFileReferences(proj, oldRel, newRel)) {
                await persistProjectPages(proj)
              }
              await refreshFileList()
              await renderLeftPanel(opts)
            } catch (e) {
              console.error('Rename failed', e)
              window.alert(e.message || 'Rename failed')
            }
          })
        })
      })

      body.querySelectorAll('[data-delete]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const rel = btn.getAttribute('data-delete')
          const fullDraft = `${base}/${rel}`
          const isPub = !!state.publishedFiles[fullDraft]
          const confirmMsg = isPub
            ? `"${rel}" is currently published. Unpublish and delete?`
            : `Delete "${rel}"?`
          if (!window.confirm(confirmMsg)) return
          try {
            await deleteFileWithUnpublish(fullDraft)
            const proj = state.currentProject
            if (proj && removeFileFromProjectReferences(proj, rel)) {
              await persistProjectPages(proj)
            }
            await refreshFileList()
            if (state.currentFilePath === fullDraft) {
              state.currentFilePath = null
              state.rightMode = 'preview'
              await render()
            } else {
              state.publishedFiles[fullDraft] = false
              await renderLeftPanel(opts)
            }
          } catch (e) {
            console.error('Delete failed', e)
            window.alert(e.message || 'Delete failed')
          }
        })
      })

      body.querySelectorAll('[data-move]').forEach((sel) => {
        sel.addEventListener('change', async () => {
          const rel = sel.getAttribute('data-move')
          const targetFolder = sel.value
          if (targetFolder === '') return
          const fileName = rel.split('/').pop()
          const newRel = targetFolder ? `${targetFolder}/${fileName}` : fileName
          if (newRel === rel) return
          try {
            await renameFileOnServer(`${base}/${rel}`, `${base}/${newRel}`)
            const proj = state.currentProject
            if (proj && updateProjectFileReferences(proj, rel, newRel)) {
              await persistProjectPages(proj)
            }
            await refreshFileList()
            await renderLeftPanel(opts)
          } catch (e) {
            console.error('Move failed', e)
            window.alert(e.message || 'Move failed')
          }
        })
      })
    } else {
      const renderTreeNode = (node, prefix, depth) => {
        let html = ''
        const sortedFolders = Object.keys(node.children).sort()
        for (const name of sortedFolders) {
          const folderPath = prefix ? `${prefix}/${name}` : name
          const isCollapsed = state.collapsedFolders.has(folderPath)
          const toggleIcon = isCollapsed ? '&#9654;' : '&#9660;'
          const pl = (depth * 1.2) + 'rem'
          html += `<li class="orbit-tree-folder">
            <div class="orbit-tree-folder-row" style="padding-left:${pl}">
              <button type="button" class="orbit-link orbit-tree-toggle" data-toggle-folder="${escapeHtml(folderPath)}">${toggleIcon}</button>
              <button type="button" class="orbit-link orbit-tree-folder-btn" data-folder="${escapeHtml(folderPath)}">&#128193; ${escapeHtml(name)}/</button>
            </div>
            ${!isCollapsed ? `<ul class="orbit-tree">${renderTreeNode(node.children[name], folderPath, depth + 1)}</ul>` : ''}
          </li>`
        }
        for (const f of node.files) {
          const icon = isImagePath(f.name) ? '&#128248;' : '&#128196;'
          const pl = `calc(${depth * 1.2}rem + 0.9rem)`
          const isPub = !!state.publishedFiles[f.fullPath]
          const pubDot = isPub ? ` <span class="orbit-tree-pub-dot" title="Published">●</span>` : ''
          html += `<li class="orbit-tree-file" style="padding-left:${pl}">
            <button type="button" class="orbit-link" data-file="${escapeHtml(f.fullPath)}">${icon} ${escapeHtml(f.name)}</button>${pubDot}
          </li>`
        }
        return html
      }

      body.innerHTML = `
        <ul class="orbit-files orbit-tree">
          <li class="orbit-tree-root">
            <button type="button" class="orbit-link orbit-tree-folder-btn" data-folder="">&#128193; Project Folder</button>
          </li>
          ${renderTreeNode(tree, '', 0)}
        </ul>
        ${truncHint}
        <div class="orbit-upload-section">
          <label class="orbit-upload-label" id="orbit-upload-drop">
            <input type="file" multiple id="orbit-upload-input" class="orbit-upload-input" />
            <span class="orbit-upload-text">Drop files here or click to upload</span>
          </label>
          <div id="orbit-upload-status" class="orbit-upload-status"></div>
          <button type="button" class="orbit-btn orbit-btn-secondary orbit-btn-sm" id="orbit-create-folder" style="margin-top:0.5rem;width:100%">+ New folder</button>
        </div>
      `

      body.querySelectorAll('[data-toggle-folder]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const fp = btn.getAttribute('data-toggle-folder')
          if (state.collapsedFolders.has(fp)) {
            state.collapsedFolders.delete(fp)
          } else {
            state.collapsedFolders.add(fp)
          }
          await renderLeftPanel(opts)
        })
      })

      body.querySelectorAll('[data-folder]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          state.expandedFolder = btn.getAttribute('data-folder')
          await renderLeftPanel(opts)
        })
      })

      body.querySelectorAll('[data-file]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const fp = btn.getAttribute('data-file')
          if (!confirmDiscardChanges()) return
          state.currentFilePath = fp
          state.rightMode = isTextEditablePath(fp) ? 'editor' : 'image'
          await render()
          scrollToRightPanelIfNeeded()
        })
      })
    }

    document.getElementById('orbit-create-folder')?.addEventListener('click', async () => {
      const raw = window.prompt('New folder name (letters, numbers, hyphens, underscores):')
      if (!raw) return
      const folderName = raw.trim().replace(/[^a-zA-Z0-9_\-]/g, '-').replace(/^-+|-+$/g, '')
      if (!folderName) { window.alert('Invalid folder name.'); return }
      const parentFolder = state.expandedFolder
        ? `${base}/${state.expandedFolder}`
        : base
      const placeholderPath = `${parentFolder}/${folderName}/.gitkeep`
      try {
        await uploadText(placeholderPath, '', 'text/plain')
        await refreshFileList()
        await renderLeftPanel(opts)
      } catch (e) {
        window.alert('Could not create folder: ' + (e.message || String(e)))
      }
    })

    const dropZone = document.getElementById('orbit-upload-drop')
    const fileInput = document.getElementById('orbit-upload-input')
    const statusEl = document.getElementById('orbit-upload-status')
    if (dropZone && fileInput && statusEl) {
      const handleFiles = async (files) => {
        if (!files.length || !state.currentProject) return
        statusEl.textContent = `Uploading ${files.length} file${files.length > 1 ? 's' : ''}…`
        let ok = 0
        let fail = 0
        for (const f of files) {
          try {
            const uploadFolder = state.expandedFolder
              ? `${base}/${state.expandedFolder}`
              : base
            await freezr.upload(f, { targetFolder: uploadFolder, overwrite: true })
            ok++
          } catch (e) {
            console.warn('Upload failed:', f.name, e)
            fail++
          }
        }
        statusEl.textContent = `Uploaded ${ok} file${ok !== 1 ? 's' : ''}` + (fail ? `, ${fail} failed` : '')
        await refreshFileList()
        await renderLeftPanel(opts)
      }
      fileInput.addEventListener('change', (e) => handleFiles([...e.target.files]))
      dropZone.addEventListener('dragover', (e) => {
        e.preventDefault()
        dropZone.classList.add('orbit-upload-dragover')
      })
      dropZone.addEventListener('dragleave', () => dropZone.classList.remove('orbit-upload-dragover'))
      dropZone.addEventListener('drop', (e) => {
        e.preventDefault()
        dropZone.classList.remove('orbit-upload-dragover')
        handleFiles([...e.dataTransfer.files])
      })
    }
  }
}

function escapeHtml(s) {
  const d = document.createElement('div')
  d.textContent = s
  return d.innerHTML
}

/**
 * Make a <textarea> grow vertically as the user types, up to `maxRows` rows.
 * We measure the line-height from the element itself so the math stays
 * accurate if the font size changes.
 */
function bindAutoGrowTextarea(el, { maxRows = 10 } = {}) {
  if (!el) return
  const resize = () => {
    // Reset first so shrinking also works when content is deleted.
    el.style.height = 'auto'
    const cs = window.getComputedStyle(el)
    const lineHeight = parseFloat(cs.lineHeight) || 18
    const padTop = parseFloat(cs.paddingTop) || 0
    const padBot = parseFloat(cs.paddingBottom) || 0
    const borderTop = parseFloat(cs.borderTopWidth) || 0
    const borderBot = parseFloat(cs.borderBottomWidth) || 0
    const maxPx = Math.round(lineHeight * maxRows + padTop + padBot + borderTop + borderBot)
    const target = Math.min(el.scrollHeight, maxPx)
    el.style.height = target + 'px'
    // Once content exceeds the cap, let the textarea scroll internally.
    el.style.overflowY = el.scrollHeight > maxPx ? 'auto' : 'hidden'
  }
  el.addEventListener('input', resize)
  // Run once to size correctly on initial mount (e.g. after a re-render that
  // preserved existing draft text in the Reply box).
  resize()
}

async function gatherPageFileContents(page) {
  if (!page) return []
  const rels = [page.html_file, ...(page.css_files || []), ...(page.js_files || [])]
  const results = []
  for (const rel of rels) {
    if (!rel) continue
    try {
      const content = await fetchText(`${draftBasePath()}/${rel}`)
      results.push({ path: rel, content })
    } catch (e) {
      console.warn('Orbit chat: could not load', rel, e)
    }
  }
  const loadedPaths = new Set(rels)
  const sharedFiles = state.fileList
    .map((f) => f.replace(`${draftBasePath()}/`, ''))
    .filter((f) => f.startsWith('shared/') && !loadedPaths.has(f))
  for (const rel of sharedFiles) {
    try {
      const content = await fetchText(`${draftBasePath()}/${rel}`)
      results.push({ path: rel, content })
    } catch (e) {
      console.warn('Orbit chat: could not load shared file', rel, e)
    }
  }
  return results
}

function updateStreamingUI() {
  const thinkEl = document.getElementById('orbit-stream-thinking')
  const thinkWrap = document.getElementById('orbit-stream-thinking-wrap')
  const contentEl = document.getElementById('orbit-stream-content')
  const filesEl = document.getElementById('orbit-stream-files')

  if (thinkEl && state.chatStreamingThinking) {
    thinkEl.textContent = state.chatStreamingThinking
    if (thinkWrap) thinkWrap.hidden = false
  }
  if (contentEl && state.chatStreaming) {
    contentEl.textContent = state.chatStreaming
  }
  updateLockOverlay()
  if (filesEl && state.chatStreamingFiles) {
    filesEl.innerHTML = state.chatStreamingFiles
      .map((f) => {
        const iconCls = f.error ? 'orbit-file-icon--error' : f.done ? '' : 'orbit-file-icon--pending'
        const icon = f.error ? '✗' : f.done ? '✓' : ''
        const spinner = (f.done || f.error) ? '' : '<span class="orbit-spinner-inline"></span>'
        const label = f.isImage ? '🖼 ' : ''
        const snippetHtml = f.snippet
          ? `<span class="orbit-file-snippet">${escapeHtml(f.snippet)}</span>`
          : ''
        return `<div class="orbit-file-item">${spinner}<span class="orbit-file-icon ${iconCls}">${icon}</span><span class="orbit-file-name">${label}${escapeHtml(f.path)}</span>${snippetHtml}</div>`
      })
      .join('')
  }
  const log = document.getElementById('orbit-chat-log')
  if (log) {
    const nearBottom = (log.scrollHeight - log.scrollTop - log.clientHeight) < 80
    if (nearBottom) log.scrollTop = log.scrollHeight
  }
}

async function handleChatSend(canLlm, forceNewThread = false) {
  if (!canLlm || state.chatBusy || !state.currentProject) return
  const inputId = forceNewThread ? 'orbit-chat-input' : 'orbit-reply-input'
  let input = document.getElementById(inputId)
  if (!input || !(input.value || '').trim()) {
    input = document.getElementById('orbit-chat-input')
  }
  const text = (input?.value || '').trim()
  if (!text) return

  if (forceNewThread || !state.activeThreadId) {
    startNewThread(state.activePageIndex)
  }
  const threadId = state.activeThreadId
  const thread = getActiveThread()

  // Resolve the page that this thread is *about* — stable across replies
  // even if the user has navigated to a different page since the thread started.
  const threadPageIndex = thread.pageIndex != null ? thread.pageIndex : state.activePageIndex
  const threadPage = state.currentProject?.pages?.[threadPageIndex] || getActivePage()

  state.chatBusy = true
  state.chatLockedFiles = new Set()

  // Pre-lock all files belonging to the thread's page (not the currently viewed one)
  const _lockPage = threadPage
  if (_lockPage && state.currentProject) {
    const _base = draftBasePath()
    for (const rel of [_lockPage.html_file, ...(_lockPage.css_files || []), ...(_lockPage.js_files || [])]) {
      if (rel) state.chatLockedFiles.add(`${_base}/${rel}`)
    }
  }
  updateLockOverlay()

  const userTs = Date.now()
  const userMsg = { role: 'user', content: text, timestamp: userTs }
  thread.messages.push(userMsg)
  if (input) {
    input.value = ''
    input.style.height = ''
    input.style.overflowY = 'hidden'
    input.dispatchEvent(new Event('input'))
  }
  await appendChatHistory(threadId, 'user', text)

  state.chatStreaming = null
  state.chatStreamingThinking = null
  state.chatStreamingFiles = null
  await render()

  let streamedText = ''
  let streamedThinking = ''

  const pushStreamRender = () => {
    const parsed = extractStreamDisplay(streamedText)
    state.chatStreaming = parsed.displayText || null
    state.chatStreamingThinking = streamedThinking || null
    state.chatStreamingFiles = parsed.files.length > 0 ? parsed.files : null
    updateStreamingUI()
  }

  const MAX_HISTORY_PAIRS = 5
  const chatHistory = []
  if (!forceNewThread && thread.messages.length > 1) {
    const older = thread.messages.slice(0, -1)
    let pairCount = 0
    for (let i = older.length - 1; i >= 0 && pairCount < MAX_HISTORY_PAIRS; i--) {
      chatHistory.unshift({ role: older[i].role, content: older[i].content })
      if (older[i].role === 'user') pairCount++
    }
  }

  try {
    // Always gather files for the thread's original page, not the current view.
    const page = threadPage
    const fileContents = await gatherPageFileContents(page)
    const projectFileList = state.fileList.map((f) => f.replace(`${draftBasePath()}/`, ''))

    const out = await sendOrbitChatMessage({
      userMessage: text,
      chatHistory,
      project: state.currentProject,
      page,
      fileContents,
      projectFileList,
      uploadText,
      uploadFile,
      fetchDraftFile: (rel) => {
        // Lock this additionally-fetched file for the duration of the request
        const full = `${draftBasePath()}/${rel}`
        if (!state.chatLockedFiles.has(full)) {
          state.chatLockedFiles.add(full)
          updateLockOverlay()
        }
        return fetchText(full)
      },
      onDelta: (chunk) => {
        streamedText += chunk
        pushStreamRender()
      },
      onThinking: (chunk) => {
        streamedThinking += chunk
        pushStreamRender()
      },
      onImageStatus: ({ path, status }) => {
        if (!state.chatStreamingFiles) state.chatStreamingFiles = []
        const existing = state.chatStreamingFiles.find((f) => f.path === path)
        if (existing) {
          existing.done = status === 'done'
          existing.error = status === 'error'
        } else {
          state.chatStreamingFiles.push({
            path,
            done: status === 'done',
            error: status === 'error',
            isImage: true
          })
        }
        updateStreamingUI()
      }
    })

    let pagesChanged = false
    const proj = state.currentProject

    if (out.newResources?.length) {
      const existingHtmlFiles = new Set((proj.pages || []).map((p) => p.html_file))
      const newPages = []

      for (const res of out.newResources) {
        if (res.type === 'html' && !existingHtmlFiles.has(res.path)) {
          const pageName = res.path.replace(/\.html?$/i, '').replace(/\//g, '-')
          const newPage = {
            name: pageName,
            html_file: res.path,
            css_files: [],
            js_files: [],
            published: false,
            public_url: null
          }
          proj.pages.push(newPage)
          existingHtmlFiles.add(res.path)
          newPages.push(newPage)
          pagesChanged = true
        }
      }

      const targetPage = newPages.length === 1 ? newPages[0] : (page || newPages[0])

      if (targetPage) {
        for (const res of out.newResources) {
          if (res.type === 'css') {
            if (!targetPage.css_files) targetPage.css_files = []
            if (!targetPage.css_files.includes(res.path)) {
              targetPage.css_files.push(res.path)
              pagesChanged = true
            }
          } else if (res.type === 'js') {
            if (!targetPage.js_files) targetPage.js_files = []
            if (!targetPage.js_files.includes(res.path)) {
              targetPage.js_files.push(res.path)
              pagesChanged = true
            }
          }
        }
      }

      if (newPages.length === 1) {
        state.activePageIndex = proj.pages.length - 1
      }
    }

    if (out.metaUpdate && page) {
      if (!page.meta) page.meta = {}
      for (const [k, v] of Object.entries(out.metaUpdate)) {
        if (v !== undefined) page.meta[k] = v
      }
      pagesChanged = true
    }

    if (pagesChanged) {
      await persistProjectPages(state.currentProject)
    }

    const fileSnippets = {}
    for (const f of out.parsed?.files || []) {
      const rel = (f.path || '').replace(/^\/+/, '')
      if (rel && f.content) {
        const lines = f.content.split('\n')
        fileSnippets[rel] = lines.slice(0, 2).join('\n')
      }
    }

    state.chatStreamingFiles = (out.filesChanged || []).map((f) => ({
      path: f, done: false, snippet: fileSnippets[f] || null
    }))
    updateStreamingUI()
    await new Promise((r) => setTimeout(r, 400))
    state.chatStreamingFiles = (out.filesChanged || []).map((f) => ({
      path: f, done: true, snippet: fileSnippets[f] || null
    }))
    updateStreamingUI()

    let assistantText = out.explanation
    if (out.parsed?.parseErrors?.length) {
      assistantText += '\n\n—\n' + out.parsed.parseErrors.map((e) => `[parse] ${e}`).join('\n')
    }
    const assistantTs = Date.now()
    thread.messages.push({
      role: 'assistant',
      content: assistantText,
      timestamp: assistantTs,
      filesChanged: out.filesChanged || [],
      thinking: streamedThinking || null,
      fileSnippets
    })
    await appendChatHistory(threadId, 'assistant', assistantText, out.filesChanged, streamedThinking || null, fileSnippets)
    await refreshFileList()
    state.rightMode = 'preview'
    await refreshPreview()
  } catch (e) {
    const errMsg = 'Error: ' + (e.message || String(e))
    thread.messages.push({
      role: 'assistant',
      content: errMsg,
      timestamp: Date.now()
    })
  } finally {
    state.chatBusy = false
    state.chatStreaming = null
    state.chatStreamingThinking = null
    state.chatStreamingFiles = null
    state.chatLockedFiles = new Set()
    await render()
  }
}

function bindChrome() {
  const sel = document.getElementById('orbit-project-select')
  if (sel) {
    sel.addEventListener('change', async () => {
      const name = sel.value
      if (!confirmDiscardChanges()) {
        sel.value = state.currentProject?.name || ''
        return
      }
      if (name === '__new_project__') {
        sel.value = state.currentProject?.name || ''
        const slug = window.prompt('Project id (letters, numbers, hyphens):', 'my-site')
        if (!slug || !/^[-a-z0-9]+$/i.test(slug)) return
        if (state.projects.some((p) => p.name === slug)) {
          window.alert('That id already exists.')
          return
        }
        const base = `projects/${slug}/draft`
        await uploadText(`${base}/index.html`, starterIndexHtml, 'text/html')
        await uploadText(`${base}/shared/common.css`, starterCss, 'text/css')
        await freezr.create(
          'projects',
          {
            name: slug,
            display_name: slug,
            description: '',
            published: false,
            public_url: null,
            entry_page: 'index',
            pages: [
              {
                name: 'index',
                html_file: 'index.html',
                css_files: ['shared/common.css'],
                js_files: [],
                published: false,
                public_url: null
              }
            ]
          },
          {}
        )
        await loadProjects()
        state.currentProject = state.projects.find((p) => p.name === slug)
        state.activePageIndex = 0
        state.expandedFolder = null
        state.rightMode = 'preview'
        await refreshFileList()
        state.currentFilePath = `${draftBasePath()}/${getActivePage().html_file}`
        await loadChatHistoryForProject()
        await render()
        return
      }
      state.currentProject = state.projects.find((p) => p.name === name) || null
      state.activePageIndex = 0
      state.expandedFolder = null
      if (state.currentProject) {
        await refreshFileList()
        const pg = getActivePage()
        state.currentFilePath = pg ? `${draftBasePath()}/${pg.html_file}` : null
        await loadChatHistoryForProject()
      }
      state.rightMode = 'preview'
      await render()
    })
  }

  document.getElementById('orbit-save')?.addEventListener('click', async () => {
    // saveCurrentFile() updates the saved file's mtime locally and calls
    // setDirty(false), which (if pages tab is visible) re-renders only the
    // left panel so the "Re-publish" indicator updates. Nothing here touches
    // the editor DOM, so scroll + cursor position are preserved.
    await saveCurrentFile()
  })

document.querySelectorAll('[data-left-tab]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const tab = btn.getAttribute('data-left-tab')
        if (tab !== state.leftTab && !confirmDiscardChanges()) return
        state.leftTab = tab
        if (tab === 'chat') {
          state.rightMode = 'preview'
        }
        if (tab === 'files' || tab === 'pages') {
          await refreshFileList()
        }
        if (tab === 'files') {
          await loadPublishedFileStatus()
        }
        await render()
      })
    })
}

function bindSplitter() {
  const split = document.getElementById('orbit-splitter')
  const left = document.getElementById('orbit-left-panel')
  if (!split || !left) return

  split.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()

    const startX = e.clientX
    const startW = left.getBoundingClientRect().width

    const shield = document.createElement('div')
    shield.id = 'orbit-drag-shield'
    shield.setAttribute('aria-hidden', 'true')
    Object.assign(shield.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483646',
      cursor: 'col-resize',
      background: 'transparent',
      touchAction: 'none'
    })
    document.body.appendChild(shield)

    document.body.classList.add('orbit-resizing')

    const move = (ev) => {
      ev.preventDefault()
      const dx = ev.clientX - startX
      const w = Math.min(560, Math.max(200, Math.round(startW + dx)))
      state.leftPanelWidth = w
      left.style.flex = `0 0 ${w}px`
      left.style.width = `${w}px`
    }

    const end = () => {
      document.removeEventListener('pointermove', move, true)
      document.removeEventListener('pointerup', end, true)
      document.removeEventListener('pointercancel', end, true)
      shield.remove()
      document.body.classList.remove('orbit-resizing')
      try {
        localStorage.setItem(LS_KEY_LEFT_W, String(state.leftPanelWidth))
      } catch (_) {}
    }

    document.addEventListener('pointermove', move, { capture: true, passive: false })
    document.addEventListener('pointerup', end, { capture: true })
    document.addEventListener('pointercancel', end, { capture: true })
  })
}

/** Warn the user if they try to leave the tab while edits are unsaved. */
function bindBeforeUnloadGuard() {
  window.addEventListener('beforeunload', (e) => {
    if (!state.dirty) return
    e.preventDefault()
    // Chrome still requires returnValue to be set for the prompt to show.
    e.returnValue = ''
  })
}

// Cmd/Ctrl+S → save the currently-open editor file. Always preventDefault so
// the browser's "Save Page As…" dialog never fires while Orbit is loaded;
// saveCurrentFile() itself is a no-op when there's nothing to save.
function bindSaveShortcut() {
  window.addEventListener('keydown', (e) => {
    if (e.key !== 's' && e.key !== 'S') return
    if (!(e.metaKey || e.ctrlKey)) return
    if (e.altKey) return
    e.preventDefault()
    if (state.rightMode !== 'editor') return
    saveCurrentFile().catch((err) => console.error('Orbit: Cmd/Ctrl+S save failed', err))
  })
}

/**
 * Attach a debug handle on window so you can inspect or recover from a
 * stuck state from the browser console:
 *
 *   window.__orbit.state                 // the full live state object
 *   window.__orbit.reloadPermissions()   // force-refresh perm cache
 *   window.__orbit.reset()               // clear local UI state, reload from server
 *   window.__orbit.rerender()            // force a full re-render
 */
function exposeDebugHandle() {
  // eslint-disable-next-line no-underscore-dangle
  window.__orbit = {
    state,
    reloadPermissions,
    reset: resetLocalState,
    rerender: render
  }
}

export async function initOrbit() {
  // Load permissions FIRST so the very first render has accurate button states.
  // Every subsequent render uses this cache; publish/unpublish actions refresh
  // it on demand via ensurePublishPermissionFresh().
  try { await reloadPermissions() } catch (e) { console.warn('Orbit: reloadPermissions failed', e) }

  try { await loadProjects() } catch (e) { console.warn('Orbit: loadProjects failed', e) }

  // ensureDefaultProject is already wrapped internally — never throws.
  await ensureDefaultProject()

  state.currentProject = state.projects[0] || null
  state.activePageIndex = 0
  state.rightMode = 'preview'

  if (state.currentProject) {
    try {
      await refreshFileList()
      const pg = getActivePage()
      if (pg) state.currentFilePath = `${draftBasePath()}/${pg.html_file}`
      await loadChatHistoryForProject()
    } catch (e) {
      console.warn('Orbit: post-project init failed', e)
    }
  }

  bindBeforeUnloadGuard()
  bindSaveShortcut()
  exposeDebugHandle()

  // render() must always run — it is the only thing that mounts the UI.
  try {
    await render()
  } catch (e) {
    console.error('Orbit: render() failed during init', e)
    const root = document.getElementById('orbit-root')
    if (root && !root.querySelector('.orbit-body')) {
      root.innerHTML = '<p class="orbit-error">Orbit failed to render. Refresh the page or check the console.</p>'
    }
  }
}
