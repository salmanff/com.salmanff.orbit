/* global freezr, freezrMeta */
/**
 * LLM provider / model settings for Orbit.
 *
 * Mirrors the LLM settings block in the Creator app
 * (freezrsystmapps/info.freezr.creator/modules/panels/projectPanel.js): the
 * provider list, the model families and their prices all come from one
 * `freezr.llm.ping()` call, and the chosen family is passed straight back as
 * `options.model` on `freezr.llm.ask()` — the server resolves a family
 * shorthand ('sonnet', 'opus', 'mini', …) to a full model id.
 *
 * This module owns no DOM of its own beyond the block it renders, and knows
 * nothing about which tab hosts it. It currently sits at the bottom of the
 * Files tab; when that tab becomes "Settings" with Files / Project
 * sub-sections it moves under Project settings unchanged.
 */

const LS_KEY = 'orbitLlmSettings'

function readStored() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return (parsed && typeof parsed === 'object') ? parsed : {}
  } catch (_) {
    return {}
  }
}

function persist(llm) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      provider: llm.provider,
      model: llm.model
    }))
  } catch (_) {}
}

/** Initial state slice — assign to `state.llm`. */
export function makeLlmState() {
  const stored = readStored()
  return {
    expanded: false,
    /** Provider name ('Claude', 'ChatGPT', …). '' = whatever the server picks. */
    provider: stored.provider || '',
    /** Model FAMILY ('sonnet', 'opus', …), not a full model id. '' = provider default. */
    model: stored.model || '',
    /** providers[name] = [{ id, family, version, latest, pricing }] — null until loaded. */
    providers: null,
    pricingMeta: {},
    defaultProvider: '',
    defaultFamily: '',
    loading: false,
    error: null
  }
}

/**
 * Populate provider/model/pricing data from the server. Safe to call on every
 * render — it no-ops while a fetch is in flight and once `llm.providers` is
 * set. Set `llm.providers = null` to force a re-fetch.
 * @returns {Promise<boolean>} true when the state changed (caller should re-render)
 */
export async function loadLlmProviders(llm, { provider = null } = {}) {
  if (!llm) return false
  if (llm.loading || llm.providers) return false
  llm.loading = true
  llm.error = null
  try {
    const target = provider || llm.provider || undefined
    let result = await freezr.llm.ping(target ? { provider: target } : {})
    // Pricing that was only ever self-reported by the model is flagged for
    // refresh; one extra round-trip is worth it because those numbers are
    // routinely wrong (see the cost notes in adapters/llmConnectors).
    const meta = result?.pricingMeta?.[target || result?.defaultProvider]
    if (meta?.refreshNeeded) {
      try {
        result = await freezr.llm.ping({ ...(target ? { provider: target } : {}), refresh: true })
      } catch (_) { /* keep the unrefreshed answer */ }
    }
    llm.providers = result?.providers || {}
    llm.pricingMeta = result?.pricingMeta || {}
    llm.defaultProvider = result?.defaultProvider || ''
    llm.defaultFamily = result?.defaultFamily || ''
    // A stored provider that the user no longer has a key for would silently
    // fail every request — fall back to the server's choice instead.
    if (llm.provider && !llm.providers[llm.provider]) {
      llm.provider = ''
      llm.model = ''
      persist(llm)
    }
  } catch (e) {
    console.warn('Orbit: could not load LLM providers', e)
    llm.providers = {}
    llm.error = e.message || String(e)
  } finally {
    llm.loading = false
  }
  return true
}

const effectiveProvider = (llm) => llm.provider || llm.defaultProvider || ''

const familiesFor = (llm, providerName) => {
  const models = (llm.providers || {})[providerName] || []
  return [...new Set(models.map((m) => m.family).filter(Boolean))]
}

/** Latest model of a family — the one whose price the server will actually bill. */
const modelForFamily = (llm, providerName, family) => {
  const models = ((llm.providers || {})[providerName] || []).filter((m) => m.family === family)
  if (!models.length) return null
  return models.find((m) => m.latest) || models[models.length - 1]
}

const formatPricing = (pricing) => {
  if (!pricing) return ''
  return `$${pricing.input} in / $${pricing.output} out per M tokens`
}

/**
 * The options to merge into a `freezr.llm.ask()` call. Every field is omitted
 * when unset so the server keeps its own defaults.
 */
export function llmAskOptions(llm) {
  if (!llm) return {}
  const out = {}
  if (llm.provider) out.provider = llm.provider
  if (llm.model) out.model = llm.model
  return out
}

/** One-line summary for a collapsed header, e.g. "Claude / sonnet". */
export function llmSummary(llm) {
  const provider = effectiveProvider(llm) || 'not configured'
  const model = llm.model || llm.defaultFamily || 'default'
  return `${provider} / ${model}`
}

function esc(s) {
  const d = document.createElement('div')
  d.textContent = s == null ? '' : String(s)
  return d.innerHTML
}

/**
 * @param {object} llm - state.llm
 * @param {boolean} canLlm - whether the app holds the use_llm permission
 * @returns {string} HTML for the settings block
 */
export function renderLlmSettings(llm, canLlm) {
  if (!llm) return ''

  const header = (bodyHtml) => `
    <div class="orbit-settings-section">
      <button type="button" class="orbit-settings-header" id="orbit-llm-toggle" aria-expanded="${llm.expanded ? 'true' : 'false'}">
        <span class="orbit-settings-caret">${llm.expanded ? '&#9660;' : '&#9654;'}</span>
        <span class="orbit-settings-title">Model</span>
        <span class="orbit-settings-summary">${esc(llmSummary(llm))}</span>
      </button>
      ${llm.expanded ? bodyHtml : ''}
    </div>`

  if (!canLlm) {
    return header(`<div class="orbit-settings-body">
      <p class="orbit-muted">The <code>use_llm</code> permission is not granted, so Orbit cannot call a model.</p>
      <a class="orbit-btn orbit-btn-secondary orbit-btn-sm"
         href="/account/app/settings/${typeof freezrMeta !== 'undefined' ? freezrMeta.appName : 'com.salmanff.orbit'}"
         target="_blank" rel="noopener">Open App Settings &#8599;</a>
    </div>`)
  }

  if (llm.loading || !llm.providers) {
    return header('<div class="orbit-settings-body"><p class="orbit-muted">Loading models&hellip;</p></div>')
  }

  const providerNames = Object.keys(llm.providers)
  if (!providerNames.length) {
    return header(`<div class="orbit-settings-body">
      <p class="orbit-muted">${llm.error ? esc(llm.error) : 'No LLM keys found. Add one under Account &rarr; Resources.'}</p>
      <button type="button" class="orbit-btn orbit-btn-secondary orbit-btn-sm" id="orbit-llm-refresh">Retry</button>
    </div>`)
  }

  const provider = effectiveProvider(llm)
  const families = familiesFor(llm, provider)
  const selected = modelForFamily(llm, provider, llm.model)
  const priceLine = selected?.pricing
    ? `${esc(selected.id)} &middot; ${esc(formatPricing(selected.pricing))}`
    : 'Price shown once a model is chosen.'

  const providerOptions = [
    `<option value="" ${llm.provider ? '' : 'selected'}>Default (${esc(llm.defaultProvider || providerNames[0])})</option>`,
    ...providerNames.map((p) => `<option value="${esc(p)}" ${p === llm.provider ? 'selected' : ''}>${esc(p)}</option>`)
  ].join('')

  const modelOptions = [
    `<option value="" ${llm.model ? '' : 'selected'}>Default (${esc(llm.defaultFamily || 'provider choice')})</option>`,
    ...families.map((f) => `<option value="${esc(f)}" ${f === llm.model ? 'selected' : ''}>${esc(f)}</option>`)
  ].join('')

  return header(`
    <div class="orbit-settings-body">
      <div class="orbit-settings-row">
        <label for="orbit-llm-provider">Provider</label>
        <select id="orbit-llm-provider" class="orbit-select">${providerOptions}</select>
      </div>
      <div class="orbit-settings-row">
        <label for="orbit-llm-model">Model</label>
        <select id="orbit-llm-model" class="orbit-select">${modelOptions}</select>
      </div>
      <p class="orbit-settings-note">${priceLine}</p>
      <button type="button" class="orbit-btn orbit-btn-secondary orbit-btn-sm" id="orbit-llm-refresh">Refresh models &amp; prices</button>
    </div>`)
}

/**
 * @param {HTMLElement} container - element the block was rendered into
 * @param {object} llm - state.llm
 * @param {() => Promise<void>} rerender - re-render the panel holding the block
 */
export function bindLlmSettings(container, llm, rerender) {
  if (!container || !llm) return

  container.querySelector('#orbit-llm-toggle')?.addEventListener('click', async () => {
    llm.expanded = !llm.expanded
    // Providers are fetched lazily: an unopened settings block costs nothing.
    if (llm.expanded && !llm.providers) {
      await rerender()
      await loadLlmProviders(llm)
    }
    await rerender()
  })

  container.querySelector('#orbit-llm-provider')?.addEventListener('change', async (e) => {
    llm.provider = e.target.value
    // Families are provider-specific, so a kept model would name a family the
    // new provider has never heard of.
    llm.model = ''
    // Clearing the cache (rather than passing force) means the intermediate
    // render shows "Loading models…" instead of the old provider's families
    // sitting under the new provider's name.
    llm.providers = null
    persist(llm)
    await rerender()
    await loadLlmProviders(llm, { provider: llm.provider })
    await rerender()
  })

  container.querySelector('#orbit-llm-model')?.addEventListener('change', async (e) => {
    llm.model = e.target.value
    persist(llm)
    await rerender()
  })

  container.querySelector('#orbit-llm-refresh')?.addEventListener('click', async () => {
    llm.providers = null
    await rerender()
    await loadLlmProviders(llm)
    await rerender()
  })
}
