param(
  [string]$Rpc = "http://127.0.0.1:8645",
  [string]$PublicHost = "",
  [int]$PublicP2pPort = 9645
)

# scripts/check-public-bootstrap.ps1
# Best-effort bootstrap readiness check. A public TCP failure usually means the router/firewall
# still needs port forwarding, or the local network does not support hairpin NAT.
$ErrorActionPreference = "Stop"

if (-not $PublicHost -and $env:ZIRA_PUBLIC_HOST) { $PublicHost = $env:ZIRA_PUBLIC_HOST }
if ($env:ZIRA_PUBLIC_P2P_PORT) { $PublicP2pPort = [int]$env:ZIRA_PUBLIC_P2P_PORT }
if (-not $PublicHost) {
  try { $PublicHost = (Invoke-RestMethod -Uri "https://api.ipify.org" -TimeoutSec 10).Trim() }
  catch { $PublicHost = "" }
}

$net = Invoke-RestMethod -Uri "$Rpc/rpc/net" -TimeoutSec 8
$localListeners = @(Get-NetTCPConnection -LocalPort $PublicP2pPort -ErrorAction SilentlyContinue | Where-Object {
  $_.OwningProcess -gt 0 -and $_.State -eq "Listen"
})
$tcp = $null
if ($PublicHost) {
  $tcp = Test-NetConnection -ComputerName $PublicHost -Port $PublicP2pPort -WarningAction SilentlyContinue
}

$publicMultiaddr = if ($PublicHost -and $net.peerId) { "/ip4/$PublicHost/tcp/$PublicP2pPort/p2p/$($net.peerId)" } else { "" }
$announcedPublic = @($net.addrs | Where-Object { $_ -like "*/$PublicHost/tcp/$PublicP2pPort/p2p/*" -or $_ -like "/ip4/$PublicHost/tcp/$PublicP2pPort/*" -or $_ -like "/dns4/$PublicHost/tcp/$PublicP2pPort/*" })
$mappingPath = if ($env:ZIRA_PUBLIC_MAPPING_PATH) { $env:ZIRA_PUBLIC_MAPPING_PATH } else { Join-Path (Split-Path -Parent $PSScriptRoot) "local-private\public-port-mapping.json" }
$mappingAccepted = $false
if (Test-Path $mappingPath) {
  try {
    $mapping = Get-Content -LiteralPath $mappingPath -Raw | ConvertFrom-Json
    $mappingAccepted = [bool](@($mapping.results | Where-Object { $_.port -eq $PublicP2pPort -and $_.mapped }).Count -gt 0 -and (-not $mapping.publicHost -or $mapping.publicHost -eq $PublicHost))
  } catch {}
}
$ok = [bool]($localListeners.Count -gt 0 -and ($tcp -and $tcp.TcpTestSucceeded -or $mappingAccepted))

[pscustomobject]@{
  ok = $ok
  publicHost = $PublicHost
  publicP2pPort = $PublicP2pPort
  peerId = $net.peerId
  publicMultiaddr = $publicMultiaddr
  localListening = $localListeners.Count -gt 0
  announcedPublic = @($announcedPublic)
  tcpTestSucceeded = if ($tcp) { [bool]$tcp.TcpTestSucceeded } else { $false }
  mappingAccepted = $mappingAccepted
  note = if ($tcp -and $tcp.TcpTestSucceeded) {
    "Public TCP check succeeded from this machine."
  } elseif ($mappingAccepted) {
    "Router accepted the public TCP mapping. This LAN may not support hairpin NAT, so ask an outside network to confirm the public multiaddr."
  } else {
    "Node is not publicly reachable yet from this check. Open/forward TCP $PublicP2pPort to this PC, allow it in Windows Firewall, and ask an outside network to test the public multiaddr."
  }
} | ConvertTo-Json -Depth 5
