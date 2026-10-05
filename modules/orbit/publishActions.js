/* global freezr */
/** Publishing and unpublishing pages and individual image assets. */
import { state, draftBasePath, draftRelFilePaths } from './state.js'
import { render, renderLeftPanel } from './bus.js'
import { persistProjectPages } from './projects.js'
import { refreshFileList } from './filesData.js'
import {
  publishProjectSite, unpublishProjectSite, isFilePublished,
  canonicalPublicIdForFilePath, browseUrlToPublicId
} from '../publishService.js'
import { fetchUserBlob } from '../fileFetch.js'

export function isPageDirty(page) {
  if (!page || !page.published || !page.published_at) return false
  const base = draftBasePath()
  const files = [page.html_file, ...(page.css_files || []), ...(page.js_files || [])].filter(Boolean)
  return files.some((rel) => {
    const mtime = state.fileMtimes[`${base}/${rel}`]
    return mtime && mtime > page.published_at
  })
}

async function rerenderLeftPanel(skip) {
  if (skip) return
  await renderLeftPanel({ canLlm: state.permissions.canLlm, canPublish: state.permissions.canPublish })
}

export async function runPublishPage(pageIndex, opts = {}) {
  const proj = state.currentProject
  const page = proj?.pages?.[pageIndex]
  if (!proj || !page) return
  if (!state.permissions.canPublish) {
    window.alert('You need to grant the publish_site permission first (see the banner above, or App Settings).')
    return
  }
  const warnings = []
  try {
    await refreshFileList()
    const url = await publishProjectSite(proj, page, {
      projectFileRels: draftRelFilePaths(),
      meta: page.meta || {},
      customPublicId: page.custom_public_id || undefined,
      onWarning: (msg) => warnings.push(msg)
    })
    page.published = true
    page.public_url = url
    page.published_at = Date.now()
    await persistProjectPages(proj)
    await rerenderLeftPanel(opts.skipUiRefresh)
    if (warnings.length) {
      window.alert(`Published, but ${warnings.length} file(s) had problems:\n\n` + warnings.join('\n'))
    }
  } catch (e) {
    console.error('Orbit: publish failed', e)
    window.alert('Publish failed: ' + (e.message || String(e)))
  }
}

export async function runUnpublishPage(pageIndex, opts = {}) {
  const proj = state.currentProject
  const page = proj?.pages?.[pageIndex]
  if (!proj || !page) return
  try {
    await unpublishProjectSite(proj, page, {})
    page.published = false
    page.public_url = null
    delete page.published_at
    await persistProjectPages(proj)
    await rerenderLeftPanel(opts.skipUiRefresh)
  } catch (e) {
    console.error('Orbit: unpublish failed', e)
    window.alert('Unpublish failed: ' + (e.message || String(e)))
  }
}

export async function assetUrlsForDraftPath(fullPath) {
  const proj = state.currentProject
  if (!proj || !fullPath) return { privateUrl: '', publicUrl: '', isPublished: false }
  const base = draftBasePath()
  const rel = fullPath.startsWith(base + '/') ? fullPath.slice(base.length + 1) : fullPath
  const publicFull = `projects/${proj.name}/public/${rel}`
  let privateUrl = ''
  try { privateUrl = (await freezr.utils.tokenizedFileUrl(fullPath)) || '' } catch (_) {}
  let isPublished = false
  try { isPublished = await isFilePublished(publicFull) } catch (_) {}
  const publicUrl = isPublished ? browseUrlToPublicId(canonicalPublicIdForFilePath(publicFull)) : ''
  return { privateUrl, publicUrl, isPublished }
}

export async function publishImageFile(fullPath) {
  const proj = state.currentProject
  if (!proj || !fullPath) return
  if (!state.permissions.canPublish) { window.alert('Grant the publish_site permission first.'); return }
  const base = draftBasePath()
  const rel = fullPath.startsWith(base + '/') ? fullPath.slice(base.length + 1) : fullPath
  const lastSlash = rel.lastIndexOf('/')
  const folder = `projects/${proj.name}/public` + (lastSlash >= 0 ? '/' + rel.slice(0, lastSlash) : '')
  const name = lastSlash >= 0 ? rel.slice(lastSlash + 1) : rel
  const publicFull = `projects/${proj.name}/public/${rel}`
  try {
    const blob = await fetchUserBlob(fullPath)
    const file = new File([blob], name, { type: blob.type || 'application/octet-stream' })
    await freezr.upload(file, { targetFolder: folder, overwrite: true })
    await freezr.perms.shareFilePublicly(publicFull, { name: 'publish_site', grant: true, doNotList: true })
    await render()
  } catch (e) {
    console.error('Orbit: publish image failed', e)
    window.alert('Publish failed: ' + (e.message || String(e)))
  }
}

export async function unpublishImageFile(fullPath) {
  const proj = state.currentProject
  if (!proj || !fullPath) return
  const base = draftBasePath()
  const rel = fullPath.startsWith(base + '/') ? fullPath.slice(base.length + 1) : fullPath
  const publicFull = `projects/${proj.name}/public/${rel}`
  try {
    await freezr.perms.shareFilePublicly(publicFull, { name: 'publish_site', action: 'deny', grant: false })
    await render()
  } catch (e) {
    console.error('Orbit: unpublish image failed', e)
    window.alert('Unpublish failed: ' + (e.message || String(e)))
  }
}