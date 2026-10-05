/* global freezr */
/** The Files tab: the collapsible draft tree, the single-folder view, and uploads. */
import { state, draftBasePath } from './state.js'
import { escapeHtml, isImagePath, isTextEditablePath, scrollToRightPanelIfNeeded } from './util.js'
import { uploadText, renameFileOnServer } from './fileIO.js'
import {
  refreshFileList, deleteFileWithUnpublish,
  updateProjectFileReferences, removeFileFromProjectReferences
} from './filesData.js'
import { persistProjectPages } from './projects.js'
import { confirmDiscardChanges } from './editor.js'
import { render, renderLeftPanel } from './bus.js'
import { unpublishSingleFile } from '../publishService.js'

/** Nested tree: { children: { name: subtree }, files: [{ name, fullPath, rel }] } */
function buildFileTree(fileList, basePath) {
  const root = { name: 'Project Folder', children: {}, files: [] }
  for (const fullPath of fileList) {
    const rel = fullPath.replace(`${basePath}/`, '')
    const parts = rel.split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.children[parts[i]]) {
        node.children[parts[i]] = { name: parts[i], children: {}, files: [] }
      }
      node = node.children[parts[i]]
    }
    node.files.push({ name: parts[parts.length - 1], fullPath, rel })
  }
  return root
}

function collectFolderPaths(tree, prefix) {
  const out = [prefix || '']
  for (const [name, child] of Object.entries(tree.children || {})) {
    const p = prefix ? `${prefix}/${name}` : name
    out.push(p)
    out.push(...collectFolderPaths(child, p).filter((x) => x !== p))
  }
  return out
}

function getFilesInFolder(tree, folderRel) {
  if (!folderRel) return tree.files
  const parts = folderRel.split('/')
  let node = tree
  for (const p of parts) {
    node = node.children?.[p]
    if (!node) return []
  }
  return node.files
}

export async function renderFilesPanel(body, opts = {}) {
  const base = draftBasePath()
  const tree = buildFileTree(state.fileList, base)
  const allFolders = collectFolderPaths(tree, '')
  const truncHint = state.fileListIncomplete
    ? `<p class="orbit-muted orbit-files-trunc">List may be incomplete (${state.fileListFileCount} files, limit ${state.fileListMaxFiles}; depth limit ${state.fileListMaxDepth}).</p>`
    : ''

  if (state.expandedFolder !== null) {
    const folderFiles = getFilesInFolder(tree, state.expandedFolder)
    const folderLabel = state.expandedFolder || 'Project Folder'
    const moveTargets = allFolders.filter((f) => f !== state.expandedFolder)

    const renderFileRow = (f) => {
      const isPub = !!state.publishedFiles[f.fullPath]
      const pubBadge = isPub
        ? '<span class="orbit-file-pub-badge" title="File is publicly shared">✓</span>'
        : ''
      const unpubBtn = isPub
        ? `<button type="button" class="orbit-btn-icon orbit-btn-unpub" data-unpublish="${escapeHtml(f.rel)}" title="Unpublish this file">↓</button>`
        : ''
      return `
        <li class="orbit-file-row" data-file-rel="${escapeHtml(f.rel)}">
          <button type="button" class="orbit-link orbit-file-open" data-file="${escapeHtml(f.fullPath)}">${escapeHtml(f.name)}</button>
          ${pubBadge}
          <span class="orbit-file-actions">
            ${unpubBtn}
            <button type="button" class="orbit-btn-icon" data-rename="${escapeHtml(f.rel)}" title="Rename">&#9998;</button>
            <button type="button" class="orbit-btn-icon orbit-btn-danger" data-delete="${escapeHtml(f.rel)}" title="Delete">&times;</button>
            <select class="orbit-move-select" data-move="${escapeHtml(f.rel)}">
              <option value="">Move…</option>
              ${moveTargets.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t || '(root)')}</option>`).join('')}
            </select>
          </span>
        </li>`
    }

    body.innerHTML = `
      <div class="orbit-folder-header">
        <button type="button" class="orbit-link orbit-back-btn" id="orbit-folder-back">&larr; Back</button>
        <span class="orbit-folder-name">${escapeHtml(folderLabel)}</span>
      </div>
      <ul class="orbit-files orbit-folder-files">
        ${folderFiles.length
          ? folderFiles.map(renderFileRow).join('')
          : '<li class="orbit-muted">Empty folder.</li>'
        }
      </ul>
      ${truncHint}
      <div class="orbit-upload-section">
        <label class="orbit-upload-label" id="orbit-upload-drop">
          <input type="file" multiple id="orbit-upload-input" class="orbit-upload-input" />
          <span class="orbit-upload-text">Drop files here or click to upload</span>
        </label>
        <div id="orbit-upload-status" class="orbit-upload-status"></div>
        <button type="button" class="orbit-btn orbit-btn-secondary orbit-btn-sm" id="orbit-create-folder" style="margin-top:0.5rem;width:100%">+ New folder</button>
      </div>
    `

    document.getElementById('orbit-folder-back')?.addEventListener('click', async () => {
      state.expandedFolder = null
      await renderLeftPanel(opts)
    })

    // Unpublish individual file
    body.querySelectorAll('[data-unpublish]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const rel = btn.getAttribute('data-unpublish')
        const proj = state.currentProject
        if (!proj) return
        if (!window.confirm(`Unpublish "${rel}"? The file will remain in your draft but will no longer be publicly accessible.`)) return
        const publicFull = `projects/${proj.name}/public/${rel}`
        const draftFull = `${base}/${rel}`
        const result = await unpublishSingleFile(publicFull)
        if (result.success) {
          state.publishedFiles[draftFull] = false
          await renderLeftPanel(opts)
        } else {
          window.alert('Unpublish failed: ' + (result.error || 'unknown error'))
        }
      })
    })

    body.querySelectorAll('.orbit-file-open').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const fp = btn.getAttribute('data-file')
        if (!confirmDiscardChanges()) return
        state.currentFilePath = fp
        state.rightMode = isTextEditablePath(fp) ? 'editor' : 'image'
        await render()
        scrollToRightPanelIfNeeded()
      })
    })

    body.querySelectorAll('[data-rename]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const rel = btn.getAttribute('data-rename')
        const row = body.querySelector(`[data-file-rel="${CSS.escape(rel)}"]`)
        if (!row) return
        const openBtn = row.querySelector('.orbit-file-open')
        if (!openBtn) return
        const oldName = rel.split('/').pop()
        openBtn.outerHTML = `<input type="text" class="orbit-rename-input" data-rename-input="${escapeHtml(rel)}" value="${escapeHtml(oldName)}" /><button type="button" class="orbit-btn-icon orbit-btn-save" data-rename-save="${escapeHtml(rel)}" title="Save">&#10003;</button>`
        const inp = row.querySelector('.orbit-rename-input')
        inp?.focus()
        inp?.select()
        row.querySelector('[data-rename-save]')?.addEventListener('click', async () => {
          const newName = inp.value.trim()
          if (!newName || newName === oldName) return
          const oldRel = rel
          const parts = oldRel.split('/')
          parts[parts.length - 1] = newName
          const newRel = parts.join('/')
          try {
            await renameFileOnServer(`${base}/${oldRel}`, `${base}/${newRel}`)
            const proj = state.currentProject
            if (proj && updateProjectFileReferences(proj, oldRel, newRel)) {
              await persistProjectPages(proj)
            }
            await refreshFileList()
            await renderLeftPanel(opts)
          } catch (e) {
            console.error('Rename failed', e)
            window.alert(e.message || 'Rename failed')
          }
        })
      })
    })

    body.querySelectorAll('[data-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const rel = btn.getAttribute('data-delete')
        const fullDraft = `${base}/${rel}`
        const isPub = !!state.publishedFiles[fullDraft]
        const confirmMsg = isPub
          ? `"${rel}" is currently published. Unpublish and delete?`
          : `Delete "${rel}"?`
        if (!window.confirm(confirmMsg)) return
        try {
          await deleteFileWithUnpublish(fullDraft)
          const proj = state.currentProject
          if (proj && removeFileFromProjectReferences(proj, rel)) {
            await persistProjectPages(proj)
          }
          await refreshFileList()
          if (state.currentFilePath === fullDraft) {
            state.currentFilePath = null
            state.rightMode = 'preview'
            await render()
          } else {
            state.publishedFiles[fullDraft] = false
            await renderLeftPanel(opts)
          }
        } catch (e) {
          console.error('Delete failed', e)
          window.alert(e.message || 'Delete failed')
        }
      })
    })

    body.querySelectorAll('[data-move]').forEach((sel) => {
      sel.addEventListener('change', async () => {
        const rel = sel.getAttribute('data-move')
        const targetFolder = sel.value
        if (targetFolder === '') return
        const fileName = rel.split('/').pop()
        const newRel = targetFolder ? `${targetFolder}/${fileName}` : fileName
        if (newRel === rel) return
        try {
          await renameFileOnServer(`${base}/${rel}`, `${base}/${newRel}`)
          const proj = state.currentProject
          if (proj && updateProjectFileReferences(proj, rel, newRel)) {
            await persistProjectPages(proj)
          }
          await refreshFileList()
          await renderLeftPanel(opts)
        } catch (e) {
          console.error('Move failed', e)
          window.alert(e.message || 'Move failed')
        }
      })
    })
  } else {
    const renderTreeNode = (node, prefix, depth) => {
      let html = ''
      const sortedFolders = Object.keys(node.children).sort()
      for (const name of sortedFolders) {
        const folderPath = prefix ? `${prefix}/${name}` : name
        const isCollapsed = state.collapsedFolders.has(folderPath)
        const toggleIcon = isCollapsed ? '&#9654;' : '&#9660;'
        const pl = (depth * 1.2) + 'rem'
        html += `<li class="orbit-tree-folder">
          <div class="orbit-tree-folder-row" style="padding-left:${pl}">
            <button type="button" class="orbit-link orbit-tree-toggle" data-toggle-folder="${escapeHtml(folderPath)}">${toggleIcon}</button>
            <button type="button" class="orbit-link orbit-tree-folder-btn" data-folder="${escapeHtml(folderPath)}">&#128193; ${escapeHtml(name)}/</button>
          </div>
          ${!isCollapsed ? `<ul class="orbit-tree">${renderTreeNode(node.children[name], folderPath, depth + 1)}</ul>` : ''}
        </li>`
      }
      for (const f of node.files) {
        const icon = isImagePath(f.name) ? '&#128248;' : '&#128196;'
        const pl = `calc(${depth * 1.2}rem + 0.9rem)`
        const isPub = !!state.publishedFiles[f.fullPath]
        const pubDot = isPub ? ' <span class="orbit-tree-pub-dot" title="Published">●</span>' : ''
        html += `<li class="orbit-tree-file" style="padding-left:${pl}">
          <button type="button" class="orbit-link" data-file="${escapeHtml(f.fullPath)}">${icon} ${escapeHtml(f.name)}</button>${pubDot}
        </li>`
      }
      return html
    }

    body.innerHTML = `
      <ul class="orbit-files orbit-tree">
        <li class="orbit-tree-root">
          <button type="button" class="orbit-link orbit-tree-folder-btn" data-folder="">&#128193; Project Folder</button>
        </li>
        ${renderTreeNode(tree, '', 0)}
      </ul>
      ${truncHint}
      <div class="orbit-upload-section">
        <label class="orbit-upload-label" id="orbit-upload-drop">
          <input type="file" multiple id="orbit-upload-input" class="orbit-upload-input" />
          <span class="orbit-upload-text">Drop files here or click to upload</span>
        </label>
        <div id="orbit-upload-status" class="orbit-upload-status"></div>
        <button type="button" class="orbit-btn orbit-btn-secondary orbit-btn-sm" id="orbit-create-folder" style="margin-top:0.5rem;width:100%">+ New folder</button>
      </div>
    `

    body.querySelectorAll('[data-toggle-folder]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const fp = btn.getAttribute('data-toggle-folder')
        if (state.collapsedFolders.has(fp)) {
          state.collapsedFolders.delete(fp)
        } else {
          state.collapsedFolders.add(fp)
        }
        await renderLeftPanel(opts)
      })
    })

    body.querySelectorAll('[data-folder]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        state.expandedFolder = btn.getAttribute('data-folder')
        await renderLeftPanel(opts)
      })
    })

    body.querySelectorAll('[data-file]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const fp = btn.getAttribute('data-file')
        if (!confirmDiscardChanges()) return
        state.currentFilePath = fp
        state.rightMode = isTextEditablePath(fp) ? 'editor' : 'image'
        await render()
        scrollToRightPanelIfNeeded()
      })
    })
  }

  document.getElementById('orbit-create-folder')?.addEventListener('click', async () => {
    const raw = window.prompt('New folder name (letters, numbers, hyphens, underscores):')
    if (!raw) return
    const folderName = raw.trim().replace(/[^a-zA-Z0-9_\-]/g, '-').replace(/^-+|-+$/g, '')
    if (!folderName) { window.alert('Invalid folder name.'); return }
    const parentFolder = state.expandedFolder ? `${base}/${state.expandedFolder}` : base
    const placeholderPath = `${parentFolder}/${folderName}/.gitkeep`
    try {
      await uploadText(placeholderPath, '', 'text/plain')
      await refreshFileList()
      await renderLeftPanel(opts)
    } catch (e) {
      window.alert('Could not create folder: ' + (e.message || String(e)))
    }
  })

  const dropZone = document.getElementById('orbit-upload-drop')
  const fileInput = document.getElementById('orbit-upload-input')
  const statusEl = document.getElementById('orbit-upload-status')
  if (dropZone && fileInput && statusEl) {
    const handleFiles = async (files) => {
      if (!files.length || !state.currentProject) return
      statusEl.textContent = `Uploading ${files.length} file${files.length > 1 ? 's' : ''}…`
      let ok = 0
      let fail = 0
      for (const f of files) {
        try {
          const uploadFolder = state.expandedFolder ? `${base}/${state.expandedFolder}` : base
          await freezr.upload(f, { targetFolder: uploadFolder, overwrite: true })
          ok++
        } catch (e) {
          console.warn('Upload failed:', f.name, e)
          fail++
        }
      }
      statusEl.textContent = `Uploaded ${ok} file${ok !== 1 ? 's' : ''}` + (fail ? `, ${fail} failed` : '')
      await refreshFileList()
      await renderLeftPanel(opts)
    }
    fileInput.addEventListener('change', (e) => handleFiles([...e.target.files]))
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault()
      dropZone.classList.add('orbit-upload-dragover')
    })
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('orbit-upload-dragover'))
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault()
      dropZone.classList.remove('orbit-upload-dragover')
      handleFiles([...e.dataTransfer.files])
    })
  }
}