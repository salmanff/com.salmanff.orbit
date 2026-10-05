/* global freezr */
/** Keeps slides.json and a deck's hardcoded slide list in step, and converts projects to slide shows. */
import { state } from './state.js'
import { uploadText, fetchText } from './fileIO.js'
import { refreshFileList } from './filesData.js'
import { analyzeProject } from '../slideshow/slideshowConvert.js'
import { deckTemplateContent } from '../slideshow/slideshowTemplate.js'
import { deckPageIndex, slidesManifestJson } from '../slideshow/slideshowModel.js'

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