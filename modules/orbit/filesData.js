/* global freezr, freezrMeta */
/** Draft folder listing, publish status, and project-reference cleanup on rename/delete. */
import { state, draftBasePath } from './state.js'
import { normalizeQueryRows } from './util.js'
import { unpublishSingleFile } from '../publishService.js'

const MAX_FILES = 2000
const MAX_DEPTH = 12

// Export/import must see EVERY file, so they list independently of the Files tab's own
// (deliberately cheaper) listing. A bundle that is quietly a subset of the folder is worse
// than one that refuses to build, hence the much higher caps and the explicit `incomplete`.
const LIST_MAX_FILES = 20000
const LIST_MAX_DEPTH = 30

// Guard against a cyclic or pathological tree; far deeper than any real project.
const MAX_WALK_DEPTH = 40

function normRel(p) {
  if (!p || typeof p !== 'string') return ''
  return p.replace(/^\/+/, '').replace(/\/+$/, '')
}

function uniqueOrdered(list) {
  const seen = new Set()
  const out = []
  for (const item of list || []) {
    if (!item || seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

/**
 * Flatten whatever shape read_user_file_tree hands back into draft-relative file paths.
 *
 * This is the fix for the bug that made the Files tab, the export, the publish set and
 * checkpoints all lose the same files at once. The previous code read `result.tree` as a flat
 * array and skipped any node whose `type` was not exactly 'file' — so when the server nests a
 * folder's contents under `children`, every file in `shared/` and `slides/` vanished without a
 * word. (Publish still worked for CSS/JS only because buildPublishRelativePaths copies a page's
 * DECLARED resources before it consults the listing at all, which is what disguised the fault.)
 *
 * So: walk children when present, accept `path`/`file` as aliases for `name`, and when `type`
 * is missing infer folder-vs-file from whether the node carries children. Anything genuinely
 * ambiguous is treated as a file — over-reporting shows a stray row in the Files tab, whereas
 * under-reporting silently drops real work out of an export.
 *
 * @returns {{rel: string, mtimeMs: number|null}[]}
 */
function walkTree(nodes, prefix, out, depth) {
  if (!Array.isArray(nodes) || depth > MAX_WALK_DEPTH) return out
  for (const node of nodes) {
    if (!node) continue
    if (typeof node === 'string') {
      const rel = normRel(node)
      if (rel) out.push({ rel: prefix ? `${prefix}/${rel}` : rel, mtimeMs: null })
      continue
    }
    const rawName = node.name || node.path || node.file || ''
    const name = normRel(rawName)
    if (!name) continue
    const full = prefix ? `${prefix}/${name}` : name

    const children = Array.isArray(node.children)
      ? node.children
      : (Array.isArray(node.files) ? node.files : null)
    const isFolder = node.type === 'folder' || node.type === 'dir' || node.type === 'directory' ||
      node.isDirectory === true || (!!children && node.type !== 'file')

    if (isFolder) {
      if (children) walkTree(children, full, out, depth + 1)
      continue
    }
    out.push({ rel: full, mtimeMs: node.mtimeMs || node.mtime || null })
  }
  return out
}

/** Every file in a tree response, as draft-relative paths. Exported for reuse/testing. */
export function collectTreeFiles(tree) {
  return walkTree(Array.isArray(tree) ? tree : [], '', [], 0)
}

/**
 * The draft-relative paths the project RECORD declares: every page's html/css/js and every
 * slide's file.
 *
 * These are a second, independent source of truth, and a trustworthy one — publish resolves
 * them on every run, so a path here has demonstrably existed on disk. Unioning them into the
 * export means a future listing fault can shrink what we SEE without shrinking what we SAVE.
 */
export function declaredProjectRels(proj) {
  const out = []
  const push = (p) => { const r = normRel(p); if (r) out.push(r) }
  for (const page of proj?.pages || []) {
    if (!page) continue
    push(page.html_file)
    for (const f of page.css_files || []) push(f)
    for (const f of page.js_files || []) push(f)
  }
  for (const s of proj?.slides || []) push(s?.file)
  return uniqueOrdered(out)
}

/** Ordered union of two relative-path lists, first occurrence wins. */
export function unionRels(...lists) {
  const all = []
  for (const list of lists) for (const r of list || []) all.push(normRel(r))
  return uniqueOrdered(all.filter(Boolean)).sort()
}

/**
 * Every file in a project's draft folder, draft-relative. Used by export and by import's
 * replace mode — NOT by the Files tab.
 * @param {string} projectName
 * @returns {Promise<{rels: string[], incomplete: boolean, fileCount: number}>}
 *   incomplete is true when the listing cannot be trusted to be exhaustive; callers must
 *   then refuse to delete on the strength of it.
 */
export async function listDraftFileRels(projectName) {
  if (!projectName) return { rels: [], incomplete: false, fileCount: 0 }
  const url = '/feps/read_user_file_tree/' + encodeURIComponent(freezrMeta.appName)
  const result = await freezr.apiRequest('POST', url, {
    subPath: `projects/${projectName}/draft`,
    readSubFolders: true,
    maxFiles: LIST_MAX_FILES,
    maxDepth: LIST_MAX_DEPTH,
    includeMetadata: false
  })
  const rels = collectTreeFiles(result?.tree).map((f) => f.rel).sort()
  const fileCount = typeof result?.fileCount === 'number' ? result.fileCount : rels.length
  // fileCount > rels.length means the server counted more than we could account for — treat
  // that as truncation even when it did not say so. A false positive here only makes an import
  // refuse to delete, which is the safe direction to be wrong in.
  const incomplete = !!(result?.incomplete || result?.truncated) || fileCount > rels.length
  return { rels, incomplete, fileCount }
}

export async function refreshFileList() {
  const proj = state.currentProject
  if (!proj) { state.fileList = []; return [] }
  const base = draftBasePath()
  const url = '/feps/read_user_file_tree/' + encodeURIComponent(freezrMeta.appName)
  try {
    const result = await freezr.apiRequest('POST', url, {
      subPath: base,
      readSubFolders: true,
      maxFiles: MAX_FILES,
      maxDepth: MAX_DEPTH,
      includeMetadata: true
    })
    const files = collectTreeFiles(result?.tree)
    const out = []
    const mtimes = {}
    for (const f of files) {
      const full = `${base}/${f.rel}`
      out.push(full)
      if (f.mtimeMs) mtimes[full] = f.mtimeMs
    }
    state.fileList = out.sort()
    state.fileMtimes = mtimes
    // The UI hint stays on the server's own flags: unlike the export/import path it is not
    // gating anything destructive, so a nagging false positive costs more than it saves.
    state.fileListIncomplete = !!(result?.incomplete || result?.truncated)
    state.fileListFileCount = typeof result?.fileCount === 'number' ? result.fileCount : out.length
    state.fileListMaxFiles = MAX_FILES
    state.fileListMaxDepth = MAX_DEPTH
    return state.fileList
  } catch (e) {
    console.warn('Orbit: refreshFileList failed', e)
    state.fileList = []
    state.fileMtimes = {}
    return []
  }
}

/** Delete a draft file, unpublishing its public copy first if it was published. */
export async function deleteFileWithUnpublish(fullDraftPath) {
  const proj = state.currentProject
  if (proj) {
    const base = draftBasePath()
    if (fullDraftPath.startsWith(base + '/') && state.publishedFiles[fullDraftPath]) {
      const rel = fullDraftPath.slice(base.length + 1)
      const publicFull = `projects/${proj.name}/public/${rel}`
      try { await unpublishSingleFile(publicFull) } catch (e) { console.warn('Orbit: unpublish before delete failed', e) }
    }
  }
  await freezr.deleteFile(fullDraftPath)
  delete state.publishedFiles[fullDraftPath]
}

export function updateProjectFileReferences(proj, oldRel, newRel) {
  if (!proj) return false
  let changed = false
  for (const page of proj.pages || []) {
    if (page.html_file === oldRel) { page.html_file = newRel; changed = true }
    if (Array.isArray(page.css_files)) {
      const i = page.css_files.indexOf(oldRel)
      if (i >= 0) { page.css_files[i] = newRel; changed = true }
    }
    if (Array.isArray(page.js_files)) {
      const i = page.js_files.indexOf(oldRel)
      if (i >= 0) { page.js_files[i] = newRel; changed = true }
    }
  }
  if (Array.isArray(proj.slides)) {
    for (const s of proj.slides) {
      if (s.file === oldRel) { s.file = newRel; changed = true }
    }
  }
  return changed
}

export function removeFileFromProjectReferences(proj, rel) {
  if (!proj) return false
  let changed = false
  for (const page of proj.pages || []) {
    if (Array.isArray(page.css_files)) {
      const i = page.css_files.indexOf(rel)
      if (i >= 0) { page.css_files.splice(i, 1); changed = true }
    }
    if (Array.isArray(page.js_files)) {
      const i = page.js_files.indexOf(rel)
      if (i >= 0) { page.js_files.splice(i, 1); changed = true }
    }
  }
  return changed
}

/** Populate state.publishedFiles (keyed by DRAFT path) from the published copies' share state. */
export async function loadPublishedFileStatus() {
  const proj = state.currentProject
  if (!proj) { state.publishedFiles = {}; return }
  const base = draftBasePath()
  const rels = state.fileList
    .filter((f) => f.startsWith(base + '/'))
    .map((f) => f.slice(base.length + 1))
  if (!rels.length) { state.publishedFiles = {}; return }
  const publicBase = `projects/${proj.name}/public`
  const publicIds = rels.map((r) => `${publicBase}/${r}`)
  try {
    const rows = await freezr.query('files', { _id: { $in: publicIds } }, { count: publicIds.length })
    const list = normalizeQueryRows(rows)
    const map = {}
    for (const rec of list) {
      const acc = rec._accessibles
      const isPub = Array.isArray(acc) && acc.some((a) => a.grantee === '_public' && a.granted !== false && a.permission_name === 'publish_site')
      if (isPub) {
        const rel = rec._id.slice(publicBase.length + 1)
        map[`${base}/${rel}`] = true
      }
    }
    state.publishedFiles = map
  } catch (e) {
    console.warn('Orbit: loadPublishedFileStatus failed', e)
  }
}