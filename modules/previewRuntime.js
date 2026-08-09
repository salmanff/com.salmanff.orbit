/* Orbit preview runtime — injected into the draft preview document.
 *
 * NOT an ES module and not inline, deliberately, on both counts.
 *
 * The preview is a blob: document, and a blob: document INHERITS the Content
 * Security Policy of the page that created it — here Orbit's own page, which is
 * served with `script-src 'self' 'nonce-…'`. So an inline <script> in the
 * preview is silently blocked (no error, it just never runs), while a <script
 * src> pointing at this app's own origin is allowed by 'self'. This file has to
 * be fetched, not inlined.
 *
 * It is a classic script so that it BLOCKS: it must finish patching before the
 * page's own scripts run, and so that document.currentScript is available to
 * read its configuration (a module has neither property).
 *
 * What it fixes — in both cases the page's own code is correct and it is the
 * preview environment that differs from the published site:
 *
 * 1. fetch/XHR of the project's own files. The preview's <base> points at the
 *    app's PRIVATE userfiles route, which answers 401 to any request without a
 *    ?fileToken=. The page cannot mint one itself (the freezr SDK is not loaded
 *    here), so plain relative paths are tokenized on its behalf.
 *
 * 2. history.pushState/replaceState. The <base> makes a bare '#frag' resolve
 *    against the draft folder rather than this document, and a blob: document
 *    may refuse a URL rewrite outright — either way a SecurityError would
 *    escape into the caller.
 *
 * Not covered: url(...) inside a stylesheet, which the browser resolves against
 * the stylesheet's own URL with no hook available to us.
 */

(function () {
  var config = document.currentScript ? document.currentScript.dataset : {}
  var BASE = config.base || ''
  var TOKEN = config.token || ''
  var MEDIA = { IMG: 1, VIDEO: 1, AUDIO: 1, SOURCE: 1 }
  var notified = false

  // Ask Orbit to rebuild the preview with a freshly minted token. Sent once per
  // preview document; the parent rate-limits too, so a genuinely missing file
  // cannot drive a rebuild loop.
  function notifyParent () {
    if (notified) return
    notified = true
    try { parent.postMessage({ orbit: 'imgTokenRetry' }, '*') } catch (e) {}
  }

  function tokenize (url) {
    if (!TOKEN || typeof url !== 'string' || !url) return url
    var abs
    try { abs = new URL(url, document.baseURI).href } catch (e) { return url }
    if (abs.indexOf(BASE) !== 0) return url
    if (abs.indexOf('fileToken=') >= 0) return url
    return abs + (abs.indexOf('?') >= 0 ? '&' : '?') + 'fileToken=' + TOKEN
  }

  var nativeFetch = window.fetch
  if (nativeFetch) {
    window.fetch = function (input, init) {
      try {
        if (typeof input === 'string') input = tokenize(input)
        else if (input && input.url) input = new Request(tokenize(input.url), input)
      } catch (e) {}
      return nativeFetch.call(window, input, init).then(function (res) {
        if (res && res.status === 401) notifyParent()
        return res
      })
    }
  }

  var nativeOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function () {
    var args = [].slice.call(arguments)
    try { args[1] = tokenize(args[1]) } catch (e) {}
    return nativeOpen.apply(this, args)
  }

  var histWarned = false
  function patchHistory (name) {
    if (typeof history === 'undefined' || !history) return
    var native = history[name]
    if (typeof native !== 'function') return
    history[name] = function (state, title, url) {
      try {
        var next = (url === undefined || url === null) ? url : new URL(url, location.href).href
        return native.call(history, state, title, next)
      } catch (e) {
        if (!histWarned) {
          histWarned = true
          console.warn('Orbit preview: history.' + name + ' is not available in the preview document — ' +
            'the URL will not update here, but it will on the published page.')
        }
      }
    }
  }
  patchHistory('pushState')
  patchHistory('replaceState')

  // Media inserted after load. An <img> inside a fetched HTML fragment starts
  // loading the moment innerHTML parses it — while still detached, before any
  // observer can see it — so that first load 401s. Re-pointing the src at a
  // tokenized URL here makes the browser load it again, this time successfully.
  function tokenizeEl (el) {
    if (!el || el.nodeType !== 1 || !MEDIA[el.tagName]) return
    var raw = el.getAttribute('src')
    if (!raw) return
    var next = tokenize(raw)
    if (next !== raw) el.setAttribute('src', next)
  }
  function scan (root) {
    if (!root || root.nodeType !== 1) return
    tokenizeEl(root)
    if (!root.querySelectorAll) return
    var found = root.querySelectorAll('img,video,audio,source')
    for (var i = 0; i < found.length; i++) tokenizeEl(found[i])
  }
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var added = records[i].addedNodes
        for (var j = 0; j < added.length; j++) scan(added[j])
      }
    }).observe(document.documentElement, { childList: true, subtree: true })
  }

  document.addEventListener('error', function (e) {
    if (e.target && MEDIA[e.target.tagName]) {
      // Most likely an untokenized src that raced the observer — fix it in place
      // before falling back to a full preview rebuild.
      var before = e.target.getAttribute('src')
      tokenizeEl(e.target)
      if (e.target.getAttribute('src') !== before) return
      notifyParent()
    }
  }, true)
})()
