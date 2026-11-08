# NSIS build plugin override

`x86-unicode/System.dll` is taken from the official NSIS **3.13** release
(2026-09-27), SHA-256
`afe032f942e2ed0bf7494ec08ba813f5739fb522c640bde81d30ecaf9f894432`.

electron-builder 25.1.8 downloads NSIS 3.0.4.1. Its bundled `System.dll`
(2018) crashes with `0xC0000005` while starting the installer on Windows 11
build 26300 — before the first wizard page, on some systems reported as
`NSIS Error: Error writing temporary file`. The installer never reaches the
app, so this is not a TEMP/ACL problem. Replacing this plugin with the 3.13
build fixes the first crash.

A second, independent `System.dll` crash remains in `multiUser.nsh`: the
per-user install path calls
`System::Call 'SHELL32::SHGetKnownFolderPath(... KF_FLAG_CREATE ...)'`.
`scripts/ci/patch-nsis-multiuser.mjs` replaces that lookup with the standard
`%LOCALAPPDATA%\Programs` root; without it the fixed plugin still crashes at
about `0x1621` before the first page, especially when launched from Downloads
or another user folder.

`scripts/ci/patch-nsis-system-plugin.mjs` downloads electron-builder's normal
NSIS toolchain (checksum-verified by app-builder-lib), then overwrites this one
plugin in its cache before packaging. Both patch scripts run from `npm run dist`
and the Windows release job. `build/nsis/COPYING` is the NSIS license.
