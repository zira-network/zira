param(
  [string]$Rpc = "http://127.0.0.1:8645",
  [int[]]$Ports = @(8645, 8745, 8845, 8945),
  [string[]]$LaunchModelUrls = @(
    "https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q8_0.gguf"
  ),
  [switch]$SmokeQuery,
  [int]$SmokeWaitSeconds = 30
)

# scripts/check-field-readiness.ps1
# Full operator status check for the launch field: nodes, storage, models, providers,
# Resonators, and optional query coordination. It is read-only unless -SmokeQuery is set.
$ErrorActionPreference = "Stop"

function Read-JsonArray {
  param([string]$Uri)
  try {
    $raw = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 10
    if (-not $raw.Content -or $raw.Content.Trim() -eq "[]" -or $raw.Content.Trim() -eq "null") { return @() }
    return @((ConvertFrom-Json $raw.Content) | Where-Object { $null -ne $_ })
  } catch {
    return @()
  }
}

function Read-Json {
  param([string]$Uri)
  try { return Invoke-RestMethod -Uri $Uri -TimeoutSec 10 } catch { return $null }
}

function Count-Items {
  param($Value)
  if ($null -eq $Value) { return 0 }
  return @($Value | Where-Object { $null -ne $_ }).Count
}

$nodes = @()
foreach ($port in $Ports) {
  $base = "http://127.0.0.1:$port"
  $status = Read-Json "$base/rpc/status"
  $stats = Read-Json "$base/rpc/stats"
  $net = Read-Json "$base/rpc/net"
  $anchors = Read-Json "$base/rpc/anchors/seats"
  $models = Read-JsonArray "$base/rpc/models"
  $nodes += [pscustomobject]@{
    port = $port
    online = [bool]$status
    peerId = if ($net) { $net.peerId } else { "" }
    peers = if ($stats) { $stats.peers } else { 0 }
    stateRoot = if ($stats) { $stats.stateRoot } else { "" }
    anchors = if ($anchors) { $anchors.total } else { 0 }
    launchAuthorityActive = [bool]($status -and $status.isFounder)
    mining = [bool]($status -and $status.mining.enabled)
    storage = [bool]($status -and $status.mining.storageEnabled)
    storageGb = if ($status) { $status.mining.storageLimitGb } else { 0 }
    storageUsedGb = if ($status) { [math]::Round($status.mining.storageUsedBytes / 1GB, 3) } else { 0 }
    localTasks = [bool]($status -and $status.mining.localTaskPermission)
    serving = [bool]($status -and $status.mining.serving)
    fieldModels = Count-Items $models
    knownModels = if ($status -and $status.mining.known) { Count-Items $status.mining.known } else { 0 }
    answerLabel = if ($status) { $status.mining.answerLabel } else { "" }
  }
}

$launchModels = @()
foreach ($url in $LaunchModelUrls) {
  try {
    $head = Invoke-WebRequest -Uri $url -Method Head -MaximumRedirection 5 -UseBasicParsing -TimeoutSec 45
    $bytes = [int64]($head.Headers["Content-Length"] | Select-Object -First 1)
    $launchModels += [pscustomobject]@{
      url = $url
      available = $true
      status = [int]$head.StatusCode
      sizeGb = [math]::Round($bytes / 1GB, 2)
      acceptRanges = [string]($head.Headers["Accept-Ranges"] | Select-Object -First 1)
    }
  } catch {
    $launchModels += [pscustomobject]@{ url = $url; available = $false; status = "error"; sizeGb = 0; acceptRanges = ""; error = $_.Exception.Message }
  }
}

$pricing = Read-Json "$Rpc/rpc/pricing"
$providers = Read-JsonArray "$Rpc/rpc/providers"
$marketplace = Read-JsonArray "$Rpc/rpc/marketplace"
$ziraResonatorPresent = $false
try {
  $ziraRaw = Invoke-WebRequest -Uri "$Rpc/rpc/resonator?id=zira" -UseBasicParsing -TimeoutSec 10
  $ziraResonatorPresent = [bool]($ziraRaw.Content -and $ziraRaw.Content.Trim() -ne "null")
} catch { }
$modelsOnField = Read-JsonArray "$Rpc/rpc/models"
$stateRoots = @($nodes | Where-Object { $_.stateRoot } | Select-Object -ExpandProperty stateRoot -Unique)
$authorityNodes = @($nodes | Where-Object { $_.launchAuthorityActive })
$bootstrapPort = if ($Ports.Count -gt 0) { $Ports[0] } else { 8645 }
$authorityOnlyOnBootstrap = [bool]($authorityNodes.Count -eq 1 -and $authorityNodes[0].port -eq $bootstrapPort)
$unavailableLaunchModels = @($launchModels | Where-Object { -not $_.available })
$launchModelsReachable = $unavailableLaunchModels.Count -eq 0 -and $launchModels.Count -gt 0
$smoke = $null
if ($SmokeQuery) {
  $queryId = "q-readiness-" + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $body = @{
    query = @{
      id = $queryId
      domain = "general"
      question = "field readiness smoke test"
      history = @()
      asker = "zir1smoke"
      postedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
  } | ConvertTo-Json -Depth 5
  try {
    Invoke-RestMethod -Method Post -Uri "$Rpc/rpc/query" -ContentType "application/json" -Body $body -TimeoutSec 10 | Out-Null
    $answers = @()
    $modelBacked = @()
    $fallback = "This node is mining in coordination mode|Full generative AI answers require"
    $deadline = (Get-Date).AddSeconds($SmokeWaitSeconds)
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 750
      $answers = Read-JsonArray "$Rpc/rpc/query/answers?id=$queryId"
      $modelBacked = @($answers | Where-Object { $_.answer -and $_.answer -notmatch $fallback })
      if ((Count-Items $modelBacked) -gt 0) { break }
    }
    $smoke = [pscustomobject]@{
      queryId = $queryId
      waitSeconds = $SmokeWaitSeconds
      answers = Count-Items $answers
      modelBackedAnswers = Count-Items $modelBacked
    }
  } catch {
    $smoke = [pscustomobject]@{ queryId = $queryId; answers = 0; error = $_.Exception.Message }
  }
}

[pscustomobject]@{
  generatedAt = (Get-Date).ToString("o")
  rpc = $Rpc
  nodes = $nodes
  stateRootsAgree = $stateRoots.Count -eq 1
  providersOnline = if ($pricing) { $pricing.providersOnline } else { 0 }
  providerProfiles = Count-Items $providers
  marketplaceListings = Count-Items $marketplace
  defaultLaunchResonatorPresent = $ziraResonatorPresent
  fieldModelCount = Count-Items $modelsOnField
  launchModelUrls = $launchModels
  launchModelsReachable = $launchModelsReachable
  totalLaunchModelGb = [math]::Round(($launchModels | Measure-Object -Property sizeGb -Sum).Sum, 2)
  launchAuthorityActive = [bool]($authorityNodes.Count -gt 0)
  authorityNodeCount = Count-Items $authorityNodes
  authorityOnlyOnBootstrap = $authorityOnlyOnBootstrap
  founderKeyInEnvironment = [bool]$env:ZIRA_FOUNDER_KEY
  readyToAuthorizeModels = [bool]($authorityOnlyOnBootstrap -and $launchModelsReachable)
  readyForResonatorFunding = [bool]($authorityOnlyOnBootstrap -and ((Count-Items $modelsOnField) -gt 0))
  smokeQuery = $smoke
  nextRequiredAction = if ((Count-Items $modelsOnField) -eq 0) {
    "Authorize model hashes with an unlocked launch-authority wallet, then wait for storage peers to replicate."
  } elseif (-not $ziraResonatorPresent) {
    "Create and fund launch Resonators from an unlocked authorized wallet, then enable resonance."
  } else {
    "Keep mining/storage peers online and monitor model distribution plus Resonator task outcomes."
  }
} | ConvertTo-Json -Depth 7
