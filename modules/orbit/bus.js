/**
 * Late-bound render hooks.
 *
 * Action modules (projects.js, chat.js, publishActions.js, ...) need to trigger a re-render, but
 * the real render()/renderLeftPanel() live in shell.js, which itself imports those action modules
 * to wire up event handlers. Importing shell.js from an action module would be a cycle. Instead,
 * shell.js registers its functions here once at startup via setUiHooks(), and everyone else calls
 * the stable render/renderLeftPanel/refreshPagesPanel exports, which simply forward to whatever is
 * currently registered.
 */

let hooks = {
  render: async () => { console.warn('Orbit: render() called before shell initialized') },
  renderLeftPanel: async () => { console.warn('Orbit: renderLeftPanel() called before shell initialized') },
  refreshPagesPanel: async () => { console.warn('Orbit: refreshPagesPanel() called before shell initialized') }
}

export function setUiHooks(newHooks) {
  hooks = { ...hooks, ...newHooks }
}

export const render = (...args) => hooks.render(...args)
export const renderLeftPanel = (...args) => hooks.renderLeftPanel(...args)
export const refreshPagesPanel = (...args) => hooks.refreshPagesPanel(...args)