/* global freezr */
/** Loads and caches this app's permission grants; re-checked on demand (e.g. before publishing). */
import { state } from './state.js'

export async function reloadPermissions() {
  try {
    const perms = await freezr.perms.getAppPermissions()
    const list = Array.isArray(perms) ? perms : []
    state.permissions.raw = list
    state.permissions.canPublish = !!list.find((p) => p.name === 'publish_site' && p.granted)
    state.permissions.canLlm = !!list.find((p) => p.name === 'use_llm' && p.granted)
    state.permissions.canIframePreview = !!list.find((p) => p.name === 'allow_iframe_preview' && p.granted)
    state.permissions.sessionExpired = false
    state.permissions.lastError = null
  } catch (e) {
    console.warn('Orbit: reloadPermissions failed', e)
    state.permissions.lastError = e
    if (e && (e.status === 401 || /session|token/i.test(e.message || ''))) {
      state.permissions.sessionExpired = true
    }
  } finally {
    state.permissions.loaded = true
  }
}