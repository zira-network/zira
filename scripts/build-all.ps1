# scripts/build-all.ps1
# Build everything and stage the Console into the node so one ZIRA Core binary serves the GUI.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
pnpm build:protocol
pnpm build:node
pnpm build:console
$pub = "$root\node\public"
if (Test-Path $pub) { Remove-Item -Recurse -Force $pub }
New-Item -ItemType Directory -Force $pub | Out-Null
Copy-Item -Recurse -Force "$root\apps\console\dist\*" $pub
Pop-Location
Write-Host "Done. Run a node:  node node\dist\index.js   then open http://127.0.0.1:8645" -ForegroundColor Green
