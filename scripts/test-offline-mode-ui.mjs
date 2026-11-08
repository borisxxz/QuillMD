import { mkdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'

const PROFILE_DIR = await (async () => {
  const { mkdtemp } = await import('node:fs/promises')
  return mkdtemp(join(tmpdir(), 'quillmd-offline-'))
})()
const PORT = 9487
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let hits = 0
const server = createServer((req, res) => {
  hits += 1
  if (req.url?.startsWith('/feed')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ tag_name: 'v0.0.1', name: 'QuillMD 0.0.1', body: '', assets: [] }))
    return
  }
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG_1PX.length })
  res.end(PNG_1PX)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const baseUrl = `http://127.0.0.1:${address.port}`
const env = { ...process.env, HORSEMD_TEST_UPDATE_FEED: `${baseUrl}/feed` }

await mkdir(PROFILE_DIR, { recursive: true })
let app = await launchBuiltElectron({ profileDir: PROFILE_DIR, port: PORT, cleanProfile: false, env })
try {
  // Let the normal startup update check run while offline mode is off.
  await sleep(1800)
  const baseline = hits
  if (baseline < 1) throw new Error(`expected the online startup update check to hit the test feed, got ${baseline}`)

  const toggled = await app.evaluate(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const visible = (el) => {
      if (!el) return false
      const r = el.getBoundingClientRect()
      const s = getComputedStyle(el)
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
    }
    const text = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim()
    const buttons = () => [...document.querySelectorAll('button')].filter(visible)
    const settingsButton = buttons().find((b) => b.title === '设置' || b.title === 'Settings' || text(b) === '设置' || text(b) === 'Settings')
    if (!settingsButton) throw new Error('settings button not found')
    settingsButton.click()
    await sleep(500)
    const general = buttons().find((b) => text(b) === '通用' || text(b) === 'General')
    if (!general) throw new Error('general settings nav not found')
    general.click()
    await sleep(250)
    const toggle = [...document.querySelectorAll('button[role="switch"]')]
      .find((b) => visible(b) && /离线模式|Offline mode/i.test(b.getAttribute('aria-label') || ''))
    if (!toggle) throw new Error('offline toggle not found')
    if (toggle.getAttribute('aria-checked') !== 'false') throw new Error('offline toggle did not default off')
    toggle.click()
    await sleep(600)
    const stored = JSON.parse(localStorage.getItem('horsemd.settings.v1') || '{}')
    return {
      ariaChecked: toggle.getAttribute('aria-checked'),
      stored: stored.offlineMode === true,
      mainValue: await window.api.getOfflineMode(),
      update: await window.api.checkUpdate(),
      external: await window.api.openExternal('https://example.com/offline-blocked'),
      upload: await window.api.uploadImage('picgo', 'test.png', new Uint8Array([1]))
    }
  })()`)
  if (toggled.ariaChecked !== 'true' || !toggled.stored || toggled.mainValue !== true) {
    throw new Error('offline toggle did not persist in UI/main: ' + JSON.stringify(toggled))
  }
  if (toggled.update?.ok !== false || toggled.update?.offline !== true) {
    throw new Error('offline update check did not fail closed: ' + JSON.stringify(toggled.update))
  }
  if (toggled.external?.ok !== false || toggled.external?.offline !== true) {
    throw new Error('offline external link was not blocked: ' + JSON.stringify(toggled.external))
  }
  if (toggled.upload?.ok !== false || toggled.upload?.offline !== true) {
    throw new Error('offline image upload was not blocked: ' + JSON.stringify(toggled.upload))
  }
  let syncError = ''
  try { await app.evaluate(`window.api.syncTestConnection('offline-test')`) } catch (e) { syncError = String(e?.message || e) }
  if (!/离线模式/.test(syncError)) throw new Error('offline sync did not fail with offline error: ' + syncError)

  // Renderer resource loads are canceled by the session guard. A CSP fetch test
  // would fail for the wrong reason; an <img> is allowed by our CSP.
  const imageBlocked = await app.evaluate(`(async () => {
    const before = performance.now()
    const result = await new Promise((resolve) => {
      const img = new Image()
      const done = (value) => { img.src = ''; resolve(value) }
      img.onload = () => done('loaded')
      img.onerror = () => done('error')
      setTimeout(() => done('timeout'), 2500)
      img.src = '${baseUrl}/blocked.png?' + Date.now()
    })
    return { result, elapsed: performance.now() - before }
  })()`)
  if (hits !== baseline) {
    throw new Error(`offline mode made ${hits - baseline} network request(s)` + JSON.stringify(imageBlocked))
  }
} finally {
  await stopBuiltElectron(app, { removeProfile: false })
}

// Restart: main must read offline-mode.json before the renderer's startup
// update check, so the test feed receives no request.
app = await launchBuiltElectron({ profileDir: PROFILE_DIR, port: PORT, cleanProfile: false, env })
try {
  await sleep(1800)
  const afterRestart = hits
  const persisted = await app.evaluate(`(async () => ({
    main: await window.api.getOfflineMode(),
    check: await window.api.checkUpdate()
  }))()`)
  if (persisted.main !== true || persisted.check?.offline !== true) {
    throw new Error('offline mode did not survive restart: ' + JSON.stringify(persisted))
  }
  if (hits !== afterRestart) throw new Error('startup update check hit the feed while offline')

  // Turning it back off must restore network immediately.
  await app.evaluate(`window.api.setOfflineMode(false)`)
  await sleep(500)
  const beforeImage = hits
  const imageLoaded = await app.evaluate(`(async () => new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve('loaded')
    img.onerror = () => resolve('error')
    setTimeout(() => resolve('timeout'), 3000)
    img.src = '${baseUrl}/online.png?' + Date.now()
  }))()`)
  if (imageLoaded !== 'loaded' || hits <= beforeImage) {
    throw new Error('network did not resume after offline off: ' + imageLoaded + ', hits=' + (hits - beforeImage))
  }
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  server.close()
}

// Leave no test profile behind if verification reached this point.
await rm(PROFILE_DIR, { recursive: true, force: true })
console.log('offline mode ok: UI persisted, startup update blocked, sync/image/upload/external blocked, network resumed')
