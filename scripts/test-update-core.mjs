// In-app update (#164), pure part: which release asset each install gets and
// how it is installed, checksum parsing, version order, macOS bundle paths.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  compareVersions,
  DEFAULT_MIRRORS,
  digestSha256,
  downloadSources,
  normalizeSha512,
  rankSources,
  macBundlePath,
  macBundleReplaceable,
  parseChecksums,
  pickUpdateAsset,
  plistVersion
} from '../src/main/update-core.js'

// A real-shaped SHA-512 pair for normalizeSha512.
const sha512Bytes = createHash('sha512').update('QuillMD update fixture').digest()
const sha512Hex = sha512Bytes.toString('hex')
const sha512B64 = sha512Bytes.toString('base64')

const names = [
  'quillmd-0.13.257-x86_64.pkg.tar.xz', 'QuillMD-0.13.257-android.apk',
  'QuillMD-0.13.257-arm64.zip', 'QuillMD-0.13.257-arm64.zip.blockmap', 'QuillMD-0.13.257-arm64.dmg',
  'QuillMD-0.13.257-x64.zip', 'QuillMD-0.13.257-x64.dmg', 'QuillMD-Setup-0.13.257.exe', 'QuillMD-Setup-0.13.257.exe.blockmap',
  'quillmd_0.13.257_amd64.deb', 'latest.yml', 'latest-mac.yml', 'SHA256SUMS.txt'
]
const assets = names.map((name) => ({ name, url: `https://example.com/${name}`, size: 1 }))
const pick = (opts) => {
  const r = pickUpdateAsset({ assets, version: '0.13.257', ...opts })
  return r && [r.asset.name, r.mode]
}

assert.deepEqual(pick({ platform: 'win32', arch: 'x64' }), ['QuillMD-Setup-0.13.257.exe', 'install'])
assert.deepEqual(pick({ platform: 'win32', arch: 'arm64' }), ['QuillMD-Setup-0.13.257.exe', 'install'])
assert.deepEqual(pick({ platform: 'darwin', arch: 'arm64', macWritable: true }), ['QuillMD-0.13.257-arm64.zip', 'install'])
assert.deepEqual(pick({ platform: 'darwin', arch: 'x64', macWritable: true }), ['QuillMD-0.13.257-x64.zip', 'install'])
// Not replaceable in place (read-only, disk image, translocated): the dmg is opened.
assert.deepEqual(pick({ platform: 'darwin', arch: 'arm64', macWritable: false }), ['QuillMD-0.13.257-arm64.dmg', 'open'])
assert.deepEqual(pick({ platform: 'darwin', arch: 'x64', macWritable: false }), ['QuillMD-0.13.257-x64.dmg', 'open'])
assert.deepEqual(pick({ platform: 'linux', arch: 'x64', linuxPackage: 'deb' }), ['quillmd_0.13.257_amd64.deb', 'reveal'])
assert.deepEqual(pick({ platform: 'linux', arch: 'x64', linuxPackage: 'pacman' }), ['quillmd-0.13.257-x86_64.pkg.tar.xz', 'reveal'])
// No package for this install → GitHub only.
assert.equal(pick({ platform: 'linux', arch: 'x64', linuxPackage: null }), null)
assert.equal(pick({ platform: 'linux', arch: 'arm64', linuxPackage: 'deb' }), null)
assert.equal(pick({ platform: 'android', arch: 'arm64' }), null)
// Another version's assets, or a malformed version, never match.
assert.equal(pickUpdateAsset({ assets, version: '0.13.258', platform: 'win32', arch: 'x64' }), null)
assert.equal(pickUpdateAsset({ assets, version: '0.13.257.*', platform: 'win32', arch: 'x64' }), null)
assert.equal(pickUpdateAsset({ assets: [{ name: 'QuillMD-Setup-0x13x257.exe' }], version: '0.13.257', platform: 'win32', arch: 'x64' }), null)
assert.deepEqual(pickUpdateAsset({ assets, version: 'v0.13.257', platform: 'win32', arch: 'x64' })?.asset.name, 'QuillMD-Setup-0.13.257.exe')

const sums = parseChecksums('f005a52df1e370f21884b11c6782aa1cc1fdf8025095db38edc370fef4d410fc  quillmd-0.13.256-x86_64.pkg.tar.xz\r\n6197A8632EA972B1324281406F4BE386DAD60579E21BFC158DA7265C0D9E3C38 *QuillMD-Setup-0.13.256.exe\nnot a line\n')
assert.equal(sums.get('quillmd-0.13.256-x86_64.pkg.tar.xz'), 'f005a52df1e370f21884b11c6782aa1cc1fdf8025095db38edc370fef4d410fc')
assert.equal(sums.get('QuillMD-Setup-0.13.256.exe'), '6197a8632ea972b1324281406f4be386dad60579e21bfc158da7265c0d9e3c38')
assert.equal(sums.size, 2)

assert.equal(compareVersions('0.13.257', '0.13.256'), 1)
assert.equal(compareVersions('0.13.256', '0.13.256'), 0)
assert.equal(compareVersions('0.13.29', '0.13.256'), -1)
assert.equal(compareVersions('v1.0.0', '0.99.99'), 1)

assert.equal(macBundlePath('/Applications/QuillMD.app/Contents/MacOS/QuillMD'), '/Applications/QuillMD.app')
assert.equal(macBundlePath('/Users/a/My Apps/QuillMD.app/Contents/MacOS/QuillMD'), '/Users/a/My Apps/QuillMD.app')
assert.equal(macBundlePath('/usr/bin/node'), null)
assert.equal(macBundleReplaceable('/Applications/QuillMD.app'), true)
assert.equal(macBundleReplaceable('/Volumes/QuillMD 0.13.257/QuillMD.app'), false)
assert.equal(macBundleReplaceable('/private/var/folders/x/AppTranslocation/ABC/QuillMD.app'), false)

assert.equal(plistVersion('<dict><key>CFBundleShortVersionString</key>\n\t<string>0.13.257</string></dict>'), '0.13.257')
assert.equal(plistVersion('<dict></dict>'), null)

// Download sources: GitHub first, then the public mirrors, only for GitHub
// release downloads.
const gh = 'https://github.com/example/horsemd/releases/download/v0.13.257/QuillMD-Setup-0.13.257.exe'
const mirrors = ['https://mirror.example/']
assert.deepEqual(downloadSources(gh).map((x) => x.via), ['direct', ...DEFAULT_MIRRORS.map((m) => new URL(m).host)])
assert.deepEqual(downloadSources(gh, mirrors).map((x) => x.via), ['direct', 'mirror.example'])
assert.equal(downloadSources(gh, mirrors)[1].url, mirrors[0] + gh)
assert.deepEqual(downloadSources('https://example.com/x.exe').map((x) => x.via), ['direct'])
assert.deepEqual(downloadSources('https://github.com/example/horsemd/archive/main.zip').map((x) => x.via), ['direct'])
assert.equal(downloadSources('http://127.0.0.1:1/x', ['http://127.0.0.1:2/m/'], { anyUrl: true })[1].url, 'http://127.0.0.1:2/m/http://127.0.0.1:1/x')

// Ranking by measured speed (Windows test PC in China, 2026-10-26: GitHub
// ~11–50 KB/s, ghfast.top ~850 KB/s, gh-proxy.com ~265 KB/s).
const src = (via) => ({ url: via, via })
const order = (probes) => rankSources(probes).map((x) => x.via)
assert.deepEqual(order([
  { source: src('direct'), ok: true, speed: 50e3 },
  { source: src('ghfast.top'), ok: true, speed: 850e3 },
  { source: src('gh-proxy.com'), ok: true, speed: 265e3 }
]), ['ghfast.top', 'gh-proxy.com', 'direct'])
// GitHub is preferred when it is close enough to the fastest (≥ 70 %).
assert.deepEqual(order([
  { source: src('direct'), ok: true, speed: 8e6 },
  { source: src('ghfast.top'), ok: true, speed: 10e6 }
]), ['direct', 'ghfast.top'])
// A failed probe stays as a last resort, in its original order.
assert.deepEqual(order([
  { source: src('direct'), ok: false, speed: 0 },
  { source: src('ghfast.top'), ok: false, speed: 0 },
  { source: src('gh-proxy.com'), ok: true, speed: 1e5 }
]), ['gh-proxy.com', 'direct', 'ghfast.top'])
assert.deepEqual(order([{ source: src('direct'), ok: false, speed: 0 }]), ['direct'])

assert.equal(digestSha256('sha256:AA6F60F734E1A50EDBCCBFEA45EAA5DD6A6930A8587806FFD0E3135D76701A8C'), 'aa6f60f734e1a50edbccbfea45eaa5dd6a6930a8587806ffd0e3135d76701a8c')
assert.equal(digestSha256('sha512:abc'), null)
assert.equal(digestSha256(undefined), null)

// electron-builder writes base64 SHA-512 into latest*.yml; our digests are hex.
// The v0.0.3 updater compared the two encodings as strings and every CNB
// download failed with 校验不一致.
assert.equal(normalizeSha512(sha512B64), sha512Hex)
assert.equal(normalizeSha512(sha512Hex.toUpperCase()), sha512Hex) // hex passes through, lowercased
assert.equal(normalizeSha512(`"${sha512B64}"`), sha512Hex) // a quoted YAML scalar still normalizes
assert.equal(normalizeSha512('G2Ji0Mt9M2yE6Gi6lvKJCWPLSfcWz6MA'), '') // base64 but not 64 bytes
assert.equal(normalizeSha512('not-a-sha'), '')
assert.equal(normalizeSha512(''), '')
assert.equal(normalizeSha512(undefined), '')

// The release-pipeline rewriter (scripts/ci/normalize-latest-yml-sha512.mjs):
// base64 → hex in place, lossless, idempotent, refuses invalid values.
{
  const { execFileSync } = await import('node:child_process')
  const { mkdtemp, readFile, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'quillmd-normalize-yml-'))
  try {
    const exeBytes = Buffer.alloc(2048, 7)
    const exeShaB64 = createHash('sha512').update(exeBytes).digest('base64')
    const exeShaHex = createHash('sha512').update(exeBytes).digest('hex')
    await writeFile(join(dir, 'latest.yml'), `version: 9.9.9\r\nfiles:\r\n  - url: QuillMD-Setup-9.9.9.exe\r\n    sha512: ${exeShaB64}\r\n    size: ${exeBytes.length}\r\npath: QuillMD-Setup-9.9.9.exe\r\nsha512: ${exeShaB64}\r\nreleaseDate: '2026-11-08T00:00:00.000Z'\r\n`)
    const run = () => execFileSync(process.execPath, [join(process.cwd(), 'scripts/ci/normalize-latest-yml-sha512.mjs'), dir], { encoding: 'utf8' })
    run()
    const rewritten = await readFile(join(dir, 'latest.yml'), 'utf8')
    assert.match(rewritten, /^version: 9\.9\.9\r$/m, 'CRLF line endings preserved')
    assert.equal([...rewritten.matchAll(/sha512: ([0-9a-f]{128})\r?$/mg)].length, 2, 'both sha512 values rewritten to hex')
    assert.ok(rewritten.includes(exeShaHex), 'hex value present')
    assert.ok(!rewritten.includes(exeShaB64), 'base64 value gone')
    const again = run() // idempotent
    assert.match(again, /already hex/)
    assert.equal(await readFile(join(dir, 'latest.yml'), 'utf8'), rewritten)
    // An invalid value must fail the build, not publish garbage.
    await writeFile(join(dir, 'latest-mac.yml'), `version: 9.9.9\nsha512: definitely-not-a-sha\n`)
    let refused = ''
    try { run() } catch (error) { refused = String(error.stderr || error.stdout || error) }
    assert.match(refused, /neither valid hex nor base64/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

console.log('PASS update core: asset per platform / install mode, checksums (base64/hex SHA-512), versions, macOS bundle paths, download sources (GitHub / mirrors) ranked by speed, asset digests')
