param(
  [string]$Bootstrap = "",
  [switch]$EnableMining,
  [switch]$EnableProvider,
  [string]$ProviderEndpoint = "http://127.0.0.1:11434/v1",
  [string]$ProviderModel = "qwen2.5-coder:14b",
  [string]$ProviderLabel = "zira-extra-ollama"
)

# scripts/launch-extra-mainnet-nodes.ps1
# Add non-founder mainnet roles to the existing local launch mesh without resetting state.
# Mining and endpoint providers are off by default. Pass -EnableMining, and optionally
# -EnableProvider, when this machine should actively mine/answer.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$nodeEntry = Join-Path $root "node\dist\index.js"
if (-not (Test-Path $nodeEntry)) {
  Push-Location $root
  pnpm build:node
  Pop-Location
}

$runtime = Join-Path $root "local-private\runtime-mainnet"
$logs = Join-Path $runtime "logs"
$nodes = Join-Path $runtime "nodes"
New-Item -ItemType Directory -Force $logs, $nodes | Out-Null

if (-not $Bootstrap) {
  $net = Invoke-RestMethod "http://127.0.0.1:8645/rpc/net"
  $Bootstrap = "/ip4/127.0.0.1/tcp/9645/p2p/$($net.peerId)"
}

function Write-Runner {
  param(
    [string]$Name,
    [hashtable]$Env
  )
  $runner = Join-Path $runtime "$Name.ps1"
  $log = Join-Path $logs "$Name.log"
  $lines = @(
    '$ErrorActionPreference = "Stop"',
    "Set-Location '$root'"
  )
  foreach ($key in $Env.Keys) {
    $value = [string]$Env[$key]
    $escaped = $value.Replace("'", "''")
    $lines += "`$env:$key = '$escaped'"
  }
  $lines += "& node '$nodeEntry' *>&1 | Tee-Object -FilePath '$log'"
  $lines | Set-Content -LiteralPath $runner -Encoding UTF8
  return @{ Runner = $runner; Log = $log }
}

function Start-Role {
  param(
    [string]$Name,
    [hashtable]$Env
  )
  $files = Write-Runner -Name $Name -Env $Env
  if (Test-Path $files.Log) { Remove-Item -LiteralPath $files.Log -Force }
  Start-Process -FilePath "powershell" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $files.Runner) -WindowStyle Hidden | Out-Null
  return $files.Log
}

function Wait-ForRpc {
  param([int]$Port)
  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline) {
    try { return Invoke-RestMethod "http://127.0.0.1:$Port/rpc/status" }
    catch { Start-Sleep -Milliseconds 500 }
  }
  throw "RPC did not become ready on port $Port"
}

$minerOn = if ($EnableMining) { "1" } else { "0" }
$workspaceTasksOn = if ($EnableMining) { "1" } else { "0" }
$roles = @(
  @{ Name = "analysis-peer"; Rpc = "9045"; P2p = "10045"; Ws = "10046"; Mine = $minerOn; StorageGb = "8"; LocalTasks = $workspaceTasksOn; Provide = "1"; Label = "$ProviderLabel-analysis" },
  @{ Name = "resonance-peer"; Rpc = "9145"; P2p = "10145"; Ws = "10146"; Mine = $minerOn; StorageGb = "8"; LocalTasks = $workspaceTasksOn; Provide = "1"; Label = "$ProviderLabel-resonance" },
  @{ Name = "archive-storage"; Rpc = "9245"; P2p = "10245"; Ws = "10246"; Mine = "0"; StorageGb = "40"; LocalTasks = "0"; Provide = "0"; Label = "archive-storage" },
  @{ Name = "observer-relay"; Rpc = "9345"; P2p = "10345"; Ws = "10346"; Mine = $minerOn; StorageGb = "2"; LocalTasks = $workspaceTasksOn; Provide = "0"; Label = "observer-relay" }
)

$started = @()
foreach ($role in $roles) {
  try {
    Invoke-RestMethod "http://127.0.0.1:$($role.Rpc)/rpc/status" -TimeoutSec 2 | Out-Null
    $started += [pscustomobject]@{ name = $role.Name; port = [int]$role.Rpc; status = "already online" }
    continue
  } catch {
    # Expected when the role is not running yet.
  }

  $data = Join-Path $nodes $role.Name
  $env = @{
    ZIRA_NETWORK = "mainnet"
    ZIRA_RESET = "0"
    ZIRA_FAST_SYNC = "1"
    ZIRA_DATA_DIR = $data
    ZIRA_RPC_PORT = $role.Rpc
    ZIRA_P2P_PORT = $role.P2p
    ZIRA_WS_PORT = $role.Ws
    ZIRA_BOOTSTRAP = $Bootstrap
    ZIRA_SERVE_CONSOLE = "0"
    ZIRA_MINE = $role.Mine
    ZIRA_STORAGE = "1"
    ZIRA_STORAGE_GB = $role.StorageGb
    ZIRA_LOCAL_TASKS = $role.LocalTasks
    ZIRA_FOUNDER_KEY = ""
    ZIRA_FOUNDER_ADDRESS = ""
  }
  if ($EnableMining -and $EnableProvider -and $role.Provide -eq "1") {
    $env.ZIRA_PROVIDE = "1"
    $env.ZIRA_PROVIDE_ENDPOINT = $ProviderEndpoint
    $env.ZIRA_PROVIDE_MODEL = $ProviderModel
    $env.ZIRA_PROVIDE_LABEL = $role.Label
  }

  Start-Role -Name $role.Name -Env $env | Out-Null
  Wait-ForRpc -Port ([int]$role.Rpc) | Out-Null
  $started += [pscustomobject]@{ name = $role.Name; port = [int]$role.Rpc; status = "started" }
}

Start-Sleep -Seconds 3
$summary = @()
foreach ($port in @(9045, 9145, 9245, 9345)) {
  try {
    $status = Invoke-RestMethod "http://127.0.0.1:$port/rpc/status" -TimeoutSec 5
    $models = Invoke-RestMethod "http://127.0.0.1:$port/rpc/models" -TimeoutSec 5
    $summary += [pscustomobject]@{
      port = $port
      address = $status.address
      founder = $status.isFounder
      mining = $status.mining.enabled
      serving = $status.mining.serving
      storage = $status.mining.storageEnabled
      storageGb = $status.mining.storageLimitGb
      localTasks = $status.mining.localTaskPermission
      providerReachable = $status.providerStatus.reachable
      models = @($models).Count
    }
  } catch {
    $summary += [pscustomobject]@{ port = $port; error = $_.Exception.Message }
  }
}

[pscustomobject]@{ ok = $true; bootstrap = $Bootstrap; started = $started; summary = $summary } | ConvertTo-Json -Depth 5
