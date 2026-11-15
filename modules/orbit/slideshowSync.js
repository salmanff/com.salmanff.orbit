/* global freezr */
/** Keeps slides.json and a deck's hardcoded slide list in step, converts projects to slide shows,
 * and can patch a deck's navigation script so its slide-number URL writes stay correct. */
import { state } from './state.js'
import { uploadText, fetchText } from './fileIO.js'
import { refreshFileList } from './filesData.js'
import { analyzeProject } from '../slideshow/slideshowConvert.js'
import { deckTemplateContent } from '../slideshow/slideshowTemplate.js'
import { deckPageIndex, slidesManifestJson } from '../slideshow/slideshowModel.js'
import { patchHistoryNav } from '../slideshow/deckHistoryFix.js'

export async function convertProjectToSlideshow(name, onProgress) {
  const proj = state.projects.find((p) => p.name === name)
  if (!proj) throw new Error('Project not found')
  if (onProgress) onProgress('Reading project files...')

  await refreshFileList()
  const base = `projects/${name}/draft`
  const existingRels = state.fileList
    .filter((f) => f.startsWith(base + '/'))
    .map((f) => f.slice(base.length + 1))

  const { slides, deckPage, readsManifest, skipped } = await analyzeProject({
    project: proj,
    existingRels,
    readText: (rel) => fetchText(`${base}/${rel}`)
  })

  let pages
  let keptDeck = false
  if (deckPage) {
    keptDeck = true
    pages = [deckPage]
  } else {
    if (onProgress) onProgress('Writing deck template...')
    const { html, css, js } = deckTemplateContent()
    const candidate = proj.pages[deckPageIndex(proj)]
    const htmlFile = (candidate && !existingRels.includes('index.html')) ? candidate.html_file : 'index.html'
    await uploadText(`${base}/${htmlFile}`, html, 'text/html')
    await uploadText(`${base}/deck.css`, css, 'text/css')
    await uploadText(`${base}/deck.js`, js, 'text/javascript')
    pages = [{ name: candidate?.name || 'index', html_file: htmlFile, css_files: ['deck.css'], js_files: ['deck.js'], published: false, public_url: null }]
  }

  proj.type = 'slideshow'
  proj.pages = pages
  proj.slides = slides

  if (onProgress) onProgress('Saving slides.json...')
  await uploadText(`${base}/slides.json`, slidesManifestJson(proj), 'application/json')
  await freezr.updateFields('projects', { name }, { type: 'slideshow', pages, slides })

  return { slideCount: slides.length, skipped: skipped.length, keptDeck, readsManifest }
}

/**
 * Patch a slideshow project's deck navigation script(s) so a RELATIVE history.pushState/
 * replaceState url is rebased against the real address bar URL (custom public id included)
 * instead of resolving against <base href> — see modules/slideshow/deckHistoryFix.js for why a
 * global patch, not a rewrite of the deck's own call site, is the safe approach for a deck that
 * may be hand-written. Also upgrades a project still carrying an earlier version of this patch
 * that disarmed navigation entirely.
 *
 * Only scans the deck's declared JS files (never the HTML — a raw JS snippet has no safe place
 * to live in a body fragment) and skips any that already carry the current patch and never call
 * history.pushState/replaceState at all.
 * @returns {Promise<{patchedFiles: string[]}>}
 */
export async function fixDeckHistoryNavigation(projectName) {
  const proj = state.projects.find((p) => p.name === projectName)
  if (!proj) throw new Error('Project not found')
  const deck = proj.pages?.[deckPageIndex(proj)]
  if (!deck) throw new Error('This project has no deck page')

  const base = `projects/${projectName}/draft`
  const candidates = (deck.js_files || []).filter(Boolean)
  const patchedFiles = []
  for (const rel of candidates) {
    let text
    try {
      text = await fetchText(`${base}/${rel}`)
    } catch (e) {
      continue // file missing or unreadable — nothing to patch
    }
    const { text: patched, changed } = patchHistoryNav(text)
    if (changed) {
      await uploadText(`${base}/${rel}`, patched, 'text/javascript')
      patchedFiles.push(rel)
    }
  }
  return { patchedFiles }
}