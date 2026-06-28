param(
  [string]$Output = "..\web-gui"
)

# scripts/prepare-web-gui.ps1
# Build a static Console folder suitable for uploading under a WordPress path such as /zira/.
# Mining and node execution do not run in this folder; it connects to a running ZIRA node RPC.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$out = [System.IO.Path]::GetFullPath((Join-Path $root $Output))
$stage = "$out.__staging_$PID"
$dist = Join-Path $root "apps\console\dist"

Push-Location $root
try {
  pnpm build:console
  if ($LASTEXITCODE -ne 0) { throw "Console build failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null
robocopy $dist $stage /MIR /R:2 /W:1 | Out-Host
if ($LASTEXITCODE -ge 8) { throw "robocopy failed for web-gui with exit code $LASTEXITCODE" }

$readme = @(
  "# ZIRA Web GUI",
  "",
  "Static Console build for WordPress hosting, for example `https://zira.network/zira/`.",
  "",
  "- Upload the contents of this folder to the WordPress/static file path.",
  "- This web build does not mine and does not run a node.",
  "- Users connect it to a running local or remote ZIRA node RPC from Settings.",
  "- Keep RPC admin endpoints private unless an admin token is configured."
)
$readme | Set-Content -LiteralPath (Join-Path $stage "README_WEB_GUI.txt") -Encoding UTF8

$htaccess = @(
  "Options -Indexes",
  "<IfModule mod_rewrite.c>",
  "RewriteEngine On",
  "RewriteBase /zira/",
  "RewriteRule ^index\.html$ - [L]",
  "RewriteCond %{REQUEST_FILENAME} !-f",
  "RewriteCond %{REQUEST_FILENAME} !-d",
  "RewriteRule . /zira/index.html [L]",
  "</IfModule>"
)
$htaccess | Set-Content -LiteralPath (Join-Path $stage ".htaccess") -Encoding ASCII

if (Test-Path $out) {
  robocopy $stage $out /MIR /R:2 /W:1 | Out-Host
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed for web-gui output with exit code $LASTEXITCODE" }
  Remove-Item -LiteralPath $stage -Recurse -Force
} else {
  Move-Item -LiteralPath $stage -Destination $out
}

Write-Host "Web GUI ready: $out" -ForegroundColor Green
$global:LASTEXITCODE = 0
exit 0
