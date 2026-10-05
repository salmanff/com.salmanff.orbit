/** Renders the Chat tab: threads, streaming output, reply box and undo button. */
import { state } from './state.js'
import { escapeHtml, formatTimestamp, bindAutoGrowTextarea } from './util.js'
import { handleChatSend, performUndo, updateStreamingUI } from './chat.js'
import { render } from './bus.js'
import { updateLockOverlay } from './editor.js'
import { refreshPreview } from './preview.js'

function deps() {
  return { render, refreshPreview, updateLockOverlay }
}

function renderMessage(msg) {
  if (msg.role === 'user') {
    return `<div class="orbit-msg">
      <div class="orbit-msg-user">
        <span class="orbit-msg-user-label">You</span>
        <span class="orbit-msg-ts">${escapeHtml(formatTimestamp(msg.timestamp))}</span>
      </div>
      <div class="orbit-msg-user-text">${escapeHtml(msg.content)}</div>
    </div>`
  }
  const filesHtml = (msg.filesChanged || []).length
    ? `<div class="orbit-file-items">${msg.filesChanged.map((f) => {
        const snippet = msg.fileSnippets?.[f]
        return `<div class="orbit-file-item"><span class="orbit-file-icon">&#10003;</span><span class="orbit-file-name">${escapeHtml(f)}</span>${snippet ? `<span class="orbit-file-snippet">${escapeHtml(snippet)}</span>` : ''}</div>`
      }).join('')}</div>`
    : ''
  const thinkingHtml = msg.thinking
    ? `<details class="orbit-thinking"><summary>Thinking</summary><pre class="orbit-thinking-pre">${escapeHtml(msg.thinking)}</pre></details>`
    : ''
  return `<div class="orbit-msg">
    <div class="orbit-msg-assistant">
      ${thinkingHtml}
      <div class="orbit-msg-explanation">${escapeHtml(msg.content)}</div>
      ${filesHtml}
    </div>
  </div>`
}

function renderStreamingBlock() {
  return `<div class="orbit-streaming-wrap">
    <div id="orbit-stream-thinking-wrap" class="orbit-thinking" ${state.chatStreamingThinking ? '' : 'hidden'}>
      <div class="orbit-thinking-pre" id="orbit-stream-thinking"></div>
    </div>
    <div class="orbit-msg-explanation" id="orbit-stream-content"></div>
    <div class="orbit-file-items" id="orbit-stream-files"></div>
  </div>`
}

function threadPreviewText(thread) {
  const firstUser = thread.messages.find((m) => m.role === 'user')
  return firstUser ? firstUser.content.slice(0, 80) : '(new thread)'
}

export function renderChatPanel(body, { canLlm } = {}) {
  const threads = state.chatThreads
  const activeId = state.activeThreadId

  const permBanner = !canLlm
    ? '<p class="orbit-chat-perm orbit-muted">Grant the <code>use_llm</code> permission in App Settings to chat with Orbit.</p>'
    : ''

  const threadsHtml = threads.map((thread) => {
    const isActive = thread.id === activeId
    const count = thread.messages.filter((m) => m.role === 'user').length
    return `<details class="orbit-thread${isActive ? ' orbit-thread--active' : ''}" data-thread="${escapeHtml(thread.id)}" ${isActive ? 'open' : ''}>
      <summary class="orbit-thread-summary">
        <span class="orbit-thread-preview">${escapeHtml(threadPreviewText(thread))}</span>
        <span class="orbit-thread-meta">
          <span class="orbit-thread-count">${count}</span>
          <span class="orbit-thread-ts">${escapeHtml(formatTimestamp(thread.startedAt))}</span>
        </span>
      </summary>
      <div class="orbit-thread-body">
        ${thread.messages.map(renderMessage).join('')}
        ${isActive && state.chatBusy ? renderStreamingBlock() : ''}
        ${isActive && state.lastChatEdit && state.lastChatEdit.threadId === thread.id
          ? '<div class="orbit-undo-row"><button type="button" class="orbit-btn-sm orbit-btn-secondary" id="orbit-undo-btn">Undo this change</button></div>'
          : ''}
        ${isActive && !state.chatBusy
          ? `<div class="orbit-reply-box">
              <textarea class="orbit-chat-input orbit-reply-input" id="orbit-reply-input" placeholder="Continue this thread..."></textarea>
              <button type="button" class="orbit-btn-sm" id="orbit-reply-send">Send</button>
            </div>`
          : ''}
      </div>
    </details>`
  }).join('')

  body.innerHTML = `
    <div class="orbit-chat">
      ${permBanner}
      <div class="orbit-chat-log" id="orbit-chat-log">
        ${threadsHtml || '<p class="orbit-muted">No chat yet. Ask Orbit to build something below.</p>'}
      </div>
      <div class="orbit-chat-bottom">
        <textarea class="orbit-chat-input" id="orbit-chat-input" placeholder="Ask Orbit to build or edit this page..." ${canLlm ? '' : 'disabled'}></textarea>
        <button type="button" class="orbit-btn" id="orbit-chat-send" ${canLlm ? '' : 'disabled'}>Send</button>
      </div>
    </div>
  `

  const log = document.getElementById('orbit-chat-log')
  if (log) log.scrollTop = log.scrollHeight

  const newInput = document.getElementById('orbit-chat-input')
  if (newInput) {
    bindAutoGrowTextarea(newInput)
    const draftKey = state.currentProject?.name || ''
    newInput.value = state.chatDraftNewByProject[draftKey] || ''
    newInput.addEventListener('input', () => { state.chatDraftNewByProject[draftKey] = newInput.value })
    newInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleChatSend(canLlm, true, deps()) }
    })
  }
  document.getElementById('orbit-chat-send')?.addEventListener('click', () => handleChatSend(canLlm, true, deps()))

  const replyInput = document.getElementById('orbit-reply-input')
  if (replyInput) {
    bindAutoGrowTextarea(replyInput)
    replyInput.value = state.chatDraftByThread[activeId] || ''
    replyInput.addEventListener('input', () => { state.chatDraftByThread[activeId] = replyInput.value })
    replyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleChatSend(canLlm, false, deps()) }
    })
  }
  document.getElementById('orbit-reply-send')?.addEventListener('click', () => handleChatSend(canLlm, false, deps()))

  document.getElementById('orbit-undo-btn')?.addEventListener('click', () => performUndo(deps()))

  body.querySelectorAll('.orbit-thread').forEach((el) => {
    el.addEventListener('toggle', () => {
      if (el.open) state.activeThreadId = el.getAttribute('data-thread')
    })
  })

  if (state.chatBusy) updateStreamingUI(updateLockOverlay)
}