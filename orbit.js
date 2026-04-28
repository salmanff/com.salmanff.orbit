/* Orbit — bootstrap (classic script; dynamic import for modules) */
;(async () => {
  try {
    const mod = await import('./modules/orbitMain.js')
    await mod.initOrbit()
    if (typeof mod.orbitAfterChatResponse === 'function') {
      window.orbitAfterChatResponse = mod.orbitAfterChatResponse
    }
  } catch (err) {
    console.error('Orbit failed to load', err)
    const root = document.getElementById('orbit-root')
    if (root) {
      root.innerHTML = '<p class="orbit-error">Orbit failed to load. Check the console.</p>'
    }
  }
})()