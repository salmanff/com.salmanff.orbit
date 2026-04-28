# com.salmanff.orbit

Orbit is a freezr app for building multi-page sites. 

## How to use the app

Orbit lets you create, edit, and publish simple multi-page static sites right from your browser—no coding experience required. Use the visual editor to manage pages and content, or switch to code view for direct HTML/CSS/JS editing. 

- **Start by creating a “project”** — this is your site. You can add multiple HTML pages, stylesheets, and scripts.
- **Switch between pages** via the sidebar. Each page has its own main HTML file, and you can attach CSS/JS files as needed.
- **Edit your content** in the built-in code editor or use the chat assistant to help rewrite and generate code.
- **Preview your changes** instantly on the right side.
- **Publish your site** to make it public. Only selected files for each page will be copied to the published version so you can continue editing the draft if you like.



Grant LLM permissions so you can chat with Orbit let it build your pages. 

Published sites can be shared via the public page link after publishing. All your draft changes remain private until you click “Publish”.


## Permissions Required (manifest)

- **publish_site** (`upload_pages` on `com.salmanff.orbit.files`) — required to copy/share site files so you can publish your pages.
- **allow_iframe_preview** (`allow_self_frames`) — server relaxes CSP (`frame-src` / `child-src`) so the app can embed the draft preview iframe. Grant in app settings after install/update.
- **use_llm** — chat uses your freezr llm settings to create / edit pages and files.


## Technical description of file system
- **Draft** files under `projects/<projectId>/draft/` (edit in the app).
- **Published** files under `projects/<projectId>/public/`, produced on **Publish** (copy draft → public for the files in the publish set, then share).


## Technical description of how publish works (and how the live page is served)

1. **Publish set** — For the **active page**, Orbit uses the `projects` row: `html_file`, `css_files`, and `js_files` (paths relative to that project’s draft/public folder, e.g. `index.html`, `shared/common.css`). Only those files are copied to `public/` and shared with the **`publish_site`** permission.

2. **`share_records` with `isHtmlMainPage` + `fileStructure`** — The entry HTML is shared with `isHtmlMainPage: true` and a `fileStructure` object: `{ css: [{ publicid }], js: [{ publicid }], name }`. Dependency files are shared first so each asset has a stable public id. This matches what the platform expects for uploaded HTML main pages (see `features/apps/controllers/cepsfepsApiController.mjs` and `features/public/controllers/publicPageController.mjs`).

3. **Why there is no “mismatch” with CSS/JS on the public URL** — For HTML main pages, freezr does **not** rely on whatever `<link>` / `<script>` tags happen to appear inside your draft file to decide which assets to load on the **served** page. The public renderer builds the page from a skeleton and injects stylesheet and script URLs from the **`fileStructure`** (via `loadPageHtml` in `adapters/rendering/pageLoader.mjs`, with `css_files` / `script_files` derived from those `publicid` entries). So the canonical links for the published view are driven by the same `css_files` / `js_files` you declared and published—not by separately hand-maintaining HTML to match.

4. **Draft preview** — The in-app preview loads your draft HTML (often with a `<base href>` to the draft folder). What you see there an still include links in the file body; the **published** URL is what follows the `fileStructure` pipeline above.


## Code layout

- `orbit.js` — bootstrap (dynamic `import` of modules).
- `modules/orbitMain.js` — UI, projects, editor, preview, publish/unpublish, chat.
- `modules/publishService.js` — declarative publish set, sync draft→public, `fileStructure` + `isHtmlMainPage` share.
- `modules/orbitChat.js` / `modules/parseFreezrResponse.js` — LLM + file sections.
- `modules/editorLoader.js` — CodeMirror 6 (same pattern as `info.freezr.creator`).
- `vendor/codemirror-bundle.js` — copied from Creator.
