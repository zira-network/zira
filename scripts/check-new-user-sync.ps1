param(
  [int]$RpcPort = 9045,
  [int]$P2pPort = 10045,
  [int]$WsPort = 10046,
  [int]$WaitAfterReadySec = 8,
  [int]$TimeoutSec = 30,
  [string]$RegistryUrl = "https://zira.network/bootstrap-seeds.json",
  [string]$DataDir = ""
)

# scripts/check-new-user-sync.ps1
# Simulates a fresh mainnet user who starts the node with automatic discovery only.
# No manual ZIRA_BOOTSTRAP value is supplied. The temporary node is stopped after the check.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$nodeEntry = Join-Path $root "node\dist\index.js"
if (-not (Test-Path $nodeEntry)) {
  throw "Node build not found at $nodeEntry. Run pnpm build:node first."
}

function Stop-PortOwners {
  param([int[]]$Ports)
  foreach ($port in $Ports) {
    $owners = @(Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -gt 0 } | Select-Object -ExpandProperty OwningProcess -Unique)
    foreach ($owner in $owners) {
      try { Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue } catch { # best effort cleanup
      }
    }
  }
}

function Stop-ProcessTree {
  param([int]$TargetProcessId)
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$TargetProcessId" -ErrorAction SilentlyContinue)
  foreach ($child in $children) {
    Stop-ProcessTree -TargetProcessId $child.ProcessId
  }
  try { Stop-Process -Id $TargetProcessId -Force -ErrorAction SilentlyContinue } catch { # process already exited
  }
}

Stop-PortOwners -Ports @($RpcPort, $P2pPort, $WsPort)

if (-not $DataDir) {
  $DataDir = Join-Path $root "local-private\runtime-new-user-test"
}
if (Test-Path $DataDir) {
  Remove-Item -LiteralPath $DataDir -Recurse -Force
}
New-Item -ItemType Directory -Force $DataDir | Out-Null

$log = Join-Path $DataDir "node.log"
$runner = Join-Path $DataDir "run.ps1"
$envMap = @{
  ZIRA_NETWORK = "mainnet"
  ZIRA_DATA_DIR = $DataDir
  ZIRA_RPC_PORT = "$RpcPort"
  ZIRA_P2P_PORT = "$P2pPort"
  ZIRA_WS_PORT = "$WsPort"
  ZIRA_SERVE_CONSOLE = "0"
  ZIRA_MINE = "0"
  ZIRA_STORAGE = "0"
  ZIRA_HARDWARE_DETECT = "0"
  ZIRA_BOOTSTRAP = ""
  ZIRA_BOOTSTRAP_AUTO = "1"
  ZIRA_BOOTSTRAP_REGISTRY_PATH = ""
  ZIRA_BOOTSTRAP_REGISTRY_URL = $RegistryUrl
  ZIRA_RESET = "1"
  ZIRA_LOG_LEVEL = "info"
}

$lines = @(
  '$ErrorActionPreference = "Stop"',
  "Set-Location '$root'"
)
foreach ($key in $envMap.Keys) {
  $value = [string]$envMap[$key]
  $escaped = $value.Replace("'", "''")
  $lines += "`$env:$key = '$escaped'"
}
$lines += "& node '$nodeEntry' *>&1 | Tee-Object -FilePath '$log'"
$lines | Set-Content -LiteralPath $runner -Encoding UTF8

$proc = Start-Process -FilePath "powershell" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $runner) -PassThru -WindowStyle Hidden
try {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $net = $null
  while ((Get-Date) -lt $deadline) {
    try {
      if (Test-Path $log) {
        $currentLog = Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue
        if ($currentLog -match "ERROR fatal|EADDRINUSE") {
          throw "Temporary node failed to start. See $log"
        }
      }
      $net = Invoke-RestMethod -Uri "http://127.0.0.1:$RpcPort/rpc/net" -TimeoutSec 2
      break
    } catch {
      if ($_.Exception.Message -like "Temporary node failed*") { throw }
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $net) {
    throw "Temporary node RPC did not become ready on port $RpcPort."
  }

  Start-Sleep -Seconds $WaitAfterReadySec
  $net = Invoke-RestMethod -Uri "http://127.0.0.1:$RpcPort/rpc/net" -TimeoutSec 5
  $status = Invoke-RestMethod -Uri "http://127.0.0.1:$RpcPort/rpc/status" -TimeoutSec 5
  $registryPath = Join-Path $root "docs\bootstrap-seeds.json"
  $registry = if (Test-Path $registryPath) { Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json } else { $null }
  $remoteRegistry = $null
  $remoteRegistryError = ""
  if ($RegistryUrl) {
    try {
      $remoteRegistry = Invoke-RestMethod -Uri $RegistryUrl -TimeoutSec 10
    } catch {
      $remoteRegistryError = $_.Exception.Message
    }
  }
  $remoteSeedCount = if ($remoteRegistry -and $remoteRegistry.seeds) { @($remoteRegistry.seeds).Count } else { 0 }
  $localSeedCount = if ($registry -and $registry.seeds) { @($registry.seeds).Count } else { 0 }
  $registrySeedCount = [Math]::Max($remoteSeedCount, $localSeedCount)
  $logText = if (Test-Path $log) { Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue } else { "" }

  [pscustomobject]@{
    ok = [bool]($net.peers -gt 0 -and $registrySeedCount -gt 0)
    simulated = "fresh-mainnet-user-no-manual-bootstrap"
    registryUrl = $RegistryUrl
    remoteRegistrySeeds = $remoteSeedCount
    remoteRegistryError = $remoteRegistryError
    bundledRegistrySeeds = $localSeedCount
    registrySeeds = $registrySeedCount
    peers = [int]$net.peers
    savedPeers = @($net.savedPeers).Count
    addrs = @($net.addrs)
    network = $status.network
    epoch = $status.epoch
    conclusion = if ($net.peers -gt 0 -and $registrySeedCount -gt 0) {
      "A clean user node found peers through automatic registry discovery."
    } elseif ($net.peers -gt 0) {
      "The node found a peer, but no public registry seed was visible. Treat this as local/test discovery, not proof that a far-away user can sync."
    } else {
      "A clean user node did not find peers automatically. Publish at least one reachable seed in the signed bootstrap registry URL."
    }
    logTail = (($logText -split "`r?`n") | Select-Object -Last 12)
  } | ConvertTo-Json -Depth 6
} finally {
  Stop-ProcessTree -TargetProcessId $proc.Id
  Stop-PortOwners -Ports @($RpcPort, $P2pPort, $WsPort)
}
