param(
  [int[]]$Ports = @(
    8645, 8745, 8845, 8945, 9045, 9145, 9245, 9345,
    9645, 9646, 9745, 9746, 9845, 9846, 9945, 9946,
    10045, 10046, 10145, 10146, 10245, 10246, 10345, 10346
  )
)

# scripts/stop-zira-ports.ps1
# Stop local processes that occupy the standard ZIRA launch ports.
$ErrorActionPreference = "Stop"

$connections = @(Get-NetTCPConnection -LocalPort $Ports -ErrorAction SilentlyContinue | Where-Object {
  $_.OwningProcess -gt 0 -and $_.State -ne "TimeWait" -and (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue)
})
if ($connections.Count -eq 0) {
  Write-Host "All ZIRA launch ports are free." -ForegroundColor Green
  exit 0
}

$owners = @($connections | Select-Object -ExpandProperty OwningProcess -Unique)
foreach ($owner in $owners) {
  if (-not $owner) { continue }
  $proc = Get-Process -Id $owner -ErrorAction SilentlyContinue
  if (-not $proc) { continue }
  Write-Host "Stopping process $owner ($($proc.ProcessName)) on ZIRA launch ports..." -ForegroundColor Yellow
  Stop-Process -Id $owner -Force
}

Start-Sleep -Seconds 1
$remaining = @(Get-NetTCPConnection -LocalPort $Ports -ErrorAction SilentlyContinue | Where-Object {
  $_.OwningProcess -gt 0 -and $_.State -ne "TimeWait" -and (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue)
})
if ($remaining.Count -gt 0) {
  $remaining | Select-Object LocalAddress, LocalPort, OwningProcess, State | Format-Table -AutoSize
  throw "Some ZIRA launch ports are still occupied."
}

Write-Host "All ZIRA launch ports are free." -ForegroundColor Green
