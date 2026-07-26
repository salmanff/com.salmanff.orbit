/**
 * Authenticated access to private userfiles.
 *
 * freezr has retired the ambient app_token cookie for /feps/userfiles — every
 * request now needs either an `Authorization: Bearer <app_token>` header
 * (programmatic fetch — zero token leakage into URLs) or a short-lived
 * `?fileToken=` in the URL (native <img>/<link>/<script> loads, which cannot
 * send headers). See freezr-context.md "Displaying PRIVATE files".
 */

function appToken() {
  try {
    if (freezr.app && freezr.app.isWebBased === false) return freezrMeta.appToken || ''
    return freezr.utils.getCookie('app_token_' + freezrMeta.userId) || ''
  } catch (_) {
    return ''
  }
}

function bareUrl(path) {
  const p = freezr.getFileUrl(path)
  return p.startsWith('http') ? p : window.location.origin + p
}

/**
 * Fetch a private userfile with the Bearer header (no token in any URL).
 * Returns the Response; throws an Error with `.status` on a non-2xx response.
 */
export async function fetchUserFile(path) {
  const token = appToken()
  const res = await fetch(bareUrl(path), {
    headers: token ? { Authorization: 'Bearer ' + token } : {}
  })
  if (!res.ok) {
    const err = new Error(`Failed to load ${path}: ${res.status}`)
    err.status = res.status
    throw err
  }
  return res
}

export async function fetchUserText(path) {
  return (await fetchUserFile(path)).text()
}

export async function fetchUserBlob(path) {
  return (await fetchUserFile(path)).blob()
}

/** Absolute userfiles URL with a short-lived ?fileToken= appended. */
export async function tokenizedUrl(path, options) {
  const u = await freezr.utils.tokenizedFileUrl(path, options)
  if (!u) return null
  return u.startsWith('http') ? u : window.location.origin + u
}

/**
 * Set an <img> src to a tokenized URL, retrying ONCE with a re-minted token
 * if the load fails. fileTokens expire after ~10 min; by then the SDK's token
 * cache has expired too, so the retry mints a fresh token. (If the SDK cache
 * still returns the identical failing token there is nothing more we can do
 * client-side — see getFileToken's cache.)
 */
export function setImgSrcWithRetry(img, fileId, options) {
  let retried = false
  img.addEventListener('error', async () => {
    if (retried) return
    retried = true
    try {
      const fresh = await tokenizedUrl(fileId, options)
      if (fresh && fresh !== img.src) img.src = fresh
    } catch (e) {
      console.warn('Orbit: image token retry failed', fileId, e)
    }
  })
  tokenizedUrl(fileId, options)
    .then((u) => { if (u) img.src = u })
    .catch((e) => console.warn('Orbit: could not tokenize image url', fileId, e))
}
