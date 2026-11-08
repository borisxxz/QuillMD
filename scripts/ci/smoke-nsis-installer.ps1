param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [int]$WaitSeconds = 6
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Installer)) {
  throw "installer not found: $Installer"
}
$base = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$work = Join-Path $base "quillmd-nsis-smoke"
New-Item -ItemType Directory -Force -Path $work | Out-Null
$p = Start-Process -FilePath $Installer -WorkingDirectory $work -PassThru
Start-Sleep -Seconds $WaitSeconds
$p.Refresh()
if ($p.HasExited) {
  throw "installer exited before the first window (exit code $($p.ExitCode))"
}
Write-Output "installer stayed alive (pid $($p.Id)); first-window startup OK"
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
