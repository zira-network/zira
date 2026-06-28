param(
  [string]$Rpc = "http://127.0.0.1:8645",
  [string]$PublicHost = "",
  [string]$PublicHostType = "ip4",
  [int]$PublicP2pPort = 9645,
  [string[]]$Seed = @(),
  [string]$Roles = "bootstrap,community-seed,master-candidate",
  [int]$MasterCount = 1,
  [string]$Output = "",
  [switch]$AllowUnreachable
)

# scripts/prepare-bootstrap-upload.ps1
# Builds the signed bootstrap registry that should be uploaded to:
# https://zira.network/bootstrap-seeds.json
#
# The generated file lives in local-private by default so public IP seed material is not committed
# into docs/source/release by accident.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
if (-not $Output) {
  $Output = Join-Path $root "local-private\bootstrap-seeds.wordpress-upload.json"
}
New-Item -ItemType Directory -Force (Split-Path -Parent $Output) | Out-Null

$seeds = @($Seed | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() })
if ($seeds.Count -eq 0) {
  if (-not $PublicHost -and $env:ZIRA_PUBLIC_HOST) { $PublicHost = $env:ZIRA_PUBLIC_HOST }
  if ($env:ZIRA_PUBLIC_HOST_TYPE) { $PublicHostType = $env:ZIRA_PUBLIC_HOST_TYPE }
  if ($env:ZIRA_PUBLIC_P2P_PORT) { $PublicP2pPort = [int]$env:ZIRA_PUBLIC_P2P_PORT }
  if (-not $PublicHost) {
    try { $PublicHost = (Invoke-RestMethod -Uri "https://api.ipify.org" -TimeoutSec 10).Trim() }
    catch { throw "Could not detect a public IP. Pass -PublicHost <ip-or-host> or -Seed <multiaddr>." }
  }

  $net = Invoke-RestMethod -Uri "$Rpc/rpc/net" -TimeoutSec 8
  if (-not $net.peerId) { throw "Node RPC did not return a peerId from $Rpc/rpc/net." }
  $seeds = @("/$PublicHostType/$PublicHost/tcp/$PublicP2pPort/p2p/$($net.peerId)")
}

Push-Location $root
try {
  $args = @(
    "scripts/seed-bootstrap-registry.mjs",
    "--seeds=$($seeds -join ',')",
    "--output=$Output",
    "--label=Official ZIRA bootstrap seed",
    "--roles=$Roles",
    "--master-count=$MasterCount",
    "--master-roles=master,bootstrap,community-seed"
  )
  if ($AllowUnreachable) { $args += "--allow-unreachable" }
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $raw = & node @args 2>&1
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorActionPreference
  if ($exitCode -ne 0) {
    $parsed = $null
    try { $parsed = ($raw | Out-String | ConvertFrom-Json) } catch { # keep fallback message
    }
    [pscustomobject]@{
      ok = $false
      output = $Output
      uploadUrl = "https://zira.network/bootstrap-seeds.json"
      message = if ($parsed -and $parsed.message) { $parsed.message } else { "Could not prepare bootstrap registry." }
      seeds = $seeds
      checks = if ($parsed -and $parsed.checks) { $parsed.checks } else { @() }
      nextStep = "Open/forward TCP for each seed to its node and allow it in the firewall. Re-run this command after public reachability passes."
    } | ConvertTo-Json -Depth 6
    exit $exitCode
  }
} finally {
  Pop-Location
}

$registry = Get-Content -LiteralPath $Output -Raw | ConvertFrom-Json
$checks = if ($raw) {
  try { ($raw | Out-String | ConvertFrom-Json).checks } catch { @() }
} else { @() }

[pscustomobject]@{
  ok = $true
  output = $Output
  uploadUrl = "https://zira.network/bootstrap-seeds.json"
  seeds = @($registry.seeds).Count
  seedMultiaddrs = @($registry.seeds | ForEach-Object { $_.multiaddr })
  signer = $registry.pubKey
  tcpChecks = $checks
  nextStep = "Upload this JSON file as the raw contents of https://zira.network/bootstrap-seeds.json, then run pnpm check:new-user-sync."
} | ConvertTo-Json -Depth 6
