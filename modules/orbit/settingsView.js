/* global freezr */
/**
 * Settings & Projects — a whole view, not a tab.
 *
 * Everything here acts on projects rather than inside one, so it deliberately replaces the
 * workspace: no Chat/Pages/Files tabs, no preview pane. That is what keeps "delete this
 * project" from ever sitting a click away from "edit this page".
 */
import { state, draftBasePath, draftRelFilePaths, rememberProject } from './state.js'
import { escapeHtml, normalizeQueryRows } from './util.js'
import { uploadText, uploadFile } from './fileIO.js'
import { refreshFileList } from './filesData.js'
import { loadProjects, createProject, switchToProject, deleteProject } from './projects.js'
import { convertProjectToSlideshow } from './slideshowSync.js'
import { handleRestoreCheckpoint } from './chat.js'
import { updateLockOverlay } from './editor.js'
import { refreshPreview } from './preview.js'
import { render } from './bus.js'
import { fetchUserBlob } from '../fileFetch.js'
import { isSlideshow } from '../slideshow/slideshowModel.js'
import {
  renderLlmSettings, bindLlmSettings, loadLlmProviders
} from '../llmSettings.js'
import {
  buildProjectBundle, validateBundle, applyProjectBundle,
  downloadBundle, approxBundleSize, isValidProjectName, chatDedupeKey
} from '../projectTransfer.js'
import {
  listCheckpoints, deleteCheckpoint, CHECKPOINTS_MIN, CHECKPOINTS_MAX
} from '../checkpoints.js'

const chatDeps = () => ({ render, refreshPreview, updateLockOverlay })

/** Leave the Settings & Projects view and return to the project workspace, unchanged. */
export async function closeSettingsView() {
  state.view = 'project'
  await render()
}

/** The Versions sub-section body: automatic + manual checkpoints. */
function renderVersionsBody(busy) {
  if (state.checkpointsLoading) {
    return '<div class="orbit-settings-body"><p class="orbit-muted">Loading checkpoints…</p></div>'
  }
  const list = state.checkpointsList || []
  if (!list.length) {
    return '<div class="orbit-settings-body"><p class="orbit-muted">No checkpoints yet. One is saved automatically every time you start a new chat on this project.</p></div>'
  }
  const rows = list.map((c) => {
    const when = c.takenAt ? new Date(c.takenAt).toLocaleString() : 'unknown time'
    const triggerLabel = c.trigger === 'chat_start' ? 'New chat' : 'Manual'
    return `<li class="orbit-checkpoint-item">
      <span class="orbit-checkpoint-when">${escapeHtml(when)}</span>
      <span class="orbit-checkpoint-trigger">${escapeHtml(triggerLabel)}</span>
      <span class="orbit-checkpoint-count">${c.fileCount} file${c.fileCount === 1 ? '' : 's'}</span>
      <button type="button" class="orbit-btn-sm orbit-btn-secondary" data-checkpoint-restore="${escapeHtml(c.path)}" ${busy ? 'disabled' : ''}>Restore</button>
      <button type="button" class="orbit-btn-sm orbit-delete-page-btn" data-checkpoint-delete="${escapeHtml(c.path)}" ${busy ? 'disabled' : ''}>Delete</button>
    </li>`
  }).join('')
  return `<div class="orbit-settings-body">
    <p class="orbit-settings-note">Up to ${CHECKPOINTS_MAX} are kept (oldest deleted automatically); the ${CHECKPOINTS_MIN} most recent are never auto-deleted.</p>
    <ul class="orbit-checkpoint-list">${rows}</ul>
  </div>`
}

/** The Transform sub-section body: convert and delete actions for the current project. */
function renderTransformBody(proj, busy) {
  const isDeck = isSlideshow(proj)
  const canMakeSlideshow = !isDeck && Array.isArray(proj.pages) && proj.pages.length >= 2
  const convertBtn = isDeck
    ? `<button type="button" class="orbit-btn-sm orbit-btn-secondary orbit-proj-convert" data-convert-project="${escapeHtml(proj.name)}" title="Re-read the files and rebuild the slide list" ${busy ? 'disabled' : ''}>Rebuild slides</button>`
    : canMakeSlideshow
      ? `<button type="button" class="orbit-btn-sm orbit-btn-secondary orbit-proj-convert" data-convert-project="${escapeHtml(proj.name)}" title="Turn this multi-page project into a slide show" ${busy ? 'disabled' : ''}>Make into a slide show</button>`
      : '<p class="orbit-muted">Add a second page to turn this project into a slide show.</p>'
  return `
    <div class="orbit-settings-body">
      ${convertBtn}
      <button type="button" class="orbit-btn-sm orbit-delete-page-btn" data-delete-project="${escapeHtml(proj.name)}" ${busy ? 'disabled' : ''}>Delete project</button>
    </div>`
}

export function renderSettingsBody(projectSelectHtml) {
  const { canLlm } = state.permissions
  const busy = state.transferBusy

  // Existing-projects list: pick a project here, nothing else. Converting or deleting the
  // CURRENT project lives in its own "This project" section below, never sitting one click
  // away from an unrelated project's "open".
  const projectRow = (p) => {
    const isCurrent = state.currentProject?.name === p.name
    return `
      <li class="orbit-proj-row${isCurrent ? ' is-current' : ''}">
        <button type="button" class="orbit-link orbit-proj-open" data-open-project="${escapeHtml(p.name)}" ${busy ? 'disabled' : ''}>
          <span class="orbit-proj-name">${escapeHtml(p.display_name || p.name)}${isSlideshow(p) ? ' <span class="orbit-proj-id">slide show</span>' : ''}</span>
          <span class="orbit-proj-id">${escapeHtml(p.name)}</span>
        </button>
      </li>`
  }

  const proj = state.currentProject
  const thisProjectBody = proj
    ? `
      <button type="button" class="orbit-btn orbit-btn-secondary orbit-btn-sm" id="orbit-export-project" ${busy ? 'disabled' : ''}>
        Export ${escapeHtml(proj.name)}…
      </button>
      <label class="orbit-settings-check">
        <input type="checkbox" id="orbit-export-include-chat" ${state.exportIncludeChat ? 'checked' : ''} ${busy ? 'disabled' : ''}>
        Include chat history
      </label>
      <p class="orbit-settings-note">
        An export is a single <code>.json</code> file holding this project's pages, every file in its
        folder, and — when checked — its chat history. Re-importing the same export, or passing it
        back and forth between two freezr instances, never duplicates a chat message.
      </p>
      <div id="orbit-transfer-status" class="orbit-upload-status">${escapeHtml(state.transferStatus || '')}</div>

      <div class="orbit-settings-section" style="margin-top:0.6rem">
        <button type="button" class="orbit-settings-header" id="orbit-versions-toggle" aria-expanded="${state.settingsVersionsOpen ? 'true' : 'false'}">
          <span class="orbit-settings-caret">${state.settingsVersionsOpen ? '&#9660;' : '&#9654;'}</span>
          <span class="orbit-settings-title">Versions</span>
          <span class="orbit-settings-summary">${state.checkpointsList ? state.checkpointsList.length + ' saved' : ''}</span>
        </button>
        ${state.settingsVersionsOpen ? renderVersionsBody(busy) : ''}
      </div>

      <div class="orbit-settings-section" style="margin-top:0.6rem">
        <button type="button" class="orbit-settings-header" id="orbit-transform-toggle" aria-expanded="${state.settingsTransformOpen ? 'true' : 'false'}">
          <span class="orbit-settings-caret">${state.settingsTransformOpen ? '&#9660;' : '&#9654;'}</span>
          <span class="orbit-settings-title">Transform</span>
        </button>
        ${state.settingsTransformOpen ? renderTransformBody(proj, busy) : ''}
      </div>`
    : '<p class="orbit-muted">Open a project to export it or change its type.</p>'

  return `
    <div class="orbit-body orbit-body--settings">
      <div class="orbit-settings-page">
        <div class="orbit-left-toolbar">
          <div class="globe-toolbar orbit-globe-idle"><div class="sphere"></div><div class="orbit-ring"><div class="orbit-dot"></div></div></div>
          ${projectSelectHtml}
        </div>

        <div class="orbit-settings-scroll">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem;margin-bottom:1.25rem">
            <h3 class="orbit-settings-page-title" style="margin:0">Settings &amp; Projects</h3>
            <button type="button" class="orbit-btn orbit-btn-secondary orbit-btn-sm" id="orbit-settings-close">Close</button>
          </div>

          <h4 class="orbit-settings-heading">Model</h4>
          <div id="orbit-llm-settings">${renderLlmSettings(state.llm, canLlm)}</div>

          <h4 class="orbit-settings-heading">This project</h4>
          <div class="orbit-settings-section">
            <div class="orbit-settings-body">${thisProjectBody}</div>
          </div>

          <h4 class="orbit-settings-heading">New project</h4>
          <div class="orbit-settings-section">
            <div class="orbit-settings-body">
              <div class="orbit-settings-row">
                <label for="orbit-newproj-kind">Type</label>
                <select id="orbit-newproj-kind" class="orbit-select" ${busy ? 'disabled' : ''}>
                  <option value="web">Web page</option>
                  <option value="slideshow">Slide show</option>
                </select>
              </div>
              <div class="orbit-newproj-row">
                <input type="text" id="orbit-newproj-name" class="orbit-settings-input"
                       placeholder="project-id" autocomplete="off" spellcheck="false" ${busy ? 'disabled' : ''} />
                <button type="button" class="orbit-btn orbit-btn-sm" id="orbit-newproj-launch" ${busy ? 'disabled' : ''}>Launch project</button>
              </div>
              <p class="orbit-settings-note" id="orbit-newproj-msg">Letters, numbers, hyphens and underscores. A slide show starts from a deck template with two slides.</p>

              <label class="orbit-import-label ${busy ? 'is-disabled' : ''}" style="margin-top:0.5rem">
                <input type="file" accept="application/json,.json" id="orbit-import-input" class="orbit-upload-input" ${busy ? 'disabled' : ''} />
                <span class="orbit-btn orbit-btn-secondary orbit-btn-sm">Import a project…</span>
              </label>
              <p class="orbit-settings-note">
                Importing an export (.json) file creates a new project, or overwrites a project of the
                same name (files not in the bundle are left alone; chat messages already present are
                skipped).
              </p>
            </div>
          </div>

          <h4 class="orbit-settings-heading">Existing projects</h4>
          <div class="orbit-settings-section">
            <ul class="orbit-proj-list">
              ${state.projects.length
                ? state.projects.map(projectRow).join('')
                : '<li class="orbit-muted orbit-proj-empty">No projects yet.</li>'}
            </ul>
          </div>
        </div>
      </div>
    </div>`
}

export function bindSettingsView() {
  const rerender = () => render()
  const setStatus = (msg) => {
    state.transferStatus = msg || ''
    const el = document.getElementById('orbit-transfer-status')
    if (el) el.textContent = state.transferStatus
  }
  const runBusy = async (fn) => {
    state.transferBusy = true
    await render()
    try {
      await fn()
    } finally {
      state.transferBusy = false
      await render()
    }
  }

  bindLlmSettings(document.getElementById('orbit-llm-settings'), state.llm, rerender)
  if (state.permissions.canLlm && !state.llm.providers && !state.llm.loading) {
    loadLlmProviders(state.llm).then((changed) => {
      if (changed && state.view === 'settings') render()
    })
  }

  document.getElementById('orbit-settings-close')?.addEventListener('click', () => {
    closeSettingsView()
  })

  document.getElementById('orbit-transform-toggle')?.addEventListener('click', () => {
    state.settingsTransformOpen = !state.settingsTransformOpen
    rerender()
  })

  document.getElementById('orbit-versions-toggle')?.addEventListener('click', async () => {
    state.settingsVersionsOpen = !state.settingsVersionsOpen
    const proj = state.currentProject
    if (state.settingsVersionsOpen && state.checkpointsList === null && proj) {
      state.checkpointsLoading = true
      await rerender()
      try {
        state.checkpointsList = await listCheckpoints(proj.name)
      } catch (e) {
        console.warn('Orbit: could not load checkpoints', e)
        state.checkpointsList = []
      }
      state.checkpointsLoading = false
    }
    await rerender()
  })

  document.querySelectorAll('[data-checkpoint-restore]').forEach((btn) => {
    btn.addEventListener('click', () => handleRestoreCheckpoint(btn.getAttribute('data-checkpoint-restore'), chatDeps()))
  })
  document.querySelectorAll('[data-checkpoint-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const path = btn.getAttribute('data-checkpoint-delete')
      if (!window.confirm('Delete this checkpoint? This cannot be undone.')) return
      btn.disabled = true
      try {
        await deleteCheckpoint(path)
        state.checkpointsList = (state.checkpointsList || []).filter((c) => c.path !== path)
        await rerender()
      } catch (e) {
        console.error('Orbit: delete checkpoint failed', e)
        window.alert('Could not delete checkpoint: ' + (e.message || String(e)))
        btn.disabled = false
      }
    })
  })

  // ---- new project: inline field, no dialog ----
  const nameInput = document.getElementById('orbit-newproj-name')
  const msgEl = document.getElementById('orbit-newproj-msg')
  const launch = async () => {
    const slug = (nameInput?.value || '').trim()
    const say = (text, isError) => {
      if (!msgEl) return
      msgEl.textContent = text
      msgEl.classList.toggle('orbit-settings-note--error', !!isError)
    }
    if (!slug) return say('Enter a project id first.', true)
    if (!isValidProjectName(slug)) {
      return say('Use letters, numbers, hyphens and underscores only — no spaces.', true)
    }
    if (state.projects.some((p) => p.name === slug)) {
      return say(`"${slug}" already exists. Pick another id.`, true)
    }
    await runBusy(async () => {
      const kind = document.getElementById('orbit-newproj-kind')?.value === 'slideshow' ? 'slideshow' : 'web'
      setStatus(kind === 'slideshow' ? 'Creating slide show…' : 'Creating project…')
      try {
        await createProject(slug, kind) // switches to it, which leaves this view
      } catch (e) {
        console.error('Orbit: could not create project', e)
        setStatus('')
        say('Could not create project: ' + (e.message || String(e)), true)
      }
    })
  }
  document.getElementById('orbit-newproj-launch')?.addEventListener('click', launch)
  nameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); launch() }
  })

  // ---- project list ----
  document.querySelectorAll('[data-open-project]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await switchToProject(btn.getAttribute('data-open-project'))
    })
  })

  document.querySelectorAll('[data-delete-project]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const name = btn.getAttribute('data-delete-project')
      // Typing the name is the whole safeguard here: this deletes every file in the
      // project, published copies included, and cannot be undone.
      const typed = window.prompt(
        `Delete the project "${name}"?\n\n` +
        'This permanently removes ALL of its files — drafts, published copies and chat history. ' +
        'It cannot be undone.\n\n' +
        'Type the project id to confirm:'
      )
      if (typed == null) return
      if (typed.trim() !== name) {
        window.alert('That did not match the project id. Nothing was deleted.')
        return
      }
      await runBusy(async () => {
        try {
          const { deleted, warnings } = await deleteProject(name, setStatus)
          await loadProjects()
          if (state.currentProject?.name === name) {
            state.currentProject = state.projects[0] || null
            state.activePageIndex = 0
            state.currentFilePath = null
            state.fileList = []
            if (state.currentProject) rememberProject(state.currentProject.name)
          }
          setStatus(`Deleted "${name}" (${deleted} file${deleted === 1 ? '' : 's'}).`)
          if (warnings.length) {
            window.alert(
              `"${name}" was removed, but ${warnings.length} file(s) could not be deleted:\n\n` +
              warnings.join('\n')
            )
          }
        } catch (e) {
          console.error('Orbit: delete project failed', e)
          setStatus('')
          window.alert('Could not delete "' + name + '": ' + (e.message || String(e)))
        }
      })
    })
  })

  // ---- convert a multi-page web project into a slide show ----
  document.querySelectorAll('[data-convert-project]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const name = btn.getAttribute('data-convert-project')
      const proj = state.projects.find((p) => p.name === name)
      if (!proj) return
      const rebuilding = isSlideshow(proj)
      const msg = rebuilding
        ? `Rebuild the slide list for "${name}"?\n\n` +
          'Orbit re-reads the deck and the files in the project and rewrites the slide list to match ' +
          'what the presentation actually contains. Use this when the Slides tab is missing slides, or ' +
          'showing ones that are no longer part of the show.\n\n' +
          'No slide file is changed or deleted — only the list. Anything listed that you do not want ' +
          'can be deleted from the Slides tab afterwards.\n\nContinue?'
        : `Turn "${name}" into a slide show?\n\n` +
          'Orbit reads the project files to work out which page is the deck and which pages are slides. ' +
          'If the main page already plays the slides it is kept exactly as it is; otherwise Orbit writes ' +
          'a fresh deck template with the slide viewer already wired up, so the show plays straight away.\n\n' +
          'No files are deleted. A page that becomes a slide no longer uses its own CSS/JS — the deck\'s ' +
          'styling applies instead, so a slide that looks different can be restyled from the Slides tab ' +
          'or by asking Chat.\n\n' +
          'Pages published on their own get unpublished — publish the whole presentation afterwards.\n\nContinue?'
      if (!window.confirm(msg)) return
      await runBusy(async () => {
        try {
          const result = await convertProjectToSlideshow(name, setStatus)
          await loadProjects()
          const n = result?.slideCount || 0
          let note = rebuilding
            ? `Rebuilt "${name}" — ${n} slide${n === 1 ? '' : 's'}.`
            : `"${name}" is now a slide show (${n} slide${n === 1 ? '' : 's'}).`
          if (result?.skipped) {
            note += ` ${result.skipped} other .html file${result.skipped === 1 ? '' : 's'} in slides/ ` +
              `${result.skipped === 1 ? 'is' : 'are'} not part of the show and ` +
              `${result.skipped === 1 ? 'was' : 'were'} left alone.`
          }
          setStatus(note)
          // A kept deck with its own hardcoded slide list will not follow slides.json, so
          // reordering would silently do nothing — say so rather than let it confuse later.
          if (result?.keptDeck && !result.readsManifest) {
            window.alert(
              'Orbit kept the existing deck page, but that deck lists its slides itself rather than ' +
              'reading slides.json.\n\nThe Slides tab now matches what it plays, but reordering or adding ' +
              'a slide there will not change the presentation until the deck reads slides.json. Ask Chat: ' +
              '"Make the deck load its slides from slides.json and follow Orbit\'s slide-show rules."'
            )
          }
          state.leftTab = 'slides'
          await switchToProject(name)
        } catch (e) {
          console.error('Orbit: convert to slide show failed', e)
          setStatus('')
          window.alert('Could not convert "' + name + '": ' + (e.message || String(e)))
        }
      })
    })
  })

  // ---- export ----
  document.getElementById('orbit-export-include-chat')?.addEventListener('change', (e) => {
    state.exportIncludeChat = !!e.target.checked
  })
  document.getElementById('orbit-export-project')?.addEventListener('click', async () => {
    const proj = state.currentProject
    if (!proj) return
    await runBusy(async () => {
      try {
        // The export reads the folder listing, which may be stale if the user came straight
        // here from another project.
        await refreshFileList()

        let chatHistory = null
        let chatFetchFailed = false
        if (state.exportIncludeChat) {
          setStatus('Reading chat history…')
          try {
            const rows = await freezr.query('chat_history', { project_name: proj.name }, { sort: { _date_modified: 1 }, count: 2000 })
            chatHistory = normalizeQueryRows(rows)
          } catch (e) {
            console.warn('Orbit: could not read chat history for export', e)
            chatFetchFailed = true
          }
        }

        const { bundle, warnings } = await buildProjectBundle({
          project: proj,
          fileRels: draftRelFilePaths(),
          fetchDraftBlob: (rel) => fetchUserBlob(`${draftBasePath()}/${rel}`),
          onProgress: setStatus,
          chatHistory
        })
        const stamp = new Date().toISOString().slice(0, 10)
        downloadBundle(bundle, `${proj.name}-${stamp}.orbit.json`)
        const chatNote = bundle.chatHistory ? `, ${bundle.chatHistory.length} chat message${bundle.chatHistory.length === 1 ? '' : 's'}` : ''
        setStatus(`Exported ${bundle.files.length} file${bundle.files.length === 1 ? '' : 's'}${chatNote} (${approxBundleSize(bundle)}).`)
        if (warnings.length || chatFetchFailed) {
          window.alert(
            (warnings.length
              ? 'The export finished, but ' + warnings.length + ' file' + (warnings.length > 1 ? 's' : '') +
                ' could not be read and were left out:\n\n' + warnings.join('\n')
              : '') +
            (chatFetchFailed ? (warnings.length ? '\n\n' : '') + 'Chat history could not be read, so none was included in the export.' : '')
          )
        }
      } catch (e) {
        console.error('Orbit: export failed', e)
        setStatus('')
        window.alert('Export failed: ' + (e.message || String(e)))
      }
    })
  })

  // ---- import ----
  document.getElementById('orbit-import-input')?.addEventListener('change', async (ev) => {
    const file = ev.target.files?.[0]
    ev.target.value = '' // so re-picking the same file fires change again
    if (!file) return

    let bundle
    try {
      bundle = validateBundle(JSON.parse(await file.text()))
    } catch (e) {
      window.alert('Could not read that bundle.\n\n' + (e.message || String(e)))
      return
    }

    const name = bundle.project.name
    const exists = state.projects.some((p) => p.name === name)
    const chatCount = Array.isArray(bundle.chatHistory) ? bundle.chatHistory.length : 0
    const ok = window.confirm(
      (exists
        ? `A project called "${name}" already exists.\n\n` +
          `Import will overwrite its pages and write ${bundle.files.length} file(s) over the ones in its folder. ` +
          'Files not in the bundle are left in place.'
        : `Import "${name}" — ${bundle.files.length} file(s)?`) +
      (chatCount ? `\n\nIncludes ${chatCount} chat message${chatCount === 1 ? '' : 's'} (duplicates are skipped automatically).` : '') +
      '\n\nContinue?'
    )
    if (!ok) return

    await runBusy(async () => {
      try {
        const importingCurrent = exists && state.currentProject?.name === name
        if (importingCurrent) await refreshFileList()

        // Re-importing the same bundle, or passing it back and forth between two instances,
        // must not duplicate every chat message — compare against what this project has.
        let existingChatKeys = null
        if (chatCount) {
          try {
            const rows = await freezr.query('chat_history', { project_name: name }, { sort: { _date_modified: 1 }, count: 2000 })
            existingChatKeys = new Set(normalizeQueryRows(rows).map(chatDedupeKey))
          } catch (e) {
            console.warn('Orbit: could not read existing chat history before import', e)
            existingChatKeys = new Set()
          }
        }

        const result = await applyProjectBundle({
          bundle,
          existingRels: importingCurrent ? draftRelFilePaths() : [],
          uploadText,
          uploadFile,
          projectExists: exists,
          onProgress: setStatus,
          existingChatKeys,
          createChatRecord: chatCount ? (rec) => freezr.create('chat_history', { ...rec, project_name: name }, {}) : undefined,
          saveProjectRow: async (row, alreadyExists) => {
            const fields = { ...row }
            delete fields.name
            // updateFields only writes the keys it is given, and a web-project bundle
            // carries neither `type` nor `slides`. Without setting them explicitly, an
            // import over a same-named slide show would leave type:'slideshow' and the old
            // slide list in place — the project would keep a Slides tab listing files the
            // import had just replaced. Normalise both on every import.
            const isDeckBundle = row.type === 'slideshow'
            fields.type = isDeckBundle ? 'slideshow' : 'web'
            fields.slides = isDeckBundle && Array.isArray(row.slides) ? row.slides : []
            if (alreadyExists) {
              await freezr.updateFields('projects', { name: row.name }, fields)
            } else {
              await freezr.create('projects', { ...row, type: fields.type, slides: fields.slides }, {})
            }
          }
        })
        await loadProjects()

        let msg = `Imported "${result.name}" — ${result.written} file(s) written.`
        if (result.chatWritten || result.chatSkipped) {
          msg += ` ${result.chatWritten} chat message${result.chatWritten === 1 ? '' : 's'} added` +
            (result.chatSkipped ? `, ${result.chatSkipped} already present.` : '.')
        }
        if (result.warnings.length) {
          msg += `\n\n${result.warnings.length} file(s) failed:\n` + result.warnings.join('\n')
        }
        if (result.leftovers.length) {
          msg += `\n\n${result.leftovers.length} file(s) already in the folder were not in the bundle and were left in place:\n` +
            result.leftovers.join('\n') + '\n\nDelete them from the Files tab if they are no longer wanted.'
        }
        setStatus(`Imported "${result.name}".`)
        window.alert(msg)
        await switchToProject(name) // opens the imported project
      } catch (e) {
        console.error('Orbit: import failed', e)
        setStatus('')
        window.alert('Import failed: ' + (e.message || String(e)))
      }
    })
  })
}