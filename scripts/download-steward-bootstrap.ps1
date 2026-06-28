param(
  [string]$StewardRpc = "http://127.0.0.1:8645",
  [string]$PublicHost = "",
  [string]$PublicHostType = "ip4",
  [int[]]$RpcPorts = @(8645, 8745, 8845, 8945),
  [int[]]$P2pPorts = @(9645, 9745, 9845, 9945),
  [string]$Output = "",
  [switch]$AllowUnreachable
)

# scripts/download-steward-bootstrap.ps1
# Founder/steward helper: build a signed bootstrap registry from the active local mainnet mesh.
# The output is written under local-private by default, ready to upload as:
# https://zira.network/bootstrap-seeds.json
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
if (-not $Output) {
  $Output = Join-Path $root "local-private\bootstrap-seeds.wordpress-upload.json"
}
if (-not $PublicHost -and $env:ZIRA_PUBLIC_HOST) { $PublicHost = $env:ZIRA_PUBLIC_HOST }
if ($env:ZIRA_PUBLIC_HOST_TYPE) { $PublicHostType = $env:ZIRA_PUBLIC_HOST_TYPE }
if (-not $PublicHost) {
  try { $PublicHost = (Invoke-RestMethod -Uri "https://api.ipify.org" -TimeoutSec 10).Trim() }
  catch { throw "Could not detect a public IP. Pass -PublicHost <ip-or-host>." }
}

$seedList = New-Object System.Collections.Generic.List[string]
$livePeerByPort = @{}
$liveMeshSeeds = New-Object System.Collections.Generic.List[string]

function Get-MultiaddrPort {
  param([string]$Multiaddr)
  $m = [regex]::Match($Multiaddr, '/tcp/(\d+)')
  if ($m.Success) { return [int]$m.Groups[1].Value }
  return $null
}

function Get-MultiaddrPeerId {
  param([string]$Multiaddr)
  $m = [regex]::Match($Multiaddr, '/p2p/([^/]+)')
  if ($m.Success) { return [string]$m.Groups[1].Value }
  return ""
}

for ($i = 0; $i -lt $RpcPorts.Count; $i++) {
  $rpcPort = $RpcPorts[$i]
  $p2pPort = if ($i -lt $P2pPorts.Count) { $P2pPorts[$i] } else { $P2pPorts[0] + ($i * 100) }
  try {
    $net = Invoke-RestMethod -Uri "http://127.0.0.1:$rpcPort/rpc/net" -TimeoutSec 5
    if ($net.peerId) {
      $livePeerByPort[$p2pPort] = [string]$net.peerId
      $seed = "/$PublicHostType/$PublicHost/tcp/$p2pPort/p2p/$($net.peerId)"
      if (-not $liveMeshSeeds.Contains($seed)) { $liveMeshSeeds.Add($seed) }
    }
  } catch {
    # Ignore inactive local launch roles.
  }
}

# Ask the steward for its candidate view first. This includes connected/saved/storage candidates and
# marks the public steward self-address when PublicHost is supplied.
try {
  $stewardUrl = "$StewardRpc/rpc/founder/bootstrap-candidates?publicHost=$([uri]::EscapeDataString($PublicHost))&publicHostType=$([uri]::EscapeDataString($PublicHostType))&publicP2pPort=$($P2pPorts[0])&scanLocalMesh=1&meshRpcPorts=$([uri]::EscapeDataString(($RpcPorts -join ',')))&meshP2pPorts=$([uri]::EscapeDataString(($P2pPorts -join ',')))"
  $candidateView = Invoke-RestMethod -Uri $stewardUrl -TimeoutSec 8
  foreach ($candidate in @($candidateView.candidates)) {
    if ($candidate.shareable -and $candidate.multiaddr -and -not $seedList.Contains([string]$candidate.multiaddr)) {
      $candidatePort = Get-MultiaddrPort([string]$candidate.multiaddr)
      $candidatePeer = Get-MultiaddrPeerId([string]$candidate.multiaddr)
      if ($candidatePort -and $livePeerByPort.ContainsKey($candidatePort) -and $livePeerByPort[$candidatePort] -ne $candidatePeer) {
        continue
      }
      $seedList.Add([string]$candidate.multiaddr)
    }
  }
} catch {
  # Fall back to the explicit local mesh port scan below.
}

$liveMeshSeeds | ForEach-Object {
  if (-not $seedList.Contains($_)) { $seedList.Add($_) }
}

if ($seedList.Count -eq 0) {
  throw "No active local steward/mainnet nodes returned peer IDs."
}

if ($AllowUnreachable) {
  & (Join-Path $PSScriptRoot "prepare-bootstrap-upload.ps1") -Rpc $StewardRpc -Output $Output -Roles "bootstrap,community-seed,master-candidate" -MasterCount 1 -Seed $seedList.ToArray() -AllowUnreachable
} else {
  & (Join-Path $PSScriptRoot "prepare-bootstrap-upload.ps1") -Rpc $StewardRpc -Output $Output -Roles "bootstrap,community-seed,master-candidate" -MasterCount 1 -Seed $seedList.ToArray()
}
exit $LASTEXITCODE
