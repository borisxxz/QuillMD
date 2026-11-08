// electron-builder 25.1.8's per-user installer resolves the Windows
// FOLDERID_UserProgramFiles known folder with:
//
//   System::Call 'SHELL32::SHGetKnownFolderPath(..., KF_FLAG_CREATE, ...)'
//
// On Windows 11 build 26300 that System.dll call crashes the installer with
// 0xC0000005 (System.dll, offset 0x1621) before the first wizard page. The
// crash is independent of the NSIS System.dll version and reproduces with a
// full NSIS 3.13 build; replacing only this call fixes it.
//
// %LOCALAPPDATA%\Programs is the normal per-user install root. Systems that
// relocated FOLDERID_UserProgramFiles lose that customization, which is an
// acceptable trade-off for an installer that actually starts.
import { access, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const appBuilderLib = dirname(require.resolve('app-builder-lib/package.json'))
const template = join(appBuilderLib, 'templates', 'nsis', 'multiUser.nsh')

const MARKER = 'QuillMD PATCH: known-folder lookup removed'
const SYSTEM_BLOCK = /(?:\r?\n)?[ \t]*System::Store S[\s\S]*?[ \t]*System::Store L[ \t]*(?=\r?\n)/

async function main() {
  await access(template)
  let text = await readFile(template, 'utf8')
  if (text.includes(MARKER)) {
    console.log('[nsis] multiUser known-folder patch already applied')
    return
  }
  if (!text.includes('SHGetKnownFolderPath')) {
    throw new Error(`unexpected multiUser.nsh: SHGetKnownFolderPath not found in ${template}`)
  }
  const replacement = [
    '',
    `      # ${MARKER}`,
    '      # %LOCALAPPDATA%\\Programs is the standard per-user install root.',
    '      # The old System::Call crashes installer startup on Windows 11 26300.',
    '',
  ].join('\n')
  const next = text.replace(SYSTEM_BLOCK, replacement)
  if (next === text) {
    throw new Error(`could not replace the SHGetKnownFolderPath block in ${template}`)
  }
  await writeFile(template, next, 'utf8')
  console.log(`[nsis] patched ${template}`)
}

main().catch((error) => {
  console.error(`[nsis] multiUser patch failed: ${error?.message || error}`)
  process.exit(1)
})
