/* global freezrMeta */
/** The Pages tab: the page list up top and the selected page's settings below. */
import { state, draftBasePath } from './state.js'
import { escapeHtml, scrollToRightPanelIfNeeded } from './util.js'
import { uploadText } from './fileIO.js'
import { refreshFileList } from './filesData.js'
import { persistProjectPages, addResourceToPage, removeResourceFromPage } from './projects.js'
import { confirmDiscardChanges } from './editor.js'
import { openDraftInNewTab } from './preview.js'
import { reloadPermissions } from './permissions.js'
import { runPublishPage, runUnpublishPage, isPageDirty } from './publishActions.js'
import { render, renderLeftPanel, refreshPagesPanel } from './bus.js'
import { defaultPublicIdForPage } from '../publishService.js'

export async function renderPagesPanel(body, opts = {}) {
  const { canPublish = false } = opts
  const proj = state.currentProject
  if (!proj || !proj.pages) {
    body.innerHTML = '<p class="orbit-muted">No project</p>'
    return
  }

  const sharedFiles = state.fileList
    .map((f) => f.replace(`${draftBasePath()}/`, ''))
    .filter((f) => f.endsWith('.css') || f.endsWith('.js'))

  const isAdmin = !!(typeof freezrMeta !== 'undefined' && (freezrMeta.adminUser || freezrMeta.publisherUser))

  const permBanner = !canPublish
    ? `<div class="orbit-perm-banner" role="alert">
        You need to grant the <strong style="display:inline;width:auto;margin:0">publish_site</strong> permission to be able to publish. Go to the app settings to grant the permission.
        <div style="display:flex;gap:0.5rem;margin-top:0.4rem;flex-wrap:wrap">
          <button type="button" class="orbit-btn-sm orbit-btn-secondary" id="orbit-perm-recheck">Re-check</button>
          <a class="orbit-btn-sm orbit-btn-secondary" href="/account/app/settings/com.salmanff.orbit" target="_blank" rel="noopener">App Settings ↗</a>
        </div>
      </div>`
    : ''

  // ── Top list ──────────────────────────────────────────────────────────────
  const listItems = proj.pages.map((pg, i) => {
    const isActive = i === state.activePageIndex
    const isPub = !!pg.published
    const dirty = isPub ? isPageDirty(pg) : false
    const statusClass = isPub
      ? (dirty ? 'orbit-page-status--dirty' : 'orbit-page-status--pub')
      : 'orbit-page-status--draft'
    const statusLabel = isPub ? (dirty ? 'Modified' : 'Published') : 'Draft'
    return `
      <div class="orbit-page-item${isActive ? ' orbit-page-item--active' : ''}" data-page-select="${i}" role="button" tabindex="0">
        <span class="orbit-page-item-name">${escapeHtml(pg.name)}</span>
        <span class="orbit-page-status ${statusClass}">${statusLabel}</span>
      </div>`
  }).join('')

  // ── Bottom detail panel ───────────────────────────────────────────────────
  const selPg = proj.pages[state.activePageIndex]
  let detailHtml = '<p class="orbit-muted orbit-detail-empty">Select a page above to view settings.</p>'
  if (selPg) {
    const i = state.activePageIndex
    const isPub = !!selPg.published
    const pubUrl = selPg.public_url || null
    const dirty = isPub ? isPageDirty(selPg) : false
    const cssFiles = selPg.css_files || []
    const jsFiles = selPg.js_files || []
    const defaultPid = defaultPublicIdForPage(proj.name, selPg)
    const customPid = selPg.custom_public_id || ''
    const displayUrl = customPid || defaultPid
    const meta = selPg.meta || {}
    // Show the user's saved title verbatim. If they haven't entered one, leave the input
    // empty so the placeholder (page name) is visible — that way it's obvious the field is
    // unset and the publish flow will fall back to the page name automatically.
    const metaTitle = meta.title || ''

    // All .html files in the draft folder, for the "change main html page" dropdown. Always
    // include the page's current html_file (it may not yet be in state.fileList).
    const allHtmlFiles = state.fileList
      .map((f) => f.replace(`${draftBasePath()}/`, ''))
      .filter((f) => /\.html?$/i.test(f))
    const htmlChoiceSet = new Set(allHtmlFiles)
    if (selPg.html_file) htmlChoiceSet.add(selPg.html_file)
    const htmlChoices = [...htmlChoiceSet].sort()
    const htmlOptions = [
      '<option value="">— pick another html file —</option>',
      ...htmlChoices
        .filter((f) => f !== selPg.html_file)
        .map((f) => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`)
    ].join('')

    const resourceRows = []
    resourceRows.push(
      '<li class="orbit-res-row orbit-res-html">' +
        `<button type="button" class="orbit-res-link" data-page="${i}" data-res-open="${escapeHtml(selPg.html_file)}">html: ${escapeHtml(selPg.html_file)}</button>` +
        ` <button type="button" class="orbit-res-html-change" data-page-html-change="${i}" title="Change main HTML page">change</button>` +
        `<select class="orbit-res-html-select orbit-hidden" data-page-html="${i}">${htmlOptions}</select>` +
      '</li>'
    )
    cssFiles.forEach((f) => {
      resourceRows.push(`<li class="orbit-res-row"><button type="button" class="orbit-res-link" data-page="${i}" data-res-open="${escapeHtml(f)}">css: ${escapeHtml(f)}</button> <button type="button" class="orbit-res-remove" data-page="${i}" data-res="${escapeHtml(f)}" data-res-type="css" title="Remove">&times;</button></li>`)
    })
    jsFiles.forEach((f) => {
      resourceRows.push(`<li class="orbit-res-row"><button type="button" class="orbit-res-link" data-page="${i}" data-res-open="${escapeHtml(f)}">js: ${escapeHtml(f)}</button> <button type="button" class="orbit-res-remove" data-page="${i}" data-res="${escapeHtml(f)}" data-res-type="js" title="Remove">&times;</button></li>`)
    })

    const usedPaths = new Set([selPg.html_file, ...cssFiles, ...jsFiles])
    const availableShared = sharedFiles.filter((f) => !usedPaths.has(f))
    const addOptions = [
      '<option value="">+ Add resource…</option>',
      ...availableShared.map((f) => `<option value="existing:${escapeHtml(f)}">${escapeHtml(f)}</option>`),
      '<option value="__new_css__">New CSS file…</option>',
      '<option value="__new_js__">New JS file…</option>',
      '<option value="__new_shared_css__">New shared CSS…</option>',
      '<option value="__new_shared_js__">New shared JS…</option>'
    ].join('')

    const isPreviewing = state.rightMode === 'preview'
    detailHtml = `
      <div class="orbit-detail-inner">
        <div class="orbit-detail-header">
          <button type="button" class="orbit-detail-page-name orbit-detail-page-name-btn" data-page-preview="${i}" title="Preview this page">${escapeHtml(selPg.name)}</button>
          <div class="orbit-detail-links">
            <button type="button" class="orbit-page-open orbit-link" data-page-open-draft="${i}">Draft ↗</button>
            ${isPub && pubUrl ? `<a class="orbit-page-open" href="${escapeHtml(pubUrl)}" target="_blank" rel="noopener">Live ↗</a>` : ''}
          </div>
        </div>

        <div class="orbit-detail-actions">
          <button type="button" class="orbit-btn-sm orbit-btn-secondary" data-page-preview="${i}" ${isPreviewing ? 'disabled' : ''}>${isPreviewing ? 'Previewing' : 'Preview'}</button>
          ${isPub
            ? `<button type="button" class="orbit-btn-sm${dirty ? '' : ' orbit-btn-secondary'}" data-page-republish="${i}" ${canPublish && dirty ? '' : 'disabled'}>${dirty ? 'Re-publish' : 'Up to date'}</button>
               <button type="button" class="orbit-btn-sm orbit-btn-secondary" data-page-unpublish="${i}" ${canPublish ? '' : 'disabled'}>Unpublish</button>`
            : `<button type="button" class="orbit-btn-sm" data-page-publish="${i}" ${canPublish ? '' : 'disabled'}>Publish</button>`
          }
        </div>

        <div class="orbit-detail-section">
          <label class="orbit-meta-label">Resources (${1 + cssFiles.length + jsFiles.length})</label>
          <ul class="orbit-res-list">${resourceRows.join('')}</ul>
          <select class="orbit-res-add" data-page-add-res="${i}">${addOptions}</select>
        </div>

        <div class="orbit-detail-section">
          <label class="orbit-meta-label">Public URL path</label>
          <input type="text" class="orbit-page-url-input" data-page-url="${i}"
            value="${escapeHtml(displayUrl)}"
            placeholder="${escapeHtml(defaultPid)}"
            ${isAdmin ? '' : 'readonly'}
            title="${isAdmin ? 'Custom public URL path (admin/publisher only)' : 'Public URL path'}">
        </div>

        <div class="orbit-detail-section">
          <label class="orbit-meta-label">Title</label>
          <input type="text" class="orbit-meta-input" data-page-meta="${i}" data-meta-field="title"
            value="${escapeHtml(metaTitle)}" placeholder="${escapeHtml(selPg.name)}">
          <label class="orbit-meta-label">Description</label>
          <textarea class="orbit-meta-input orbit-detail-textarea" data-page-meta="${i}" data-meta-field="description"
            placeholder="Page description for search engines and social sharing">${escapeHtml(meta.description || '')}</textarea>
          <label class="orbit-meta-label">Social image URL</label>
          <input type="text" class="orbit-meta-input" data-page-meta="${i}" data-meta-field="image"
            value="${escapeHtml(meta.image || '')}" placeholder="https://…">
        </div>

        <div class="orbit-detail-danger">
          <button type="button" class="orbit-btn-sm orbit-delete-page-btn" data-page-delete="${i}">Delete Page</button>
        </div>
      </div>
    `
  }

  body.innerHTML = `
    <div class="orbit-pages-split">
      <div class="orbit-pages-list-wrap">
        ${permBanner}
        <div class="orbit-pages-list">
          ${listItems}
        </div>
        <div class="orbit-pages-list-footer">
          <button type="button" class="orbit-btn orbit-btn-secondary orbit-new-page-btn" id="orbit-add-page">+ New page</button>
        </div>
      </div>
      <div class="orbit-pages-detail-wrap">
        ${detailHtml}
      </div>
    </div>
  `

  // ── Page list click: select + preview ──────────────────────────────────
  body.querySelectorAll('[data-page-select]').forEach((item) => {
    const activate = async () => {
      if (!confirmDiscardChanges()) return
      const idx = parseInt(item.getAttribute('data-page-select'), 10)
      state.activePageIndex = idx
      const pg = proj.pages[idx]
      if (pg) state.currentFilePath = `${draftBasePath()}/${pg.html_file}`
      state.rightMode = 'preview'
      await render()
      scrollToRightPanelIfNeeded()
    }
    item.addEventListener('click', activate)
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate() }
    })
  })

  // ── Preview action (page name + Preview button) ────────────────────────
  body.querySelectorAll('[data-page-preview]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirmDiscardChanges()) return
      const idx = parseInt(btn.getAttribute('data-page-preview'), 10)
      state.activePageIndex = idx
      const pg = proj.pages[idx]
      if (pg) state.currentFilePath = `${draftBasePath()}/${pg.html_file}`
      state.rightMode = 'preview'
      await render()
      scrollToRightPanelIfNeeded()
    })
  })

  // ── Publish actions ────────────────────────────────────────────────────
  body.querySelectorAll('[data-page-publish]').forEach((btn) => {
    btn.addEventListener('click', () => runPublishPage(parseInt(btn.getAttribute('data-page-publish'), 10)))
  })
  body.querySelectorAll('[data-page-republish]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.getAttribute('data-page-republish'), 10)
      await runUnpublishPage(idx, { skipUiRefresh: true })
      await runPublishPage(idx)
    })
  })
  body.querySelectorAll('[data-page-unpublish]').forEach((btn) => {
    btn.addEventListener('click', () => runUnpublishPage(parseInt(btn.getAttribute('data-page-unpublish'), 10)))
  })

  // ── Open draft in new tab ──────────────────────────────────────────────
  body.querySelectorAll('[data-page-open-draft]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.getAttribute('data-page-open-draft'), 10)
      const pg = state.currentProject?.pages?.[idx]
      if (!pg) return
      await openDraftInNewTab(pg)
    })
  })

  // ── Resource links ─────────────────────────────────────────────────────
  body.querySelectorAll('.orbit-res-link').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const relPath = btn.getAttribute('data-res-open')
      if (!relPath) return
      if (!confirmDiscardChanges()) return
      state.rightMode = 'editor'
      state.currentFilePath = `${draftBasePath()}/${relPath}`
      await render()
      scrollToRightPanelIfNeeded()
    })
  })
  body.querySelectorAll('.orbit-res-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-page'), 10)
      const res = btn.getAttribute('data-res')
      const type = btn.getAttribute('data-res-type')
      removeResourceFromPage(idx, res, type)
    })
  })

  // Main html page: clicking "change" reveals a dropdown to swap the backing file. The
  // previous html file is left on disk (the user can still open it via the Files tab and
  // assign it to another page).
  body.querySelectorAll('.orbit-res-html-change').forEach((btn) => {
    btn.addEventListener('click', () => {
      const row = btn.closest('.orbit-res-html')
      if (!row) return
      const sel = row.querySelector('.orbit-res-html-select')
      const link = row.querySelector('.orbit-res-link')
      if (!sel) return
      sel.classList.remove('orbit-hidden')
      btn.classList.add('orbit-hidden')
      if (link) link.classList.add('orbit-hidden')
      sel.focus()
    })
  })
  body.querySelectorAll('.orbit-res-html-select').forEach((sel) => {
    const restore = () => {
      const row = sel.closest('.orbit-res-html')
      if (!row) return
      sel.classList.add('orbit-hidden')
      row.querySelector('.orbit-res-html-change')?.classList.remove('orbit-hidden')
      row.querySelector('.orbit-res-link')?.classList.remove('orbit-hidden')
      sel.value = ''
    }
    sel.addEventListener('change', async () => {
      const idx = parseInt(sel.getAttribute('data-page-html'), 10)
      const page = proj.pages?.[idx]
      if (!page) { restore(); return }
      const newHtml = sel.value
      if (!newHtml || newHtml === page.html_file) { restore(); return }
      if (!confirmDiscardChanges()) { restore(); return }
      page.html_file = newHtml
      await persistProjectPages(proj)
      if (idx === state.activePageIndex) {
        state.currentFilePath = `${draftBasePath()}/${newHtml}`
      }
      await render()
    })
    sel.addEventListener('blur', () => {
      if (!sel.value) restore()
    })
  })

  body.querySelectorAll('.orbit-res-add').forEach((sel) => {
    sel.addEventListener('change', async () => {
      const idx = parseInt(sel.getAttribute('data-page-add-res'), 10)
      const val = sel.value
      if (!val) return
      sel.value = ''
      if (val.startsWith('existing:')) {
        const filePath = val.slice(9)
        const type = filePath.endsWith('.css') ? 'css' : 'js'
        await addResourceToPage(idx, filePath, type)
      } else if (
        val === '__new_css__' || val === '__new_shared_css__' ||
        val === '__new_js__' || val === '__new_shared_js__'
      ) {
        const picked = (val === '__new_css__' || val === '__new_shared_css__') ? 'css' : 'js'
        const shared = (val === '__new_shared_css__' || val === '__new_shared_js__')
        const raw = window.prompt(picked === 'css' ? 'CSS filename (e.g. styles.css):' : 'JS filename (e.g. app.js):')
        const trimmed = raw && raw.trim()
        if (!trimmed) return
        // If the user typed an explicit .css or .js extension, honour it (they may have
        // picked "New JS" but typed "styles.css" — let it become a CSS file rather than
        // producing "styles.css.js").
        const hasCss = trimmed.toLowerCase().endsWith('.css')
        const hasJs = trimmed.toLowerCase().endsWith('.js')
        const type = hasCss ? 'css' : hasJs ? 'js' : picked
        const name = (hasCss || hasJs) ? trimmed : `${trimmed}.${type}`
        const path = shared ? `shared/${name}` : name
        const stub = type === 'css' ? `/* ${name} */\n` : `// ${name}\n`
        const mime = type === 'css' ? 'text/css' : 'text/javascript'
        await uploadText(`${draftBasePath()}/${path}`, stub, mime)
        await addResourceToPage(idx, path, type)
        await refreshFileList()
      }
    })
  })

  // ── URL & meta ─────────────────────────────────────────────────────────
  body.querySelectorAll('.orbit-page-url-input').forEach((input) => {
    input.addEventListener('change', async () => {
      const idx = parseInt(input.getAttribute('data-page-url'), 10)
      const page = proj.pages?.[idx]
      if (!page) return
      page.custom_public_id = input.value.trim() || null
      await persistProjectPages(proj)
    })
  })
  body.querySelectorAll('[data-page-meta]').forEach((el) => {
    el.addEventListener('change', async () => {
      const idx = parseInt(el.getAttribute('data-page-meta'), 10)
      const field = el.getAttribute('data-meta-field')
      const page = proj.pages?.[idx]
      if (!page || !field) return
      if (!page.meta) page.meta = {}
      page.meta[field] = el.value.trim() || null
      await persistProjectPages(proj)
    })
  })

  // ── Delete page ────────────────────────────────────────────────────────
  // If the page is currently published, unpublish it first so the live URL is taken down
  // before we forget about the page in the project record — otherwise the published files
  // become orphaned with no UI affordance left to retract them.
  body.querySelectorAll('[data-page-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.getAttribute('data-page-delete'), 10)
      const page = proj.pages?.[idx]
      if (!page) return
      const files = [page.html_file, ...(page.css_files || []), ...(page.js_files || [])].filter(Boolean)
      const fileList = files.map((f) => `  • ${f}`).join('\n')
      const wasPublished = !!page.published
      const unpublishNote = wasPublished
        ? '\n\nThis page is currently published — it will be unpublished first.'
        : ''
      const msg = `Delete page "${page.name}" from the project?${unpublishNote}\n\nThis removes it from the page list but does NOT delete its draft files. Please delete these manually afterwards:\n\n${fileList}`
      if (!window.confirm(msg)) return
      if (wasPublished) {
        await runUnpublishPage(idx, { skipUiRefresh: true })
        // runUnpublishPage may have failed (e.g. permission denied); bail out rather than
        // orphan the published files.
        if (proj.pages?.[idx]?.published) {
          window.alert('Could not unpublish the page; deletion aborted.')
          await refreshPagesPanel()
          return
        }
      }
      proj.pages.splice(idx, 1)
      if (state.activePageIndex >= proj.pages.length) {
        state.activePageIndex = Math.max(0, proj.pages.length - 1)
      }
      await persistProjectPages(proj)
      await renderLeftPanel(opts)
    })
  })

  // ── Add page / re-check permission ─────────────────────────────────────
  document.getElementById('orbit-add-page')?.addEventListener('click', async () => {
    if (!confirmDiscardChanges()) return
    const name = window.prompt('Page name (e.g. about):')
    if (!name || !/^[-a-z0-9_]+$/i.test(name)) return
    if (proj.pages.some((p) => p.name === name)) {
      window.alert('A page with that name already exists.')
      return
    }
    const htmlFile = `${name}.html`
    // If a file with this name already exists in the draft folder, reuse it as-is.
    // Previously we always wrote a blank stub, which silently overwrote any pre-existing
    // page (e.g. one the user uploaded via the Files tab and was about to register here).
    const htmlAlreadyExists = state.fileList.includes(`${draftBasePath()}/${htmlFile}`)
    if (!htmlAlreadyExists) {
      await uploadText(`${draftBasePath()}/${htmlFile}`, `<h1>${name}</h1>\n`, 'text/html')
    }
    proj.pages.push({ name, html_file: htmlFile, css_files: [], js_files: [], published: false, public_url: null })
    await persistProjectPages(proj)
    await refreshFileList()
    state.activePageIndex = proj.pages.length - 1
    state.currentFilePath = `${draftBasePath()}/${htmlFile}`
    state.rightMode = 'preview'
    await render()
  })

  document.getElementById('orbit-perm-recheck')?.addEventListener('click', async () => {
    await reloadPermissions()
    await refreshPagesPanel()
  })
}