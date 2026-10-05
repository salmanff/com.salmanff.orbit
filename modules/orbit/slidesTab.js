/** The Slides tab: gathers the state the panel needs and wires its handlers. */
import { state, draftBasePath, activeSlide } from './state.js'
import { confirmDiscardChanges } from './editor.js'
import { persistProjectPages } from './projects.js'
import { reloadPermissions } from './permissions.js'
import { runPublishPage, runUnpublishPage, isPageDirty } from './publishActions.js'
import {
  showSlidePreview, editSlideFile, addSlideAfterActive, duplicateSlide,
  deleteSlideById, moveSlide, renameSlide, openDeckDraftInNewTab
} from './slideActions.js'
import { addResourceToPage, removeResourceFromPage } from './projects.js'
import { scrollToRightPanelIfNeeded } from './util.js'
import { render, refreshPagesPanel } from './bus.js'
import { isSlideshow, slidesOf, deckPageIndex } from '../slideshow/slideshowModel.js'
import { renderSlidesPanel, bindSlidesPanel } from '../slideshow/slidesPanel.js'

export async function renderSlidesTab(body, opts = {}) {
  const proj = state.currentProject
  if (!isSlideshow(proj)) {
    body.innerHTML = '<p class="orbit-muted">Not a slide show.</p>'
    return
  }
  const deck = proj.pages?.[deckPageIndex(proj)] || null
  const used = new Set([deck?.html_file, ...(deck?.css_files || []), ...(deck?.js_files || [])].filter(Boolean))
  const availableAssets = state.fileList
    .map((f) => f.replace(`${draftBasePath()}/`, ''))
    .filter((f) => (f.endsWith('.css') || f.endsWith('.js')) && !used.has(f) && !f.startsWith('slides/'))

  body.innerHTML = renderSlidesPanel({
    slides: slidesOf(proj),
    activeSlideId: activeSlide()?.id || null,
    deckPage: deck,
    projectName: proj.display_name || proj.name,
    projectFolderName: proj.name,
    canPublish: opts.canPublish,
    deckDirty: deck ? isPageDirty(deck) : true,
    availableAssets
  })

  bindSlidesPanel(body, {
    onSelect: (id) => showSlidePreview(id),
    onEdit: (id) => editSlideFile(id),
    onAdd: () => addSlideAfterActive(),
    onDuplicate: (id) => duplicateSlide(id),
    onDelete: (id) => deleteSlideById(id),
    onMove: (id, delta) => moveSlide(id, delta),
    onRename: (id, title) => renameSlide(id, title),
    onPublish: () => runPublishPage(deckPageIndex(proj)),
    onRepublish: async () => {
      await runUnpublishPage(deckPageIndex(proj), { skipUiRefresh: true })
      await runPublishPage(deckPageIndex(proj))
    },
    onUnpublish: () => runUnpublishPage(deckPageIndex(proj)),
    onOpenDraft: () => openDeckDraftInNewTab(),
    onOpenFile: async (rel) => {
      if (!confirmDiscardChanges()) return
      state.currentFilePath = `${draftBasePath()}/${rel}`
      state.rightMode = 'editor'
      await render()
      scrollToRightPanelIfNeeded()
    },
    onAddResource: (rel) => addResourceToPage(deckPageIndex(proj), rel, rel.endsWith('.css') ? 'css' : 'js'),
    onRemoveResource: (rel, type) => removeResourceFromPage(deckPageIndex(proj), rel, type),
    onMeta: async (field, value) => {
      if (!deck.meta) deck.meta = {}
      deck.meta[field] = (value || '').trim() || null
      await persistProjectPages(proj)
    },
    onPublicId: async (value) => {
      if (!deck) return
      deck.custom_public_id = (value || '').trim() || null
      await persistProjectPages(proj)
    },
    onRecheck: async () => { await reloadPermissions(); await refreshPagesPanel() }
  })
}