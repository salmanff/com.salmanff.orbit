/* global freezr, freezrMeta */
/** Assembles the draft preview document, tokenizes its asset URLs, and refreshes the iframe. */
import { state, draftBasePath, getActivePage } from './state.js'
import { fetchText } from './fileIO.js'
import { escapeHtml } from './util.js'
import { isSlideshow, slidesOf, deckPageIndex } from '../slideshow/slideshowModel.js'

let lastPreviewUrl = null

/**
 * Budget for the "a file 401'd, rebuild me with a fresh token" message the injected runtime posts
 * back. The runtime guards itself to one message per preview document — but every rebuild creates a
 * NEW document whose guard starts clean, so without a cap here one genuinely unreachable file
 * rebuilds the preview forever and the pane never settles.
 */
const RETRY_LIMIT = 3
const RETRY_WINDOW_MS = 10000
let retryTimes = []

/**
 * Release the previous preview document.
 *
 * Deliberately NOT immediate: a user who pops the preview frame out into its own tab is holding
 * that same blob URL, and revoking it the moment the pane re-renders leaves them staring at a blank
 * page. A preview document is a few KB, so holding it a little longer costs nothing.
 */
function revokeLastPreview() {
  const url = lastPreviewUrl
  lastPreviewUrl = null
  if (!url) return
  setTimeout(() => { try { URL.revokeObjectURL(url) } catch (_) {} }, 30000)
}

function tokenizeRel(rel, token) {
  if (!token) return rel
  const sep = rel.includes('?') ? '&' : '?'
  return `${rel}${sep}fileToken=${encodeURIComponent(token)}`
}

/**
 * Mint a fileToken covering this app's own files.
 *
 * Deliberately NOT freezr.utils.getFileToken() first: the SDK caches a 'self' token per app+user
 * and keeps handing back the cached one until its RECORDED expiry passes. If the server stops
 * accepting that token early — a restart, a session change, clock skew — every rebuild gets the
 * same dead token back and the preview can never recover for the life of the page. Minting through
 * the raw route gives a genuinely fresh token each time; the SDK helper stays as a fallback in case
 * the route differs on a given server.
 *
 * @returns {Promise<{token: string|null, error: string|null}>}
 */
async function mintFileToken() {
  const app = typeof freezrMeta !== 'undefined' ? freezrMeta.appName : null
  const user = typeof freezrMeta !== 'undefined' ? freezrMeta.userId : null
  if (!app || !user) return { token: null, error: 'freezrMeta is missing the app or user id.' }

  let firstError = null
  try {
    const url = '/feps/getuserfiletoken/self/' + encodeURIComponent(app) + '/' + encodeURIComponent(user)
    const res = await freezr.apiRequest('GET', url)
    if (res && res.fileToken) return { token: res.fileToken, error: null }
    firstError = 'The server returned no fileToken.'
  } catch (e) {
    firstError = e.message || String(e)
    console.warn('Orbit: direct file-token mint failed; falling back to the SDK helper', e)
  }

  try {
    const token = await freezr.utils.getFileToken('', { permission_name: 'self' })
    if (token) return { token, error: null }
  } catch (e) {
    return { token: null, error: e.message || String(e) }
  }
  return { token: null, error: firstError || 'No fileToken could be obtained.' }
}

/**
 * Shown in place of the preview when no token could be minted. Previously this failure was
 * swallowed and the preview rendered anyway — every stylesheet, script and fetch inside it then
 * 401'd, which looks like a broken page rather than a permissions problem. Readable with or without
 * the stylesheet, so it still says something useful if style-src blocks it.
 */
function tokenErrorDoc(message) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font: 14px/1.55 system-ui, -apple-system, sans-serif; color: #1b1f24; margin: 0; padding: 2rem; }
  .wrap { max-width: 34rem; margin: 0 auto; }
  h1 { font-size: 1rem; margin: 0 0 .6rem; color: #b42318; }
  code { background: #f1f3f5; border-radius: 3px; padding: .1em .35em; font-size: 12px; }
  p { margin: 0 0 .7rem; }
  .why { color: #5b6570; font-size: 13px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Preview unavailable &mdash; no file token</h1>
  <p>Orbit could not obtain a <code>fileToken</code>, and draft files cannot be read without one.
     Nothing is wrong with your page: its CSS, JavaScript and any files it loads would all be
     refused, so Orbit is showing this instead of a page that only looks broken.</p>
  <p class="why">Server said: ${escapeHtml(message || 'no reason given')}</p>
  <p class="why">Most often this means the login session expired. Reload Orbit, or sign in again,
     then reopen this preview. The published site is unaffected &mdash; it serves public copies and
     needs no token.</p>
</div>
</body>
</html>`
}

async function buildPreviewDoc(page, slideIndex, token) {
  const base = draftBasePath()
  const html = await fetchText(`${base}/${page.html_file}`).catch(() => '<p>Could not load page.</p>')
  // Native <link>/<script> tags can't carry an Authorization header or be intercepted by the
  // fetch/XHR patch in previewRuntime.js, so these need the fileToken baked into their URL.
  const cssLinks = (page.css_files || []).map((f) => `<link rel="stylesheet" href="${tokenizeRel(f, token)}">`).join('\n')
  const jsScripts = (page.js_files || []).map((f) => `<script src="${tokenizeRel(f, token)}"></script>`).join('\n')
  const baseHref = `${window.location.origin}/feps/userfiles/${freezrMeta.appName}/${freezrMeta.userId}/${base}/`
  const runtimeUrl = new URL('../previewRuntime.js', import.meta.url).href
  const startSlideMeta = (slideIndex != null && slideIndex >= 0) ? `<meta name="orbit-start-slide" content="${slideIndex + 1}">` : ''
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<base href="${baseHref}">
${startSlideMeta}
${cssLinks}
<script src="${runtimeUrl}" data-base="${baseHref}" data-token="${token}"></script>
</head>
<body>
${html}
${jsScripts}
</body>
</html>`
}

export async function refreshPreview() {
  const iframe = document.getElementById('orbit-preview-frame')
  if (!iframe) return
  const proj = state.currentProject
  if (!proj) return
  let page = getActivePage()
  let slideIndex = null
  if (isSlideshow(proj)) {
    page = proj.pages[deckPageIndex(proj)]
    const slides = slidesOf(proj)
    slideIndex = slides.findIndex((s) => s.id === state.activeSlideId)
  }
  if (!page) return
  try {
    const { token, error } = await mintFileToken()
    const doc = token
      ? await buildPreviewDoc(page, slideIndex, token)
      : tokenErrorDoc(error)
    const url = URL.createObjectURL(new Blob([doc], { type: 'text/html' }))
    revokeLastPreview()
    lastPreviewUrl = url
    iframe.src = url
  } catch (e) {
    console.warn('Orbit: refreshPreview failed', e)
  }
}

/**
 * Open the draft in a new tab.
 *
 * NOT the raw html file. Orbit pages are body FRAGMENTS — no <link>, no <script> — because the CSS
 * and JS a page uses are declared on the page record and injected by Orbit when it builds the
 * document. Serving draft/index.html straight from the userfiles route therefore renders the markup
 * with no styling and no behaviour, which for a slide deck looks like an unstyled shell stuck on
 * "Loading…": the fragment is on screen, but nothing that would fill it in ever ran.
 *
 * So this assembles exactly the same document the preview pane uses (base href, tokenized CSS/JS,
 * the fetch-tokenizing runtime) and opens that.
 *
 * The window is opened BEFORE the awaits: window.open() only survives the popup blocker while the
 * click's transient activation is still live, and minting a token plus reading the page can outlast
 * it. That rules out 'noopener' — it returns null, and the handle is needed to navigate. The draft
 * is the user's own content and already runs same-origin inside the preview iframe, so keeping the
 * opener reference exposes nothing new.
 */
export async function openDraftInNewTab(page) {
  if (!page) return
  const proj = state.currentProject
  if (!proj) return

  const win = window.open('', '_blank')
  if (!win) {
    window.alert('Your browser blocked the new tab. Allow pop-ups for this site, then press Draft again.')
    return
  }

  try {
    // A slide show has exactly one page (the deck), so opening it means opening the slide the user
    // is working on — the same one the preview pane is showing.
    const slideIndex = isSlideshow(proj)
      ? slidesOf(proj).findIndex((s) => s.id === state.activeSlideId)
      : null

    const { token, error } = await mintFileToken()
    const doc = token
      ? await buildPreviewDoc(page, slideIndex, token)
      : tokenErrorDoc(error)

    const url = URL.createObjectURL(new Blob([doc], { type: 'text/html' }))
    win.location.replace(url)
    // Held well past load so a quick reload still works. By the time it is released the fileToken
    // baked into the document has expired anyway, so the tab is stale regardless.
    setTimeout(() => { try { URL.revokeObjectURL(url) } catch (_) {} }, 10 * 60 * 1000)
  } catch (e) {
    console.error('Orbit: could not open the draft in a new tab', e)
    try { win.close() } catch (_) {}
    window.alert('Could not open the draft: ' + (e.message || String(e)))
  }
}

/**
 * The preview document's injected runtime posts this message when a file 401s, asking for a freshly
 * tokenized rebuild (tokens expire after ~10 min). Rate-limited here because the runtime's own
 * one-shot guard resets on every rebuild, so an unrecoverable 401 would otherwise loop forever.
 */
export function bindPreviewImgTokenRetry() {
  window.addEventListener('message', (e) => {
    if (e?.data?.orbit !== 'imgTokenRetry') return
    const now = Date.now()
    retryTimes = retryTimes.filter((t) => (now - t) < RETRY_WINDOW_MS)
    if (retryTimes.length >= RETRY_LIMIT) {
      console.warn('Orbit: preview requested a token rebuild too many times — stopping. A file it needs is probably missing or not readable.')
      return
    }
    retryTimes.push(now)
    refreshPreview()
  })
}