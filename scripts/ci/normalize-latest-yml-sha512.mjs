// Rewrite electron-builder's `latest*.yml` SHA-512 values from base64 to
// lowercase hex, in place, before they are uploaded to a release.
//
// Why: the in-app updater (src/main/updater.js) compares the `sha512` it read
// from `latest*.yml` against a hex digest it computed itself. electron-builder
// writes base64; QuillMD releases up to v0.0.4 shipped that raw, so every
// client before the normalizeSha512 fix compared base64 against hex and failed
// with 「下载的文件校验不一致」. New clients normalize either encoding, but
// every `latest*.yml` we publish also carries hex so those older clients keep
// updating (only this project's updater consumes these files — electron-updater
// is not used).
//
// Usage: node scripts/ci/normalize-latest-yml-sha512.mjs <dir> [<dir>...]
// Idempotent: hex values pass through unchanged. Every rewrite is verified by
// re-encoding back to the original base64, so a broken transform can never be
// uploaded.
import fs from 'node:fs'
import path from 'node:path'

const dirs = process.argv.slice(2)
if (!dirs.length) {
  console.error('usage: node scripts/ci/normalize-latest-yml-sha512.mjs <dir> [<dir>...]')
  process.exit(1)
}

const normalize = (value) => {
  const raw = String(value || '').trim().replace(/^["']|["']$/g, '')
  if (/^[0-9a-fA-F]{128}$/.test(raw)) return raw.toLowerCase()
  try {
    const bytes = Buffer.from(raw, 'base64')
    if (bytes.length === 64) {
      const hex = bytes.toString('hex')
      // Round-trip check: the transform must be lossless before it is published.
      if (Buffer.from(hex, 'hex').toString('base64') !== raw) return null
      return hex
    }
  } catch { /* not base64 */ }
  return null
}

let touched = 0
for (const dir of dirs) {
  let entries = []
  try { entries = fs.readdirSync(dir) } catch { continue }
  for (const name of entries) {
    if (!/^latest(-mac|-linux)?\.yml$/.test(name)) continue
    const file = path.join(dir, name)
    const text = fs.readFileSync(file, 'utf8')
    let changed = 0
    const out = text.split(/(\r?\n)/).map((line) => {
      if (!/^\s*sha512:\s*/.test(line)) return line
      const newline = line.match(/(\r?\n)$/)?.[1] || ''
      const body = newline ? line.slice(0, -newline.length) : line
      const value = body.replace(/^\s*sha512:\s*/, '').trim()
      const hex = normalize(value)
      if (!hex) {
        console.error(`${file}: sha512 value is neither valid hex nor base64: ${value}`)
        process.exit(1)
      }
      if (hex === value) return line // already hex (or same string) — untouched
      changed += 1
      const indent = body.match(/^\s*/)[0]
      return `${indent}sha512: ${hex}${newline}`
    }).join('')
    if (changed) {
      fs.writeFileSync(file, out, 'utf8')
      touched += changed
      console.log(`${path.relative(process.cwd(), file)}: ${changed} sha512 value(s) rewritten to hex`)
    } else {
      console.log(`${path.relative(process.cwd(), file)}: already hex`)
    }
  }
}
console.log(`normalize-latest-yml-sha512: done (${touched} rewritten)`)
