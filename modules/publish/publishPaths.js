/**
 * Path helpers for the publish pipeline: normalizing relative paths, working out the exact file
 * set a page publishes, and mapping a project-relative path to its draft/public location.
 */

export function normalizeRelPath(p) {
  if (!p || typeof p !== 'string') return ''
  return p.replace(/^\/+/, '').replace(/\/+$/, '')
}

/** Unique relative paths, first occurrence wins (order preserved). */
export function uniqueRelPathsOrdered(list) {
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

export function draftPath(projectName, rel) {
  return `projects/${projectName}/draft/${rel}`
}

export function publicPath(projectName, rel) {
  return `projects/${projectName}/public/${rel}`
}