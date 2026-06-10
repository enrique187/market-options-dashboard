$ErrorActionPreference = "Stop"
$AppRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$BundledPython = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"

if (Test-Path $BundledPython) {
  $Python = $BundledPython
} else {
  $Python = "python"
}

Set-Location $AppRoot
Write-Host "Starting market dashboard..."
Write-Host "Open http://127.0.0.1:8765/ in your browser."
& $Python "server.py"

