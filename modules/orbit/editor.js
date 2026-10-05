/** CodeMirror mount, dirty flag, save, and the AI lock overlay. */
import { state } from './state.js'
import { fetchText, uploadText } from './fileIO.js'
import { createEditor } from '../editorLoader.js'
import { renderLeftPanel } from './bus.js'

let editorInstance = null

function langForPath(path) {
  if (/\.html?$/i.test(path)) return 'html'
  if (/\.css$/i.test(path)) return 'css'
  if (/\.m?js$/i.test(path)) return 'javascript'
  if (/\.json$/i.test(path)) return 'json'
  return null
}

function mimeForPath(path) {
  if (/\.html?$/i.test(path)) return 'text/html'
  if (/\.css$/i.test(path)) return 'text/css'
  if (/\.m?js$/i.test(path)) return 'text/javascript'
  if (/\.json$/i.test(path)) return 'application/json'
  return 'text/plain'
}

export function setDirty(isDirty) {
  state.dirty = isDirty
  const btn = document.getElementById('orbit-save')
  if (btn) btn.classList.toggle('orbit-save-clean', !isDirty)
  if (!isDirty && (state.leftTab === 'pages' || state.leftTab === 'slides')) {
    renderLeftPanel({ canLlm: state.permissions.canLlm, canPublish: state.permissions.canPublish })
  }
}

export function destroyEditor() {
  if (editorInstance) {
    try { editorInstance.destroy() } catch (_) {}
    editorInstance = null
  }
}

export async function openFile(fullPath) {
  state.currentFilePath = fullPath
  let text = ''
  try {
    text = await fetchText(fullPath)
  } catch (e) {
    console.warn('Orbit: could not load file for editing', fullPath, e)
  }
  state.editorText = text
  state.loadedEditorPath = fullPath
  destroyEditor()
  const mount = document.getElementById('orbit-editor-mount')
  if (!mount) return
  mount.innerHTML = ''
  try {
    editorInstance = await createEditor(mount, {
      content: text,
      language: langForPath(fullPath),
      onChange: () => setDirty(true)
    })
  } catch (e) {
    console.error('Orbit: could not mount editor', e)
    mount.innerHTML = '<p class="orbit-error">Editor failed to load.</p>'
    return
  }
  setDirty(false)
  updateLockOverlay()
}

export async function saveCurrentFile() {
  if (!editorInstance || !state.currentFilePath) return
  const content = editorInstance.getContent()
  try {
    await uploadText(state.currentFilePath, content, mimeForPath(state.currentFilePath))
    state.editorText = content
    setDirty(false)
  } catch (e) {
    console.error('Orbit: save failed', e)
    window.alert('Save failed: ' + (e.message || String(e)))
  }
}

export function confirmDiscardChanges() {
  if (!state.dirty) return true
  const ok = window.confirm('You have unsaved changes in the editor. Discard them?')
  if (ok) state.dirty = false
  return ok
}

export function updateLockOverlay() {
  const overlay = document.getElementById('orbit-editor-locked')
  if (!overlay) return
  const locked = state.rightMode === 'editor' && state.currentFilePath && state.chatLockedFiles.has(state.currentFilePath)
  overlay.classList.toggle('hidden', !locked)
}