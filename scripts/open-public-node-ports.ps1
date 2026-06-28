param(
  [int[]]$Ports = @(9645, 9646),
  [switch]$MainnetMesh,
  [string]$PublicHost = "",
  [switch]$CheckOnly
)

# scripts/open-public-node-ports.ps1
# Best-effort router port mapping for public ZIRA P2P TCP. Uses Windows UPnP COM when the router
# supports it. This cannot bypass CGNAT, ISP blocks, or routers with UPnP disabled.
$ErrorActionPreference = "Stop"

if ($MainnetMesh) {
  $Ports += @(9745, 9746, 9845, 9846, 9945, 9946)
}
$Ports = @($Ports | Sort-Object -Unique)

$nodeScript = Join-Path $PSScriptRoot "open-public-node-ports.mjs"
if (Test-Path $nodeScript) {
  $nodeArgs = @($nodeScript, "--ports=$($Ports -join ',')")
  if ($PublicHost) { $nodeArgs += "--public-host=$PublicHost" }
  if ($CheckOnly) { $nodeArgs += "--check-only" }
  & node @nodeArgs
  exit $LASTEXITCODE
}

function Get-PrimaryIPv4 {
  try {
    $cfg = Get-NetIPConfiguration -ErrorAction Stop | Where-Object {
      $_.IPv4DefaultGateway -and $_.IPv4Address.IPAddress -and $_.IPv4Address.IPAddress -notlike "127.*"
    } | Select-Object -First 1
    if ($cfg) { return [string]$cfg.IPv4Address.IPAddress }
  } catch {}
  try {
    return [string](Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object {
      $_.IPAddress -notlike "127.*" -and $_.PrefixOrigin -ne "WellKnown"
    } | Select-Object -First 1 -ExpandProperty IPAddress)
  } catch {}
  return ""
}

function Get-PublicIPv4 {
  param([string]$Fallback)
  if ($Fallback) { return $Fallback.Trim() }
  try {
    $ip = (Invoke-RestMethod -Uri "https://api.ipify.org" -TimeoutSec 8).Trim()
    if ($ip -match '^\d{1,3}(\.\d{1,3}){3}$') { return $ip }
  } catch {}
  return ""
}

function Test-PublicTcp {
  param([string]$HostName, [int]$Port)
  if (-not $HostName) { return $false }
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $async = $client.BeginConnect($HostName, $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(2500, $false)) { return $false }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

$localIp = Get-PrimaryIPv4
$publicIp = Get-PublicIPv4 -Fallback $PublicHost
$results = @()
$upnpAvailable = $false
$collection = $null

try {
  $nat = New-Object -ComObject HNetCfg.NATUPnP
  $collection = $nat.StaticPortMappingCollection
  $upnpAvailable = $null -ne $collection
} catch {
  $upnpAvailable = $false
}

foreach ($port in $Ports) {
  $mapped = $false
  $changed = $false
  $errorMessage = ""
  if ($upnpAvailable -and $localIp -and -not $CheckOnly) {
    try {
      $existing = $null
      foreach ($mapping in $collection) {
        if ($mapping.ExternalPort -eq $port -and $mapping.Protocol -eq "TCP") {
          $existing = $mapping
          break
        }
      }
      if ($existing -and $existing.InternalClient -eq $localIp -and $existing.InternalPort -eq $port -and $existing.Enabled) {
        $mapped = $true
      } else {
        if ($existing) { $collection.Remove($port, "TCP") | Out-Null }
        $collection.Add($port, "TCP", $port, $localIp, $true, "ZIRA Core TCP $port") | Out-Null
        $mapped = $true
        $changed = $true
      }
    } catch {
      $errorMessage = $_.Exception.Message
    }
  } elseif ($CheckOnly) {
    $mapped = $upnpAvailable
  } elseif (-not $localIp) {
    $errorMessage = "Could not determine local LAN IPv4 address."
  } else {
    $errorMessage = "Router UPnP port mapping is unavailable or disabled."
  }

  $reachable = Test-PublicTcp -HostName $publicIp -Port $port
  $row = [ordered]@{
    port = $port
    localIp = $localIp
    publicHost = $publicIp
    upnpAvailable = $upnpAvailable
    mapped = $mapped
    changed = $changed
    reachableFromHere = $reachable
  }
  if ($errorMessage) { $row.error = $errorMessage }
  $results += [pscustomobject]$row
}

$ready = @($results | Where-Object { $_.reachableFromHere }).Count -gt 0
[pscustomobject]@{
  ok = $ready
  publicHost = $publicIp
  localIp = $localIp
  ports = $Ports
  upnpAvailable = $upnpAvailable
  results = $results
  note = if ($ready) {
    "At least one public TCP port accepted a connection."
  } elseif ($upnpAvailable) {
    "UPnP mapping was attempted, but public TCP did not accept yet. Some routers block hairpin checks; verify from an outside network."
  } else {
    "Router UPnP was unavailable. Manual router forwarding or disabling CGNAT may still be required."
  }
} | ConvertTo-Json -Depth 6
