/* global freezr */
/** Chat history, sending a message, and the two undo mechanisms (instant undo + checkpoints). */
import { state, draftBasePath, draftRelFilePaths, getActiveThread, startNewThread, activeSlide, activeSlideIndex } from './state.js'
import { normalizeQueryRows, escapeHtml } from './util.js'
import { uploadText, uploadFile, fetchText } from './fileIO.js'
import { fetchUserBlob, fetchUserText } from '../fileFetch.js'
import { refreshFileList, deleteFileWithUnpublish } from './filesData.js'
import { persistProjectPages } from './projects.js'
import { isSlideshow, slidesOf, deckPageIndex, newSlideId, titleFromSlideHtml } from '../slideshow/slideshowModel.js'
import { sendOrbitChatMessage, mimeForPath } from '../orbitChat.js'
import { extractStreamDisplay } from '../parseFreezrResponse.js'
import { llmAskOptions } from '../llmSettings.js'
import { saveCheckpoint, pruneCheckpoints, restoreCheckpoint } from '../checkpoints.js'

export async function loadChatHistoryForProject() {
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
        fileSnippets: r.file_snippets || null,
        checkpointPath: r.checkpoint_path || null
      })
    }
    state.chatThreads = []
    for (const [tid, msgs] of threadMap) {
      state.chatThreads.push({
        id: tid,
        messages: msgs,
        startedAt: msgs[0]?.timestamp || null,
        checkpointPath: msgs.find((m) => m.checkpointPath)?.checkpointPath || null
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

export async function appendChatHistory(threadId, role, content, filesChanged = [], thinking = null, fileSnippets = null, checkpointPath = null) {
  if (!state.currentProject) return
  const timestamp = Date.now()
  try {
    await freezr.create('chat_history', {
      project_name: state.currentProject.name,
      thread_id: threadId,
      role,
      content,
      timestamp,
      active_page: state.currentProject.pages?.[state.activePageIndex]?.name || '',
      files_changed: filesChanged,
      thinking,
      file_snippets: fileSnippets,
      checkpoint_path: checkpointPath
    }, {})
  } catch (e) {
    console.warn('Orbit: chat_history save failed', e)
  }
  return timestamp
}

async function gatherPageFileContents(page) {
  if (!page) return []
  const rels = [page.html_file, ...(page.css_files || []), ...(page.js_files || [])]
  const results = []
  for (const rel of rels) {
    if (!rel) continue
    try { results.push({ path: rel, content: await fetchText(`${draftBasePath()}/${rel}`) }) } catch (e) { console.warn('Orbit chat: could not load', rel, e) }
  }
  const loadedPaths = new Set(rels)
  const sharedFiles = state.fileList
    .map((f) => f.replace(`${draftBasePath()}/`, ''))
    .filter((f) => f.startsWith('shared/') && !loadedPaths.has(f))
  for (const rel of sharedFiles) {
    try { results.push({ path: rel, content: await fetchText(`${draftBasePath()}/${rel}`) }) } catch (e) { console.warn('Orbit chat: could not load shared file', rel, e) }
  }
  return results
}

export function updateStreamingUI(updateLockOverlay) {
  const thinkEl = document.getElementById('orbit-stream-thinking')
  const thinkWrap = document.getElementById('orbit-stream-thinking-wrap')
  const contentEl = document.getElementById('orbit-stream-content')
  const filesEl = document.getElementById('orbit-stream-files')

  if (thinkEl && state.chatStreamingThinking) {
    thinkEl.textContent = state.chatStreamingThinking
    if (thinkWrap) thinkWrap.hidden = false
  }
  if (contentEl && state.chatStreaming) contentEl.textContent = state.chatStreaming
  if (updateLockOverlay) updateLockOverlay()
  if (filesEl && state.chatStreamingFiles) {
    filesEl.innerHTML = state.chatStreamingFiles.map((f) => {
      const iconCls = f.error ? 'orbit-file-icon--error' : f.done ? '' : 'orbit-file-icon--pending'
      const icon = f.error ? '✗' : f.done ? '✓' : ''
      const spinner = (f.done || f.error) ? '' : '<span class="orbit-spinner-inline"></span>'
      const label = f.isImage ? '🖼 ' : ''
      const snippetHtml = f.snippet ? `<span class="orbit-file-snippet">${escapeHtml(f.snippet)}</span>` : ''
      return `<div class="orbit-file-item">${spinner}<span class="orbit-file-icon ${iconCls}">${icon}</span><span class="orbit-file-name">${label}${escapeHtml(f.path)}</span>${snippetHtml}</div>`
    }).join('')
  }
  const log = document.getElementById('orbit-chat-log')
  if (log) {
    const nearBottom = (log.scrollHeight - log.scrollTop - log.clientHeight) < 80
    if (nearBottom) log.scrollTop = log.scrollHeight
  }
}

/**
 * @typedef {{ render: () => Promise<void>, refreshPreview: () => Promise<void>,
 *   updateLockOverlay: () => void }} ChatDeps
 */

/** @param {ChatDeps} deps */
export async function handleChatSend(canLlm, forceNewThread, deps) {
  if (!canLlm || state.chatBusy || !state.currentProject) return
  const inputId = forceNewThread ? 'orbit-chat-input' : 'orbit-reply-input'
  let input = document.getElementById(inputId)
  if (!input || !(input.value || '').trim()) input = document.getElementById('orbit-chat-input')
  const text = (input?.value || '').trim()
  if (!text) return

  state.lastChatEdit = null

  const willStartNewThread = forceNewThread || !state.activeThreadId
  let newThreadCheckpointPath = null
  if (willStartNewThread) {
    try {
      await refreshFileList()
      const saved = await saveCheckpoint({
        project: state.currentProject,
        fileRels: draftRelFilePaths(),
        fetchDraftBlob: (rel) => fetchUserBlob(`${draftBasePath()}/${rel}`),
        trigger: 'chat_start'
      })
      if (saved) {
        newThreadCheckpointPath = saved.path
        pruneCheckpoints(state.currentProject.name).catch((e) => console.warn('Orbit: checkpoint prune failed', e))
      }
    } catch (e) {
      console.warn('Orbit: checkpoint save failed (continuing without one)', e)
    }
    startNewThread(state.activePageIndex, newThreadCheckpointPath)
  }
  const threadId = state.activeThreadId
  const thread = getActiveThread()

  const threadPageIndex = thread.pageIndex != null ? thread.pageIndex : state.activePageIndex
  const threadPage = state.currentProject?.pages?.[threadPageIndex] || state.currentProject?.pages?.[state.activePageIndex]

  state.chatBusy = true
  state.chatLockedFiles = new Set()

  if (threadPage && state.currentProject) {
    const _base = draftBasePath()
    for (const rel of [threadPage.html_file, ...(threadPage.css_files || []), ...(threadPage.js_files || [])]) {
      if (rel) state.chatLockedFiles.add(`${_base}/${rel}`)
    }
  }
  deps.updateLockOverlay()

  const userTs = Date.now()
  const userMsg = { role: 'user', content: text, timestamp: userTs }
  thread.messages.push(userMsg)
  if (input) {
    input.value = ''
    input.style.height = ''
    input.style.overflowY = 'hidden'
    input.dispatchEvent(new Event('input'))
    if (input.id === 'orbit-chat-input') {
      delete state.chatDraftNewByProject[state.currentProject?.name || '']
    } else if (input.id === 'orbit-reply-input') {
      delete state.chatDraftByThread[threadId]
    }
  }
  await appendChatHistory(threadId, 'user', text, [], null, null, willStartNewThread ? newThreadCheckpointPath : null)

  state.chatStreaming = null
  state.chatStreamingThinking = null
  state.chatStreamingFiles = null
  await deps.render()

  let streamedText = ''
  let streamedThinking = ''

  const pushStreamRender = () => {
    const parsed = extractStreamDisplay(streamedText)
    state.chatStreaming = parsed.displayText || null
    state.chatStreamingThinking = streamedThinking || null
    state.chatStreamingFiles = parsed.files.length > 0 ? parsed.files : null
    updateStreamingUI(deps.updateLockOverlay)
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
    const page = threadPage
    const fileContents = await gatherPageFileContents(page)

    let slideshowCtx = null
    if (isSlideshow(state.currentProject)) {
      const slides = slidesOf(state.currentProject)
      const slideId = thread.slideId || activeSlide()?.id || null
      const slide = slides.find((s) => s.id === slideId) || slides[0] || null
      if (slide && !fileContents.some((f) => f.path === slide.file)) {
        try { fileContents.push({ path: slide.file, content: await fetchText(`${draftBasePath()}/${slide.file}`) }) } catch (e) { console.warn('Orbit chat: could not load active slide', slide.file, e) }
      }
      slideshowCtx = { slides, activeSlideId: slide?.id || null }
    }

    const projectFileList = draftRelFilePaths()

    const out = await sendOrbitChatMessage({
      userMessage: text,
      chatHistory,
      llmOptions: llmAskOptions(state.llm),
      project: state.currentProject,
      page,
      fileContents,
      projectFileList,
      slideshow: slideshowCtx,
      uploadText,
      uploadFile,
      fetchDraftFile: (rel) => {
        const full = `${draftBasePath()}/${rel}`
        if (!state.chatLockedFiles.has(full)) {
          state.chatLockedFiles.add(full)
          deps.updateLockOverlay()
        }
        return fetchText(full)
      },
      onDelta: (chunk) => { streamedText += chunk; pushStreamRender() },
      onThinking: (chunk) => { streamedThinking += chunk; pushStreamRender() },
      onImageStatus: ({ path, status }) => {
        if (!state.chatStreamingFiles) state.chatStreamingFiles = []
        const existing = state.chatStreamingFiles.find((f) => f.path === path)
        if (existing) {
          existing.done = status === 'done'
          existing.error = status === 'error'
        } else {
          state.chatStreamingFiles.push({ path, done: status === 'done', error: status === 'error', isImage: true })
        }
        updateStreamingUI(deps.updateLockOverlay)
      }
    })

    let pagesChanged = false
    const proj = state.currentProject
    const pagesBeforeUndo = proj?.pages ? JSON.parse(JSON.stringify(proj.pages)) : null
    const slidesBeforeUndo = isSlideshow(proj) ? JSON.parse(JSON.stringify(slidesOf(proj))) : null

    if (out.newResources?.length && isSlideshow(proj)) {
      const slides = slidesOf(proj)
      const existingFiles = new Set(slides.map((s) => s.file))
      let insertAt = activeSlideIndex()
      insertAt = insertAt >= 0 ? insertAt + 1 : slides.length
      let addedSlide = null
      for (const res of out.newResources) {
        if (res.type === 'html' && !existingFiles.has(res.path)) {
          const id = newSlideId(slides)
          const title = titleFromSlideHtml(
            (out.parsed?.files || []).find((f) => (f.path || '').replace(/^\/+/, '') === res.path)?.content,
            res.path
          )
          slides.splice(insertAt++, 0, { id, file: res.path, title })
          existingFiles.add(res.path)
          addedSlide = id
          pagesChanged = true
        }
      }
      const deck = proj.pages[deckPageIndex(proj)]
      if (deck) {
        for (const res of out.newResources) {
          if (res.type === 'css') {
            if (!deck.css_files) deck.css_files = []
            if (!deck.css_files.includes(res.path)) { deck.css_files.push(res.path); pagesChanged = true }
          } else if (res.type === 'js') {
            if (!deck.js_files) deck.js_files = []
            if (!deck.js_files.includes(res.path)) { deck.js_files.push(res.path); pagesChanged = true }
          }
        }
      }
      proj.slides = slides
      if (addedSlide) state.activeSlideId = addedSlide
    } else if (out.newResources?.length) {
      const existingHtmlFiles = new Set((proj.pages || []).map((p) => p.html_file))
      const newPages = []

      for (const res of out.newResources) {
        if (res.type === 'html' && !existingHtmlFiles.has(res.path)) {
          const pageName = res.path.replace(/\.html?$/i, '').replace(/\//g, '-')
          const newPage = { name: pageName, html_file: res.path, css_files: [], js_files: [], published: false, public_url: null }
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
            if (!targetPage.css_files.includes(res.path)) { targetPage.css_files.push(res.path); pagesChanged = true }
          } else if (res.type === 'js') {
            if (!targetPage.js_files) targetPage.js_files = []
            if (!targetPage.js_files.includes(res.path)) { targetPage.js_files.push(res.path); pagesChanged = true }
          }
        }
      }
      if (newPages.length === 1) state.activePageIndex = proj.pages.length - 1
    }

    if (out.metaUpdate && page) {
      if (!page.meta) page.meta = {}
      for (const [k, v] of Object.entries(out.metaUpdate)) {
        if (v !== undefined) page.meta[k] = v
      }
      pagesChanged = true
    }

    if (pagesChanged) await persistProjectPages(state.currentProject)

    const fileSnippets = {}
    for (const f of out.parsed?.files || []) {
      const rel = (f.path || '').replace(/^\/+/, '')
      if (rel && f.content) {
        const lines = f.content.split('\n')
        fileSnippets[rel] = lines.slice(0, 2).join('\n')
      }
    }

    state.chatStreamingFiles = (out.filesChanged || []).map((f) => ({ path: f, done: false, snippet: fileSnippets[f] || null }))
    updateStreamingUI(deps.updateLockOverlay)
    await new Promise((r) => setTimeout(r, 400))
    state.chatStreamingFiles = (out.filesChanged || []).map((f) => ({ path: f, done: true, snippet: fileSnippets[f] || null }))
    updateStreamingUI(deps.updateLockOverlay)

    let assistantText = out.explanation
    if (out.parsed?.parseErrors?.length) {
      assistantText += '\n\n—\n' + out.parsed.parseErrors.map((e) => `[parse] ${e}`).join('\n')
    }
    const assistantTs = Date.now()
    const assistantMsgObj = {
      role: 'assistant',
      content: assistantText,
      timestamp: assistantTs,
      filesChanged: out.filesChanged || [],
      thinking: streamedThinking || null,
      fileSnippets
    }
    thread.messages.push(assistantMsgObj)
    await appendChatHistory(threadId, 'assistant', assistantText, out.filesChanged, streamedThinking || null, fileSnippets)
    if (out.undo && (out.undo.files?.length || out.undo.images?.length || pagesChanged)) {
      state.lastChatEdit = {
        threadId,
        projectName: state.currentProject?.name,
        files: out.undo.files || [],
        images: out.undo.images || [],
        pagesBefore: pagesChanged ? pagesBeforeUndo : null,
        slidesBefore: pagesChanged ? slidesBeforeUndo : null,
        pagesChanged,
        assistantMsg: assistantMsgObj
      }
    }
    await refreshFileList()
    state.rightMode = 'preview'
    await deps.refreshPreview()
  } catch (e) {
    const errMsg = 'Error: ' + (e.message || String(e))
    thread.messages.push({ role: 'assistant', content: errMsg, timestamp: Date.now() })
  } finally {
    state.chatBusy = false
    state.chatStreaming = null
    state.chatStreamingThinking = null
    state.chatStreamingFiles = null
    state.chatLockedFiles = new Set()
    await deps.render()
  }
}

/**
 * Restore the project to a checkpoint. Mirrors Import: files the checkpoint lists are
 * overwritten, anything else in the draft folder is left alone. Does not touch chat history.
 * @param {ChatDeps} deps
 */
export async function handleRestoreCheckpoint(path, deps) {
  if (!state.currentProject) return
  const ok = window.confirm(
    'Restore the project to this checkpoint?\n\n' +
    'Files it contains are overwritten with the saved versions. Files created since the ' +
    'checkpoint that are not part of it are left in place. Chat history is not affected.'
  )
  if (!ok) return
  try {
    await refreshFileList()
    const { applyProjectBundle } = await import('../projectTransfer.js')
    const result = await restoreCheckpoint({
      path,
      fetchText: (p) => fetchUserText(p),
      existingRels: draftRelFilePaths(),
      uploadText,
      uploadFile,
      saveProjectRow: async (row) => {
        const fields = { ...row }
        delete fields.name
        const isDeckBundle = row.type === 'slideshow'
        fields.type = isDeckBundle ? 'slideshow' : 'web'
        fields.slides = isDeckBundle && Array.isArray(row.slides) ? row.slides : []
        await freezr.updateFields('projects', { name: row.name }, fields)
      }
    })
    const { normalizeQueryRows: nqr } = await import('./util.js')
    const rows = await freezr.query('projects', { name: state.currentProject.name }, {})
    const list = nqr(rows)
    if (list[0]) state.currentProject = list[0]
    await refreshFileList()
    state.rightMode = 'preview'
    await deps.render()
    await deps.refreshPreview()
    let msg = 'Restored checkpoint — ' + result.written + ' file' + (result.written === 1 ? '' : 's') + ' written.'
    if (result.warnings.length) msg += '\n\n' + result.warnings.length + ' file(s) failed:\n' + result.warnings.join('\n')
    if (result.leftovers.length) msg += '\n\n' + result.leftovers.length + ' file(s) in the folder were not part of the checkpoint and were left in place.'
    window.alert(msg)
  } catch (e) {
    console.error('Orbit: restore checkpoint failed', e)
    window.alert('Restore failed: ' + (e.message || String(e)))
  }
}

/**
 * Instant, single-turn undo for the chat's most recent reply. Only ever covers the LAST reply —
 * state.lastChatEdit is replaced/cleared on every subsequent message and is not persisted; a
 * checkpoint is what survives a reload.
 * @param {ChatDeps} deps
 */
export async function performUndo(deps) {
  const edit = state.lastChatEdit
  if (!edit) return
  if (!state.currentProject || state.currentProject.name !== edit.projectName) {
    window.alert('Switch back to "' + edit.projectName + '" to undo that change.')
    return
  }
  const btn = document.getElementById('orbit-undo-btn')
  if (btn) { btn.disabled = true; btn.textContent = 'Undoing…' }
  try {
    const base = draftBasePath()
    let restoredCount = 0
    let removedCount = 0
    let skippedImages = 0
    for (const f of edit.files || []) {
      const full = `${base}/${f.path}`
      if (f.existed) {
        await uploadText(full, f.prevContent != null ? f.prevContent : '', mimeForPath(f.path))
        restoredCount++
      } else {
        try { await deleteFileWithUnpublish(full) } catch (e) { console.warn('Orbit: undo could not delete new file', f.path, e) }
        removedCount++
      }
    }
    for (const img of edit.images || []) {
      const full = `${base}/${img.path}`
      if (!img.existed) {
        try { await deleteFileWithUnpublish(full) } catch (e) { console.warn('Orbit: undo could not delete new image', img.path, e) }
        removedCount++
      } else {
        skippedImages++
      }
    }
    if (edit.pagesChanged && state.currentProject) {
      if (edit.pagesBefore) state.currentProject.pages = edit.pagesBefore
      if (isSlideshow(state.currentProject) && edit.slidesBefore) state.currentProject.slides = edit.slidesBefore
      await persistProjectPages(state.currentProject)
    }
    const thread = state.chatThreads.find((t) => t.id === edit.threadId)
    const parts = []
    if (restoredCount) parts.push(restoredCount + ' file' + (restoredCount > 1 ? 's' : '') + ' restored')
    if (removedCount) parts.push(removedCount + ' new file' + (removedCount > 1 ? 's' : '') + ' removed')
    if (edit.pagesChanged) parts.push('page list reverted')
    let note = 'Changes undone' + (parts.length ? ' — ' + parts.join(', ') + '.' : '.')
    if (skippedImages) {
      note += ' (' + skippedImages + ' image' + (skippedImages > 1 ? 's' : '') + ' that existed before could not be restored and ' +
        (skippedImages > 1 ? 'were' : 'was') + ' left as the chat left ' + (skippedImages > 1 ? 'them' : 'it') + '.)'
    }
    if (thread) {
      thread.messages.push({ role: 'assistant', content: note, timestamp: Date.now() })
      await appendChatHistory(thread.id, 'assistant', note)
    }
    state.lastChatEdit = null
    await refreshFileList()
    state.rightMode = 'preview'
    await deps.render()
    await deps.refreshPreview()
  } catch (e) {
    console.error('Orbit: undo failed', e)
    window.alert('Undo failed: ' + (e.message || String(e)))
    if (btn) { btn.disabled = false; btn.textContent = 'Undo this change' }
  }
}