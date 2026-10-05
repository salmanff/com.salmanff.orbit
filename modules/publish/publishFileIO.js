/* global freezr */
/** Low-level file I/O for publishing: text/blob upload, draft reads, and the draft-to-public
 * sync of an explicit file list. */
import { fetchUserFile } from '../fileFetch.js'
import { draftPath, publicPath, uniqueRelPathsOrdered } from './publishPaths.js'

function isProbablyTextPath(p) {
  return /\.(html?|css|js|mjs|json|svg|txt|md|xml|map)$/i.test(p)
}

export async function uploadToPath(fullPath, text, blob, mimeOverride) {
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

/** Fetch a draft file's content as text or blob, choosing by its extension. Bearer-authenticated —
 * the ambient cookie no longer works for userfiles. */
export async function fetchDraftAsTextOrBlob(fullDraftPath) {
  const res = await fetchUserFile(fullDraftPath)
  if (isProbablyTextPath(fullDraftPath)) {
    return { kind: 'text', text: await res.text() }
  }
  return { kind: 'blob', blob: await res.blob() }
}

/**
 * Copy only listed relative paths from draft → public.
 * For the HTML entry file, `htmlRewrite` may provide a rewritten version with public image URLs.
 */
export async function syncDraftToPublicExplicit(projectName, relativePaths, htmlEntryRel, htmlRewrite, onWarning) {
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