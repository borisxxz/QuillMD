// In-app update (#164): check → download (progress, SHA-256 checked against
// the release's SHA256SUMS.txt) → install on restart.
//
// Only assets of the release this process fetched itself are downloaded —
// the renderer never passes a URL. Requests go through Chromium's network
// stack (net.request, as sync does: Node's fetch can abort an unsigned app
// under launchd). Install happens in 'will-quit', so the normal quit path
// runs first: the renderer's unsaved-changes confirm can cancel it.
//   Windows: the NSIS installer, `--updated /S --force-run` (silent, same
//            folder, starts HorseMD again) — what electron-updater runs.
//   macOS:   a detached shell script waits for this process to exit, swaps
//            the .app from the release zip in, clears quarantine and opens
//            it. (Squirrel.Mac requires a signed app; QuillMD is unsigned.)
// See update-core.js for which asset / mode a platform gets.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createElectronRequest } from './sync/electron-request.js'
import {
  compareVersions,
  DEFAULT_MIRRORS,
  digestSha256,
  downloadSources,
  macBundlePath,
  macBundleReplaceable,
  normalizeSha512,
  parseChecksums,
  pickUpdateAsset,
  plistVersion,
  rankSources
} from './update-core.js'

const execFileAsync = promisify(execFile)
// The production feed is CNB: its release pages and asset downloads are
// reachable directly from China. GitHub is only the CI build source.
const CNB_REPO = 'boris007/QuillMD'
// Tests point the whole CNB site at a local server (refs + latest.yml +
// assets) so the production CNB code path runs end to end
// (scripts/test-update-cnb-feed.mjs).
const CNB_TEST_SITE = process.env.HORSEMD_TEST_UPDATE_CNB_SITE || ''
const CNB_SITE = CNB_TEST_SITE || `https://cnb.cool/${CNB_REPO}`
const CNB_RELEASES = `${CNB_SITE}/-/releases`
const CNB_DOWNLOAD_ROOT = `${CNB_RELEASES}/download`
const CNB_GIT_REFS = `${CNB_SITE}.git/info/refs?service=git-upload-pack`
// Tests point this at a local GitHub-shaped JSON server (scripts/test-update-ui.mjs).
const TEST_FEED = process.env.HORSEMD_TEST_UPDATE_FEED || ''
const FEED = TEST_FEED || CNB_GIT_REFS
// Release assets are downloaded over HTTPS only (a test feed may serve them
// from 127.0.0.1).
const LOCAL_TEST_ALLOWED = Boolean(TEST_FEED) || Boolean(CNB_TEST_SITE)
const allowedUrl = (url) => /^https:\/\//.test(url) || (LOCAL_TEST_ALLOWED && /^http:\/\/127\.0\.0\.1[:/]/.test(url))
export const RELEASES_PAGE = CNB_RELEASES
// A source that sends nothing for this long is dropped for the next one.
const STALL_MS = 30000
// Source probe: up to PROBE_BYTES or PROBE_MS from each source at once.
const PROBE_BYTES = 512 * 1024
const PROBE_MS = 5000
// Tests replace the public mirrors with local ones (comma-separated prefixes).
const TEST_MIRRORS = process.env.HORSEMD_TEST_UPDATE_MIRRORS || ''
const MIRRORS = TEST_MIRRORS ? TEST_MIRRORS.split(',').filter(Boolean) : DEFAULT_MIRRORS
// Packaged: package.json's version (app.getVersion()). Unpackaged (dev,
// tests): app.getVersion() is Electron's own, so the build-time define.
/* global __APP_VERSION__ */
const currentVersion = (app) => (app.isPackaged || typeof __APP_VERSION__ === 'undefined' ? app.getVersion() : __APP_VERSION__)
const PROGRESS_EVERY_MS = 200

function linuxPackage() {
  try {
    if (fs.existsSync('/var/lib/dpkg/info/quillmd.list') || fs.existsSync('/var/lib/dpkg/info/horse.list')) return 'deb'
    if (fs.readdirSync('/var/lib/pacman/local').some((name) => /^(quillmd|horse)-\d/.test(name))) return 'pacman'
  } catch { /* not that kind of system */ }
  return null
}

function macWritable(bundle) {
  if (!macBundleReplaceable(bundle)) return false
  try {
    fs.accessSync(bundle, fs.constants.W_OK)
    fs.accessSync(dirname(bundle), fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** The newest `vX.Y.Z` tag from CNB's public Git smart-HTTP refs response. */
function latestCnbTag(refsText) {
  const tags = []
  for (const match of refsText.matchAll(/refs\/tags\/(v\d+\.\d+\.\d+)/g)) tags.push(match[1])
  if (!tags.length) throw new Error('CNB 上没有可用的版本 tag')
  return tags.sort((a, b) => compareVersions(b.slice(1), a.slice(1)))[0]
}

/**
 * Minimal parser for electron-builder's `latest*.yml`. The files only contain
 * a `version`, a `files` array (`url`, `sha512`, `size`), and summary keys;
 * no dependency is needed for that shape.
 */
function parseUpdateYaml(text) {
  const out = { version: '', files: [] }
  let file = null
  for (const line of String(text || '').split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+url:\s*(.+?)\s*$/)
    if (item) {
      file = { url: item[1] }
      out.files.push(file)
      continue
    }
    const pair = line.match(/^\s*([A-Za-z0-9_-]+):\s*(.*?)\s*$/)
    if (!pair) continue
    const [, key, value] = pair
    if (file && ['sha512', 'size'].includes(key)) {
      file[key] = key === 'size' ? Number(value) || 0 : value
    } else if (!file && ['version', 'path', 'sha512', 'size'].includes(key)) {
      out[key] = key === 'size' ? Number(value) || 0 : value
    }
  }
  return out
}

function cnbMetadataFile() {
  if (process.platform === 'win32') return 'latest.yml'
  if (process.platform === 'darwin') return 'latest-mac.yml'
  return 'latest-linux.yml'
}

export function registerUpdater({ app, ipcMain, net, shell, sendToRenderer, requestQuit, log = null, isOffline = () => false }) {
  const request = createElectronRequest(net)
  let release = null // the last release fetched by update:check
  let state = { status: 'idle' }
  let controller = null
  let cancelling = false
  let pendingInstall = null

  const publish = (next) => {
    state = next
    sendToRenderer?.('update:state', state)
  }
  const trace = (entry) => { try { log?.({ kind: 'update', ...entry }) } catch { /* never breaks */ } }

  const target = () => {
    if (!release) return null
    const bundle = process.platform === 'darwin' ? macBundlePath(process.execPath) : null
    return pickUpdateAsset({
      assets: release.assets,
      version: release.version,
      platform: process.platform,
      arch: process.arch,
      linuxPackage: process.platform === 'linux' ? linuxPackage() : null,
      macWritable: process.platform === 'darwin' && macWritable(bundle)
    })
  }

  async function fetchRelease() {
    // The test harness still serves a GitHub-shaped release object.
    if (TEST_FEED) {
      const res = await request(FEED, {
        method: 'GET',
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'QuillMD-Updater' },
        signal: AbortSignal.timeout(8000)
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      release = {
        version: String(data.tag_name || '').replace(/^v/i, ''),
        url: data.html_url || RELEASES_PAGE,
        name: typeof data.name === 'string' ? data.name : '',
        notes: typeof data.body === 'string' ? data.body.slice(0, 4000) : '',
        assets: (Array.isArray(data.assets) ? data.assets : [])
          .filter((asset) => asset && typeof asset.name === 'string' && allowedUrl(String(asset.browser_download_url || '')))
          .map((asset) => ({ name: asset.name, url: asset.browser_download_url, size: Number(asset.size) || 0, sha256: digestSha256(asset.digest) }))
      }
      return release
    }

    // CNB's JSON API requires a login even for public repositories, but its
    // Git smart-HTTP refs and release download URLs are public. Read the tag
    // list, pick the newest semantic version, then read that release's
    // electron-builder metadata from its public download URL.
    const refs = await request(FEED, {
      method: 'GET',
      headers: { 'User-Agent': 'QuillMD-Updater' },
      signal: AbortSignal.timeout(8000)
    })
    if (!refs.ok) throw new Error(`HTTP ${refs.status}`)
    const tag = latestCnbTag(await refs.text())
    const metadataUrl = `${CNB_DOWNLOAD_ROOT}/${tag}/${cnbMetadataFile()}`
    const metadataRes = await request(metadataUrl, {
      method: 'GET',
      headers: { 'User-Agent': 'QuillMD-Updater' },
      signal: AbortSignal.timeout(8000)
    })
    if (!metadataRes.ok) throw new Error(`HTTP ${metadataRes.status}`)
    const metadata = parseUpdateYaml(await metadataRes.text())
    release = {
      version: metadata.version || tag.replace(/^v/, ''),
      url: `${CNB_RELEASES}/tag/${tag}`,
      name: `QuillMD ${metadata.version || tag.replace(/^v/, '')}`,
      notes: `## QuillMD ${metadata.version || tag.replace(/^v/, '')}\n\n请查看发布页了解本次更新内容。`,
      assets: metadata.files.map((file) => ({
        name: file.url,
        url: `${CNB_DOWNLOAD_ROOT}/${tag}/${file.url}`,
        size: Number(file.size) || 0,
        sha512: file.sha512 || ''
      }))
    }
    return release
  }

  // Check: same answer shape as before (notify-only callers keep working),
  // plus whether this install can download directly and how.
  ipcMain.handle('update:check', async () => {
    if (isOffline()) return { ok: false, offline: true }
    if (!FEED) return { ok: false, disabled: true }
    try {
      const r = await fetchRelease()
      const picked = target()
      return {
        ok: true,
        latest: r.version,
        current: currentVersion(app),
        url: r.url,
        name: r.name,
        notes: r.notes,
        download: picked ? { mode: picked.mode, size: picked.asset.size } : null
      }
    } catch {
      return { ok: false }
    }
  })

  ipcMain.handle('update:getState', () => state)

  async function readText(url, signal) {
    const res = await request(url, { method: 'GET', signal, headers: { 'User-Agent': 'QuillMD-Updater' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.text()
  }

  const abortError = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })

  // The checksum a download must have. CNB metadata carries SHA-512 —
  // electron-builder writes it base64 into `latest*.yml`, digests here are
  // hex, so the value is normalized first (the release pipeline also rewrites
  // uploaded `latest*.yml` to hex for older clients). The GitHub-shaped test
  // feed carries a SHA-256 digest. The expected value is never taken from a
  // mirror or the renderer.
  async function expectedSha(asset, signal) {
    const sha512 = normalizeSha512(asset.sha512)
    if (sha512) return { algo: 'sha512', value: sha512 }
    if (asset.sha256) return { algo: 'sha256', value: asset.sha256 }
    const sumsAsset = release.assets.find((item) => item.name === 'SHA256SUMS.txt')
    if (!sumsAsset) throw new Error('这个版本缺少校验信息，为安全起见不能直接下载。')
    const expected = parseChecksums(await readText(sumsAsset.url, signal)).get(asset.name)
    if (!expected) throw new Error(`校验文件里没有 ${asset.name}，为安全起见不能直接下载。`)
    return { algo: 'sha256', value: expected }
  }

  // Every source at once, up to PROBE_BYTES / PROBE_MS each: bytes per
  // second decides the order (update-core rankSources).
  async function probeSources(sources, signal) {
    if (sources.length < 2) return sources
    const results = await Promise.all(sources.map(async (source) => {
      const ctl = new AbortController()
      const onAbort = () => ctl.abort()
      signal.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => ctl.abort(), PROBE_MS)
      const started = Date.now()
      let bytes = 0
      let status = 0
      const speed = () => bytes / Math.max(0.05, (Date.now() - started) / 1000)
      try {
        const res = await request(source.url, { method: 'GET', signal: ctl.signal, headers: { 'User-Agent': 'QuillMD-Updater', Range: `bytes=0-${PROBE_BYTES - 1}` } })
        status = res.status
        if (!(res.status === 200 || res.status === 206) || !res.body) return { source, ok: false, speed: 0, status }
        const reader = res.body.getReader()
        while (bytes < PROBE_BYTES) {
          const { done, value } = await reader.read()
          if (done) break
          bytes += value.length
        }
        ctl.abort() // a server that ignores Range sends the whole file
        return { source, ok: true, speed: speed(), status }
      } catch {
        return { source, ok: bytes > 0, speed: speed(), status }
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
    }))
    trace({ step: 'probe', results: results.map((r) => ({ via: r.source.via, status: r.status, kbps: Math.round(r.speed / 1024), ok: r.ok })) })
    if (signal.aborted) throw abortError()
    return rankSources(results)
  }

  // One source: stream into `part` while hashing. Nothing for STALL_MS ends
  // this attempt only (the next source is tried); the user's cancel ends all.
  async function fetchTo(source, part, sizeHint, signal, hashAlgo = 'sha256') {
    const attempt = new AbortController()
    const onAbort = () => attempt.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    let stalled = false
    let stall = null
    const armStall = () => {
      clearTimeout(stall)
      stall = setTimeout(() => { stalled = true; attempt.abort() }, STALL_MS)
    }
    const out = fs.createWriteStream(part)
    const hash = createHash(hashAlgo)
    let received = 0
    let lastSent = 0
    try {
      armStall()
      const res = await request(source.url, { method: 'GET', signal: attempt.signal, headers: { 'User-Agent': 'QuillMD-Updater' } })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const total = Number(res.headers.get('content-length')) || sizeHint
      publish({ ...state, received: 0, total, via: source.via })
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        armStall()
        hash.update(value)
        received += value.length
        if (!out.write(value)) await new Promise((resolve) => out.once('drain', resolve))
        const now = Date.now()
        if (now - lastSent >= PROGRESS_EVERY_MS) {
          lastSent = now
          publish({ ...state, received, total })
        }
      }
      await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())))
      return { sha: hash.digest('hex'), received, total }
    } catch (error) {
      out.destroy()
      await fsp.rm(part, { force: true })
      if (signal.aborted) throw abortError()
      throw new Error(stalled ? `${STALL_MS / 1000} 秒没有进展` : String(error?.message || error).replace(/^Error: /, ''))
    } finally {
      clearTimeout(stall)
      signal.removeEventListener('abort', onAbort)
    }
  }

  async function download() {
    if (state.status === 'downloading') return state
    if (state.status === 'ready' && state.version === release?.version) return state
    if (!release) await fetchRelease()
    if (compareVersions(release.version, currentVersion(app)) <= 0) throw new Error('已经是最新版本。')
    const picked = target()
    if (!picked) throw new Error('这个系统没有可以直接下载的安装包，请到 CNB 发布页下载。')
    const { asset, mode } = picked
    controller = new AbortController()
    cancelling = false
    const { signal } = controller
    const version = release.version
    publish({ status: 'downloading', version, mode, name: asset.name, received: 0, total: asset.size, via: null })
    trace({ step: 'download', version, asset: asset.name, mode })

    const expected = await expectedSha(asset, signal)
    // install: a private folder; open / reveal: the user's Downloads.
    const dir = mode === 'install' ? join(app.getPath('temp'), 'horsemd-update', version) : app.getPath('downloads')
    await fsp.mkdir(dir, { recursive: true })
    const file = join(dir, asset.name)
    const part = `${file}.part`

    // GitHub or a mirror, fastest first; the next one on failure, stall or
    // a checksum mismatch.
    const sources = await probeSources(downloadSources(asset.url, MIRRORS, { anyUrl: Boolean(TEST_MIRRORS) }), signal)
    let fetched = null
    let mismatch = false
    const failures = []
    for (const source of sources) {
      trace({ step: 'source', via: source.via })
      try {
        const result = await fetchTo(source, part, asset.size, signal, expected.algo)
        if (result.sha !== expected.value) {
          await fsp.rm(part, { force: true })
          mismatch = true
          failures.push(`${source.via}: checksum`)
          trace({ step: 'checksum-mismatch', via: source.via, asset: asset.name })
          continue
        }
        fetched = { ...result, via: source.via }
        break
      } catch (error) {
        if (signal.aborted) throw error
        failures.push(`${source.via}: ${error.message}`)
        trace({ step: 'source-failed', via: source.via, message: error.message.slice(0, 200) })
      }
    }
    if (!fetched) {
      throw new Error(mismatch
        ? '下载的文件校验不一致，已删除。请重试，或到 CNB 发布页下载。'
        : `下载失败（${failures.join('；')}）。请检查网络后重试，或到 CNB 发布页下载。`)
    }
    const { received, total, via } = fetched
    await fsp.rm(file, { force: true })
    await fsp.rename(part, file)

    let installFrom = file
    if (process.platform === 'darwin' && mode === 'install') {
      const unpacked = join(dir, 'app')
      await fsp.rm(unpacked, { recursive: true, force: true })
      await fsp.mkdir(unpacked, { recursive: true })
      await execFileAsync('/usr/bin/ditto', ['-x', '-k', file, unpacked])
      const name = (await fsp.readdir(unpacked)).find((entry) => entry.endsWith('.app'))
      if (!name) throw new Error('更新包里没有找到 QuillMD.app。')
      installFrom = join(unpacked, name)
      const plist = await fsp.readFile(join(installFrom, 'Contents', 'Info.plist'), 'utf8')
      if (plistVersion(plist) !== version) throw new Error('更新包的版本号不对，已停止。')
    }
    controller = null
    trace({ step: 'ready', version, asset: asset.name, via })
    if (mode === 'open') shell.openPath(file)
    if (mode === 'reveal') shell.showItemInFolder(file)
    publish({ status: 'ready', version, mode, name: asset.name, received, total, via, file, installFrom })
    return state
  }

  ipcMain.handle('update:download', async () => {
    if (isOffline()) return { ok: false, offline: true, error: 'offline' }
    if (!FEED) return { ok: false, error: 'disabled' }
    try {
      return await download()
    } catch (error) {
      controller = null
      if (cancelling) {
        cancelling = false
        publish({ status: 'idle' })
      } else {
        trace({ step: 'error', message: String(error?.message || error).slice(0, 300) })
        publish({ ...state, status: 'error', error: String(error?.message || error).replace(/^Error: /, '') })
      }
      return state
    }
  })

  ipcMain.handle('update:cancel', () => {
    if (state.status !== 'downloading') return state
    cancelling = true
    controller?.abort()
    return state
  })

  // Open / reveal what was downloaded (open / reveal modes, after the fact).
  ipcMain.handle('update:showFile', () => {
    if (state.status !== 'ready' || !state.file) return false
    if (state.mode === 'open') shell.openPath(state.file)
    else shell.showItemInFolder(state.file)
    return true
  })

  ipcMain.handle('update:install', () => {
    if (isOffline()) return { ok: false, offline: true, error: 'offline' }
    if (!FEED) return { ok: false, error: 'disabled' }
    if (state.status !== 'ready' || state.mode !== 'install') return false
    // Never in a dev / test run: the "app" there is node_modules' Electron.
    if (!app.isPackaged) {
      trace({ step: 'install-refused-unpackaged' })
      return false
    }
    pendingInstall = { ...state }
    trace({ step: 'install-requested', version: state.version })
    requestQuit()
    return true
  })

  return {
    // The user kept the app open (unsaved-changes confirm cancelled).
    cancelPendingInstall() { pendingInstall = null },
    // Offline mode can be turned on while a download runs; abort it at once.
    cancelDownload() {
      if (state.status !== 'downloading') return state
      cancelling = true
      controller?.abort()
      return state
    },
    // 'will-quit': start the installer / swap script, detached.
    runPendingInstall() {
      const job = pendingInstall
      pendingInstall = null
      if (!job) return
      try {
        if (process.platform === 'win32') {
          spawn(job.installFrom, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref()
        } else if (process.platform === 'darwin') {
          const bundle = macBundlePath(process.execPath)
          const script = join(dirname(job.file), 'install.sh')
          fs.writeFileSync(script, MAC_SWAP_SCRIPT, { mode: 0o755 })
          spawn('/bin/sh', [script, String(process.pid), job.installFrom, bundle], { detached: true, stdio: 'ignore' }).unref()
        }
        trace({ step: 'install-started', version: job.version })
      } catch (error) {
        trace({ step: 'install-failed', message: String(error?.message || error) })
      }
    }
  }
}

// Waits for QuillMD to exit, swaps the bundle (the old one is kept until the
// new one is in place, and put back if the move fails), clears quarantine and
// opens the result.
const MAC_SWAP_SCRIPT = `#!/bin/sh
PID="$1"; NEW="$2"; DEST="$3"
i=0
while kill -0 "$PID" 2>/dev/null && [ "$i" -lt 240 ]; do sleep 0.25; i=$((i + 1)); done
OLD="$DEST.horsemd-old-$$"
if mv "$DEST" "$OLD"; then
  if mv "$NEW" "$DEST"; then
    xattr -dr com.apple.quarantine "$DEST" 2>/dev/null
    rm -rf "$OLD"
  else
    mv "$OLD" "$DEST"
  fi
fi
open "$DEST"
`
