param(
  [string[]]$Urls = @(
    "https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q8_0.gguf"
  ),
  [string]$Rpc = "http://127.0.0.1:8645"
)

# scripts/check-launch-models.ps1
# Operator preflight for the first launch models. It checks URL reachability, size, free disk,
# founder activation, and current field model count without printing any private key material.
$ErrorActionPreference = "Stop"

$models = @()
foreach ($url in $Urls) {
  try {
    $head = Invoke-WebRequest -Uri $url -Method Head -MaximumRedirection 5 -UseBasicParsing -TimeoutSec 45
    $bytes = [int64]($head.Headers["Content-Length"] | Select-Object -First 1)
    $models += [pscustomobject]@{
      url = $url
      available = $true
      status = [int]$head.StatusCode
      sizeGb = [math]::Round($bytes / 1GB, 2)
      acceptRanges = [string]($head.Headers["Accept-Ranges"] | Select-Object -First 1)
    }
  } catch {
    $models += [pscustomobject]@{
      url = $url
      available = $false
      status = "error"
      sizeGb = 0
      acceptRanges = ""
      error = $_.Exception.Message
    }
  }
}

$totalGb = [math]::Round(($models | Measure-Object -Property sizeGb -Sum).Sum, 2)
$driveName = (Get-Location).Path.Substring(0, 1)
$drive = Get-PSDrive -Name $driveName
$status = $null
$fieldModels = @()
try { $status = Invoke-RestMethod -Uri "$Rpc/rpc/status" -TimeoutSec 10 } catch { }
try {
  $rawModels = Invoke-WebRequest -Uri "$Rpc/rpc/models" -UseBasicParsing -TimeoutSec 10
  $fieldModels = @((ConvertFrom-Json $rawModels.Content))
} catch { }
$unavailableModels = @($models | Where-Object { -not $_.available })
$launchAuthorityActive = [bool]($status -and $status.isFounder)

[pscustomobject]@{
  models = $models
  totalDownloadGb = $totalGb
  freeDiskGb = [math]::Round($drive.Free / 1GB, 2)
  enoughDiskForOneCopy = $drive.Free -gt (($totalGb + 5) * 1GB)
  rpc = $Rpc
  founderActive = $launchAuthorityActive
  founderKeyInEnvironment = [bool]$env:ZIRA_FOUNDER_KEY
  fieldModelCount = $fieldModels.Count
  readyToAuthorize = [bool]($launchAuthorityActive -and $unavailableModels.Count -eq 0)
  readyToAuthorizeFromEnvironment = [bool]($launchAuthorityActive -and $env:ZIRA_FOUNDER_KEY -and $unavailableModels.Count -eq 0)
} | ConvertTo-Json -Depth 5
