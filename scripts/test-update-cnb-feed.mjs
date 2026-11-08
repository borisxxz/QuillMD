// Regression test for the production CNB update path (v0.0.3 → v0.0.4 broke on
// it): the app discovers the tag via CNB's git refs, reads electron-builder's
// `latest*.yml` — whose SHA-512 is base64 — and must compare it against the
// hex digest it computes of the downloaded bytes. The first QuillMD release
// compared the two strings directly, so every CNB download ended in
// 「下载的文件校验不一致」. Runs the real `src/main/updater.js` in a bare
// Electron main process against a local CNB-shaped server (good bytes then
// corrupt bytes). Windows-only: the NSIS asset's install mode has no side
// effects; the macOS dmg / Linux deb modes open or reveal files.
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import electronPath from 'electron'

if (process.platform !== 'win32') {
  console.log('SKIP update CNB feed: Windows runs it in test:core (macOS dmg / Linux deb download modes have Finder side effects)')
  process.exit(0)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const VERSION = '99.0.1'
const exeName = `QuillMD-Setup-${VERSION}.exe`
const asset = randomBytes(3 * 1024 * 1024) // incompressible, still instant on loopback
const sha512Hex = createHash('sha512').update(asset).digest('hex')
const sha512Base64 = createHash('sha512').update(asset).digest('base64')
// electron-builder's exact `latest.yml` shape: per-file entries plus summary keys.
const latestYml = `version: ${VERSION}
files:
  - url: ${exeName}
    sha512: ${sha512Base64}
    size: ${asset.length}
path: ${exeName}
sha512: ${sha512Base64}
releaseDate: '2026-11-08T00:00:00.000Z'
`

let corrupt = false
const server = http.createServer((req, res) => {
  const send = (status, type, body) => {
    res.writeHead(status, { 'content-type': type, 'content-length': body.length })
    res.end(body)
  }
  if (req.url.includes('.git/info/refs')) {
    // latestCnbTag() only regex-scans for tag refs; a plain list is enough.
    return send(200, 'text/plain', `# service=git-upload-pack\nrefs/tags/v0.0.3\nrefs/tags/v0.0.4\nrefs/tags/v${VERSION}\n`)
  }
  if (req.url.endsWith('/latest.yml') || req.url.endsWith('/latest-mac.yml') || req.url.endsWith('/latest-linux.yml')) {
    return send(200, 'text/yaml', latestYml)
  }
  if (req.url.endsWith(`/${exeName}`)) {
    const body = corrupt ? Buffer.from(asset).fill(7, 1000, 2000) : asset
    return send(200, 'application/octet-stream', body)
  }
  send(404, 'text/plain', 'not found')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
// The site value must end in a path segment: updater builds `<site>.git/...`
// and `<site>/-/releases/...` from it (the real one is cnb.cool/boris007/QuillMD).
const base = `http://127.0.0.1:${server.address().port}/cnb`

const root = await mkdtemp(join(tmpdir(), 'quillmd-update-cnb-'))
const updateDir = join(tmpdir(), 'horsemd-update', VERSION)
const updaterUrl = pathToFileURL(join(process.cwd(), 'src/main/updater.js')).href

async function runPhase(name) {
  const resultFile = join(root, `${name}.json`)
  const main = join(root, `${name}.mjs`)
  await writeFile(main, `
import { app, net } from 'electron'
import { writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { registerUpdater } from ${JSON.stringify(updaterUrl)}
const handlers = new Map()
const ipcMain = { handle: (name, fn) => handlers.set(name, fn) }
const traces = []
const updater = registerUpdater({
  app, ipcMain, net,
  shell: { openPath: () => '', showItemInFolder: () => {} },
  sendToRenderer: () => {},
  requestQuit: () => {},
  log: (entry) => traces.push(entry)
})
app.whenReady().then(async () => {
  const out = {}
  try {
    out.check = await handlers.get('update:check')()
    out.download = await handlers.get('update:download')()
    if (out.download?.file) {
      out.fileSha512Hex = createHash('sha512').update(await readFile(out.download.file)).digest('hex')
    }
  } catch (e) {
    out.threw = String(e && e.message || e)
  }
  out.traces = traces.map((t) => t.step)
  out.tracesFull = traces
  writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(out))
  app.exit(0)
}).catch((e) => { writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ threw: String(e && e.stack || e) })); app.exit(0) })
`)
  await rm(updateDir, { recursive: true, force: true })
  const child = spawn(electronPath, [main, `--user-data-dir=${join(root, `${name}-profile`)}`], {
    stdio: 'ignore',
    env: { ...process.env, HORSEMD_TEST_UPDATE_CNB_SITE: base }
  })
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 60000))
  ])
  if (!exited) child.kill('SIGKILL')
  assert.ok(exited, `${name}: Electron did not finish`)
  return JSON.parse(await readFile(resultFile, 'utf8'))
}

try {
  // 1. Good bytes: base64 SHA-512 from latest.yml must verify against the hex
  //    digest of the download (this is exactly what v0.0.3 got wrong).
  corrupt = false
  const good = await runPhase('good')
  assert.equal(good.threw, undefined, good.threw)
  assert.equal(good.check?.ok, true, `check failed: ${JSON.stringify(good)}`)
  assert.equal(good.check?.latest, VERSION)
  assert.equal(good.download?.status, 'ready', `download not ready: ${JSON.stringify(good.download)}`)
  assert.equal(good.download?.via, 'direct')
  assert.equal(good.download?.file?.endsWith(exeName), true, good.download?.file)
  assert.equal(good.fileSha512Hex, sha512Hex, 'the downloaded file is not the served bytes')
  assert.ok(!existsSync(join(updateDir, `${exeName}.part`)), 'part file left behind')

  // 2. Corrupt bytes: rejected, deleted, the checksum message shown.
  corrupt = true
  const bad = await runPhase('corrupt')
  assert.equal(bad.threw, undefined, bad.threw)
  assert.equal(bad.download?.status, 'error', `corrupt download not an error: ${JSON.stringify(bad.download)}`)
  assert.match(bad.download?.error || '', /校验不一致/)
  assert.ok(!existsSync(updateDir) || !existsSync(join(updateDir, exeName)), 'rejected file left behind')
  assert.ok(bad.traces.includes('checksum-mismatch'), `no checksum-mismatch trace: ${JSON.stringify(bad.traces)}`)

  console.log('PASS update CNB feed: tag discovery + latest.yml base64 SHA-512 verified against the hex digest (corrupt bytes still rejected)')
} finally {
  server.close()
  await rm(root, { recursive: true, force: true })
  await rm(updateDir, { recursive: true, force: true })
}
