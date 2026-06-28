param(
  [string]$ConsoleDir = "",
  [switch]$NoReset,
  [switch]$EnableMining,
  [switch]$EnableProvider,
  [string]$ProviderEndpoint = "http://127.0.0.1:11434/v1",
  [string]$ProviderModel = "qwen2.5-coder:14b",
  [string]$ProviderLabel = "zira-ollama",
  [string]$PublicHost = "",
  [string]$PublicHostType = "ip4",
  [int]$PublicP2pPort = 9645,
  [int]$PublicWsPort = 9646,
  [switch]$SkipFirewall,
  [string]$JoinBootstrap = "",
  [switch]$StewardOnly
)

# scripts/launch-mainnet-fresh.ps1
# Launch a fresh local mainnet mesh:
# - 8645/9645 bootstrap + Console + default 1GB storage
# - 8745/9745 storage peer with 40GB storage for the first GGUF models
# - 8845/9845 coordinator peer with default 1GB storage
# - 8945/9945 observer/storage peer with default 1GB storage
# Mining is off by default. Pass -EnableMining when this machine should actively mine.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
if (-not $PublicHost -and $env:ZIRA_PUBLIC_HOST) { $PublicHost = $env:ZIRA_PUBLIC_HOST }
if ($env:ZIRA_PUBLIC_HOST_TYPE) { $PublicHostType = $env:ZIRA_PUBLIC_HOST_TYPE }
if ($env:ZIRA_PUBLIC_P2P_PORT) { $PublicP2pPort = [int]$env:ZIRA_PUBLIC_P2P_PORT }
if ($env:ZIRA_PUBLIC_WS_PORT) { $PublicWsPort = [int]$env:ZIRA_PUBLIC_WS_PORT }
$nodeEntry = Join-Path $root "node\dist\index.js"
if (-not (Test-Path $nodeEntry)) {
  Push-Location $root
  pnpm build:node
  Pop-Location
}

if (-not $SkipFirewall) {
  try {
    & (Join-Path $PSScriptRoot "open-node-ports.ps1") -MainnetMesh -AutoElevate | Out-Host
    $publicPorts = & (Join-Path $PSScriptRoot "open-public-node-ports.ps1") -MainnetMesh -PublicHost $PublicHost | ConvertFrom-Json
    $publicPorts | ConvertTo-Json -Depth 6 | Out-Host
    if (-not $PublicHost -and ($publicPorts.ok -or $publicPorts.mapped) -and $publicPorts.publicHost) {
      $PublicHost = [string]$publicPorts.publicHost
      $PublicHostType = "ip4"
    } elseif (-not $publicPorts.ok) {
      Write-Host "Public TCP is not reachable yet, so launch will not auto-advertise unreachable public seed addresses." -ForegroundColor Yellow
    }
  } catch {
    Write-Host "Automatic TCP setup skipped/failed. Mainnet will run locally; public reachability may require Administrator approval, router UPnP, or manual forwarding." -ForegroundColor Yellow
  }
}

if (-not $ConsoleDir) {
  $builtConsole = Join-Path $root "apps\console\dist"
  $bundledConsole = Join-Path $root "node\public"
  if (Test-Path $builtConsole) { $ConsoleDir = $builtConsole }
  else { $ConsoleDir = $bundledConsole }
}

& (Join-Path $PSScriptRoot "stop-zira-ports.ps1")

$runtime = Join-Path $root "local-private\runtime-mainnet"
$logs = Join-Path $runtime "logs"
$nodes = Join-Path $runtime "nodes"
New-Item -ItemType Directory -Force $logs, $nodes | Out-Null

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

function Wait-ForLog {
  param(
    [string]$Log,
    [string]$Pattern,
    [int]$TimeoutSec = 90
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path $Log) {
      $text = Get-Content -LiteralPath $Log -Raw -ErrorAction SilentlyContinue
      if ($text -match "ERROR fatal|EADDRINUSE") { throw "Node failed to start. See $Log" }
      if ($text -match $Pattern) { return $matches }
    }
    Start-Sleep -Milliseconds 500
  }
  throw "Timed out waiting for '$Pattern' in $Log"
}

function Wait-ForRpc {
  param([int]$Port)
  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline) {
    try {
      return Invoke-RestMethod "http://127.0.0.1:$Port/rpc/status"
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  throw "RPC did not become ready on port $Port"
}

$reset = if ($NoReset) { "0" } else { "1" }
$publicAnnounce = @()
if ($PublicHost) {
  $cleanPublicHost = $PublicHost.Trim()
  $publicAnnounce += "/$PublicHostType/$cleanPublicHost/tcp/$PublicP2pPort"
  if ($PublicWsPort -gt 0) { $publicAnnounce += "/$PublicHostType/$cleanPublicHost/tcp/$PublicWsPort/ws" }
}
# Autonomous coordination is a low-priority background process. Keep it light so it never
# starves real user/Console queries on a single shared inference endpoint: a small batch on a
# slow cycle. Operators with more inference capacity can raise these.
$coordinationEnv = @{
  ZIRA_TASK_REAP_MS = "5000"
  ZIRA_AUTONOMOUS_RESONANCE_CYCLE_MS = "120000"
  ZIRA_AUTONOMOUS_RESONANCE_SETTLE_MS = "30000"
  ZIRA_AUTONOMOUS_RESONANCE_MIN_ANSWERS = "1"
  ZIRA_AUTONOMOUS_RESONANCE_MAX_PER_CYCLE = "1"
  ZIRA_AUTONOMOUS_RESONANCE_TASK_UZIR = "1000000"
}
$bootstrapData = Join-Path $nodes "bootstrap"
$bootstrapEnv = @{
  ZIRA_NETWORK = "mainnet"
  ZIRA_RESET = $reset
  ZIRA_DATA_DIR = $bootstrapData
  ZIRA_RPC_PORT = "8645"
  ZIRA_P2P_PORT = "9645"
  ZIRA_WS_PORT = "9646"
  ZIRA_SERVE_CONSOLE = "1"
  ZIRA_CONSOLE_DIR = $ConsoleDir
  ZIRA_MINE = "0"
  ZIRA_KEEP_MODELS = "1"
  ZIRA_LOCAL_TASKS = "0"
  ZIRA_STORAGE = "1"
  ZIRA_STORAGE_GB = "1"
  ZIRA_EVENTS_KEY = $env:ZIRA_EVENTS_KEY
  ZIRA_EVENTS_CLAIM_ZIR = "10"
  ZIRA_ANCHOR_RESERVE_KEY = $env:ZIRA_ANCHOR_RESERVE_KEY
} + $coordinationEnv
if ($publicAnnounce.Count -gt 0) {
  $bootstrapEnv.ZIRA_ANNOUNCE = ($publicAnnounce -join ",")
}
# Join an existing network (e.g. the public VPS backbone) so this keyed steward/bootstrap node peers
# with it and provides single-master finality, WITHOUT putting any key on that remote backbone.
if ($JoinBootstrap) { $bootstrapEnv.ZIRA_BOOTSTRAP = $JoinBootstrap }
$bootstrapLog = Start-Role -Name "bootstrap" -Env $bootstrapEnv

$peerMatch = Wait-ForLog -Log $bootstrapLog -Pattern "libp2p peer id (\S+)"
$peerId = $peerMatch[1]
$bootstrap = "/ip4/127.0.0.1/tcp/9645/p2p/$peerId"
$lanIp = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } | Select-Object -First 1 -ExpandProperty IPAddress
$lanBootstrap = if ($lanIp) { "/ip4/$lanIp/tcp/9645/p2p/$peerId" } else { "" }
$publicBootstrap = if ($PublicHost) { "/$PublicHostType/$cleanPublicHost/tcp/$PublicP2pPort/p2p/$peerId" } else { "" }
Wait-ForRpc -Port 8645 | Out-Null
if ($publicBootstrap) {
  Push-Location $root
  try {
    $registryOut = pnpm seed:bootstrap-registry "--seed=$publicBootstrap" "--output=docs/bootstrap-seeds.json" "--label=Official ZIRA bootstrap seed" 2>&1
    if ($LASTEXITCODE -ne 0) { throw "seed:bootstrap-registry failed with exit code $LASTEXITCODE" }
    Write-Host "Signed bootstrap registry refreshed for the configured public seed." -ForegroundColor Green
  } catch {
    Write-Host "Signed bootstrap registry was not refreshed. Open/forward TCP $PublicP2pPort and make sure a launch-authority private key is available, then run pnpm seed:bootstrap-registry." -ForegroundColor Yellow
  } finally {
    Pop-Location
  }
}

$minerOn = if ($EnableMining) { "1" } else { "0" }
$workspaceTasksOn = if ($EnableMining) { "1" } else { "0" }
$roles = @(
  @{
    Name = "storage-peer"; Rpc = "8745"; P2p = "9745"; Ws = "9746"; Mine = $minerOn; StorageGb = "40"; LocalTasks = $workspaceTasksOn
  },
  @{
    Name = "coordinator-peer"; Rpc = "8845"; P2p = "9845"; Ws = "9846"; Mine = $minerOn; StorageGb = "1"; LocalTasks = $workspaceTasksOn
  },
  @{
    Name = "observer-storage"; Rpc = "8945"; P2p = "9945"; Ws = "9946"; Mine = "0"; StorageGb = "1"; LocalTasks = "0"
  }
)
# Steward-only: run just the keyed bootstrap node (the master that finalizes), no extra local peers.
# Used when the public backbone lives elsewhere (e.g. the VPS) and this machine only provides finality.
if ($StewardOnly) { $roles = @() }

foreach ($role in $roles) {
  $data = Join-Path $nodes $role.Name
  $roleEnv = @{
    ZIRA_NETWORK = "mainnet"
    ZIRA_RESET = $reset
    ZIRA_DATA_DIR = $data
    ZIRA_RPC_PORT = $role.Rpc
    ZIRA_P2P_PORT = $role.P2p
    ZIRA_WS_PORT = $role.Ws
    ZIRA_BOOTSTRAP = $bootstrap
    ZIRA_SERVE_CONSOLE = "0"
    ZIRA_MINE = $role.Mine
    ZIRA_KEEP_MODELS = "1"
    ZIRA_STORAGE = "1"
    ZIRA_STORAGE_GB = $role.StorageGb
    ZIRA_LOCAL_TASKS = $role.LocalTasks
    ZIRA_FOUNDER_KEY = ""
    ZIRA_FOUNDER_ADDRESS = ""
  } + $coordinationEnv
  if ($EnableMining -and $EnableProvider -and $role.Mine -eq "1") {
    $roleEnv.ZIRA_PROVIDE = "1"
    $roleEnv.ZIRA_PROVIDE_ENDPOINT = $ProviderEndpoint
    $roleEnv.ZIRA_PROVIDE_MODEL = $ProviderModel
    $roleEnv.ZIRA_PROVIDE_LABEL = $ProviderLabel
  }
  $log = Start-Role -Name $role.Name -Env $roleEnv
  Wait-ForLog -Log $log -Pattern "ZIRA node up" | Out-Null
  Wait-ForRpc -Port ([int]$role.Rpc) | Out-Null
}

Start-Sleep -Seconds 2
$summary = @()
$summaryPorts = if ($StewardOnly) { @(8645) } else { @(8645, 8745, 8845, 8945) }
foreach ($port in $summaryPorts) {
  $status = Invoke-RestMethod "http://127.0.0.1:$port/rpc/status"
  $stats = Invoke-RestMethod "http://127.0.0.1:$port/rpc/stats"
  $anchors = Invoke-RestMethod "http://127.0.0.1:$port/rpc/anchors"
  $models = Invoke-RestMethod "http://127.0.0.1:$port/rpc/models"
  $summary += [pscustomobject]@{
    port = $port
    peers = $stats.peers
    anchors = $anchors.Count
    founder = $status.isFounder
    mining = $status.mining.enabled
    storage = $status.mining.storageEnabled
    storageGb = $status.mining.storageLimitGb
    localTasks = $status.mining.localTaskPermission
    serving = $status.mining.serving
    models = $models.Count
  }
}

Write-Host "Fresh mainnet launched." -ForegroundColor Green
Write-Host "Local-only loopback bootstrap: configured for the local mesh"
if ($lanBootstrap) { Write-Host "Local-only LAN bootstrap:      available but hidden from console output" }
if ($publicBootstrap) {
  Write-Host "Public bootstrap:   configured and hidden from console output" -ForegroundColor Green
  Write-Host "Remote users can reach this only if TCP $PublicP2pPort is forwarded/open to this machine. TCP $PublicWsPort is used for WebSocket peers when opened." -ForegroundColor Yellow
} else {
  Write-Host "Public bootstrap:   not configured. Remote users cannot reach loopback/LAN addresses; restart with -PublicHost <public-ip-or-dns> after opening TCP $PublicP2pPort." -ForegroundColor Yellow
}
$summary | Format-Table -AutoSize
if (-not $summary[0].founder) {
  Write-Host "Founder Resonator path: inactive. Set ZIRA_FOUNDER_KEY for the bootstrap node to publish the default ZIRA Resonator and authorize model launch actions." -ForegroundColor Yellow
}
