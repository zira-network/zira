param(
  [int[]]$Ports = @(9645, 9646),
  [switch]$MainnetMesh,
  [switch]$IncludeRpc,
  [switch]$AutoElevate,
  [switch]$CheckOnly
)

# scripts/open-node-ports.ps1
# Best-effort Windows Firewall setup for ZIRA node ports. This opens the local PC firewall only;
# router/NAT forwarding is still verified separately by check-public-bootstrap.ps1.
$ErrorActionPreference = "Stop"

if ($MainnetMesh) {
  $Ports += @(9745, 9746, 9845, 9846, 9945, 9946)
}
if ($IncludeRpc) {
  $Ports += @(8645, 8745, 8845, 8945)
}
$Ports = @($Ports | Sort-Object -Unique)

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-FirewallRuleForPort {
  param([int]$Port)
  try {
    $rules = @(Get-NetFirewallPortFilter -Protocol TCP -ErrorAction Stop | Where-Object { $_.LocalPort -eq "$Port" })
    foreach ($filter in $rules) {
      $rule = Get-NetFirewallRule -AssociatedNetFirewallPortFilter $filter -ErrorAction SilentlyContinue | Where-Object {
        $_.Enabled -eq "True" -and $_.Direction -eq "Inbound" -and $_.Action -eq "Allow"
      }
      if ($rule) { return $true }
    }
  } catch {
    # Older Windows/PowerShell may not expose NetSecurity. The add path still uses netsh.
  }
  return $false
}

if (-not (Test-Admin)) {
  $script = $PSCommandPath
  $argList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$script`"")
  $argList += @("-Ports", ($Ports -join ","))
  if ($CheckOnly) { $argList += "-CheckOnly" }
  if ($AutoElevate -and -not $CheckOnly) {
    try {
      Start-Process -FilePath "powershell" -Verb RunAs -ArgumentList $argList | Out-Null
      [pscustomobject]@{
        ok = $true
        elevated = $false
        requestedElevation = $true
        ports = $Ports
        message = "Windows asked for administrator approval to open ZIRA node TCP ports."
      } | ConvertTo-Json -Depth 4
      exit 0
    } catch {
      [pscustomobject]@{
        ok = $false
        elevated = $false
        ports = $Ports
        message = "Could not request elevation. Re-run this command from an Administrator PowerShell."
      } | ConvertTo-Json -Depth 4
      exit 1
    }
  }
  [pscustomobject]@{
    ok = $false
    elevated = $false
    ports = $Ports
    message = "Administrator rights are required to open Windows Firewall ports. Run: powershell -ExecutionPolicy Bypass -File scripts/open-node-ports.ps1 -MainnetMesh -AutoElevate"
  } | ConvertTo-Json -Depth 4
  exit 0
}

$results = @()
foreach ($port in $Ports) {
  $alreadyOpen = Test-FirewallRuleForPort -Port $port
  if ($CheckOnly) {
    $results += [pscustomobject]@{ port = $port; open = $alreadyOpen; changed = $false }
    continue
  }
  if (-not $alreadyOpen) {
    $name = "ZIRA Core TCP $port"
    $out = & netsh advfirewall firewall add rule name="$name" dir=in action=allow protocol=TCP localport=$port profile=any 2>&1
    if ($LASTEXITCODE -ne 0) {
      $results += [pscustomobject]@{ port = $port; open = $false; changed = $false; error = ($out | Out-String).Trim() }
      continue
    }
    $results += [pscustomobject]@{ port = $port; open = $true; changed = $true }
  } else {
    $results += [pscustomobject]@{ port = $port; open = $true; changed = $false }
  }
}

[pscustomobject]@{
  ok = @($results | Where-Object { -not $_.open }).Count -eq 0
  elevated = $true
  ports = $Ports
  results = $results
  note = "Windows Firewall rules are local only. Router/NAT forwarding is verified with pnpm check:public-bootstrap."
} | ConvertTo-Json -Depth 5
