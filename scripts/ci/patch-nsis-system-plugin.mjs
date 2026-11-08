// electron-builder 25.x bundles NSIS 3.0.4.1. Its 2018 System.dll plugin
// crashes with 0xC0000005 while the installer starts on Windows 11 build
// 26300 (reported to the user as "Error writing temporary file"). The crash
// happens before the first wizard page and leaves no install files. Replacing
// only that plugin with NSIS 3.13's build fixes the same installer script.
//
// Keep the patch local to electron-builder's checksum-verified tool cache, so
// `npm run dist` and release CI use it without a custom NSIS distribution.
import { createHash } from 'node:crypto'
import { copyFile, readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { getBinFromUrl } = require('app-builder-lib/out/binDownload')

const NSIS_VERSION = '3.0.4.1'
const NSIS_CHECKSUM = 'VKMiizYdmNdJOWpRGz4trl4lD++BvYP2irAXpMilheUP0pc93iKlWAoP843Vlraj8YG19CVn0j+dCo/hURz9+Q=='
const SYSTEM_DLL_SHA256 = 'afe032f942e2ed0bf7494ec08ba813f5739fb522c640bde81d30ecaf9f894432'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const source = join(root, 'build', 'nsis', 'x86-unicode', 'System.dll')

async function main() {
  if (process.platform !== 'win32') {
    console.log('[nsis] System.dll patch is Windows-only; skipped')
    return
  }
  const digest = createHash('sha256').update(await readFile(source)).digest('hex')
  if (digest !== SYSTEM_DLL_SHA256) {
    throw new Error(`build/nsis/x86-unicode/System.dll checksum mismatch: ${digest}`)
  }
  const nsisDir = await getBinFromUrl('nsis', NSIS_VERSION, NSIS_CHECKSUM)
  const destination = join(nsisDir, 'Plugins', 'x86-unicode', 'System.dll')
  await copyFile(source, destination)
  const { size } = await stat(destination)
  console.log(`[nsis] patched System.dll (${size} bytes) in ${nsisDir}`)
}

main().catch((error) => {
  console.error(`[nsis] patch failed: ${error?.message || error}`)
  process.exit(1)
})
