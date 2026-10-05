/** Central mutable state object for Orbit, plus small derived getters and a couple of persisted prefs. */
import { makeLlmState } from '../llmSettings.js'

const LS_LEFT_WIDTH = 'orbitLeftPanelWidth'
const LS_LAST_PROJECT = 'orbitLastProject'

function readStoredWidth() {
  try {
    const raw = localStorage.getItem(LS_LEFT_WIDTH)
    const n = raw ? parseInt(raw, 10) : NaN
    return (Number.isFinite(n) && n >= 200 && n <= 560) ? n : 320
  } catch (_) {
    return 320
  }
}

export const state = {
  // view / navigation
  view: 'project', // 'project' | 'settings'
  leftTab: 'chat', // 'chat' | 'pages' | 'slides' | 'files'
  rightMode: 'preview', // 'preview' | 'editor' | 'image'
  leftPanelWidth: readStoredWidth(),

  // projects
  projects: [],
  currentProject: null,
  activePageIndex: 0,
  activeSlideId: null,

  // files
  fileList: [],
  fileMtimes: {},
  fileListIncomplete: false,
  fileListFileCount: 0,
  fileListMaxFiles: 0,
  fileListMaxDepth: 0,
  publishedFiles: {},
  expandedFolder: null,
  collapsedFolders: new Set(),

  // editor
  currentFilePath: null,
  editorText: '',
  loadedEditorPath: null,
  dirty: false,

  // chat
  chatThreads: [],
  activeThreadId: null,
  chatBusy: false,
  chatLockedFiles: new Set(),
  chatStreaming: null,
  chatStreamingThinking: null,
  chatStreamingFiles: null,
  chatDraftNewByProject: {},
  chatDraftByThread: {},
  lastChatEdit: null,

  // permissions (see permissions.js)
  permissions: {
    loaded: false,
    raw: null,
    canPublish: false,
    canLlm: false,
    canIframePreview: false,
    sessionExpired: false,
    lastError: null
  },

  // LLM provider/model settings (see llmSettings.js)
  llm: makeLlmState(),

  // Settings & Projects view
  exportIncludeChat: false,
  transferBusy: false,
  transferStatus: '',
  settingsVersionsOpen: false,
  settingsTransformOpen: false,
  checkpointsList: null,
  checkpointsLoading: false
}

export function draftBasePath() {
  return state.currentProject ? `projects/${state.currentProject.name}/draft` : ''
}

/** Draft-relative paths of every file currently in state.fileList for the active project. */
export function draftRelFilePaths() {
  const base = draftBasePath()
  if (!base) return []
  return state.fileList
    .filter((f) => f.startsWith(base + '/'))
    .map((f) => f.slice(base.length + 1))
}

export function getActivePage() {
  return state.currentProject?.pages?.[state.activePageIndex] || null
}

export function getActiveThread() {
  return state.chatThreads.find((t) => t.id === state.activeThreadId) || null
}

/** Start a new chat thread and make it active; returns the thread object. */
export function startNewThread(pageIndex, checkpointPath) {
  const id = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const thread = {
    id,
    messages: [],
    startedAt: Date.now(),
    pageIndex,
    checkpointPath: checkpointPath || null,
    slideId: state.activeSlideId || null
  }
  state.chatThreads.push(thread)
  state.activeThreadId = id
  return thread
}

export function activeSlide() {
  const proj = state.currentProject
  if (!proj || proj.type !== 'slideshow') return null
  const slides = Array.isArray(proj.slides) ? proj.slides : []
  return slides.find((s) => s.id === state.activeSlideId) || null
}

export function activeSlideIndex() {
  const proj = state.currentProject
  if (!proj || proj.type !== 'slideshow') return -1
  const slides = Array.isArray(proj.slides) ? proj.slides : []
  return slides.findIndex((s) => s.id === state.activeSlideId)
}

export function rememberProject(name) {
  try { localStorage.setItem(LS_LAST_PROJECT, name) } catch (_) {}
}

export function persistLeftPanelWidth(w) {
  state.leftPanelWidth = w
  try { localStorage.setItem(LS_LEFT_WIDTH, String(w)) } catch (_) {}
}