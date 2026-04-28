/**
 * Draft file tree under projects/{id}/draft — used by Orbit Files tab.
 */

export function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Build nested tree: { children: { folderName: subtree }, files: [{ full, name }] } */
export function buildDraftFileTree(fullPaths, draftBase) {
  const root = { children: {}, files: [] }
  const base = draftBase.replace(/\/+$/, '')
  for (const fullPath of fullPaths) {
    if (!fullPath || !fullPath.startsWith(base + '/')) continue
    const rel = fullPath.slice(base.length + 1)
    if (!rel) continue
    const parts = rel.split('/')
    const fileName = parts.pop()
    let node = root
    for (const part of parts) {
      if (!node.children[part]) node.children[part] = { children: {}, files: [] }
      node = node.children[part]
    }
    node.files.push({ full: fullPath, name: fileName })
  }
  for (const k of Object.keys(root.children)) {
    sortTree(root.children[k])
  }
  root.files.sort((a, b) => a.name.localeCompare(b.name))
  return root
}

function sortTree(node) {
  node.files.sort((a, b) => a.name.localeCompare(b.name))
  for (const k of Object.keys(node.children)) {
    sortTree(node.children[k])
  }
}

const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|eot|pdf|zip|gz|tar|mp3|mp4|webm|mov|bin|dat)$/i

export function isBinaryPath(path) {
  return BINARY_EXT.test(path || '')
}

/** Single segment: letters, numbers, hyphens, underscores, dots (not ..) */
export function sanitizeFolderSegment(name) {
  const t = (name || '').trim()
  if (!t || t.includes('..') || t.includes('/') || t.includes('\\')) return null
  if (!/^[a-zA-Z0-9._-]+$/.test(t)) return null
  if (t === '.' || t === '..') return null
  return t
}
