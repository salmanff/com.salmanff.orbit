/**
 * Publish only the entry HTML + declared dependencies (projects page css_files / js_files).
 * Images referenced inside the HTML are also published and their srcs rewritten in the
 * public copy (the draft copy is left untouched).
 * Uses share_records with isHtmlMainPage + fileStructure so the public site can serve HTML + assets
 * (see publicPageController — fileStructure.css/js entries carry `publicid`).
 */


import { fetchUserFile } from './fileFetch.js'

const PUBLISH_PERM = 'publish_site'

function normalizeQueryRows(rows) {
  if (Array.isArray(rows)) return rows
  if (rows && Array.isArray(rows.data)) return rows.data
  return []
}

function isProbablyTextPath(p) {
  return /\.(html?|css|js|mjs|json|svg|txt|md|xml|map)$/i.test(p)
}

function normalizeRelPath(p) {
  if (!p || typeof p !== 'string') return ''
  return p.replace(/^\/+/, '').replace(/\/+$/, '')
}

/** Unique relative paths, first occurrence wins (order preserved). */
function uniqueRelPathsOrdered(list) {
  const seen = new Set()
  const out = []
  for (const raw of list || []) {
    const n = normalizeRelPath(raw)
    if (!n || seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return out
}

/** Housekeeping files that are never part of the site. */
function isNotSiteContent(rel) {
  const name = rel.split('/').pop() || ''
  return name.startsWith('.')
}

/**
 * Relative paths under projects/{id}/draft|public that must be published for this page.
 *
 * The page's own html/css/js, PLUS every other file in the project folder. That
 * second part matters because a page can load files at runtime — a slide it
 * fetches, a JSON data file — and there is no way for it to authenticate: a
 * visitor to a published site is anonymous, so they cannot mint a fileToken.
 * The file has to genuinely BE public, which means it has to be copied and
 * shared here, whether or not anything declared it.
 *
 * The one exclusion is another page's entry HTML: each page has its own Publish
 * button and its own published/unpublished state, so publishing page A must not
 * quietly put page B on the web.
 *
 * @param {object} page
 * @param {string[]} [projectFileRels] - every file in the project draft folder,
 *   relative to the draft root. Omit and only the declared resources publish.
 * @param {object} [project] - used to find the other pages' entry HTML files.
 */
export function buildPublishRelativePaths(page, projectFileRels, project) {
  if (!page) return []
  const rels = []
  if (page.html_file) rels.push(normalizeRelPath(page.html_file))
  for (const p of page.css_files || []) rels.push(normalizeRelPath(p))
  for (const p of page.js_files || []) rels.push(normalizeRelPath(p))

  const otherPageHtml = new Set(
    (project?.pages || [])
      .filter((p) => p !== page)
      .map((p) => normalizeRelPath(p.html_file))
      .filter(Boolean)
  )
  for (const raw of projectFileRels || []) {
    const rel = normalizeRelPath(raw)
    if (!rel || otherPageHtml.has(rel) || isNotSiteContent(rel)) continue
    rels.push(rel)
  }
  return uniqueRelPathsOrdered(rels)
}

function draftPath(projectName, rel) {
  return `projects/${projectName}/draft/${rel}`
}

function publicPath(projectName, rel) {
  return `projects/${projectName}/public/${rel}`
}

async function uploadToPath(fullPath, text, blob, mimeOverride) {
  const last = fullPath.lastIndexOf('/')
  const folder = last >= 0 ? fullPath.slice(0, last) : ''
  const fileName = last >= 0 ? fullPath.slice(last + 1) : fullPath

  if (text !== undefined) {
    const mime = mimeOverride || 'text/plain'
    const blobObj = new Blob([text], { type: mime })
    const file = new File([blobObj], fileName, { type: mime })
    await freezr.upload(file, { targetFolder: folder, overwrite: true })
  } else if (blob) {
    const file = new File([blob], fileName, { type: blob.type || 'application/octet-stream' })
    await freezr.upload(file, { targetFolder: folder, overwrite: true })
  }
}

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
function rewriteImgSrcs(html, urlMap, projectName) {
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
function revertImgSrcs(html, reverseMap) {
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
async function publishHtmlImages(projectName, htmlContent) {
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
async function unpublishHtmlImages(projectName, publishedHtml) {
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
async function fetchPublishedHtml(projectName, rel) {
  try {
    const got = await fetchDraftAsTextOrBlob(publicPath(projectName, rel))
    return got.kind === 'text' ? got.text : null
  } catch (_) {
    return null
  }
}

async function fetchDraftAsTextOrBlob(draftPath) {
  // Bearer-authenticated — the ambient cookie no longer works for userfiles.
  const res = await fetchUserFile(draftPath)
  if (isProbablyTextPath(draftPath)) {
    return { kind: 'text', text: await res.text() }
  }
  return { kind: 'blob', blob: await res.blob() }
}

/**
 * Copy only listed relative paths from draft → public.
 * For the HTML entry file, `htmlRewrite` may provide a rewritten version with public image URLs.
 */
async function syncDraftToPublicExplicit(projectName, relativePaths, htmlEntryRel, htmlRewrite, onWarning) {
  const list = uniqueRelPathsOrdered(relativePaths)
  if (list.length === 0) {
    throw new Error('No files in publish set (page html / css / js).')
  }
  for (const rel of list) {
    const from = draftPath(projectName, rel)
    const to = publicPath(projectName, rel)
    const isEntry = rel === htmlEntryRel
    try {
      if (htmlRewrite && isEntry) {
        // Write the image-rewritten HTML to public (draft is unchanged)
        await uploadToPath(to, htmlRewrite, null, 'text/html')
      } else {
        const got = await fetchDraftAsTextOrBlob(from)
        if (got.kind === 'text') {
          await uploadToPath(to, got.text, null)
        } else {
          await uploadToPath(to, undefined, got.blob)
        }
      }
    } catch (e) {
      // The whole project folder is in the publish set now, so a single
      // awkward file — oversized, odd name, momentary network failure — must
      // not take the page down with it. The ENTRY html is the exception:
      // without it there is no page to serve.
      if (isEntry) throw e
      const msg = rel + ': ' + (e.message || String(e))
      console.warn('publishProjectSite: could not copy to public —', msg, e)
      if (onWarning) onWarning(msg)
    }
  }
}

export function canonicalPublicIdForFilePath(fullPath) {
  const uid = freezrMeta.userId
  const appFiles = freezrMeta.appName + '.files'
  return '@' + uid + '/' + appFiles + '/' + fullPath
}

export function browseUrlToPublicId(publicId) {
  if (!publicId) return null
  const base = window.location.origin.replace(/\/$/, '')
  if (publicId.startsWith('http')) return publicId
  const path = publicId.startsWith('/') ? publicId : '/' + publicId
  return base + path
}

function publicIdFromShareResponse(res, fullPath) {
  if (!res) return canonicalPublicIdForFilePath(fullPath)
  const pid = res._publicid || res.publicid
  if (pid) return pid
  return canonicalPublicIdForFilePath(fullPath)
}

/**
 * Share one file with publish_site; return its public id string for fileStructure.
 */
async function sharePublicFileForPublish(fullPath) {
  const res = await freezr.perms.shareFilePublicly(fullPath, {
    name: PUBLISH_PERM,
    grant: true,
    doNotList: true
  })
  return publicIdFromShareResponse(res, fullPath)
}

function getPublishSiteAccessible(fileRecord) {
  const acc = fileRecord._accessibles
  if (!Array.isArray(acc)) return null
  return (
    acc.find(
      (a) =>
        a.permission_name === PUBLISH_PERM &&
        a.grantee === '_public' &&
        a.granted !== false &&
        a.public_id
    ) ||
    acc.find((a) => a.grantee === '_public' && a.granted !== false && a.public_id) ||
    null
  )
}

async function loadFileRecord(fullPath) {
  let rows = await freezr.query('files', { _id: fullPath }, {})
  let rec = normalizeQueryRows(rows)[0] || null
  if (!rec) {
    rows = await freezr.query('files', { $or: [{ _id: fullPath }, { name: fullPath }] }, {})
    rec = normalizeQueryRows(rows)[0] || null
  }
  return rec
}

/**
 * Publish: sync explicit paths, share each CSS/JS asset, then share entry HTML with isHtmlMainPage + fileStructure.
 * Images referenced in the HTML are also published and their srcs rewritten in the public copy.
 * Returns public browse URL for the entry page.
 */
/**
 * @param {object} project
 * @param {object} page
 * @param {object} [opts]
 * @param {string} [opts.customPublicId] Admin-only custom slug for the public URL.
 * @param {string} [opts.previousPublicId] If the public ID changed, unpublish the old one first.
 * @param {boolean} [opts.forcePublicIdTakeover] If the chosen publicid is held by an orphaned/conflicting
 *   public record, delete it (and clean up the source `_accessibles` entry when same collection) instead of failing.
 * @param {string[]} [opts.projectFileRels] Every file in the project draft folder (relative to the
 *   draft root). Published alongside the declared resources so files the page fetches at runtime
 *   resolve on the live site — see buildPublishRelativePaths.
 * @param {(message: string) => void} [opts.onWarning] Called once per file that could not be
 *   copied or shared. These are not fatal — the page still publishes — but the caller should
 *   surface them, or a half-published site looks like a fully published one.
 */
export async function publishProjectSite(project, page, opts = {}) {
  if (!project?.name) throw new Error('Invalid project')
  if (!page?.html_file) throw new Error('Page must have html_file')

  const projectName = project.name
  const rels = buildPublishRelativePaths(page, opts.projectFileRels, project)
  if (rels.length === 0) throw new Error('Nothing to publish')

  if (opts.previousPublicId && opts.customPublicId && opts.previousPublicId !== opts.customPublicId) {
    try {
      await freezr.perms.unshareByPublicId(opts.previousPublicId, {
        name: PUBLISH_PERM,
        table_id: freezrMeta.appName + '.files',
        grantees: ['_public'],
        forcePublicIdCleanup: true
      })
    } catch (e) {
      console.warn('Orbit: could not revoke previous public id', opts.previousPublicId, e)
    }
  }

  // 1. Read draft HTML and publish any local images referenced inside it
  const entryRel = normalizeRelPath(page.html_file)
  let htmlForPublic = null
  let imageRels = []
  try {
    const draftHtmlResult = await fetchDraftAsTextOrBlob(draftPath(projectName, entryRel))
    if (draftHtmlResult.kind === 'text') {
      const { urlMap } = await publishHtmlImages(projectName, draftHtmlResult.text)
      imageRels = Object.keys(urlMap)
      // Always rewrite: maps draft images to public URLs AND strips any
      // ?fileToken= the in-app display may have left in the draft HTML.
      htmlForPublic = rewriteImgSrcs(draftHtmlResult.text, urlMap, projectName)
    }
  } catch (e) {
    console.warn('publishProjectSite: image scan failed', e)
  }

  // 2. Copy everything in the publish set to public. publishHtmlImages has
  // already copied and shared the <img>-referenced images, so skip those.
  const imageRelSet = new Set(imageRels)
  const warn = typeof opts.onWarning === 'function' ? opts.onWarning : null
  await syncDraftToPublicExplicit(
    projectName,
    rels.filter((rel) => !imageRelSet.has(rel)),
    entryRel,
    htmlForPublic,
    warn
  )

  const cssRels = uniqueRelPathsOrdered(page.css_files || [])
  const jsRels = uniqueRelPathsOrdered(page.js_files || [])

  const cssStructure = []
  for (const rel of cssRels) {
    const full = publicPath(projectName, rel)
    const pid = await sharePublicFileForPublish(full)
    cssStructure.push({ publicid: pid })
  }

  const jsStructure = []
  for (const rel of jsRels) {
    const full = publicPath(projectName, rel)
    const pid = await sharePublicFileForPublish(full)
    jsStructure.push({ publicid: pid })
  }

  // 3. Share the rest — files the page loads at runtime rather than declaring.
  // Nothing references them from the page skeleton, so they need no publicid
  // recorded; they just have to be publicly readable at their own URL. One
  // failure must not abort the publish: the page itself is still worth serving.
  const declared = new Set([entryRel, ...cssRels, ...jsRels, ...imageRels])
  for (const rel of rels) {
    if (declared.has(rel)) continue
    try {
      await sharePublicFileForPublish(publicPath(projectName, rel))
    } catch (e) {
      const msg = rel + ': ' + (e.message || String(e))
      console.warn('publishProjectSite: could not share runtime asset —', msg, e)
      if (warn) warn(msg)
    }
  }

  const entryPath = publicPath(projectName, entryRel)

  const fileStructure = {
    css: cssStructure,
    js: jsStructure,
    // Used by the public page renderer as a *page-title* fallback when the
    // user hasn't entered a meta.title. Prefer the page name over the project
    // name so the rendered <title> says "About" rather than the whole site.
    name: page.name || project.display_name || project.name || entryRel
  }

  const shareOpts = {
    name: PUBLISH_PERM,
    grant: true,
    isHtmlMainPage: true,
    fileStructure
  }
  if (opts.customPublicId) {
    shareOpts.publicid = opts.customPublicId
  }
  // Always send a meta object so the backend overwrites any stale value, and
  // default meta.title to the page name when the user hasn't typed one — the
  // Pages-tab Title input pre-fills with the page name as a hint, but only
  // saves to page.meta.title if the user actually edits it.
  {
    const incoming = (opts.meta && typeof opts.meta === 'object') ? opts.meta : {}
    const metaOut = { ...incoming }
    if (!metaOut.title) metaOut.title = page.name || project.display_name || project.name || ''
    shareOpts.meta = metaOut
  }
  if (opts.forcePublicIdTakeover) {
    shareOpts.forcePublicIdTakeover = true
  }

  const shareRes = await freezr.perms.shareFilePublicly(entryPath, shareOpts)

  const entryPid = publicIdFromShareResponse(shareRes, entryPath)
  const url = browseUrlToPublicId(entryPid)
  if (!url) throw new Error('Could not build public URL for entry page')
  return url
}

/**
 * Unpublish: revoke publish_site for the entry HTML only.
 * CSS/JS files are intentionally NOT un-shared here — they may be used by other pages.
 * Image files referenced in the published HTML are un-shared.
 * Un-sharing individual CSS/JS/image files can be done from the Files panel.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.forcePublicIdCleanup] If a record is gone but a public record
 *   still exists for its canonical publicid, delete the orphan instead of leaving it.
 */
export async function unpublishProjectSite(project, page, opts = {}) {
  if (!project?.name || !page?.html_file) return

  const projectName = project.name
  const entryRel = normalizeRelPath(page.html_file)
  const entryPath = publicPath(projectName, entryRel)

  // Un-share the entry HTML
  try {
    const rec = await loadFileRecord(entryPath)
    if (rec && rec._id) {
      await freezr.perms.shareFilePublicly(rec._id, {
        name: PUBLISH_PERM,
        action: 'deny',
        grant: false
      })
    } else {
      const pubId = canonicalPublicIdForFilePath(entryPath)
      await freezr.perms.unshareByPublicId(pubId, {
        name: PUBLISH_PERM,
        table_id: freezrMeta.appName + '.files',
        grantees: ['_public'],
        forcePublicIdCleanup: opts.forcePublicIdCleanup === true
      })
    }
  } catch (e) {
    console.warn('Orbit unpublish entry HTML', entryPath, e)
  }

  // Un-share images that were embedded in the published HTML
  try {
    const publishedHtml = await fetchPublishedHtml(projectName, entryRel)
    if (publishedHtml) {
      await unpublishHtmlImages(projectName, publishedHtml)
    }
  } catch (e) {
    console.warn('Orbit unpublish images', e)
  }
}

/**
 * Un-share a single file (any type) from the publish_site permission.
 * Used from the Files panel "Unpublish" button.
 */
export async function unpublishSingleFile(fullPublicPath, opts = {}) {
  try {
    const rec = await loadFileRecord(fullPublicPath)
    if (rec && rec._id) {
      await freezr.perms.shareFilePublicly(rec._id, {
        name: PUBLISH_PERM,
        action: 'deny',
        grant: false
      })
    } else {
      const pubId = canonicalPublicIdForFilePath(fullPublicPath)
      await freezr.perms.unshareByPublicId(pubId, {
        name: PUBLISH_PERM,
        table_id: freezrMeta.appName + '.files',
        grantees: ['_public'],
        forcePublicIdCleanup: true
      })
    }
    return { success: true }
  } catch (e) {
    console.warn('unpublishSingleFile', fullPublicPath, e)
    return { success: false, error: e.message || String(e) }
  }
}

/**
 * Check whether the public version of a file is currently shared with `_public`.
 * Returns true/false.
 */
export async function isFilePublished(fullPublicPath) {
  try {
    const rec = await loadFileRecord(fullPublicPath)
    if (!rec) return false
    const acc = rec._accessibles
    if (!Array.isArray(acc)) return false
    return acc.some(
      a => a.grantee === '_public' && a.granted !== false && a.permission_name === PUBLISH_PERM
    )
  } catch (_) {
    return false
  }
}

/**
 * Compute the default public-id path for a page's entry HTML.
 * Admin users can override this with a custom slug.
 */
export function defaultPublicIdForPage(projectName, page) {
  if (!projectName || !page?.html_file) return ''
  const rel = normalizeRelPath(page.html_file)
  const fullPath = publicPath(projectName, rel)
  return canonicalPublicIdForFilePath(fullPath)
}

export async function hasPublishPermission() {
  try {
    const perms = await freezr.perms.getAppPermissions()
    const list = Array.isArray(perms) ? perms : []
    const p = list.find((x) => x.name === PUBLISH_PERM)
    return !!(p && p.granted)
  } catch (_) {
    return false
  }
}
