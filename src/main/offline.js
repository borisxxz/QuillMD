// Strict offline mode.
//
// The persisted flag lives in userData/offline-mode.json because the main
// process must know it BEFORE the renderer mounts (the startup update check and
// automatic cloud sync are renderer-initiated IPC calls). localStorage is only
// a UI mirror.
//
// Enforcement has two layers:
//   1. installOfflineNetworkGuard(session) cancels every http/https/ws/wss
//      request in the Chromium session — renderer images/media/iframes, hidden
//      export windows, and Electron net requests that use the session.
//   2. Network-capable main-process call sites also check isOffline(), so a
//      future path that bypasses the session still fails closed with a clean
//      user-facing error instead of silently connecting.
import fs from 'node:fs'
import { dirname, join } from 'node:path'

const FILE = 'offline-mode.json'
const BLOCKED_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:'])

let statePath = null
let offline = false
const offlineListeners = new Set()

export function onOfflineEnabled(listener) {
  offlineListeners.add(listener)
  return () => offlineListeners.delete(listener)
}

export function initOfflineMode(app) {
  statePath = join(app.getPath('userData'), FILE)
  offline = false
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    offline = parsed?.offlineMode === true
  } catch {
    offline = false
  }
  return offline
}

export function isOffline() {
  return offline
}

export function setOfflineMode(value) {
  const wasOffline = offline
  offline = value === true
  if (statePath) {
    try {
      fs.mkdirSync(dirname(statePath), { recursive: true })
      fs.writeFileSync(statePath, `${JSON.stringify({ offlineMode: offline }, null, 2)}\n`, 'utf8')
    } catch {
      // Persistence failure must not make the UI and main process disagree:
      // the live value is still authoritative for this session.
    }
  }
  if (offline && !wasOffline) {
    for (const listener of [...offlineListeners]) {
      try { listener() } catch { /* one listener must not block the rest */ }
    }
  }
  return offline
}

export function offlineError(message = '离线模式已开启，此联网功能不可用。') {
  const error = new Error(message)
  error.code = 'OFFLINE'
  return error
}

export function offlineBlockedUrl(url) {
  try {
    const parsed = new URL(String(url || ''))
    if (!BLOCKED_SCHEMES.has(parsed.protocol)) return false
    // Dev serves the app itself from a local HTTP origin. That is app content,
    // not an outbound request; production uses file://.
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl && parsed.origin === new URL(devUrl).origin) return false
    return true
  } catch {
    return false
  }
}

export function installOfflineNetworkGuard(session) {
  session.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => {
      callback({ cancel: offline && offlineBlockedUrl(details.url) })
    }
  )
}

export function offlineFetch(fetchImpl) {
  return async (url, init = {}) => {
    if (isOffline()) throw offlineError()
    const controller = new AbortController()
    const stopForOffline = () => controller.abort()
    const stopForCaller = () => controller.abort()
    offlineListeners.add(stopForOffline)
    init.signal?.addEventListener('abort', stopForCaller, { once: true })
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal })
    } finally {
      offlineListeners.delete(stopForOffline)
      init.signal?.removeEventListener('abort', stopForCaller)
    }
  }
}
