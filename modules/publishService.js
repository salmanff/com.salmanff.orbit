/* global freezr, freezrMeta */
/**
 * Publish only the entry HTML + declared dependencies (projects page css_files / js_files).
 * Images referenced inside the HTML are also published and their srcs rewritten in the
 * public copy (the draft copy is left untouched).
 * Uses share_records with isHtmlMainPage + fileStructure so the public site can serve HTML + assets
 * (see publicPageController — fileStructure.css/js entries carry `publicid`).
 *
 * This file is the orchestrator for the two public entry points (publish/unpublish a page, and
 * single-file unpublish/status checks). Path handling, file I/O, image publishing and sharing are
 * split out into ./publish/* — see those files for the per-concern logic.
 */
import {
  normalizeRelPath, uniqueRelPathsOrdered, buildPublishRelativePaths, draftPath, publicPath
} from './publish/publishPaths.js'
import { fetchDraftAsTextOrBlob, syncDraftToPublicExplicit } from './publish/publishFileIO.js'
import {
  publishHtmlImages, rewriteImgSrcs, unpublishHtmlImages, fetchPublishedHtml
} from './publish/publishImages.js'
import {
  PUBLISH_PERM, canonicalPublicIdForFilePath, browseUrlToPublicId, publicIdFromShareResponse,
  sharePublicFileForPublish, loadFileRecord, defaultPublicIdForPage, hasPublishPermission
} from './publish/publishShare.js'

export {
  buildPublishRelativePaths, canonicalPublicIdForFilePath, browseUrlToPublicId,
  defaultPublicIdForPage, hasPublishPermission
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