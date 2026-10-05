/* global freezr, freezrMeta */
/**
 * Durable checkpoints: a snapshot of a project's files + row, taken automatically at the start
 * of each new chat thread (and reusable for a manual save later), so a bad run of edits can be
 * rolled back even after the page has been closed and reopened — unlike the single-turn
 * in-memory Undo in orbitMain.js, which only covers the most recent chat reply and disappears
 * on reload.
 *
 * A checkpoint IS an export bundle (see projectTransfer.js) without chat history, written to
 * projects/<name>/versions/<timestamp>.json. Its own files-table record carries the
 * checkpoint's metadata (trigger, label, fileCount, takenAt) via upload options.data, per the
 * files-table contract — there is no separate checkpoints collection.
 *
 * Listing walks the versions/ folder via read_user_file_tree rather than querying the files
 * table by path prefix: only _id and _date_modified are reliably indexed (see freezr-context.md
 * indexing note), and a folder listing is exactly what the rest of Orbit already uses to
 * enumerate a project's files.
 */
import { buildProjectBundle, applyProjectBundle, validateBundle } from './projectTransfer.js'

export const CHECKPOINTS_MIN = 5
export const CHECKPOINTS_MAX = 20

function normalizeQueryRows(rows) {
  if (Array.isArray(rows)) return rows
  if (rows && Array.isArray(rows.data)) return rows.data
  return []
}

function versionsFolder(projectName) {
  return `projects/${projectName}/versions`
}

/**
 * Take a checkpoint of the given project's CURRENT draft files + row.
 * @param {object} opts
 * @param {object} opts.project - the projects row
 * @param {string[]} opts.fileRels - every file in the draft folder, relative to it
 * @param {(rel: string) => Promise<Blob>} opts.fetchDraftBlob
 * @param {string} [opts.trigger] - 'chat_start' | 'manual'
 * @param {string} [opts.label]
 * @returns {Promise<{path: string, warnings: string[]}|null>} null when the project has no name
 */
export async function saveCheckpoint({ project, fileRels, fetchDraftBlob, trigger, label }) {
  if (!project?.name) return null
  const { bundle, warnings } = await buildProjectBundle({ project, fileRels, fetchDraftBlob })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const fileName = `${ts}.json`
  const path = `${versionsFolder(project.name)}/${fileName}`
  const json = JSON.stringify(bundle)
  const blob = new Blob([json], { type: 'application/json' })
  const file = new File([blob], fileName, { type: 'application/json' })
  await freezr.upload(file, {
    targetFolder: versionsFolder(project.name),
    overwrite: true,
    data: {
      kind: 'orbit-checkpoint',
      trigger: trigger || 'manual',
      label: label || '',
      fileCount: bundle.files.length,
      takenAt: Date.now()
    }
  })
  return { path, warnings }
}

/** Every checkpoint for a project, newest first. */
export async function listCheckpoints(projectName) {
  if (typeof freezrMeta === 'undefined' || !freezrMeta.appName || !projectName) return []
  const prefix = versionsFolder(projectName)
  const url = '/feps/read_user_file_tree/' + encodeURIComponent(freezrMeta.appName)
  let tree = []
  try {
    const result = await freezr.apiRequest('POST', url, {
      subPath: prefix,
      readSubFolders: false,
      maxFiles: 200,
      maxDepth: 1,
      includeMetadata: true
    })
    tree = Array.isArray(result?.tree) ? result.tree : []
  } catch (e) {
    console.warn('Orbit: listCheckpoints failed', e)
    return []
  }
  const files = tree.filter((n) => n && n.type === 'file' && /\.json$/i.test(n.name || ''))
  const records = []
  for (const f of files) {
    const path = `${prefix}/${f.name}`
    let meta = null
    try {
      const rows = await freezr.query('files', { _id: path }, {})
      meta = normalizeQueryRows(rows)[0] || null
    } catch (e) {
      // a checkpoint whose metadata record is gone is still worth listing — just unlabeled
    }
    records.push({
      path,
      trigger: meta?.trigger || 'manual',
      label: meta?.label || '',
      fileCount: meta?.fileCount || 0,
      takenAt: meta?.takenAt || meta?._date_modified || f.mtimeMs || 0,
      size: meta?._file_size || f.size || 0
    })
  }
  records.sort((a, b) => b.takenAt - a.takenAt)
  return records
}

/** Delete checkpoints beyond `max`, oldest first. Never deletes the most recent `min`. */
export async function pruneCheckpoints(projectName, { min = CHECKPOINTS_MIN, max = CHECKPOINTS_MAX } = {}) {
  const list = await listCheckpoints(projectName)
  const keep = Math.max(max, min)
  if (list.length <= keep) return { deleted: 0 }
  const toDelete = list.slice(keep)
  let deleted = 0
  for (const rec of toDelete) {
    try {
      await freezr.deleteFile(rec.path)
      deleted++
    } catch (e) {
      console.warn('Orbit: checkpoint prune failed', rec.path, e)
    }
  }
  return { deleted }
}

export async function deleteCheckpoint(path) {
  await freezr.deleteFile(path)
}

/**
 * Restore a checkpoint onto the CURRENT project — overwrites files it lists, leaves any other
 * file in the draft folder alone (same contract as Import), and never touches chat history.
 * @param {object} opts
 * @param {string} opts.path - the checkpoint's file path
 * @param {(path: string) => Promise<string>} opts.fetchText
 * @param {string[]} opts.existingRels
 * @param {(fullPath: string, text: string, mime: string) => Promise<void>} opts.uploadText
 * @param {(fullPath: string, file: File) => Promise<void>} opts.uploadFile
 * @param {(row: object, exists: boolean) => Promise<void>} opts.saveProjectRow
 */
export async function restoreCheckpoint({ path, fetchText, existingRels, uploadText, uploadFile, saveProjectRow }) {
  const text = await fetchText(path)
  const bundle = validateBundle(JSON.parse(text))
  return applyProjectBundle({ bundle, existingRels, uploadText, uploadFile, projectExists: true, saveProjectRow })
}