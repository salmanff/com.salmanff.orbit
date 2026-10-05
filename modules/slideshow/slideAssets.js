/**
 * Working out which files a single slide — and only that slide — uses.
 *
 * Deleting a slide should take its own image, its own stylesheet, its own snippet of JS with
 * it. It must NOT take a file that any other slide, or the deck itself, still needs. There is
 * no manifest of per-slide assets to consult, so this reads the sources and compares: what the
 * doomed slide reaches, minus what everything else reaches, minus the things that are never
 * deletable (the deck's own files, slides.json, other slides' html).
 *
 * The bias throughout is towards KEEPING a file. A missed orphan leaves a stray file the user
 * can delete from the Files tab; a false orphan silently breaks a slide that still works. So
 * the "used elsewhere" side of the comparison is deliberately over-generous — in JS, any quoted
 * string that looks like a path counts as a reference.
 *
 * Paths inside a slide are relative to the PROJECT ROOT (that is the contract the deck runtime
 * and Chat both follow), so every path here is draft-relative.
 *
 * Pure except for the injected `readText`.
 */

const NEVER_DELETE = new Set(['slides.json'])

/** A reference as written -> a draft-relative path, or null when it is not one of our files. */
function normalizeRef(raw) {
  let s = String(raw || '').trim()
  if (!s) return null
  // Absolute or non-file schemes: http:, https:, data:, blob:, mailto:, tel:, #fragment.
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null
  if (s.startsWith('//') || s.startsWith('#')) return null
  s = s.split('#')[0].split('?')[0].trim()
  if (!s) return null
  // Root-relative and parent-relative paths are not draft-relative project files.
  if (s.startsWith('/') || s.startsWith('../')) return null
  s = s.replace(/^\.\//, '')
  return s || null
}

/** Paths referenced by markup or stylesheet text, in source order (duplicates possible). */
export function extractRefs(text) {
  const src = String(text || '')
  const out = []
  let m

  // src="…" href='…' poster="…" data-src="…" srcset="a.png 1x, b.png 2x"
  const attr = /\b(?:src|href|poster|data-src|srcset|data-href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
  while ((m = attr.exec(src))) {
    const value = m[1] != null ? m[1] : m[2]
    for (const part of String(value).split(',')) {
      const first = part.trim().split(/\s+/)[0]
      const ref = normalizeRef(first)
      if (ref) out.push(ref)
    }
  }

  // url(…) in inline styles and stylesheets
  const cssUrl = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]+))\s*\)/gi
  while ((m = cssUrl.exec(src))) {
    const ref = normalizeRef(m[1] != null ? m[1] : (m[2] != null ? m[2] : m[3]))
    if (ref) out.push(ref)
  }

  // @import "…" / @import url("…")
  const cssImport = /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)')/gi
  while ((m = cssImport.exec(src))) {
    const ref = normalizeRef(m[1] != null ? m[1] : m[2])
    if (ref) out.push(ref)
  }

  return out
}

/** Anything in JS that merely LOOKS like a path counts — this side must not under-report. */
function extractQuotedPaths(text) {
  const src = String(text || '')
  const out = []
  const re = /['"`]\s*([^'"`\s<>]+\.[A-Za-z0-9]{1,6})\s*['"`]/g
  let m
  while ((m = re.exec(src))) {
    const ref = normalizeRef(m[1])
    if (ref) out.push(ref)
  }
  return out
}

function refsIn(rel, text) {
  return /\.m?js$/i.test(rel) ? extractQuotedPaths(text) : extractRefs(text)
}

/**
 * Every draft-relative path reachable from `seeds`, following stylesheets one step onward
 * (a slide's CSS may itself pull in a background image or @import another sheet).
 * The seeds themselves are not included.
 */
async function collectRefs(seeds, readText, onDisk) {
  const found = new Set()
  const seen = new Set()
  const queue = [...(seeds || [])].filter(Boolean)

  while (queue.length) {
    const rel = queue.shift()
    if (!rel || seen.has(rel)) continue
    seen.add(rel)
    if (!onDisk.has(rel)) continue
    if (!/\.(html?|css|m?js)$/i.test(rel)) continue

    let text
    try {
      text = await readText(rel)
    } catch (_) {
      continue // an unreadable source is one source fewer, never a reason to delete more
    }

    for (const ref of refsIn(rel, text)) {
      found.add(ref)
      if (/\.css$/i.test(ref)) queue.push(ref)
    }
  }

  return found
}

/**
 * Files that the given slide references and nothing else in the project does.
 *
 * @param {object} opts
 * @param {{ id: string, file: string, title: string }} opts.slide - the slide being deleted
 * @param {Array} opts.otherSlides - every slide that is staying
 * @param {object|null} opts.deckPage - the deck page (html_file, css_files, js_files)
 * @param {string[]} opts.existingRels - every file in the draft folder, draft-relative
 * @param {(rel: string) => Promise<string>} opts.readText
 * @returns {Promise<string[]>} draft-relative paths, sorted; safe to delete
 */
export async function findOrphanSlideAssets({ slide, otherSlides, deckPage, existingRels, readText }) {
  if (!slide || !slide.file) return []
  const onDisk = new Set(existingRels || [])

  const deckFiles = deckPage
    ? [deckPage.html_file, ...(deckPage.css_files || []), ...(deckPage.js_files || [])].filter(Boolean)
    : []

  // Things that are never this slide's to delete, whatever the references say.
  const protectedRels = new Set([...NEVER_DELETE, ...deckFiles, slide.file])
  for (const s of otherSlides || []) if (s && s.file) protectedRels.add(s.file)

  const mine = await collectRefs([slide.file], readText, onDisk)
  if (!mine.size) return []

  const theirSeeds = [
    ...(otherSlides || []).map((s) => s && s.file).filter(Boolean),
    ...deckFiles
  ]
  const theirs = await collectRefs(theirSeeds, readText, onDisk)

  return [...mine]
    .filter((rel) => onDisk.has(rel) && !protectedRels.has(rel) && !theirs.has(rel))
    .sort()
}