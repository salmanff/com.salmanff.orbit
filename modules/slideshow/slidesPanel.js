/* global freezrMeta */
/**
 * The Slides tab for slide-show projects — markup and event wiring only.
 * Every state change goes through the handlers orbitMain passes in, so this
 * module knows nothing about freezr, persistence or the preview.
 */

function esc(s) {
  const d = document.createElement('div')
  d.textContent = s == null ? '' : String(s)
  return d.innerHTML
}

/**
 * @param {object} ctx - { slides, activeSlideId, deckPage, projectName,
 *   canPublish, deckDirty, availableAssets }
 */
export function renderSlidesPanel(ctx) {
  const {
    slides = [],
    activeSlideId = null,
    deckPage = null,
    projectName = '',
    canPublish = false,
    deckDirty = false,
    availableAssets = []
  } = ctx

  let activeIdx = slides.findIndex((s) => s.id === activeSlideId)
  if (activeIdx < 0 && slides.length) activeIdx = 0
  const active = activeIdx >= 0 ? slides[activeIdx] : null
  const appName = typeof freezrMeta !== 'undefined' && freezrMeta.appName ? freezrMeta.appName : 'com.salmanff.orbit'

  const permBanner = canPublish
    ? ''
    : `<div class="orbit-perm-banner" role="alert">
        Grant the <strong style="display:inline;width:auto;margin:0">publish_site</strong> permission in app settings to publish this presentation.
        <div style="display:flex;gap:0.5rem;margin-top:0.4rem;flex-wrap:wrap">
          <button type="button" class="orbit-btn-sm orbit-btn-secondary" id="orbit-perm-recheck">Re-check</button>
          <a class="orbit-btn-sm orbit-btn-secondary" href="/account/app/settings/${esc(appName)}" target="_blank" rel="noopener">App Settings ↗</a>
        </div>
      </div>`

  const items = slides.length
    ? slides.map((s, i) => `
        <div class="orbit-page-item orbit-slide-item${i === activeIdx ? ' orbit-page-item--active' : ''}"
             data-slide-select="${esc(s.id)}" role="button" tabindex="0" title="${esc(s.file)} — double-click to edit">
          <span class="orbit-slide-num">${i + 1}</span>
          <span class="orbit-page-item-name">${esc(s.title || s.file)}</span>
          <span class="orbit-slide-actions">
            <button type="button" class="orbit-btn-icon" data-slide-move="-1" data-slide-id="${esc(s.id)}" title="Move up" ${i === 0 ? 'disabled' : ''}>&#8593;</button>
            <button type="button" class="orbit-btn-icon" data-slide-move="1" data-slide-id="${esc(s.id)}" title="Move down" ${i === slides.length - 1 ? 'disabled' : ''}>&#8595;</button>
          </span>
        </div>`).join('')
    : '<p class="orbit-muted orbit-detail-empty">No slides yet — add one below.</p>'

  const slideSection = active
    ? `
      <div class="orbit-detail-header">
        <span class="orbit-detail-page-name">Slide ${activeIdx + 1} of ${slides.length}</span>
        <span class="orbit-slide-file">${esc(active.file)}</span>
      </div>
      <div class="orbit-detail-actions">
        <button type="button" class="orbit-btn-sm" data-slide-action="edit">Edit HTML</button>
        <button type="button" class="orbit-btn-sm orbit-btn-secondary" data-slide-action="duplicate">Duplicate</button>
        <button type="button" class="orbit-btn-sm orbit-delete-page-btn" data-slide-action="delete" title="Delete this slide">Delete</button>
      </div>
      <div class="orbit-detail-section">
        <label class="orbit-meta-label" for="orbit-slide-title">Slide title</label>
        <input type="text" id="orbit-slide-title" class="orbit-meta-input" value="${esc(active.title || '')}" placeholder="Untitled slide">
        <p class="orbit-settings-note">Used in this list and as the slide's accessible label. To change what the slide says, edit it or ask Chat.</p>
      </div>`
    : ''

  const isPub = !!deckPage?.published
  const statusClass = isPub ? (deckDirty ? 'orbit-page-status--dirty' : 'orbit-page-status--pub') : 'orbit-page-status--draft'
  const statusLabel = isPub ? (deckDirty ? 'Modified since published' : 'Published') : 'Not published'
  const publishButtons = isPub
    ? `<button type="button" class="orbit-btn-sm${deckDirty ? '' : ' orbit-btn-secondary'}" data-deck-action="republish" ${canPublish && deckDirty ? '' : 'disabled'}>${deckDirty ? 'Re-publish' : 'Up to date'}</button>
       <button type="button" class="orbit-btn-sm orbit-btn-secondary" data-deck-action="unpublish" ${canPublish ? '' : 'disabled'}>Unpublish</button>`
    : `<button type="button" class="orbit-btn-sm" data-deck-action="publish" ${canPublish && slides.length ? '' : 'disabled'}>Publish</button>`

  const cssFiles = deckPage?.css_files || []
  const jsFiles = deckPage?.js_files || []
  const templateRows = deckPage
    ? [
        `<li class="orbit-res-row orbit-res-html"><button type="button" class="orbit-res-link" data-open-file="${esc(deckPage.html_file)}">html: ${esc(deckPage.html_file)}</button></li>`,
        ...cssFiles.map((f) => `<li class="orbit-res-row"><button type="button" class="orbit-res-link" data-open-file="${esc(f)}">css: ${esc(f)}</button> <button type="button" class="orbit-res-remove" data-deck-remove="${esc(f)}" data-res-type="css" title="Remove from the deck">&times;</button></li>`),
        ...jsFiles.map((f) => `<li class="orbit-res-row"><button type="button" class="orbit-res-link" data-open-file="${esc(f)}">js: ${esc(f)}</button> <button type="button" class="orbit-res-remove" data-deck-remove="${esc(f)}" data-res-type="js" title="Remove from the deck">&times;</button></li>`)
      ].join('')
    : ''
  const addOptions = [
    '<option value="">+ Add a CSS / JS file to the deck…</option>',
    ...availableAssets.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`)
  ].join('')

  const runtimeNote = deckPage && !jsFiles.includes('deck.js')
    ? `<p class="orbit-settings-note">This deck uses its own script. Orbit keeps <code>slides.json</code> in step with the slide list; if the deck does not read it yet, ask Chat: <em>“Make the deck load its slides from slides.json and follow Orbit's slide-show rules.”</em></p>`
    : ''

  const meta = deckPage?.meta || {}

  return `
    <div class="orbit-pages-split">
      <div class="orbit-pages-list-wrap">
        ${permBanner}
        <div class="orbit-pages-list">${items}</div>
        <div class="orbit-pages-list-footer">
          <button type="button" class="orbit-btn orbit-btn-secondary orbit-new-page-btn" id="orbit-add-slide">+ New slide</button>
        </div>
      </div>
      <div class="orbit-pages-detail-wrap">
        <div class="orbit-detail-inner" data-active-slide="${esc(active?.id || '')}">
          ${slideSection}

          <div class="orbit-detail-section">
            <label class="orbit-meta-label">Presentation</label>
            <div class="orbit-slide-deck-status">
              <span class="orbit-page-status ${statusClass}">${statusLabel}</span>
              <button type="button" class="orbit-page-open orbit-link" data-deck-action="draft">Draft ↗</button>
              ${isPub && deckPage?.public_url ? `<a class="orbit-page-open" href="${esc(deckPage.public_url)}" target="_blank" rel="noopener">Live ↗</a>` : ''}
            </div>
            <div class="orbit-detail-actions">
              ${publishButtons}
            </div>
            <p class="orbit-settings-note">Publishing puts the whole presentation online in one go — every slide, the template and its images.</p>
          </div>

          <div class="orbit-detail-section">
            <label class="orbit-meta-label">Deck template (shared by every slide)</label>
            <ul class="orbit-res-list">${templateRows}</ul>
            ${availableAssets.length ? `<select class="orbit-res-add" id="orbit-deck-add">${addOptions}</select>` : ''}
            ${runtimeNote}
          </div>

          <div class="orbit-detail-section">
            <label class="orbit-meta-label">Title</label>
            <input type="text" class="orbit-meta-input" data-deck-meta="title" value="${esc(meta.title || '')}" placeholder="${esc(projectName)}">
            <label class="orbit-meta-label">Description</label>
            <textarea class="orbit-meta-input orbit-detail-textarea" data-deck-meta="description"
              placeholder="Description for search engines and social sharing">${esc(meta.description || '')}</textarea>
            <label class="orbit-meta-label">Social image URL</label>
            <input type="text" class="orbit-meta-input" data-deck-meta="image" value="${esc(meta.image || '')}" placeholder="https://…">
          </div>

          </div>
      </div>
    </div>`
}

/**
 * @param {HTMLElement} body
 * @param {object} h - handlers (onSelect, onEdit, onAdd, onDuplicate,
 *   onDelete, onMove, onRename, onPublish, onRepublish,
 *   onUnpublish, onOpenDraft, onOpenFile, onAddResource, onRemoveResource,
 *   onMeta, onRecheck)
 */
export function bindSlidesPanel(body, h) {
  if (!body || !h) return
  const activeId = body.querySelector('[data-active-slide]')?.getAttribute('data-active-slide') || null

  body.querySelectorAll('[data-slide-select]').forEach((item) => {
    const id = item.getAttribute('data-slide-select')
    item.addEventListener('click', () => h.onSelect(id))
    item.addEventListener('dblclick', () => h.onEdit(id))
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); h.onSelect(id) }
    })
  })

  body.querySelectorAll('[data-slide-move]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      h.onMove(btn.getAttribute('data-slide-id'), parseInt(btn.getAttribute('data-slide-move'), 10))
    })
    btn.addEventListener('dblclick', (e) => e.stopPropagation())
  })

  body.querySelectorAll('[data-slide-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!activeId) return
      const action = btn.getAttribute('data-slide-action')
      if (action === 'edit') h.onEdit(activeId)
      else if (action === 'duplicate') h.onDuplicate(activeId)
      else if (action === 'delete') h.onDelete(activeId)
    })
  })

  const titleInput = body.querySelector('#orbit-slide-title')
  if (titleInput && activeId) {
    titleInput.addEventListener('change', () => h.onRename(activeId, titleInput.value))
    titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') titleInput.blur() })
  }

  body.querySelector('#orbit-add-slide')?.addEventListener('click', () => h.onAdd())

  body.querySelectorAll('[data-deck-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.getAttribute('data-deck-action')
      if (action === 'publish') h.onPublish()
      else if (action === 'republish') h.onRepublish()
      else if (action === 'unpublish') h.onUnpublish()
      else if (action === 'draft') h.onOpenDraft()
    })
  })

  body.querySelectorAll('[data-open-file]').forEach((btn) => {
    btn.addEventListener('click', () => h.onOpenFile(btn.getAttribute('data-open-file')))
  })

  body.querySelectorAll('[data-deck-remove]').forEach((btn) => {
    btn.addEventListener('click', () => h.onRemoveResource(btn.getAttribute('data-deck-remove'), btn.getAttribute('data-res-type')))
  })

  const addSel = body.querySelector('#orbit-deck-add')
  addSel?.addEventListener('change', () => {
    const rel = addSel.value
    addSel.value = ''
    if (rel) h.onAddResource(rel)
  })

  body.querySelectorAll('[data-deck-meta]').forEach((el) => {
    el.addEventListener('change', () => h.onMeta(el.getAttribute('data-deck-meta'), el.value))
  })

  body.querySelector('#orbit-perm-recheck')?.addEventListener('click', () => h.onRecheck())
}