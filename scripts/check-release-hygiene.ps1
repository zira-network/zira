param(
  [string]$LaunchFolder = "..\zira"
)

# scripts/check-release-hygiene.ps1
# Scan the public source/release folders for private keys, runtime state, logs, and large model files.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$launch = [System.IO.Path]::GetFullPath((Join-Path $root $LaunchFolder))
$publicRoots = @(
  (Join-Path $launch "source"),
  (Join-Path $launch "release")
)

$missing = @($publicRoots | Where-Object { -not (Test-Path $_) })
if ($missing.Count -gt 0) {
  throw "Launch public folder missing. Run scripts/prepare-launch.ps1 first. Missing: $($missing -join ', ')"
}

$forbiddenSegments = @(
  "secrets",
  "local-private",
  "runtime-mainnet",
  "launch-models",
  "node_modules",
  ".git"
)
$forbiddenNames = @(
  "identity.json",
  "peer-key.bin",
  "events.jsonl",
  "snapshot.json",
  "mining.json",
  "provider.json",
  "peers.json",
  "storage-peers.json",
  "founder-backups.json",
  "zti-history.jsonl"
)
$forbiddenExtensions = @(".gguf", ".part", ".log")
$findings = @()

foreach ($publicRoot in $publicRoots) {
  Get-ChildItem -LiteralPath $publicRoot -Recurse -Force | ForEach-Object {
    $rel = $_.FullName.Substring($launch.Length + 1)
    $parts = @($rel -split '[\\/]' | ForEach-Object { $_.ToLowerInvariant() })
    $name = $_.Name.ToLowerInvariant()
    $ext = $_.Extension.ToLowerInvariant()

    if ($parts | Where-Object { $_ -in $forbiddenSegments -or $_.StartsWith("runtime-") }) {
      $findings += "forbidden path: $rel"
      return
    }
    if (-not $_.PSIsContainer -and $name -in $forbiddenNames) {
      $findings += "forbidden runtime file: $rel"
      return
    }
    if (-not $_.PSIsContainer -and $ext -in $forbiddenExtensions) {
      $findings += "forbidden artifact extension: $rel"
      return
    }
    if (-not $_.PSIsContainer -and $ext -in @(".json", ".md", ".dm", ".txt", ".js", ".ts", ".tsx", ".ps1", ".mjs")) {
      try {
        $text = Get-Content -LiteralPath $_.FullName -Raw -ErrorAction Stop
        $matches = [regex]::Matches($text, '/ip4/(\d{1,3}(?:\.\d{1,3}){3})/tcp/\d+/p2p/[A-Za-z0-9]+')
        foreach ($match in $matches) {
          $ip = $match.Groups[1].Value
          if ($ip -match '^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|0\.0\.0\.0$)') { continue }
          $findings += "public ip bootstrap multiaddr: $rel"
          break
        }
      } catch {
        # skip unreadable text candidate
      }
    }
  }
}

if ($findings.Count -gt 0) {
  $findings | Sort-Object | ForEach-Object { Write-Error $_ }
  throw "Release hygiene check failed with $($findings.Count) finding(s)."
}

[pscustomobject]@{
  checkedAt = (Get-Date).ToString("o")
  launchFolder = $launch
  publicRoots = $publicRoots
  findings = 0
} | ConvertTo-Json -Depth 4
