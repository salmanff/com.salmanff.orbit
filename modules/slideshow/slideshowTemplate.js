/**
 * Starter files for a new slide-show project: the deck shell (index.html,
 * deck.css, deck.js), two slides and the derived slides.json.
 *
 * deck.js is plain browser JavaScript written into the USER's project; it runs
 * on the published site, where the freezr SDK is not loaded.
 */
import { slidesManifestJson } from './slideshowModel.js'

const DECK_HTML = `<div class="deck" id="deck">
  <div class="deck-stage" id="deck-stage">
    <p class="deck-loading">Loading slides…</p>
  </div>
  <nav class="deck-controls" aria-label="Slide controls">
    <button type="button" id="deck-prev" aria-label="Previous slide">&#8249;</button>
    <span id="deck-counter" class="deck-counter"></span>
    <button type="button" id="deck-next" aria-label="Next slide">&#8250;</button>
    <button type="button" id="deck-full" aria-label="Full screen">&#x26F6;</button>
  </nav>
</div>
`

const DECK_CSS = `/* deck.css — the template every slide sits in.

   The stage FILLS THE SCREEN by default, so the presentation looks right on a
   phone, a laptop and a projector without black bars. Nothing here fixes the
   slide to a particular shape.

   What keeps a slide proportional instead is the DESIGN BOX below: every slide
   is written to fit --deck-design-width x --deck-design-height em, and deck.js
   picks the stage font-size so that box always fits the screen, whatever its
   shape. Because slide content is sized in em, scaling that one number scales
   the whole slide.

   Things you may want to change, all from this file:

     * Classic letterboxed slides (fixed aspect ratio) — add the class
       "is-framed" to the <div class="deck"> in index.html, and set
       --deck-aspect to the ratio you want (16 / 9, 4 / 3, 1 / 1, 9 / 16 ...).
       deck.js measures the stage, so it follows along with no JS change.
     * A taller or wider design box, longer or shorter lines, a bigger minimum
       text size — the custom properties in :root.
     * Colours — --deck-bg (around the stage) and --deck-slide-bg / -fg.
*/

:root {
  /* The safe area every slide is designed to fit, in em. */
  --deck-design-width: 50;
  --deck-design-height: 28;
  /* Text never shrinks below this, so a small window stays readable. */
  --deck-min-font: 10px;
  /* Longest a block of text gets before it is centred on a very wide screen. */
  --deck-content-width: 46em;
  /* Only used when the deck is framed — see .deck.is-framed below. */
  --deck-aspect: 16 / 9;

  --deck-bg: #0f1115;
  --deck-slide-bg: #ffffff;
  --deck-slide-fg: #1b1f24;
}

html, body {
  margin: 0;
  height: 100%;
  background: var(--deck-bg);
}

.deck {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}

.deck:fullscreen {
  background: #000;
}

/* Default: edge to edge, any screen shape. */
.deck-stage {
  position: relative;
  width: 100%;
  height: 100%;
  background: var(--deck-slide-bg);
  color: var(--deck-slide-fg);
  overflow: hidden;
}

/* Opt-in: classic slides at a fixed ratio, letterboxed on screens of another
   shape. Add class "is-framed" to the deck element in index.html. */
.deck.is-framed .deck-stage {
  width: min(100vw, calc(100vh * var(--deck-aspect)));
  height: auto;
  aspect-ratio: var(--deck-aspect);
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.45);
}

.slide {
  position: absolute;
  inset: 0;
  box-sizing: border-box;
  padding: 2.5em 3em;
  display: none;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 0.6em;
}

.slide.is-active {
  display: flex;
}

/* A line of text stays readable on a very wide screen: blocks are centred in a
   column no wider than --deck-content-width. Give a block the class
   "deck-bleed" to opt out (an edge-to-edge image or banner, say). */
.slide > *:not(img):not(video) {
  width: 100%;
  max-width: var(--deck-content-width);
}
.slide > img,
.slide > video {
  max-width: min(100%, var(--deck-content-width));
}
.slide > .deck-bleed {
  width: 100%;
  max-width: none;
}

.slide h1 { font-size: 3em; line-height: 1.1; margin: 0; }
.slide h2 { font-size: 2em; line-height: 1.15; margin: 0 0 0.3em; }
.slide p  { font-size: 1.2em; line-height: 1.45; margin: 0; }
.slide ul, .slide ol { font-size: 1.2em; line-height: 1.5; margin: 0; padding-left: 1.3em; }
.slide li + li { margin-top: 0.35em; }
.slide img { max-width: 100%; max-height: 70%; object-fit: contain; }

/* Title slide */
.title-slide {
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 0.5em;
}
.title-slide .subtitle {
  font-size: 1.4em;
  color: #5b6570;
}

.deck-controls {
  position: fixed;
  left: 50%;
  bottom: 12px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.25rem 0.6rem;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  font-size: 13px;
  opacity: 0.35;
  transition: opacity 0.2s;
}
.deck-controls:hover,
.deck-controls:focus-within {
  opacity: 1;
}
.deck-controls button {
  background: none;
  border: none;
  color: inherit;
  font-size: 18px;
  cursor: pointer;
  padding: 0.1rem 0.4rem;
}
.deck-counter {
  min-width: 3.5em;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.deck-loading,
.deck-error {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: 2em;
  text-align: center;
  font-size: 1.1em;
  color: #5b6570;
}
.deck-error {
  color: #b42318;
}
.slide .deck-error {
  position: static;
}
`

const DECK_JS = `/* deck.js — the slide-show runtime Orbit created for this presentation.
 *
 * It reads slides.json, fetches each slide's HTML fragment and shows one slide
 * at a time on a stage that fills the screen. Keys: arrows / space / PageUp /
 * PageDown / Home /
 * End, and F for full screen. Clicking the right two thirds of a slide goes
 * forward, the left third goes back; swiping works on touch screens.
 *
 * Contract Orbit relies on (keep it if you change this file):
 *  - slides.json: {"slides":[{"id","file","title"}]} in presentation order
 *  - each slide is wrapped in <section class="slide" data-slide-id="ID">
 *  - start slide: <meta name="orbit-start-slide" content="N"> (1-based), else #N
 */
(function () {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()

  function escapeHtml (s) {
    var d = document.createElement('div')
    d.textContent = s == null ? '' : String(s)
    return d.innerHTML
  }

  function start () {
    var deck = document.getElementById('deck')
    var stage = document.getElementById('deck-stage')
    if (!deck || !stage) return
    var counter = document.getElementById('deck-counter')
    var slides = []
    var current = 0

    function message (text, isError) {
      stage.innerHTML = ''
      var p = document.createElement('p')
      p.className = isError ? 'deck-error' : 'deck-loading'
      p.textContent = text
      stage.appendChild(p)
    }

    // The stage fills the screen, so its shape varies from a tall phone to a
    // wide projector. Every slide is designed to fit a box of
    // --deck-design-width x --deck-design-height em (set in deck.css); taking
    // the font-size from whichever of the two runs out first keeps that box on
    // screen whatever the shape, and because slide content is sized in em the
    // whole slide scales with it. On a 16:9 screen this works out to
    // width / 50, which is what a framed deck used to get.
    function fit () {
      var cs = getComputedStyle(stage)
      var num = function (name, fallback) {
        var v = parseFloat(cs.getPropertyValue(name))
        return (isFinite(v) && v > 0) ? v : fallback
      }
      var byWidth = stage.clientWidth / num('--deck-design-width', 50)
      var byHeight = stage.clientHeight / num('--deck-design-height', 28)
      var size = Math.min(byWidth, byHeight)
      stage.style.fontSize = Math.max(num('--deck-min-font', 10), size) + 'px'
    }

    function startIndex () {
      var meta = document.querySelector('meta[name="orbit-start-slide"]')
      var raw = meta ? meta.getAttribute('content') : String(location.hash || '').replace('#', '')
      var n = parseInt(raw, 10)
      if (!n || n < 1) return 0
      return Math.min(n, slides.length) - 1
    }

    function show (i) {
      if (!slides.length) return
      current = Math.max(0, Math.min(slides.length - 1, i))
      for (var k = 0; k < slides.length; k++) {
        slides[k].classList.toggle('is-active', k === current)
        slides[k].setAttribute('aria-hidden', k === current ? 'false' : 'true')
      }
      if (counter) counter.textContent = (current + 1) + ' / ' + slides.length
      try { history.replaceState(null, '', '#' + (current + 1)) } catch (e) {}
    }

    function toggleFullscreen () {
      if (document.fullscreenElement) {
        if (document.exitFullscreen) document.exitFullscreen()
      } else if (deck.requestFullscreen) {
        deck.requestFullscreen().catch(function () {})
      }
    }

    function loadSlide (s) {
      return fetch(s.file)
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status)
          return res.text()
        })
        .catch(function (err) {
          return '<p class="deck-error">Could not load ' + escapeHtml(s.file) + ' (' + escapeHtml(err.message) + ')</p>'
        })
    }

    fetch('slides.json')
      .then(function (res) {
        if (!res.ok) throw new Error('slides.json could not be loaded (HTTP ' + res.status + ')')
        return res.json()
      })
      .then(function (data) {
        var list = (data && Array.isArray(data.slides)) ? data.slides : []
        return Promise.all(list.map(loadSlide)).then(function (htmls) {
          return { list: list, htmls: htmls }
        })
      })
      .then(function (loaded) {
        if (!loaded.list.length) {
          message('This presentation has no slides yet.')
          return
        }
        stage.innerHTML = ''
        slides = loaded.list.map(function (s, i) {
          var section = document.createElement('section')
          section.className = 'slide'
          section.setAttribute('data-slide-id', s.id || ('s' + (i + 1)))
          section.setAttribute('aria-label', s.title || ('Slide ' + (i + 1)))
          section.innerHTML = loaded.htmls[i]
          stage.appendChild(section)
          return section
        })
        fit()
        show(startIndex())
      })
      .catch(function (err) {
        message('Could not load the presentation: ' + err.message, true)
      })

    function on (id, fn) {
      var el = document.getElementById(id)
      if (el) el.addEventListener('click', function (e) { e.stopPropagation(); fn() })
    }
    on('deck-prev', function () { show(current - 1) })
    on('deck-next', function () { show(current + 1) })
    on('deck-full', toggleFullscreen)

    document.addEventListener('keydown', function (e) {
      var tag = e.target && e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      var k = e.key
      if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'PageDown' || k === ' ') {
        e.preventDefault(); show(current + 1)
      } else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp') {
        e.preventDefault(); show(current - 1)
      } else if (k === 'Home') {
        e.preventDefault(); show(0)
      } else if (k === 'End') {
        e.preventDefault(); show(slides.length - 1)
      } else if (k === 'f' || k === 'F') {
        toggleFullscreen()
      }
    })

    stage.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('a, button, input, textarea, select, video, audio, summary')) return
      var r = stage.getBoundingClientRect()
      show(e.clientX - r.left < r.width / 3 ? current - 1 : current + 1)
    })

    var touchX = null
    stage.addEventListener('touchstart', function (e) { touchX = e.touches[0].clientX }, { passive: true })
    stage.addEventListener('touchend', function (e) {
      if (touchX === null) return
      var dx = e.changedTouches[0].clientX - touchX
      touchX = null
      if (Math.abs(dx) > 40) show(dx < 0 ? current + 1 : current - 1)
    })

    window.addEventListener('resize', fit)
    window.addEventListener('hashchange', function () {
      var n = parseInt(String(location.hash || '').replace('#', ''), 10)
      if (n && n - 1 !== current) show(n - 1)
    })
  }
})()
`

const STARTER_SLIDES = [
  {
    id: 's1',
    file: 'slides/slide-1.html',
    title: 'Title',
    content: `<div class="title-slide">
  <h1>Your presentation title</h1>
  <p class="subtitle">A subtitle, or your name and the date</p>
</div>
`
  },
  {
    id: 's2',
    file: 'slides/slide-2.html',
    title: 'Slide heading',
    content: `<h2>Slide heading</h2>
<ul>
  <li>Your first point</li>
  <li>Your second point</li>
  <li>Ask Orbit's chat to rewrite this slide</li>
</ul>
`
  }
]

export const NEW_SLIDE_HTML = `<h2>New slide</h2>
<ul>
  <li>Your first point</li>
  <li>Your second point</li>
</ul>
`

/**
 * The deck runtime's HTML/CSS/JS as plain text, for callers that need to write it to a
 * caller-chosen file name — e.g. converting an existing multi-page project, where the
 * default 'index.html' may already be taken by a page that is becoming a slide.
 */
export function deckTemplateContent() {
  return { html: DECK_HTML, css: DECK_CSS, js: DECK_JS }
}

/** Record for the projects table. */
export function slideshowStarterRecord(slug) {
  return {
    name: slug,
    display_name: slug,
    description: '',
    type: 'slideshow',
    published: false,
    public_url: null,
    entry_page: 'index',
    pages: [
      {
        name: 'index',
        html_file: 'index.html',
        css_files: ['deck.css'],
        js_files: ['deck.js'],
        published: false,
        public_url: null
      }
    ],
    slides: STARTER_SLIDES.map((s) => ({ id: s.id, file: s.file, title: s.title }))
  }
}

/** Every starter file, draft-relative: [{ path, content, mime }]. */
export function slideshowStarterFiles() {
  const record = slideshowStarterRecord('starter')
  return [
    { path: 'index.html', content: DECK_HTML, mime: 'text/html' },
    { path: 'deck.css', content: DECK_CSS, mime: 'text/css' },
    { path: 'deck.js', content: DECK_JS, mime: 'text/javascript' },
    ...STARTER_SLIDES.map((s) => ({ path: s.file, content: s.content, mime: 'text/html' })),
    { path: 'slides.json', content: slidesManifestJson(record), mime: 'application/json' }
  ]
}