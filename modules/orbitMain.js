/* global freezr */
/**
 * Orbit entry point — start-up order only. Everything else lives in modules/orbit/*:
 * state, data access (projects / files / permissions), actions (editor, preview,
 * publishing, slides, chat) and the panels that render them.
 */
import { state, getActivePage, draftBasePath } from './orbit/state.js'
import { reloadPermissions } from './orbit/permissions.js'
import { loadProjects, ensureDefaultProject } from './orbit/projects.js'
import { refreshFileList } from './orbit/filesData.js'
import { loadChatHistoryForProject } from './orbit/chat.js'
import { refreshPreview, bindPreviewImgTokenRetry } from './orbit/preview.js'
import {
  render, bindBeforeUnloadGuard, bindSaveShortcut, bindSettingsEscape, exposeDebugHandle
} from './orbit/shell.js'
import { isSlideshow, slidesOf, deckPageIndex } from './slideshow/slideshowModel.js'

/** Call when an external chat/LLM turn finishes — refresh the draft preview. */
export async function orbitAfterChatResponse() {
  state.rightMode = 'preview'
  await refreshFileList()
  await render()
  await refreshPreview()
}

export async function initOrbit() {
  // Load permissions FIRST so the very first render has accurate button states. Every
  // subsequent render uses this cache; publish/unpublish refresh it on demand.
  try { await reloadPermissions() } catch (e) { console.warn('Orbit: reloadPermissions failed', e) }

  try { await loadProjects() } catch (e) { console.warn('Orbit: loadProjects failed', e) }

  // ensureDefaultProject is already wrapped internally — never throws.
  await ensureDefaultProject()

  state.currentProject = state.projects[0] || null
  state.activePageIndex = 0
  state.rightMode = 'preview'
  if (isSlideshow(state.currentProject)) {
    state.activePageIndex = deckPageIndex(state.currentProject)
    state.activeSlideId = slidesOf(state.currentProject)[0]?.id || null
    state.leftTab = 'slides'
  }

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
  bindSettingsEscape()
  exposeDebugHandle()
  bindPreviewImgTokenRetry()

  // Safety net: auto-append a fileToken to any <img>/<video>/<source> in the app's own DOM
  // that still points at a bare userfiles URL (covers anything rendered without going
  // through setImgSrcWithRetry / tokenizedUrl).
  try {
    if (freezr.utils && typeof freezr.utils.observeFileTokens === 'function') {
      freezr.utils.observeFileTokens()
    }
  } catch (e) { console.warn('Orbit: observeFileTokens failed', e) }

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