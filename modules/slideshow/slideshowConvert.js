/**
 * Working out what a project's slides ACTUALLY are.
 *
 * A project's `pages` array is Orbit's idea of the project. The files on disk and the
 * deck's own source are the truth, and the two drift apart: chat adds html files, a
 * hand-written deck keeps its slide list in its own JS, an import overwrites one and not
 * the other. Conversion — and repair — reconciles them, so the Slides tab lists what the
 * presentation really contains.
 *
 * Pure except for the injected `readText`, so the reconciliation can be reasoned about
 * (and tested) without any freezr plumbing.
 */
import {
  SLIDES_DIR, SLIDES_MANIFEST, deckPageIndex, newSlideId, titleFromSlideHtml
} from './slideshowModel.js'

/**
 * Quoted "...html" paths appearing in a source file, in source order.
 * Catches both a deck that lists its slides in JS and one that puts them in markup
 * (data-src="slides/x.html", href="slides/x.html", …).
 */
export function extractHtmlRefs(text) {
  const out = []
  const re = /['"`]\s*([^'"`\s<>]+\.html?)\s*['"`]/gi
  let m
  while ((m = re.exec(String(text || '')))) {
    out.push(m[1].replace(/^\.\//, '').replace(/^\/+/, ''))
  }
  return out
}

/** First occurrence wins; falsy entries dropped. */
export function orderedUnique(list) {
  const seen = new Set()
  const out = []
  for (const item of list || []) {
    if (!item || seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

export function isSlideFile(rel) {
  return /\.html?$/i.test(rel || '') && String(rel).startsWith(SLIDES_DIR + '/')
}

/**
 * Decide the slide list and the deck for a project.
 *
 * @param {object} opts
 * @param {object} opts.project - the projects row
 * @param {string[]} opts.existingRels - every file in the draft folder, draft-relative
 * @param {(rel: string) => Promise<string>} opts.readText
 * @returns {Promise<{
 *   slides: Array<{id: string, file: string, title: string}>,
 *   deckPage: object|null,   // an existing page that already plays the slides, else null
 *   readsManifest: boolean,  // that deck reads slides.json (so reordering takes effect)
 *   skipped: string[]        // slide-looking files on disk nothing referenced
 * }>}
 */
export async function analyzeProject({ project, existingRels, readText }) {
  const onDisk = new Set(existingRels || [])
  const pages = (project && project.pages) || []
  const candidate = pages[deckPageIndex(project)] || null

  // ── Does the entry page already act as a deck? ──────────────────────────────
  let deckRefs = []
  let readsManifest = false
  if (candidate) {
    const sources = [candidate.html_file, ...(candidate.js_files || [])].filter((r) => r && onDisk.has(r))
    for (const rel of sources) {
      let text = ''
      try { text = await readText(rel) } catch (_) { continue }
      if (text.includes(SLIDES_MANIFEST)) readsManifest = true
      deckRefs.push(...extractHtmlRefs(text))
    }
    deckRefs = orderedUnique(deckRefs).filter((f) => f !== candidate.html_file && onDisk.has(f))
  }
  // A page that references slide files, or fetches slides.json, is a working deck and is
  // kept. Anything else is just content and becomes a slide like the rest.
  const deckPage = (deckRefs.length > 0 || readsManifest) ? candidate : null

  // ── Every other place a slide could be recorded ─────────────────────────────
  const titleByFile = new Map()
  const idByFile = new Map()
  const remember = (list) => {
    for (const s of list || []) {
      if (!s || !s.file) continue
      if (s.title && !titleByFile.has(s.file)) titleByFile.set(s.file, s.title)
      if (s.id && !idByFile.has(s.file)) idByFile.set(s.file, s.id)
    }
  }

  let manifestFiles = []
  if (onDisk.has(SLIDES_MANIFEST)) {
    try {
      const parsed = JSON.parse(await readText(SLIDES_MANIFEST))
      const list = Array.isArray(parsed && parsed.slides) ? parsed.slides : []
      remember(list)
      manifestFiles = list.map((s) => s && s.file).filter((f) => f && onDisk.has(f))
    } catch (_) { /* a malformed manifest is simply one source fewer */ }
  }

  remember(project && project.slides)
  const recordFiles = ((project && project.slides) || [])
    .map((s) => s && s.file).filter((f) => f && onDisk.has(f))

  const pageFiles = pages
    .filter((p) => !deckPage || p !== deckPage)
    .map((p) => p && p.html_file)
    .filter((f) => f && onDisk.has(f))

  const diskSlides = (existingRels || []).filter(isSlideFile).sort()

  // Union rather than "first non-empty source wins": each source knows about slides the
  // others have forgotten, and silently dropping one is the failure that started this.
  // Order follows confidence — what the deck plays, then the manifest, then pages.
  const referenced = orderedUnique([...deckRefs, ...manifestFiles, ...pageFiles, ...recordFiles])
  const files = referenced.length ? referenced : diskSlides
  const skipped = diskSlides.filter((f) => !files.includes(f))

  // ── Build the slide records, preserving ids/titles so the UI keeps its place ─
  const slides = []
  for (const file of files) {
    let title = titleByFile.get(file)
    if (!title) {
      try {
        title = titleFromSlideHtml(await readText(file), file)
      } catch (_) {
        title = String(file).split('/').pop().replace(/\.html?$/i, '') || 'Slide'
      }
    }
    slides.push({ id: idByFile.get(file) || newSlideId(slides), file, title })
  }

  return { slides, deckPage, readsManifest, skipped }
}