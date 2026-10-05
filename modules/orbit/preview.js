/* global freezr, freezrMeta */
/** Assembles the draft preview document, tokenizes its asset URLs, and refreshes the iframe. */
import { state, draftBasePath, getActivePage } from './state.js'
import { fetchText } from './fileIO.js'
import { isSlideshow, slidesOf, deckPageIndex } from '../slideshow/slideshowModel.js'

let lastPreviewUrl = null

function revokeLastPreview() {
  if (lastPreviewUrl) {
    try { URL.revokeObjectURL(lastPreviewUrl) } catch (_) {}
    lastPreviewUrl = null
  }
}

function tokenizeRel(rel, token) {
  if (!token) return rel
  const sep = rel.includes('?') ? '&' : '?'
  return `${rel}${sep}fileToken=${encodeURIComponent(token)}`
}

async function buildPreviewDoc(page, slideIndex) {
  const base = draftBasePath()
  const html = await fetchText(`${base}/${page.html_file}`).catch(() => '<p>Could not load page.</p>')
  let token = ''
  try { token = (await freezr.utils.getFileToken('', { permission_name: 'self' })) || '' } catch (_) {}
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
    const doc = await buildPreviewDoc(page, slideIndex)
    const url = URL.createObjectURL(new Blob([doc], { type: 'text/html' }))
    revokeLastPreview()
    lastPreviewUrl = url
    iframe.src = url
  } catch (e) {
    console.warn('Orbit: refreshPreview failed', e)
  }
}

export async function openDraftInNewTab(page) {
  if (!page) return
  const url = await freezr.utils.tokenizedFileUrl(`${draftBasePath()}/${page.html_file}`)
  if (url) window.open(url, '_blank', 'noopener')
}

/** The preview document's injected runtime posts this message when a file 401s, asking for a
 * freshly tokenized rebuild (tokens expire after ~10 min). */
export function bindPreviewImgTokenRetry() {
  window.addEventListener('message', (e) => {
    if (e?.data?.orbit === 'imgTokenRetry') refreshPreview()
  })
}