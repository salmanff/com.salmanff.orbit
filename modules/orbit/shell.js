/* global freezrMeta */
/** The app frame: full render, left-panel dispatch, chrome bindings and global handlers. */
import { state, draftBasePath, getActivePage, persistLeftPanelWidth } from './state.js'
import { escapeHtml, isImagePath, scrollToRightPanelIfNeeded } from './util.js'
import { setUiHooks } from './bus.js'
import { reloadPermissions } from './permissions.js'
import { loadProjects, switchToProject, dropdownProjects } from './projects.js'
import { loadChatHistoryForProject } from './chat.js'
import { refreshFileList, loadPublishedFileStatus } from './filesData.js'
import {
  openFile, saveCurrentFile, confirmDiscardChanges, destroyEditor, updateLockOverlay
} from './editor.js'
import { refreshPreview, openDraftInNewTab } from './preview.js'
import { assetUrlsForDraftPath, publishImageFile, unpublishImageFile } from './publishActions.js'
import { renderChatPanel } from './chatPanel.js'
import { renderPagesPanel } from './pagesPanel.js'
import { renderFilesPanel } from './filesPanel.js'
import { renderSlidesTab } from './slidesTab.js'
import { renderSettingsBody, bindSettingsView, closeSettingsView } from './settingsView.js'
import { setImgSrcWithRetry } from '../fileFetch.js'
import { isSlideshow, slidesOf, deckPageIndex } from '../slideshow/slideshowModel.js'

const SETTINGS_OPTION = '__settings__'

function leftPanelStyleAttr() {
  const w = state.leftPanelWidth
  return `style="flex:0 0 ${w}px;width:${w}px;min-width:200px;max-width:560px"`
}

/**
 * The project dropdown, shared by the workspace and the settings page so the control never
 * moves or changes shape between the two.
 */
function projectSelectHtml() {
  const proj = state.currentProject
  const inSettings = state.view === 'settings'
  const options = dropdownProjects()
    .map((p) => `<option value="${escapeHtml(p.name)}" ${(!inSettings && proj && p.name === proj.name) ? 'selected' : ''}>${escapeHtml(p.display_name || p.name)}</option>`)
    .join('')
  return `<select id="orbit-project-select" class="orbit-select">
    ${options}
    <option value="${SETTINGS_OPTION}" ${inSettings ? 'selected' : ''}>⚙ Settings &amp; Projects</option>
  </select>`
}

/** Re-render only the left panel (cheap: no file re-fetch, no editor re-mount). */
export async function refreshPagesPanel() {
  if (state.leftTab !== 'pages' && state.leftTab !== 'slides') return
  await renderLeftPanel({
    canLlm: state.permissions.canLlm,
    canPublish: state.permissions.canPublish
  })
}

export async function renderLeftPanel(opts = {}) {
  const { canLlm = false } = opts
  const body = document.getElementById('orbit-left-body')
  if (!body) return

  if (state.leftTab === 'chat') {
    renderChatPanel(body, { canLlm })
  } else if (state.leftTab === 'slides') {
    await renderSlidesTab(body, opts)
  } else if (state.leftTab === 'pages') {
    await renderPagesPanel(body, opts)
  } else {
    await renderFilesPanel(body, opts)
  }
}

export async function render() {
  const root = document.getElementById('orbit-root')
  if (!root) return

  // Permissions come from the cached state; loaded once in initOrbit() and refreshed
  // explicitly via reloadPermissions(). If the initial load never completed, do it now.
  if (!state.permissions.loaded) {
    await reloadPermissions()
  }

  if (state.view === 'settings') {
    root.innerHTML = renderSettingsBody(projectSelectHtml())
    bindChrome()
    bindSettingsView()
    return
  }

  const { canPublish, canLlm, canIframePreview, sessionExpired } = state.permissions
  const proj = state.currentProject
  const page = getActivePage()

  // Pre-compute (async) tokenized asset URLs for the image toolbar — the template below is
  // built synchronously.
  const assetInfo = (state.rightMode === 'image' && state.currentFilePath)
    ? await assetUrlsForDraftPath(state.currentFilePath)
    : { privateUrl: '', publicUrl: '', isPublished: false }

  const sessionBanner = sessionExpired
    ? `<div class="orbit-perm-banner orbit-session-expired-banner" role="alert">
        <strong>Session expired.</strong>
        Your login token has expired — permissions cannot be verified.
        <button type="button" class="orbit-btn-sm orbit-btn-secondary" id="orbit-session-refresh">Refresh session</button>
      </div>`
    : ''

  const previewPanelHtml = canIframePreview
    ? '<iframe id="orbit-preview-frame" class="orbit-preview-frame" title="Draft preview"></iframe>'
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
          ${projectSelectHtml()}
        </div>
        <nav class="orbit-tabs">
          <button type="button" data-left-tab="chat" class="${state.leftTab === 'chat' ? 'active' : ''}">Chat</button>
          ${isSlideshow(proj)
            ? `<button type="button" data-left-tab="slides" class="${state.leftTab === 'slides' ? 'active' : ''}">Slides</button>`
            : `<button type="button" data-left-tab="pages" class="${state.leftTab === 'pages' ? 'active' : ''}">Pages</button>`}
          <button type="button" data-left-tab="files" class="${state.leftTab === 'files' ? 'active' : ''}">Files</button>
        </nav>
        <div class="orbit-left-body" id="orbit-left-body"></div>
      </aside>
      <div class="orbit-splitter" id="orbit-splitter" role="separator" aria-orientation="vertical" aria-label="Resize side panel"></div>
      <section class="orbit-right">
        ${state.rightMode === 'editor' ? `<div class="orbit-right-toolbar">
          <span class="orbit-meta">${state.currentFilePath ? state.currentFilePath.split('/').pop() : ''}</span>
          <button type="button" id="orbit-editor-preview" class="orbit-btn orbit-btn-secondary orbit-btn-sm">Preview</button>
          <button type="button" id="orbit-save" class="orbit-btn${state.dirty ? '' : ' orbit-save-clean'}">Save</button>
        </div>` : ''}
        ${state.rightMode === 'image' ? (() => {
          const fp = state.currentFilePath
          const { privateUrl, publicUrl, isPublished } = assetInfo
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
            <div class="orbit-asset-url-hint">Private URL includes a temporary access token (expires in ~10 min). Inside your site pages, reference the file by its relative path instead.</div>
            ${isPublished ? `<div class="orbit-asset-url-row">
              <button type="button" class="orbit-btn orbit-btn-sm" data-copy-url="public">Copy public URL</button>
              <input type="text" class="orbit-asset-url-input" data-asset-url="public" readonly value="${escapeHtml(publicUrl)}" />
            </div>` : '<div class="orbit-asset-url-hint">Publish to get a public URL.</div>'}
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

  document.getElementById('orbit-session-refresh')?.addEventListener('click', async () => {
    await reloadPermissions()
    await render()
  })

  document.getElementById('orbit-open-draft-preview')?.addEventListener('click', async () => {
    const pg = getActivePage()
    if (pg) await openDraftInNewTab(pg)
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
      const name = fp.split('/').pop()
      if (isImagePath(fp)) {
        // src is set asynchronously with a fileToken; retries once with a fresh token if the
        // load fails (tokens expire after ~10 min).
        imgEl.innerHTML = `<img alt="${escapeHtml(name)}" class="orbit-image-preview-img" />`
        const imgTag = imgEl.querySelector('img')
        if (imgTag) setImgSrcWithRetry(imgTag, fp)
      } else {
        const tokUrl = assetInfo.privateUrl || ''
        imgEl.innerHTML = `<div class="orbit-asset-placeholder">
          <div class="orbit-asset-placeholder-icon">&#128196;</div>
          <div class="orbit-asset-placeholder-name">${escapeHtml(name)}</div>
          <a class="orbit-asset-placeholder-link" href="${escapeHtml(tokUrl)}" target="_blank" rel="noopener">Open in new tab ↗</a>
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

function bindChrome() {
  const sel = document.getElementById('orbit-project-select')
  if (sel) {
    sel.addEventListener('change', async () => {
      const name = sel.value
      if (!confirmDiscardChanges()) {
        sel.value = state.currentProject?.name || ''
        return
      }
      if (name === SETTINGS_OPTION) {
        state.view = 'settings'
        await render()
        return
      }
      await switchToProject(name)
    })
  }

  document.getElementById('orbit-editor-preview')?.addEventListener('click', async () => {
    if (!confirmDiscardChanges()) return
    const proj = state.currentProject
    if (isSlideshow(proj)) {
      state.activePageIndex = deckPageIndex(proj)
      const deck = getActivePage()
      if (deck) state.currentFilePath = `${draftBasePath()}/${deck.html_file}`
    }
    state.rightMode = 'preview'
    await render()
  })

  document.getElementById('orbit-save')?.addEventListener('click', async () => {
    // saveCurrentFile() updates the saved file's mtime locally and calls setDirty(false),
    // which (if the pages tab is visible) re-renders only the left panel so the
    // "Re-publish" indicator updates. Nothing here touches the editor DOM, so scroll and
    // cursor position are preserved.
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
      if (tab === 'files' || tab === 'pages' || tab === 'slides') {
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
      persistLeftPanelWidth(state.leftPanelWidth)
    }

    document.addEventListener('pointermove', move, { capture: true, passive: false })
    document.addEventListener('pointerup', end, { capture: true })
    document.addEventListener('pointercancel', end, { capture: true })
  })
}

/** Warn the user if they try to leave the tab while edits are unsaved. */
export function bindBeforeUnloadGuard() {
  window.addEventListener('beforeunload', (e) => {
    if (!state.dirty) return
    e.preventDefault()
    // Chrome still requires returnValue to be set for the prompt to show.
    e.returnValue = ''
  })
}

/**
 * Cmd/Ctrl+S saves the currently-open editor file. Always preventDefault so the browser's
 * "Save Page As…" dialog never fires while Orbit is loaded; saveCurrentFile() is itself a
 * no-op when there is nothing to save.
 */
export function bindSaveShortcut() {
  window.addEventListener('keydown', (e) => {
    if (e.key !== 's' && e.key !== 'S') return
    if (!(e.metaKey || e.ctrlKey)) return
    if (e.altKey) return
    e.preventDefault()
    if (state.rightMode !== 'editor') return
    saveCurrentFile().catch((err) => console.error('Orbit: Cmd/Ctrl+S save failed', err))
  })
}

/** Esc closes the Settings & Projects view, mirroring the explicit Close button. */
export function bindSettingsEscape() {
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    if (state.view !== 'settings') return
    if (state.transferBusy) return
    e.preventDefault()
    closeSettingsView().catch((err) => console.error('Orbit: close settings failed', err))
  })
}

/**
 * Clear in-memory UI state that could plausibly be "stuck" from a previous session or a bug
 * (dirty flags, editor refs, cached file lists, expanded folders, permissions cache), then
 * re-derive everything from the server. Exposed via window.__orbit.reset().
 */
export async function resetLocalState() {
  console.log('[Orbit] resetLocalState — clearing UI caches and reloading from server')
  destroyEditor()
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
  state.activeSlideId = slidesOf(state.currentProject)[0]?.id || null
  if (isSlideshow(state.currentProject)) {
    state.activePageIndex = deckPageIndex(state.currentProject)
    if (state.leftTab === 'pages') state.leftTab = 'slides'
  }
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
 * Debug handle on window so a stuck state can be inspected or recovered from the console:
 *   window.__orbit.state / .reloadPermissions() / .reset() / .rerender()
 */
export function exposeDebugHandle() {
  // eslint-disable-next-line no-underscore-dangle
  window.__orbit = {
    state,
    reloadPermissions,
    reset: resetLocalState,
    rerender: render
  }
}

export { updateLockOverlay, scrollToRightPanelIfNeeded }

// Register the renderer so the action modules can re-render without importing this file.
setUiHooks({ render, renderLeftPanel, refreshPagesPanel })