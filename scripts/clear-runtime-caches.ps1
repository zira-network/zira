param(
  [switch]$KeepModels = $true
)

# scripts/clear-runtime-caches.ps1
# Clear local runtime/cache state before a fresh launch. Heavy model folders are preserved by default.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$private = Join-Path $root "local-private"
$runtimeMainnet = Join-Path $private "runtime-mainnet"
$newUserTest = Join-Path $private "runtime-new-user-test"

if (Test-Path $newUserTest) {
  Remove-Item -LiteralPath $newUserTest -Recurse -Force
}

if (Test-Path (Join-Path $runtimeMainnet "logs")) {
  Remove-Item -LiteralPath (Join-Path $runtimeMainnet "logs") -Recurse -Force
}

$nodes = Join-Path $runtimeMainnet "nodes"
if (Test-Path $nodes) {
  Get-ChildItem -LiteralPath $nodes -Directory | ForEach-Object {
    Get-ChildItem -LiteralPath $_.FullName -Force | Where-Object {
      -not ($KeepModels -and $_.Name -eq "models")
    } | Remove-Item -Recurse -Force
  }
}

[pscustomobject]@{
  ok = $true
  runtime = $runtimeMainnet
  keptModels = [bool]$KeepModels
  message = "Runtime caches cleared. Model folders were preserved when present."
} | ConvertTo-Json -Depth 3
