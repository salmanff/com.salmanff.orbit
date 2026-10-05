/**
 * Pinning relative URLs in the PUBLISHED copy of a page.
 *
 * A published page is served from whatever public id it was shared under. With the canonical id
 * (@user/app.files/projects/<name>/public/index.html) the page sits in the same folder as the files
 * it ships with, so a relative path a page fetches at run time — a slide deck reading slides.json,
 * a page loading a data file — resolves correctly by accident.
 *
 * With a CUSTOM short public id (/why2026) it does not: the browser resolves the same relative path
 * against the short URL, asks the server for /slides.json, and the server answers with an HTML error
 * page. That is why the failure surfaces inside the page as
 *   "Unexpected token '<', "<!DOCTYPE "... is not valid JSON"
 * rather than as a 404 — the fetch succeeded, it just got HTML.
 *
 * Declared CSS/JS are unaffected (the public renderer injects those as absolute URLs from
 * fileStructure) and <img> srcs are rewritten to absolute public URLs at publish time, so a <base>
 * only governs what is left: the run-time fetches we need to fix.
 *
 * Pure string/URL work, no I/O.
 */
import { normalizeRelPath, publicPath } from './publishPaths.js'
import { canonicalPublicIdForFilePath, browseUrlToPublicId } from './publishShare.js'

/**
 * Absolute URL of the folder the entry page's published copy lives in, with a trailing slash.
 * @returns {string|null} null when it cannot be derived (caller should then skip injection)
 */
export function publicFolderBaseUrl(projectName, entryRel) {
  if (!projectName || !entryRel) return null
  const rel = normalizeRelPath(entryRel)
  if (!rel) return null
  const url = browseUrlToPublicId(canonicalPublicIdForFilePath(publicPath(projectName, rel)))
  if (!url) return null
  const cut = url.lastIndexOf('/')
  return cut >= 0 ? url.slice(0, cut + 1) : null
}

/**
 * Insert a <base href> into the published HTML.
 *
 * Orbit pages are body fragments, so the tag normally goes at the very top of the fragment; a page
 * that happens to be a full document gets it just inside <head> instead. A page that already
 * declares its own <base> is left alone — that is the author being explicit, and overriding it
 * would break them.
 */
export function injectPublicBase(html, baseUrl) {
  if (!baseUrl || typeof html !== 'string') return html
  if (/<base\b/i.test(html)) return html
  const tag = '<base href="' + String(baseUrl).replace(/"/g, '&quot;') + '">\n'
  const headOpen = html.search(/<head\b[^>]*>/i)
  if (headOpen >= 0 && /<\/head\s*>/i.test(html)) {
    const insertAt = html.indexOf('>', headOpen) + 1
    if (insertAt > 0) return html.slice(0, insertAt) + '\n' + tag + html.slice(insertAt)
  }
  return tag + html
}