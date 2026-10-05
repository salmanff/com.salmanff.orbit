/**
 * Slide-show project model — pure helpers, no DOM and no I/O.
 *
 * A slide-show project is a normal `projects` row with:
 *   type:   'slideshow'
 *   pages:  [deckPage]            — the deck shell (template html/css/js)
 *   slides: [{ id, file, title }] — presentation order; `file` is draft-relative
 *
 * `slides.json` in the draft folder is DERIVED from `slides` (see
 * slidesManifestJson) so the deck runtime can read the order at run time, in
 * the preview and on the published site alike.
 */

export const SLIDES_MANIFEST = 'slides.json'
export const SLIDES_DIR = 'slides'

export function isSlideshow(project) {
  return !!project && project.type === 'slideshow'
}

export function slidesOf(project) {
  return isSlideshow(project) && Array.isArray(project.slides) ? project.slides : []
}

/** Index of the deck page: the entry page, else 'index', else the first page. */
export function deckPageIndex(project) {
  const pages = project?.pages || []
  if (!pages.length) return 0
  let i = pages.findIndex((p) => p.name === project.entry_page)
  if (i < 0) i = pages.findIndex((p) => p.name === 'index')
  return i < 0 ? 0 : i
}

export function newSlideId(slides) {
  const list = slides || []
  let id
  do {
    id = 's' + Math.random().toString(36).slice(2, 8)
  } while (list.some((s) => s.id === id))
  return id
}

/** First unused slides/slide-N.html, checked against files on disk AND slide records. */
export function nextSlideFile(existingRels, slides) {
  const taken = new Set([...(existingRels || []), ...(slides || []).map((s) => s.file)])
  let n = 1
  while (taken.has(`${SLIDES_DIR}/slide-${n}.html`)) n++
  return `${SLIDES_DIR}/slide-${n}.html`
}

/** First unused `${base}.${ext}`, else `${base}-1.${ext}`, `${base}-2.${ext}`, … */
export function nextAvailableName(existingRels, base, ext) {
  const taken = new Set(existingRels || [])
  if (!taken.has(`${base}.${ext}`)) return `${base}.${ext}`
  let n = 1
  while (taken.has(`${base}-${n}.${ext}`)) n++
  return `${base}-${n}.${ext}`
}

export function slidesManifestJson(project) {
  const slides = slidesOf(project).map((s) => ({ id: s.id, file: s.file, title: s.title || '' }))
  return JSON.stringify({ slides }, null, 2) + '\n'
}

/** A readable title from a slide's first h1/h2, else its file name. */
export function titleFromSlideHtml(html, fallbackPath) {
  const m = String(html || '').match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/i)
  const text = m
    ? m[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
    : ''
  if (text) return text.length > 60 ? text.slice(0, 57) + '…' : text
  const base = String(fallbackPath || '').split('/').pop().replace(/\.html?$/i, '')
  return base || 'Slide'
}