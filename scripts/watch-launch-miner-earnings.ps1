param(
  [int]$IntervalSeconds = 60,
  [double]$PerProviderZir = 1,
  [int]$MinAnswered = 1,
  [double]$DailyCapZir = 20
)

$ErrorActionPreference = "Continue"
Write-Host "Watching launch miner earnings every $IntervalSeconds seconds. Per provider: $PerProviderZir ZIR, min answers: $MinAnswered, daily cap: $DailyCapZir ZIR."

while ($true) {
  $ts = (Get-Date).ToString("o")
  try {
    Write-Host "[$ts] settling active launch miners..."
    node scripts/settle-launch-miners.mjs "--per-provider-zir=$PerProviderZir" "--min-answered=$MinAnswered" "--daily-cap-zir=$DailyCapZir"
  } catch {
    Write-Warning "[$ts] settlement loop failed: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds $IntervalSeconds
}
