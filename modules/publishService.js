/**
 * Publish only the entry HTML + declared dependencies (projects page css_files / js_files).
 * Images referenced inside the HTML are also published and their srcs rewritten in the
 * public copy (the draft copy is left untouched).
 * Uses share_records with isHtmlMainPage + fileStructure so the public site can serve HTML + assets
 * (see publicPageController — fileStructure.css/js entries carry `publicid`).
 */


const PUBLISH_PERM = 'publish_site'

function normalizeQueryRows(rows) {
  if (Array.isArray(rows)) return rows
  if (rows && Array.isArray(rows.data)) return rows.data
  return []
}

function fepsUrl(relPath) {
  const path = freezr.getFileUrl(relPath)
  return path.startsWith('http') ? path : window.location.origin + path
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

/**
 * Relative paths under projects/{id}/draft|public that must exist for this page.
 */
export function buildPublishRelativePaths(page) {
  if (!page) return []
  const rels = []
  if (page.html_file) rels.push(normalizeRelPath(page.html_file))
  for (const p of page.css_files || []) rels.push(normalizeRelPath(p))
  for (const p of page.js_files || []) rels.push(normalizeRelPath(p))
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
 * Extract all local image src values from an HTML string.
 * Returns an array of unique relative paths (skips data: URIs, absolute URLs, and empty strings).
 */
function extractLocalImgSrcs(html) {
  const srcs = new Set()
  // Match src="..." and src='...' in <img> tags
  const re = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi
  let m
  while ((m = re.exec(html)) !== null) {
    const src = m[1].trim()
    if (!src || src.startsWith('data:') || /^https?:\/\//i.test(src) || src.startsWith('//')) continue
    // Strip leading /
    const clean = src.replace(/^\/+/, '')
    srcs.add(clean)
  }
  return [...srcs]
}

/**
 * Given an HTML string and a map of { draftRelPath → publicUrl },
 * replace every matching local img src with its public URL.
 */
function rewriteImgSrcs(html, urlMap) {
  return html.replace(/<img\b([^>]*)\bsrc\s*=\s*(["'])([^"']+)\2([^>]*)>/gi, (full, pre, q, src, post) => {
    const clean = src.trim().replace(/^\/+/, '')
    const replacement = urlMap[clean]
    if (replacement) return `<img${pre}src=${q}${replacement}${q}${post}>`
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
  const localSrcs = extractLocalImgSrcs(htmlContent)
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
 * Un-share all image files found in the published HTML.
 * Does NOT un-share CSS/JS files.
 */
async function unpublishHtmlImages(projectName, publishedHtml) {
  const localSrcs = extractLocalImgSrcs(publishedHtml)
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
  const res = await fetch(fepsUrl(draftPath), { credentials: 'include' })
  if (!res.ok) throw new Error(`Fetch failed ${draftPath}: ${res.status}`)
  if (isProbablyTextPath(draftPath)) {
    return { kind: 'text', text: await res.text() }
  }
  return { kind: 'blob', blob: await res.blob() }
}

/**
 * Copy only listed relative paths from draft → public.
 * For the HTML entry file, `htmlRewrite` may provide a rewritten version with public image URLs.
 */
async function syncDraftToPublicExplicit(projectName, relativePaths, htmlEntryRel, htmlRewrite) {
  const list = uniqueRelPathsOrdered(relativePaths)
  if (list.length === 0) {
    throw new Error('No files in publish set (page html / css / js).')
  }
  for (const rel of list) {
    const from = draftPath(projectName, rel)
    const to = publicPath(projectName, rel)
    if (htmlRewrite && rel === htmlEntryRel) {
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
 */
export async function publishProjectSite(project, page, opts = {}) {
  if (!project?.name) throw new Error('Invalid project')
  if (!page?.html_file) throw new Error('Page must have html_file')

  const projectName = project.name
  const rels = buildPublishRelativePaths(page)
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
  try {
    const draftHtmlResult = await fetchDraftAsTextOrBlob(draftPath(projectName, entryRel))
    if (draftHtmlResult.kind === 'text') {
      const { urlMap } = await publishHtmlImages(projectName, draftHtmlResult.text)
      if (Object.keys(urlMap).length > 0) {
        htmlForPublic = rewriteImgSrcs(draftHtmlResult.text, urlMap)
      }
    }
  } catch (e) {
    console.warn('publishProjectSite: image scan failed', e)
  }

  // 2. Copy all declared files (HTML, CSS, JS) to public
  await syncDraftToPublicExplicit(projectName, rels, entryRel, htmlForPublic)

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
