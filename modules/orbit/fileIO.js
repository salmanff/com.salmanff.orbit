/* global freezr */
/** Upload (text or binary), fetch and rename a single draft file by its full path. */
import { fetchUserText, fetchUserBlob } from '../fileFetch.js'

function splitPath(fullPath) {
  const idx = fullPath.lastIndexOf('/')
  return {
    folder: idx >= 0 ? fullPath.slice(0, idx) : '',
    name: idx >= 0 ? fullPath.slice(idx + 1) : fullPath
  }
}

/** Upload text content, overwriting whatever is at fullPath. */
export async function uploadText(fullPath, text, mime) {
  const { folder, name } = splitPath(fullPath)
  const mimeType = mime || 'text/plain'
  const blob = new Blob([text == null ? '' : text], { type: mimeType })
  const file = new File([blob], name, { type: mimeType })
  await freezr.upload(file, { targetFolder: folder, overwrite: true })
}

/** Upload a File/Blob to an EXACT path (the final path name always matches fullPath's basename). */
export async function uploadFile(fullPath, fileObject) {
  const { folder, name } = splitPath(fullPath)
  const needsRename = !fileObject.name || fileObject.name !== name
  const file = needsRename ? new File([fileObject], name, { type: fileObject.type }) : fileObject
  await freezr.upload(file, { targetFolder: folder, overwrite: true })
}

/** Fetch a draft (private) file's text content, tokenizing the request. */
export async function fetchText(fullPath) {
  return fetchUserText(fullPath)
}

/** Rename/move a file by copying its bytes to the new path then deleting the old one. */
export async function renameFileOnServer(oldFullPath, newFullPath) {
  const blob = await fetchUserBlob(oldFullPath)
  const { folder, name } = splitPath(newFullPath)
  const file = new File([blob], name, { type: blob.type || 'application/octet-stream' })
  await freezr.upload(file, { targetFolder: folder, overwrite: true })
  await freezr.deleteFile(oldFullPath)
}