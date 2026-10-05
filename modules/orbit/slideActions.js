/** Slide CRUD driven by the Slides tab: add, duplicate, delete, move, rename, preview. */
import { state, draftBasePath, draftRelFilePaths } from './state.js'
import { confirmDiscardChanges } from './editor.js'
import { persistProjectPages } from './projects.js'
import { refreshFileList, deleteFileWithUnpublish } from './filesData.js'
import { uploadText, fetchText } from './fileIO.js'
import { render, refreshPagesPanel } from './bus.js'
import { refreshPreview, openDraftInNewTab } from './preview.js'
import { slidesOf, deckPageIndex, newSlideId, nextSlideFile } from '../slideshow/slideshowModel.js'
import { NEW_SLIDE_HTML } from '../slideshow/slideshowTemplate.js'
import { findOrphanSlideAssets } from '../slideshow/slideAssets.js'
import { rewriteSlideList } from '../slideshow/deckSlideList.js'

function deck() {
  const proj = state.currentProject
  return proj?.pages?.[deckPageIndex(proj)] || null
}

async function afterSlidesChange() {
  const proj = state.currentProject
  await persistProjectPages(proj)
  const d = deck()
  if (d) {
    try {
      const text = await fetchText(`${draftBasePath()}/${d.html_file}`)
      const rewritten = rewriteSlideList(text, slidesOf(proj))
      if (rewritten && rewritten.changed) {
        await uploadText(`${draftBasePath()}/${d.html_file}`, rewritten.text, 'text/html')
      }
    } catch (_) { /* not every deck has a rewritable list, and that's fine */ }
  }
  await refreshFileList()
  await refreshPagesPanel()
  await refreshPreview()
}

export async function showSlidePreview(id) {
  state.activeSlideId = id
  state.rightMode = 'preview'
  await render()
}

export async function editSlideFile(id) {
  if (!confirmDiscardChanges()) return
  const proj = state.currentProject
  const slide = slidesOf(proj).find((s) => s.id === id)
  if (!slide) return
  state.activeSlideId = id
  state.currentFilePath = `${draftBasePath()}/${slide.file}`
  state.rightMode = 'editor'
  await render()
}

export async function addSlideAfterActive() {
  const proj = state.currentProject
  const slides = slidesOf(proj)
  const activeIdx = slides.findIndex((s) => s.id === state.activeSlideId)
  const insertAt = activeIdx >= 0 ? activeIdx + 1 : slides.length
  const file = nextSlideFile(draftRelFilePaths(), slides)
  const id = newSlideId(slides)
  await uploadText(`${draftBasePath()}/${file}`, NEW_SLIDE_HTML, 'text/html')
  slides.splice(insertAt, 0, { id, file, title: 'New slide' })
  proj.slides = slides
  state.activeSlideId = id
  await afterSlidesChange()
}

export async function duplicateSlide(id) {
  const proj = state.currentProject
  const slides = slidesOf(proj)
  const idx = slides.findIndex((s) => s.id === id)
  if (idx < 0) return
  const src = slides[idx]
  let text = ''
  try { text = await fetchText(`${draftBasePath()}/${src.file}`) } catch (_) {}
  const file = nextSlideFile(draftRelFilePaths(), slides)
  const newId = newSlideId(slides)
  await uploadText(`${draftBasePath()}/${file}`, text, 'text/html')
  slides.splice(idx + 1, 0, { id: newId, file, title: src.title ? `${src.title} copy` : 'Slide copy' })
  proj.slides = slides
  state.activeSlideId = newId
  await afterSlidesChange()
}

export async function deleteSlideById(id) {
  const proj = state.currentProject
  const slides = slidesOf(proj)
  const idx = slides.findIndex((s) => s.id === id)
  if (idx < 0) return
  if (slides.length <= 1) { window.alert('A slide show needs at least one slide.'); return }
  const slide = slides[idx]
  if (!window.confirm(`Delete "${slide.title || slide.file}"?`)) return

  const otherSlides = slides.filter((s) => s.id !== id)
  let orphans = []
  try {
    orphans = await findOrphanSlideAssets({
      slide,
      otherSlides,
      deckPage: deck(),
      existingRels: draftRelFilePaths(),
      readText: (rel) => fetchText(`${draftBasePath()}/${rel}`)
    })
  } catch (e) { console.warn('Orbit: findOrphanSlideAssets failed', e) }

  slides.splice(idx, 1)
  proj.slides = slides
  if (state.activeSlideId === id) {
    state.activeSlideId = slides[Math.min(idx, slides.length - 1)]?.id || null
  }
  try { await deleteFileWithUnpublish(`${draftBasePath()}/${slide.file}`) } catch (e) { console.warn('Orbit: could not delete slide file', e) }
  for (const rel of orphans) {
    try { await deleteFileWithUnpublish(`${draftBasePath()}/${rel}`) } catch (e) { console.warn('Orbit: could not delete orphaned asset', rel, e) }
  }
  await afterSlidesChange()
}

export async function moveSlide(id, delta) {
  const proj = state.currentProject
  const slides = slidesOf(proj)
  const idx = slides.findIndex((s) => s.id === id)
  const target = idx + delta
  if (idx < 0 || target < 0 || target >= slides.length) return
  const [item] = slides.splice(idx, 1)
  slides.splice(target, 0, item)
  proj.slides = slides
  await afterSlidesChange()
}

export async function renameSlide(id, title) {
  const proj = state.currentProject
  const slide = slidesOf(proj).find((s) => s.id === id)
  if (!slide) return
  slide.title = (title || '').trim() || slide.title
  await afterSlidesChange()
}

export async function openDeckDraftInNewTab() {
  const d = deck()
  if (d) await openDraftInNewTab(d)
}