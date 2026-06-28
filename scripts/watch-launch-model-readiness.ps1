param(
  [string]$Rpc = "http://127.0.0.1:8645",
  [int[]]$Ports = @(8645, 8745, 8845, 8945),
  [int]$TargetModelCount = 2,
  [int]$PollSeconds = 60,
  [int]$TimeoutHours = 8,
  [string]$ReportPath = "local-private\launch-model-readiness.json"
)

# scripts/watch-launch-model-readiness.ps1
# Operator watcher for the launch models. It waits for authority-signed models to appear,
# asks storage-capable peers with enough capacity to fetch them, and writes readiness snapshots.
# Reaching TargetModelCount means models are announced; use check:field for provider/replication health.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
if (-not [System.IO.Path]::IsPathRooted($ReportPath)) { $ReportPath = Join-Path $root $ReportPath }
$reportDir = Split-Path -Parent $ReportPath
if (-not (Test-Path $reportDir)) { New-Item -ItemType Directory -Force $reportDir | Out-Null }

function Read-Json {
  param([string]$Uri)
  try { return Invoke-RestMethod -Uri $Uri -TimeoutSec 20 } catch { return $null }
}

function Read-JsonArray {
  param([string]$Uri)
  try {
    $raw = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 20
    if (-not $raw.Content -or $raw.Content.Trim() -eq "[]" -or $raw.Content.Trim() -eq "null") { return @() }
    return @((ConvertFrom-Json $raw.Content) | Where-Object { $null -ne $_ })
  } catch {
    return @()
  }
}

function Count-Items {
  param($Value)
  if ($null -eq $Value) { return 0 }
  return @($Value | Where-Object { $null -ne $_ }).Count
}

function Write-Snapshot {
  param($Models, $Nodes, [string]$NextAction)
  [pscustomobject]@{
    generatedAt = (Get-Date).ToString("o")
    rpc = $Rpc
    modelCount = Count-Items $Models
    models = @($Models)
    nodes = @($Nodes)
    nextAction = $NextAction
  } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
}

$deadline = (Get-Date).AddHours($TimeoutHours)
$fetchStarted = @{}
while ((Get-Date) -lt $deadline) {
  $models = Read-JsonArray "$Rpc/rpc/models"
  $nodes = @()
  foreach ($port in $Ports) {
    $status = Read-Json "http://127.0.0.1:$port/rpc/status"
    $nodeModels = Read-JsonArray "http://127.0.0.1:$port/rpc/models"
    $nodes += [pscustomobject]@{
      port = $port
      online = [bool]$status
      storage = [bool]($status -and $status.mining.storageEnabled)
      storageGb = if ($status) { [double]$status.mining.storageLimitGb } else { 0 }
      storageUsedGb = if ($status) { [math]::Round($status.mining.storageUsedBytes / 1GB, 3) } else { 0 }
      mining = [bool]($status -and $status.mining.enabled)
      serving = [bool]($status -and $status.mining.serving)
      modelCount = Count-Items $nodeModels
    }
  }

  foreach ($model in $models) {
    $meta = $model.meta
    if (-not $meta -or -not $meta.id) { continue }
    foreach ($node in $nodes) {
      if ($node.port -eq 8645 -or -not $node.online -or -not $node.storage) { continue }
      $requiredGb = [math]::Ceiling([double]$meta.sizeBytes / 1GB) + 1
      if ($node.storageGb -lt $requiredGb) { continue }
      $key = "$($node.port):$($meta.id)"
      if ($fetchStarted[$key]) { continue }
      $fetchStarted[$key] = $true
      Write-Host "Requesting model fetch on port $($node.port): $($meta.name) $($meta.id.Substring(0, 12))"
      try {
        Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($node.port)/rpc/models/fetch" -ContentType "application/json" -Body (@{ id = $meta.id } | ConvertTo-Json) -TimeoutSec 30 | Out-Null
      } catch {
        Write-Host "Fetch request pending/failed on $($node.port): $($_.Exception.Message)"
      }
    }
  }

  $next = if ((Count-Items $models) -lt $TargetModelCount) {
    "Waiting for launch model download, authority signature, and field announcement."
  } else {
    "Launch models are announced. Continue with check:field to verify provider counts, storage replication, mining checks, Resonator funding, and adaptive-field smoke tests."
  }
  Write-Snapshot -Models $models -Nodes $nodes -NextAction $next

  if ((Count-Items $models) -ge $TargetModelCount) {
    Write-Host "Target model count reached. Models are announced; run pnpm check:field to verify replication/providers. Final readiness snapshot: $ReportPath"
    exit 0
  }
  Start-Sleep -Seconds $PollSeconds
}

throw "Timed out waiting for $TargetModelCount launch models. Last snapshot: $ReportPath"
