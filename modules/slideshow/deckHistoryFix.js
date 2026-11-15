/**
 * Keeping a deck's navigation hash writes aligned with the real address bar URL.
 *
 * A deck commonly writes the current slide number into the URL so a refresh or a shared link
 * lands on the right slide, e.g. `history.replaceState(null, '', '#3')`. The browser resolves a
 * RELATIVE url argument to history.pushState/replaceState against the page's <base href> — which
 * Orbit deliberately sets to the project's canonical public path so other relative run-time
 * fetches (slides.json, images, ...) keep working even under a custom short public URL (see
 * modules/publish/publishBase.js). The side effect: a plain '#3' silently overwrites a custom
 * short public id (e.g. /why2026) with that long canonical path the moment it's written.
 *
 * The fix is NOT to stop writing the hash — it's to write it onto the URL that is ACTUALLY
 * showing. This patch rebases any url argument against `location.href` (the real, current
 * address bar URL, custom public id included) rather than against <base href>, so
 * `history.replaceState(null, '', '#3')` ends up as e.g. `https://host/why2026#3` instead of
 * the long default path.
 *
 * Deliberately NOT a surgical rewrite of the deck's own history.*State(...) call site: a deck may
 * be hand-written, and guessing at its exact code shape (and rewriting live site logic blind)
 * risks breaking it. A one-time global monkey-patch at the top of the file fixes every call
 * site — present or added later — without needing to find or understand any of them.
 *
 * An earlier version of this patch disarmed history.pushState/replaceState entirely (made them
 * no-ops) rather than rebase them. That throws away slide-number tracking once the URL it writes
 * to is correct, so `patchHistoryNav` below also detects and upgrades a project still carrying
 * that old patch.
 */

export const HISTORY_PATCH_MARKER = '__orbitHistoryPatch'
// Only used to detect and strip the earlier version of this patch that disarmed navigation
// entirely, so a project patched by that version can be upgraded to the rebasing patch below.
const LEGACY_NO_HASH_NAV_MARKER = '__orbitNoHashNavPatch'
const LEGACY_PATCH_START = '/* orbit:no-hash-nav-patch'
const LEGACY_PATCH_END = '})();'

// The trailing semicolon is required: this text is prepended directly before whatever code
// follows it (the rest of deck.js), and without it the two statements can be parsed as one
// expression (the classic no-semicolon ASI hazard with back-to-back IIFEs).
export const HISTORY_PATCH = `/* orbit:history-patch — do not remove; keeps slide URLs pointed at
   the real address bar URL (including a custom short public id) instead of the page's <base
   href>. See modules/slideshow/deckHistoryFix.js for the full explanation. */
(function () {
  ['pushState', 'replaceState'].forEach(function (name) {
    var native = history[name]
    if (native.${HISTORY_PATCH_MARKER}) return
    var patched = function (state, title, url) {
      var abs = (url === undefined || url === null) ? url : new URL(url, location.href).href
      return native.call(history, state, title, abs)
    }
    patched.${HISTORY_PATCH_MARKER} = true
    history[name] = patched
  })
})();
`

/**
 * Strip a previously-installed no-op patch block, if present. Matching is loose (start/end
 * markers only) so minor formatting drift between Orbit versions doesn't block the upgrade.
 */
function stripLegacyNoHashPatch(text) {
  if (!text.includes(LEGACY_NO_HASH_NAV_MARKER)) return { text, changed: false }
  const start = text.indexOf(LEGACY_PATCH_START)
  if (start < 0) return { text, changed: false }
  const end = text.indexOf(LEGACY_PATCH_END, start)
  if (end < 0) return { text, changed: false }
  const after = end + LEGACY_PATCH_END.length
  const rest = text.slice(after).replace(/^\n/, '')
  return { text: text.slice(0, start) + rest, changed: true }
}

/**
 * Prepend the rebasing history patch to a script's source. Upgrades a project still carrying the
 * old no-op patch in place; otherwise prepends fresh unless the file already has this patch or
 * never touches history navigation at all.
 * @param {string} text
 * @returns {{text: string, changed: boolean}}
 */
export function patchHistoryNav(text) {
  const src = String(text || '')
  const { text: stripped, changed: hadLegacy } = stripLegacyNoHashPatch(src)
  if (stripped.includes(HISTORY_PATCH_MARKER)) {
    return { text: stripped, changed: hadLegacy }
  }
  const touchesHistory = /history\s*\.\s*(pushState|replaceState)\s*\(/.test(stripped)
  if (!hadLegacy && !touchesHistory) return { text: stripped, changed: false }
  return { text: HISTORY_PATCH + '\n' + stripped, changed: true }
}