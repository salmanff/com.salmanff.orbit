/** Pure helpers: escaping, path classification, timestamp formatting, auto-grow textarea, row normalization. */

export function escapeHtml(s) {
  const d = document.createElement('div')
  d.textContent = s == null ? '' : String(s)
  return d.innerHTML
}

/** freezr.query() may return a bare array or { data: [...] } depending on backend; normalize both. */
export function normalizeQueryRows(rows) {
  if (Array.isArray(rows)) return rows
  if (rows && Array.isArray(rows.data)) return rows.data
  return []
}

export function isImagePath(path) {
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(path || '')
}

export function isTextEditablePath(path) {
  return /\.(html?|css|m?js|json|svg|txt|md|xml|csv|map)$/i.test(path || '')
}

/** Short time for today, otherwise a short date + time. */
export function formatTimestamp(ts) {
  if (!ts) return ''
  try {
    const d = new Date(ts)
    const now = new Date()
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    if (d.toDateString() === now.toDateString()) return time
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time
  } catch (_) {
    return ''
  }
}

/** Grows a textarea with its content up to a max height, then scrolls internally. */
export function bindAutoGrowTextarea(el, opts = {}) {
  if (!el) return
  const maxHeight = opts.maxHeight || 200
  const grow = () => {
    el.style.height = ''
    const h = Math.min(el.scrollHeight, maxHeight)
    el.style.height = h + 'px'
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }
  el.addEventListener('input', grow)
  grow()
}

/** On narrow (mobile) layouts the right panel sits below the left; scroll it into view. */
export function scrollToRightPanelIfNeeded() {
  if (typeof window === 'undefined' || window.innerWidth > 800) return
  const right = document.querySelector('.orbit-right')
  if (right) right.scrollIntoView({ behavior: 'smooth', block: 'start' })
}