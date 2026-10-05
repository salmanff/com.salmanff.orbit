/* global freezr, freezrMeta */
/** Project records: load, create, switch, persist pages, delete. */
import { state, draftBasePath, rememberProject } from './state.js'
import { normalizeQueryRows } from './util.js'
import { render, renderLeftPanel } from './bus.js'
import { uploadText } from './fileIO.js'
import { isValidProjectName } from '../projectTransfer.js'
import { slideshowStarterRecord, slideshowStarterFiles } from '../slideshow/slideshowTemplate.js'
import { isSlideshow, slidesOf, deckPageIndex } from '../slideshow/slideshowModel.js'

export async function loadProjects() {
  try {
    const rows = await freezr.query('projects', {}, { sort: { _date_modified: -1 }, count: 200 })
    state.projects = normalizeQueryRows(rows)
  } catch (e) {
    console.warn('Orbit: loadProjects failed', e)
    state.projects = []
  }
  return state.projects
}

export function dropdownProjects() {
  return state.projects
}

export async function persistProjectPages(proj) {
  if (!proj || !proj.name) return
  const fields = { pages: proj.pages }
  if (proj.type === 'slideshow') fields.slides = proj.slides || []
  try {
    await freezr.updateFields('projects', { name: proj.name }, fields)
  } catch (e) {
    console.warn('Orbit: persistProjectPages failed', e)
  }
}

async function rerenderLeftPanel() {
  await renderLeftPanel({ canLlm: state.permissions.canLlm, canPublish: state.permissions.canPublish })
}

export async function addResourceToPage(pageIndex, filePath, type) {
  const proj = state.currentProject
  const page = proj?.pages?.[pageIndex]
  if (!page) return
  const key = type === 'css' ? 'css_files' : 'js_files'
  if (!page[key]) page[key] = []
  if (!page[key].includes(filePath)) page[key].push(filePath)
  await persistProjectPages(proj)
  await rerenderLeftPanel()
}

export async function removeResourceFromPage(pageIndex, filePath, type) {
  const proj = state.currentProject
  const page = proj?.pages?.[pageIndex]
  if (!page) return
  const key = type === 'css' ? 'css_files' : 'js_files'
  if (Array.isArray(page[key])) {
    const i = page[key].indexOf(filePath)
    if (i >= 0) page[key].splice(i, 1)
  }
  await persistProjectPages(proj)
  await rerenderLeftPanel()
}

export async function switchToProject(name) {
  const proj = state.projects.find((p) => p.name === name)
  if (!proj) return
  state.currentProject = proj
  state.activePageIndex = isSlideshow(proj) ? deckPageIndex(proj) : 0
  state.activeSlideId = isSlideshow(proj) ? (slidesOf(proj)[0]?.id || null) : null
  if (isSlideshow(proj)) { if (state.leftTab === 'pages') state.leftTab = 'slides' } else if (state.leftTab === 'slides') { state.leftTab = 'pages' }
  state.currentFilePath = null
  state.rightMode = 'preview'
  state.view = 'project'
  state.fileList = []
  rememberProject(name)

  const { refreshFileList } = await import('./filesData.js')
  await refreshFileList()
  const page = proj.pages?.[state.activePageIndex]
  if (page) state.currentFilePath = `${draftBasePath()}/${page.html_file}`

  const { loadChatHistoryForProject } = await import('./chat.js')
  await loadChatHistoryForProject()

  await render()
}

export async function createProject(slug, kind = 'web') {
  if (!isValidProjectName(slug)) throw new Error('Invalid project id')
  if (kind === 'slideshow') {
    const row = slideshowStarterRecord(slug)
    await freezr.create('projects', row, {})
    for (const f of slideshowStarterFiles()) {
      await uploadText(`projects/${slug}/draft/${f.path}`, f.content, f.mime)
    }
  } else {
    const row = {
      name: slug,
      display_name: slug,
      description: '',
      type: 'web',
      published: false,
      public_url: null,
      entry_page: 'index',
      pages: [{ name: 'index', html_file: 'index.html', css_files: [], js_files: [], published: false, public_url: null }]
    }
    await freezr.create('projects', row, {})
    await uploadText(`projects/${slug}/draft/index.html`, `<h1>${slug}</h1>\n`, 'text/html')
  }
  await loadProjects()
  await switchToProject(slug)
}

export async function deleteProject(name, onProgress) {
  const warnings = []
  let deleted = 0
  if (onProgress) onProgress(`Deleting "${name}"...`)
  try {
    const url = '/feps/read_user_file_tree/' + encodeURIComponent(freezrMeta.appName)
    const result = await freezr.apiRequest('POST', url, {
      subPath: `projects/${name}`,
      readSubFolders: true,
      maxFiles: 5000,
      maxDepth: 20,
      includeMetadata: false
    })
    const tree = Array.isArray(result?.tree) ? result.tree : []
    for (const n of tree) {
      if (!n || n.type !== 'file' || !n.name) continue
      try {
        await freezr.deleteFile(`projects/${name}/${n.name}`)
        deleted++
      } catch (e) {
        warnings.push(`${n.name}: ${e.message || String(e)}`)
      }
    }
  } catch (e) {
    warnings.push('Could not list project files: ' + (e.message || String(e)))
  }
  try {
    await freezr.delete('projects', { name })
  } catch (e) {
    warnings.push('Could not delete project record: ' + (e.message || String(e)))
  }
  try {
    await freezr.delete('chat_history', { project_name: name })
  } catch (_) { /* non-fatal */ }
  return { deleted, warnings }
}

export async function ensureDefaultProject() {
  try {
    if (!state.projects.length) {
      await createProject('my-first-site', 'web')
    }
  } catch (e) {
    console.warn('Orbit: ensureDefaultProject failed', e)
  }
}