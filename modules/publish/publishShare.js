/* global freezr, freezrMeta */
/** Sharing, canonical public ids, and file-record lookups used across the publish pipeline. */
import { normalizeRelPath, publicPath } from './publishPaths.js'

export const PUBLISH_PERM = 'publish_site'

function normalizeQueryRows(rows) {
  if (Array.isArray(rows)) return rows
  if (rows && Array.isArray(rows.data)) return rows.data
  return []
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

export function publicIdFromShareResponse(res, fullPath) {
  if (!res) return canonicalPublicIdForFilePath(fullPath)
  const pid = res._publicid || res.publicid
  if (pid) return pid
  return canonicalPublicIdForFilePath(fullPath)
}

/**
 * Share one file with publish_site; return its public id string for fileStructure.
 */
export async function sharePublicFileForPublish(fullPath) {
  const res = await freezr.perms.shareFilePublicly(fullPath, {
    name: PUBLISH_PERM,
    grant: true,
    doNotList: true
  })
  return publicIdFromShareResponse(res, fullPath)
}

export function getPublishSiteAccessible(fileRecord) {
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

export async function loadFileRecord(fullPath) {
  let rows = await freezr.query('files', { _id: fullPath }, {})
  let rec = normalizeQueryRows(rows)[0] || null
  if (!rec) {
    rows = await freezr.query('files', { $or: [{ _id: fullPath }, { name: fullPath }] }, {})
    rec = normalizeQueryRows(rows)[0] || null
  }
  return rec
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