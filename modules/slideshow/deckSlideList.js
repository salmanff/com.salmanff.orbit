/**
 * Rewriting a deck's OWN hardcoded slide list.
 *
 * Most decks read slides.json, and for those there is nothing to do. A hand-written deck
 * often keeps its slide list as a literal array in its JS (or inline in its HTML), and
 * such a deck ignores slides.json entirely — so reordering in the Slides tab would appear
 * to do nothing. This module edits that literal in place, leaving the deck's runtime, DOM
 * contract and styling exactly as they are.
 *
 * It never guesses. A rewrite happens only when exactly one array literal can be pinned
 * down as the slide list; otherwise the caller is told nothing could be done, and the user
 * is asked to have Chat switch the deck over to slides.json instead.
 *
 * Pure: no DOM, no I/O.
 */

const QUOTES = { "'": true, '"': true, '`': true }
const HTML_RE = /\.html?$/i
const TITLE_KEYS = new Set(['title', 'name', 'label', 'caption'])
const ID_KEYS = new Set(['id', 'key', 'slug'])

/** Index of the closing quote of the string starting at `i`, or -1 if unterminated. */
function skipString(src, i) {
  const q = src[i]
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue }
    if (src[j] === q) return j
  }
  return -1
}

/** Index of the `]` matching the `[` at `start`, or -1. Skips strings and comments. */
function findMatching(src, start) {
  let depth = 0
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (QUOTES[c]) {
      const end = skipString(src, i)
      if (end < 0) return -1
      i = end
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      if (end < 0) return -1
      i = end + 1
      continue
    }
    if (c === '[' || c === '{' || c === '(') depth++
    else if (c === ']' || c === '}' || c === ')') {
      depth--
      if (depth === 0) return i
      if (depth < 0) return -1
    }
  }
  return -1
}

/** Split on commas at nesting depth 0, respecting strings. */
function splitTop(inner) {
  const out = []
  let depth = 0
  let from = 0
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (QUOTES[c]) {
      const end = skipString(inner, i)
      if (end < 0) return null
      i = end
      continue
    }
    if (c === '[' || c === '{' || c === '(') depth++
    else if (c === ']' || c === '}' || c === ')') depth--
    else if (c === ',' && depth === 0) {
      out.push(inner.slice(from, i))
      from = i + 1
    }
  }
  out.push(inner.slice(from))
  return out.map((s) => s.trim()).filter((s) => s.length > 0)
}

/** A whole-token string literal -> its value, else null. */
function parseString(token) {
  const t = token.trim()
  if (t.length < 2 || !QUOTES[t[0]] || t[t.length - 1] !== t[0]) return null
  if (skipString(t, 0) !== t.length - 1) return null
  const raw = t.slice(1, -1)
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '\\') { out += raw[i]; continue }
    const n = raw[++i]
    out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n
  }
  return { quote: t[0], value: out }
}

/** A flat object literal of string values -> ordered entries, else null. */
function parseObject(token) {
  const t = token.trim()
  if (t[0] !== '{' || t[t.length - 1] !== '}') return null
  const parts = splitTop(t.slice(1, -1))
  if (!parts || !parts.length) return null
  const entries = []
  for (const part of parts) {
    let colon = -1
    let depth = 0
    for (let i = 0; i < part.length; i++) {
      const c = part[i]
      if (QUOTES[c]) {
        const end = skipString(part, i)
        if (end < 0) return null
        i = end
        continue
      }
      if (c === '[' || c === '{' || c === '(') depth++
      else if (c === ']' || c === '}' || c === ')') depth--
      else if (c === ':' && depth === 0) { colon = i; break }
    }
    if (colon < 0) return null
    const rawKey = part.slice(0, colon).trim()
    const value = parseString(part.slice(colon + 1))
    if (!value) return null
    const quotedKey = QUOTES[rawKey[0]] ? parseString(rawKey) : null
    if (QUOTES[rawKey[0]] && !quotedKey) return null
    const key = quotedKey ? quotedKey.value : rawKey
    if (!quotedKey && !/^[A-Za-z_$][\w$]*$/.test(key)) return null
    entries.push({ key, keyQuote: quotedKey ? quotedKey.quote : null, value: value.value, quote: value.quote })
  }
  return entries
}

/**
 * Parse an array literal into a slide-list shape, or null when it is not one.
 * Two shapes are accepted: an array of html path strings, and an array of flat objects
 * whose keys Orbit can regenerate (a path, an optional title, an optional id).
 */
function parseArray(literal) {
  const inner = literal.slice(1, -1)
  const parts = splitTop(inner)
  if (!parts || !parts.length) return null

  // Shape 1: plain strings.
  const strings = parts.map(parseString)
  if (strings.every((s) => s)) {
    if (!strings.every((s) => HTML_RE.test(s.value))) return null
    return {
      shape: 'string',
      files: strings.map((s) => s.value),
      quote: strings[0].quote,
      multiline: inner.includes('\n')
    }
  }

  // Shape 2: flat objects with a consistent key set.
  const objects = parts.map(parseObject)
  if (!objects.every((o) => o)) return null
  const keys = objects[0].map((e) => e.key)
  for (const obj of objects) {
    if (obj.length !== keys.length) return null
    if (!obj.every((e, i) => e.key === keys[i])) return null
  }
  const fileKey = keys.find((k) => objects.every((o) => HTML_RE.test(o.find((e) => e.key === k).value)))
  if (!fileKey) return null
  // Anything Orbit cannot regenerate would be silently lost on rewrite, so refuse instead.
  const known = keys.every((k) => k === fileKey || TITLE_KEYS.has(k) || ID_KEYS.has(k))
  if (!known) return null
  return {
    shape: 'object',
    files: objects.map((o) => o.find((e) => e.key === fileKey).value),
    keys: objects[0].map((e) => ({ key: e.key, keyQuote: e.keyQuote })),
    fileKey,
    quote: objects[0][0].quote,
    multiline: inner.includes('\n')
  }
}

/** Every array literal in `src` that parses as a slide list, in source order. */
export function findSlideListLiterals(src) {
  const text = String(src || '')
  const out = []
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (QUOTES[c]) {
      const end = skipString(text, i)
      if (end < 0) break
      i = end
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end < 0) break
      i = end + 1
      continue
    }
    if (c !== '[') continue
    const end = findMatching(text, i)
    if (end < 0) continue
    const parsed = parseArray(text.slice(i, end + 1))
    if (parsed) {
      out.push({ start: i, end, ...parsed })
      i = end
    }
  }
  return out
}

function emitString(value, quote) {
  const escaped = String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .split(quote).join('\\' + quote)
    .replace(/\n/g, '\\n')
  return quote + escaped + quote
}

function emitEntry(slide, found) {
  if (found.shape === 'string') return emitString(slide.file, found.quote)
  const pairs = found.keys.map(({ key, keyQuote }) => {
    const value = key === found.fileKey
      ? slide.file
      : TITLE_KEYS.has(key)
        ? (slide.title || '')
        : slide.id
    const name = keyQuote ? emitString(key, keyQuote) : key
    return name + ': ' + emitString(value, found.quote)
  })
  return '{ ' + pairs.join(', ') + ' }'
}

/** Indentation of the line containing `index`. */
function lineIndent(src, index) {
  const from = src.lastIndexOf('\n', index) + 1
  const m = /^[ \t]*/.exec(src.slice(from, index))
  return m ? m[0] : ''
}

/**
 * Rewrite a deck source's hardcoded slide list to match `slides`.
 *
 * @param {string} text - the deck's HTML or JS source
 * @param {Array<{id: string, file: string, title: string}>} slides
 * @returns {{text: string, changed: boolean}|null} null when no single literal is certain
 */
export function rewriteSlideList(text, slides) {
  const src = String(text || '')
  const list = (slides || []).filter((s) => s && s.file)
  if (!list.length) return null

  const found = findSlideListLiterals(src)
  if (!found.length) return null

  // A literal that already mentions one of this project's slides IS the slide list; that
  // beats any positional heuristic. Failing that, one unambiguous multi-entry array will do.
  const known = new Set(list.map((s) => s.file))
  const confirmed = found.filter((f) => f.files.some((file) => known.has(file)))
  let target = null
  if (confirmed.length === 1) target = confirmed[0]
  else if (confirmed.length === 0 && found.length === 1 && found[0].files.length > 1) target = found[0]
  if (!target) return null

  const original = src.slice(target.start, target.end + 1)
  const entries = list.map((slide) => emitEntry(slide, target))

  let literal
  if (target.multiline) {
    const openIndent = lineIndent(src, target.start)
    const firstEntryAt = src.indexOf('\n', target.start)
    const entryIndent = firstEntryAt >= 0 && firstEntryAt < target.end
      ? lineIndent(src, src.slice(0, target.end).search(/\S(?![\s\S]*\n[ \t]*\S)/) >= 0 ? target.end : target.end)
      : openIndent + '  '
    const indent = entryIndent.length > openIndent.length ? entryIndent : openIndent + '  '
    literal = '[\n' + entries.map((e) => indent + e).join(',\n') + '\n' + openIndent + ']'
  } else {
    literal = '[' + entries.join(', ') + ']'
  }

  return {
    text: src.slice(0, target.start) + literal + src.slice(target.end + 1),
    changed: literal !== original
  }
}