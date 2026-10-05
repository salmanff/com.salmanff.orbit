/* global freezr, freezrMeta */
/**
 * Publishing and un-publishing images embedded in a page's HTML: finding draft-local <img> srcs,
 * copying/sharing them to public, rewriting the HTML to point at the public copies, and the
 * reverse for unpublish.
 */
import { uploadToPath, fetchDraftAsTextOrBlob } from './publishFileIO.js'
import { draftPath, publicPath } from './publishPaths.js'
import { sharePublicFileForPublish, browseUrlToPublicId, loadFileRecord, PUBLISH_PERM } from './publishShare.js'

/**
 * Normalize an <img> src found in draft HTML to a path relative to the draft
 * root, or null when it isn't a draft file (data:/blob:/external URLs, and
 * other absolute paths such as already-public URLs).
 * Handles plain relative paths, root-relative /feps/userfiles/... paths and
 * same-origin absolute userfiles URLs. Any query string — including a
 * ?fileToken= inserted for in-app display — is dropped, so tokens never
 * survive into the public copy.
 */
function draftRelFromImgSrc(src, projectName) {
  let s = (src || '').trim()
  if (!s || s.startsWith('data:') || s.startsWith('blob:') || s.startsWith('//')) return null
  if (/^https?:\/\//i.test(s)) {
    if (!s.startsWith(window.location.origin + '/')) return null
    try { s = new URL(s).pathname } catch (_) { return null }
  }
  s = s.split('#')[0].split('?')[0]
  const userfilesPrefix = `/feps/userfiles/${freezrMeta.appName}/${freezrMeta.userId}/`
  if (s.startsWith(userfilesPrefix)) s = s.slice(userfilesPrefix.length)
  // Other server routes (another app's userfiles, public @-URLs, APIs) are not draft files.
  else if (s.startsWith('/feps/') || s.startsWith('/ceps/') || s.startsWith('/@')) return null
  s = s.replace(/^\/+/, '')
  const draftPrefix = `projects/${projectName}/draft/`
  if (s.startsWith(draftPrefix)) return s.slice(draftPrefix.length)
  return s
}

/** Drop any fileToken=… parameter from a URL, preserving other query params. */
function stripFileToken(src) {
  const qIdx = src.indexOf('?')
  if (qIdx < 0 || src.indexOf('fileToken=') < 0) return src
  const path = src.slice(0, qIdx)
  const kept = src.slice(qIdx + 1).split('&').filter((p) => p && !p.startsWith('fileToken='))
  return kept.length ? path + '?' + kept.join('&') : path
}

/**
 * Extract all draft-local image srcs from an HTML string as draft-relative
 * paths (skips data: URIs, external URLs, and empty strings).
 */
function extractLocalImgSrcs(html, projectName) {
  const srcs = new Set()
  // Match src="..." and src='...' in <img> tags
  const re = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi
  let m
  while ((m = re.exec(html)) !== null) {
    const rel = draftRelFromImgSrc(m[1], projectName)
    if (rel) srcs.add(rel)
  }
  return [...srcs]
}

/**
 * Given an HTML string and a map of { draftRelPath → publicUrl },
 * replace every matching local img src with its public URL. Srcs that do not
 * map (e.g. an image whose publish failed) still get any fileToken stripped
 * so a token never appears in the public copy.
 */
export function rewriteImgSrcs(html, urlMap, projectName) {
  return html.replace(/<img\b([^>]*)\bsrc\s*=\s*(["'])([^"']+)\2([^>]*)>/gi, (full, pre, q, src, post) => {
    const rel = draftRelFromImgSrc(src, projectName)
    const replacement = rel ? urlMap[rel] : null
    if (replacement) return `<img${pre}src=${q}${replacement}${q}${post}>`
    const stripped = stripFileToken(src.trim())
    if (stripped !== src.trim()) return `<img${pre}src=${q}${stripped}${q}${post}>`
    return full
  })
}

/**
 * Given an HTML string and a map of { publicUrl → draftRelPath },
 * replace public image URLs back to draft-relative paths.
 */
export function revertImgSrcs(html, reverseMap) {
  return html.replace(/<img\b([^>]*)\bsrc\s*=\s*(["'])([^"']+)\2([^>]*)>/gi, (full, pre, q, src, post) => {
    const replacement = reverseMap[src.trim()]
    if (replacement) return `<img${pre}src=${q}${replacement}${q}${post}>`
    return full
  })
}

/**
 * Publish all local images found in the HTML string.
 * Copies each image from draft → public, shares it, returns:
 *   { urlMap: { draftRel → publicUrl }, reverseMap: { publicUrl → draftRel } }
 */
export async function publishHtmlImages(projectName, htmlContent) {
  const localSrcs = extractLocalImgSrcs(htmlContent, projectName)
  const urlMap = {}
  const reverseMap = {}

  for (const relSrc of localSrcs) {
    try {
      const from = draftPath(projectName, relSrc)
      const to = publicPath(projectName, relSrc)
      const got = await fetchDraftAsTextOrBlob(from)
      if (got.kind === 'text') {
        await uploadToPath(to, got.text, null)
      } else {
        await uploadToPath(to, undefined, got.blob)
      }
      const pid = await sharePublicFileForPublish(to)
      const publicUrl = browseUrlToPublicId(pid)
      if (publicUrl) {
        urlMap[relSrc] = publicUrl
        reverseMap[publicUrl] = relSrc
      }
    } catch (e) {
      console.warn('publishHtmlImages: skipping', relSrc, e)
    }
  }

  return { urlMap, reverseMap }
}

/**
 * Extract image srcs from PUBLISHED HTML that point at this project's public
 * copies (publish rewrites srcs to absolute public @-URLs, so the draft-local
 * extractor never matches them). Returns public-relative paths.
 */
function extractPublishedImageRels(html, projectName) {
  const rels = new Set()
  const publicPrefix = `/@${freezrMeta.userId}/${freezrMeta.appName}.files/projects/${projectName}/public/`
  const re = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi
  let m
  while ((m = re.exec(html)) !== null) {
    let s = m[1].trim()
    if (/^https?:\/\//i.test(s)) {
      try { s = new URL(s).pathname } catch (_) { continue }
    }
    s = s.split('#')[0].split('?')[0]
    if (s.startsWith(publicPrefix)) rels.add(s.slice(publicPrefix.length))
  }
  return [...rels]
}

/**
 * Un-share all image files found in the published HTML.
 * Does NOT un-share CSS/JS files.
 */
export async function unpublishHtmlImages(projectName, publishedHtml) {
  const localSrcs = new Set([
    ...extractLocalImgSrcs(publishedHtml, projectName),
    ...extractPublishedImageRels(publishedHtml, projectName)
  ])
  for (const relSrc of localSrcs) {
    const fullPath = publicPath(projectName, relSrc)
    try {
      const rec = await loadFileRecord(fullPath)
      if (rec && rec._id) {
        await freezr.perms.shareFilePublicly(rec._id, {
          name: PUBLISH_PERM,
          action: 'deny',
          grant: false
        })
      }
    } catch (e) {
      console.warn('unpublishHtmlImages: could not un-share', relSrc, e)
    }
  }
}

/**
 * Attempt to load the published HTML for a page. Returns null if not found.
 */
export async function fetchPublishedHtml(projectName, rel) {
  try {
    const got = await fetchDraftAsTextOrBlob(publicPath(projectName, rel))
    return got.kind === 'text' ? got.text : null
  } catch (_) {
    return null
  }
}