/* global freezr, freezrMeta */
/** Draft folder listing, publish status, and project-reference cleanup on rename/delete. */
import { state, draftBasePath } from './state.js'
import { normalizeQueryRows } from './util.js'
import { unpublishSingleFile } from '../publishService.js'

const MAX_FILES = 2000
const MAX_DEPTH = 12

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
    const tree = Array.isArray(result?.tree) ? result.tree : []
    const out = []
    const mtimes = {}
    for (const n of tree) {
      if (!n || n.type !== 'file' || !n.name) continue
      const full = `${base}/${n.name}`
      out.push(full)
      if (n.mtimeMs) mtimes[full] = n.mtimeMs
    }
    state.fileList = out.sort()
    state.fileMtimes = mtimes
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