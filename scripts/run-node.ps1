param(
  [switch]$SkipFirewall
)

# scripts/run-node.ps1
# Run a single ZIRA Core node on Windows. Set ZIRA_BOOTSTRAP to join an existing network.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path "$root\node\dist\index.js")) {
  Write-Host "Building node first..." -ForegroundColor Cyan
  Push-Location $root; pnpm build:node; Pop-Location
}
if (-not $SkipFirewall) {
  try {
    $p2pPort = if ($env:ZIRA_P2P_PORT) { [int]$env:ZIRA_P2P_PORT } else { 9645 }
    $wsPort = if ($env:ZIRA_WS_PORT) { [int]$env:ZIRA_WS_PORT } else { 9646 }
    & (Join-Path $PSScriptRoot "open-node-ports.ps1") -Ports @(
      $p2pPort,
      $wsPort
    ) -AutoElevate | Out-Host
    $public = & (Join-Path $PSScriptRoot "open-public-node-ports.ps1") -Ports @($p2pPort, $wsPort) | ConvertFrom-Json
    $public | ConvertTo-Json -Depth 6 | Out-Host
    if (-not $env:ZIRA_ANNOUNCE -and ($public.ok -or $public.mapped) -and $public.publicHost) {
      $env:ZIRA_ANNOUNCE = "/ip4/$($public.publicHost)/tcp/$p2pPort,/ip4/$($public.publicHost)/tcp/$wsPort/ws"
    } elseif (-not $public.ok) {
      Write-Host "Public TCP is not reachable yet, so this node will not advertise unreachable public seed addresses." -ForegroundColor Yellow
    }
  } catch {
    Write-Host "Automatic TCP setup skipped/failed. The node can still run locally; public reachability may require Administrator approval, router UPnP, or manual forwarding." -ForegroundColor Yellow
  }
}
node "$root\node\dist\index.js"
