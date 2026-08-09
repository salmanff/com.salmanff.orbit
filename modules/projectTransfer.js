/* global freezr */
/**
 * Project export / import.
 *
 * A project is two things: a row in the `projects` table (its pages and their
 * resource declarations) and a folder of draft files. A bundle carries both, so
 * an import on another server reproduces the project exactly.
 *
 * The bundle is a single JSON file rather than a zip: freezr's CSP forbids
 * loading a zip library from a CDN, and shipping one would be a lot of bytes
 * for a format the user can otherwise read and diff by hand. Text files are
 * stored as plain text for exactly that reason; only genuinely binary files pay
 * the ~33% base64 overhead.
 */

export const BUNDLE_FORMAT = 'orbit-project'
export const BUNDLE_VERSION = 1

/** Extensions we store as readable text; everything else goes base64. */
function isTextPath(rel) {
  return /\.(html?|css|js|mjs|json|svg|txt|md|xml|csv|map)$/i.test(rel)
}

function mimeForPath(rel) {
  if (/\.html?$/i.test(rel)) return 'text/html'
  if (/\.css$/i.test(rel)) return 'text/css'
  if (/\.m?js$/i.test(rel)) return 'text/javascript'
  if (/\.json$/i.test(rel)) return 'application/json'
  if (/\.svg$/i.test(rel)) return 'image/svg+xml'
  if (/\.csv$/i.test(rel)) return 'text/csv'
  if (/\.md$/i.test(rel)) return 'text/markdown'
  return 'text/plain'
}

/** Bytes → base64 without blowing the argument limit on a large file. */
function bytesToBase64(bytes) {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function base64ToBlob(b64, type) {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: type || 'application/octet-stream' })
}

/** Reject anything that could write outside the target project folder. */
export function isSafeRelPath(rel) {
  if (typeof rel !== 'string' || !rel) return false
  if (rel.startsWith('/') || rel.includes('..') || rel.includes('\\')) return false
  if (/^[a-zA-Z]:/.test(rel)) return false
  return true
}

/** A project name we are willing to create a folder for. */
export function isValidProjectName(name) {
  return typeof name === 'string' && /^[-a-zA-Z0-9_]+$/.test(name)
}

/**
 * Build a bundle for one project.
 *
 * @param {object} opts
 * @param {object} opts.project - the projects row
 * @param {string[]} opts.fileRels - draft-relative paths to include
 * @param {(rel: string) => Promise<Blob>} opts.fetchDraftBlob
 * @param {(msg: string) => void} [opts.onProgress]
 * @returns {Promise<{bundle: object, warnings: string[]}>}
 */
export async function buildProjectBundle({ project, fileRels, fetchDraftBlob, onProgress }) {
  if (!project?.name) throw new Error('No project to export')
  const files = []
  const warnings = []
  const list = (fileRels || []).filter(isSafeRelPath)

  for (let i = 0; i < list.length; i++) {
    const rel = list[i]
    if (onProgress) onProgress(`Reading ${i + 1}/${list.length}: ${rel}`)
    try {
      const blob = await fetchDraftBlob(rel)
      if (isTextPath(rel)) {
        files.push({ path: rel, encoding: 'utf8', content: await blob.text() })
      } else {
        const bytes = new Uint8Array(await blob.arrayBuffer())
        files.push({ path: rel, encoding: 'base64', mime: blob.type || '', content: bytesToBase64(bytes) })
      }
    } catch (e) {
      // One unreadable file must not cost the user the whole export.
      warnings.push(`${rel}: ${e.message || String(e)}`)
    }
  }

  // Strip freezr's own bookkeeping fields — they belong to THIS server's copy of
  // the record and would be meaningless (or actively wrong) after an import.
  const { _id, _date_created, _date_modified, _accessibles, _owner, ...projectFields } = project

  return {
    bundle: {
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      exportedAt: new Date().toISOString(),
      project: {
        ...projectFields,
        // Publication state is specific to the server it was published from.
        published: false,
        public_url: null,
        pages: (project.pages || []).map((p) => ({ ...p, published: false, public_url: null }))
      },
      files
    },
    warnings
  }
}

/** Validate a parsed bundle, throwing a message worth showing the user. */
export function validateBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') throw new Error('That file is not an Orbit project bundle.')
  if (bundle.format !== BUNDLE_FORMAT) {
    throw new Error(`That file is not an Orbit project bundle (format: ${bundle.format || 'missing'}).`)
  }
  if (bundle.version > BUNDLE_VERSION) {
    throw new Error(`That bundle was made by a newer version of Orbit (version ${bundle.version}). Update Orbit first.`)
  }
  const name = bundle.project?.name
  if (!isValidProjectName(name)) {
    throw new Error('The bundle has no valid project name (letters, numbers, hyphens and underscores only).')
  }
  if (!Array.isArray(bundle.files)) throw new Error('The bundle has no files array.')
  const unsafe = bundle.files.filter((f) => !isSafeRelPath(f?.path))
  if (unsafe.length) {
    throw new Error(`The bundle contains unsafe file paths (e.g. "${unsafe[0]?.path}"). Refusing to import.`)
  }
  return bundle
}

/**
 * Write a bundle's files into a project's draft folder and upsert its row.
 *
 * Existing files of the same path are overwritten. Files already in the draft
 * folder that the bundle does not mention are LEFT ALONE and reported back — an
 * import should not silently delete work that predates it.
 *
 * @param {object} opts
 * @param {object} opts.bundle - already passed through validateBundle
 * @param {string[]} [opts.existingRels] - what is currently in the draft folder
 * @param {(fullPath: string, text: string, mime: string) => Promise<void>} opts.uploadText
 * @param {(fullPath: string, file: File) => Promise<void>} opts.uploadFile
 * @param {(project: object, exists: boolean) => Promise<void>} opts.saveProjectRow
 * @param {boolean} opts.projectExists
 * @param {(msg: string) => void} [opts.onProgress]
 * @returns {Promise<{name: string, written: number, warnings: string[], leftovers: string[]}>}
 */
export async function applyProjectBundle({
  bundle, existingRels, uploadText, uploadFile, saveProjectRow, projectExists, onProgress
}) {
  const name = bundle.project.name
  const base = `projects/${name}/draft`
  const warnings = []
  let written = 0

  for (let i = 0; i < bundle.files.length; i++) {
    const f = bundle.files[i]
    if (onProgress) onProgress(`Writing ${i + 1}/${bundle.files.length}: ${f.path}`)
    try {
      const full = `${base}/${f.path}`
      if (f.encoding === 'base64') {
        const blob = base64ToBlob(f.content, f.mime)
        const fileName = f.path.split('/').pop()
        await uploadFile(full, new File([blob], fileName, { type: blob.type }))
      } else {
        await uploadText(full, f.content == null ? '' : String(f.content), mimeForPath(f.path))
      }
      written++
    } catch (e) {
      warnings.push(`${f.path}: ${e.message || String(e)}`)
    }
  }

  // The row goes last: if the files failed we would rather not claim the project
  // imported cleanly.
  await saveProjectRow(bundle.project, projectExists)

  const bundlePaths = new Set(bundle.files.map((f) => f.path))
  const leftovers = (existingRels || []).filter((rel) => !bundlePaths.has(rel))

  return { name, written, warnings, leftovers }
}

/** Trigger a browser download of the bundle. */
export function downloadBundle(bundle, fileName) {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoked on a later tick so the download has certainly started.
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

/** Human-readable size for the export summary. */
export function approxBundleSize(bundle) {
  const bytes = new Blob([JSON.stringify(bundle)]).size
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}
