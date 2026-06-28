param(
  [string]$Output = "..\zira",
  [string]$WindowsDist = "apps\desktop\dist",
  [string]$UbuntuDist = "apps\desktop\dist-ubuntu"
)

# scripts/prepare-launch.ps1
# Assemble a clean launch folder for GitHub source and release artifacts.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$out = [System.IO.Path]::GetFullPath((Join-Path $root $Output))
$stage = "$out.__staging_$PID"
$source = Join-Path $stage "source"
$release = Join-Path $stage "release"
$localPrivate = Join-Path $stage "local-private"
$winRelease = Join-Path $release "windows"
$ubuntuRelease = Join-Path $release "ubuntu"

$rootResolved = (Resolve-Path -LiteralPath $root).Path
$outParent = Split-Path -Parent $out
if (-not (Test-Path $outParent)) { New-Item -ItemType Directory -Force $outParent | Out-Null }
$outResolvedParent = (Resolve-Path -LiteralPath $outParent).Path
if ($out -eq $rootResolved -or $out.StartsWith((Join-Path $rootResolved "secrets"))) {
  throw "Refusing to write launch folder to an unsafe location: $out"
}
if (Test-Path $stage) {
  Remove-Item -LiteralPath $stage -Recurse -Force
}

New-Item -ItemType Directory -Force $source, $release, $localPrivate | Out-Null

$files = @(
  ".env.example",
  ".gitignore",
  "LICENSE",
  "README.md",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "zira-mark.svg",
  "Resume ZIRA.bat",
  "Start fresh from genesis.bat"
)

foreach ($file in $files) {
  $src = Join-Path $root $file
  if (Test-Path $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $source $file) -Force }
}

$launchRootFiles = @(
  "Resume ZIRA.bat",
  "Start fresh from genesis.bat"
)
foreach ($file in $launchRootFiles) {
  $src = Join-Path $root $file
  if (Test-Path $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $stage $file) -Force }
}

$dirs = @("apps", "docs", "node", "packages", "scripts")
foreach ($dir in $dirs) {
  $src = Join-Path $root $dir
  $dst = Join-Path $source $dir
  if (Test-Path $src) {
    robocopy $src $dst /MIR /XD node_modules dist dist-fresh dist-refined dist-ubuntu dist-linux public data .zira .git /XF FOUNDER.md new-founder.mjs *.tsbuildinfo *.log | Out-Host
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed for $dir with exit code $LASTEXITCODE" }
  }
}

$privateFiles = @(
  "ZIRA_FIELD_TESTING.dm",
  "ZIRA_LOCAL_MULTI_GUI_TESTING.dm",
  "ZIRA_PUBLIC_READY_TESTING.dm",
  "ZIRA_HANDOFF.md",
  "ZIRA_LOCAL_MAINNET_RUNBOOK.dm",
  "scripts\new-founder.mjs",
  "docs\FOUNDER.md"
)
foreach ($file in $privateFiles) {
  $src = Join-Path $root $file
  if (Test-Path $src) {
    $dst = Join-Path $localPrivate $file
    $dstDir = Split-Path -Parent $dst
    if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Force $dstDir | Out-Null }
    Copy-Item -LiteralPath $src -Destination $dst -Force
  }
}

$localPrivateSrc = Join-Path $root "local-private"
if (Test-Path $localPrivateSrc) {
  robocopy $localPrivateSrc $localPrivate /E /XD node_modules .git runtime-mainnet runtime-* logs nodes models launch-models /XF *.log identity.json peer-key.bin events.jsonl snapshot.json mining.json provider.json peers.json storage-peers.json founder-backups.json zti-history.jsonl | Out-Host
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed for local-private with exit code $LASTEXITCODE" }
}

$privateReadme = @(
  "# Local Private Files",
  "",
  "This folder is for the launch operator only. Do not upload it to GitHub Releases or public source.",
  "",
  "- Public source lives in ../source/.",
  "- Public release artifacts live in ../release/.",
  "- Private keys stay in the workspace secrets folder and are not copied here.",
  "- These notes are local runbooks and acceptance tests for operating the first network nodes."
)
$privateReadme | Set-Content -LiteralPath (Join-Path $localPrivate "README_LOCAL_ONLY.md") -Encoding UTF8

$winDistPath = Join-Path $root $WindowsDist
if (Test-Path $winDistPath) {
  New-Item -ItemType Directory -Force $winRelease | Out-Null
  $windowsExtensions = @(".exe", ".blockmap", ".yml")
  Get-ChildItem -LiteralPath $winDistPath -File | Where-Object { $_.Extension -in $windowsExtensions } | ForEach-Object {
    if ($_.Name -eq "builder-debug.yml") { return }
    Copy-Item -LiteralPath $_.FullName -Destination $winRelease -Force
  }
} else {
  Write-Warning "Windows release folder not found: $winDistPath"
}

$ubuntuDistPath = Join-Path $root $UbuntuDist
if (Test-Path $ubuntuDistPath) {
  $ubuntuExtensions = @(".AppImage", ".deb", ".blockmap", ".yml", ".zip")
  $ubuntuArtifacts = @(Get-ChildItem -LiteralPath $ubuntuDistPath -File | Where-Object { $_.Extension -in $ubuntuExtensions })
  if ($ubuntuArtifacts.Count -gt 0) { New-Item -ItemType Directory -Force $ubuntuRelease | Out-Null }
  $ubuntuArtifacts | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $ubuntuRelease -Force
  }
} else {
  Write-Warning "Ubuntu release folder not found: $ubuntuDistPath"
}

$manifest = Join-Path $stage "RELEASE_MANIFEST.txt"
$lines = @(
  "ZIRA launch folder",
  "Generated: $(Get-Date -Format o)",
  "",
  "Source: source/",
  "Public releases: release/",
  "Local private notes: local-private/ (do not upload)",
  "",
  "Checksums:"
)
Get-ChildItem -LiteralPath $release -Recurse -File | Sort-Object FullName | ForEach-Object {
  $hash = Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName
  $rel = $_.FullName.Substring($stage.Length + 1)
  $lines += "$($hash.Hash)  $rel"
}
$lines | Set-Content -LiteralPath $manifest -Encoding UTF8

if (Test-Path $out) {
  New-Item -ItemType Directory -Force $out | Out-Null
  Get-ChildItem -LiteralPath $stage -Force | ForEach-Object {
    $dst = Join-Path $out $_.Name
    if ($_.PSIsContainer) {
      robocopy $_.FullName $dst /MIR /R:2 /W:1 | Out-Host
      if ($LASTEXITCODE -ge 8) { throw "robocopy failed for launch output $($_.Name) with exit code $LASTEXITCODE" }
    } else {
      Copy-Item -LiteralPath $_.FullName -Destination $dst -Force
    }
  }
  Remove-Item -LiteralPath $stage -Recurse -Force
} else {
  Move-Item -LiteralPath $stage -Destination $out
}

Write-Host "Launch folder ready: $out" -ForegroundColor Green
$global:LASTEXITCODE = 0
exit 0
