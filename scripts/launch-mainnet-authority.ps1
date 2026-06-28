param(
  [string[]]$SecretFiles = @(
    "secrets\FOUNDER_WALLET.dm",
    "secrets\ZIRA_MAINNET_FOUNDERS_LOCAL.dm",
    "local-private\ZIRA_WALLETS_AND_KEYS_LOCAL.dm",
    # Consolidated private folder lives at the repo root (one private folder, kept out of the source tree).
    "..\local-private\ZIRA_WALLETS_AND_KEYS_LOCAL.dm",
    "..\local-private\secrets\FOUNDER_WALLET.dm",
    "..\local-private\secrets\ZIRA_MAINNET_FOUNDERS_LOCAL.dm"
  ),
  [switch]$Launch,
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

# scripts/launch-mainnet-authority.ps1
# Finds a local mainnet launch-authority private key without printing it. With -Launch, starts the
# fresh local mainnet with that key inherited only by the bootstrap process. Never copy this script's
# runtime output into public materials.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$founderAddresses = @(
  "zir1km32wyjkya4h6utahkuckm56zgshnevy4v3a7t",
  "zir1c7q2fzk6lmaxsnx4s7twftzlpcd749xa6v0r7z",
  "zir1czsjyrjf8wts662kd7s9um4nmyaapjhcvr0x7n"
)
$validationErrors = 0
$derivedAddresses = @()

function Resolve-SecretPath {
  param([string]$Path)
  if ([System.IO.Path]::IsPathRooted($Path)) { return $Path }
  return Join-Path $root $Path
}

function Address-From-Private {
  param([string]$PrivateKey)
  $env:ZIRA_CANDIDATE_PRIVATE_KEY = $PrivateKey
  $validator = Join-Path $root ("packages\protocol\zira-authority-validate-" + [guid]::NewGuid().ToString("N") + ".mjs")
  try {
    @'
import { ed25519 } from "@noble/curves/ed25519";
import { sha3_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { bech32m } from "@scure/base";

try {
  const privateKey = process.env.ZIRA_CANDIDATE_PRIVATE_KEY || "";
  const publicKey = bytesToHex(ed25519.getPublicKey(hexToBytes(privateKey)));
  const full = sha3_256(hexToBytes(publicKey));
  const words = bech32m.toWords(full.slice(0, 20));
  process.stdout.write(bech32m.encode("zir", words));
} catch {
  process.exit(2);
}
'@ | Set-Content -LiteralPath $validator -Encoding UTF8
    $oldPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $address = & node $validator 2>$null
    $ErrorActionPreference = $oldPreference
    if ($LASTEXITCODE -ne 0) {
      $script:validationErrors++
      return ""
    }
    return $address
  } finally {
    $env:ZIRA_CANDIDATE_PRIVATE_KEY = $null
    Remove-Item -LiteralPath $validator -Force -ErrorAction SilentlyContinue
  }
}

$candidates = @()
foreach ($file in $SecretFiles) {
  $full = Resolve-SecretPath $file
  if (-not (Test-Path -LiteralPath $full)) { continue }
  $text = Get-Content -LiteralPath $full -Raw
  foreach ($match in [regex]::Matches($text, '(?i)(?:0x)?[0-9a-f]{64}')) {
    $hex = $match.Value.ToLowerInvariant() -replace '^0x', ''
    if ($candidates.PrivateKey -contains $hex) { continue }
    $candidates += [pscustomobject]@{ PrivateKey = $hex; Source = $full }
  }
}

$matchResult = $null
foreach ($candidate in $candidates) {
  $address = Address-From-Private $candidate.PrivateKey
  if ($address) { $derivedAddresses += $address }
  if ($founderAddresses -contains $address) {
    $matchResult = [pscustomobject]@{ Address = $address; Source = $candidate.Source; PrivateKey = $candidate.PrivateKey }
    break
  }
}

if (-not $matchResult) {
  [pscustomobject]@{
    found = $false
    checkedFiles = @($SecretFiles | ForEach-Object { Resolve-SecretPath $_ })
    candidateCount = $candidates.Count
    validationErrors = $validationErrors
    derivedAddresses = @($derivedAddresses | Sort-Object -Unique)
    message = "No local private key matched the mainnet launch-authority address set."
  } | ConvertTo-Json -Depth 4
  exit 1
}

if (-not $Launch) {
  [pscustomobject]@{
    found = $true
    address = $matchResult.Address
    source = $matchResult.Source
    launch = $false
    message = "Launch authority key found. Re-run with -Launch to start the fresh mainnet with authority enabled on the bootstrap node."
  } | ConvertTo-Json -Depth 4
  exit 0
}

$env:ZIRA_FOUNDER_KEY = $matchResult.PrivateKey
try {
  $launchArgs = @{}
  if ($NoReset) { $launchArgs.NoReset = $true }
  if ($EnableMining) { $launchArgs.EnableMining = $true }
  if ($EnableProvider) {
    $launchArgs.EnableProvider = $true
    $launchArgs.ProviderEndpoint = $ProviderEndpoint
    $launchArgs.ProviderModel = $ProviderModel
    $launchArgs.ProviderLabel = $ProviderLabel
  }
  if ($PublicHost) {
    $launchArgs.PublicHost = $PublicHost
    $launchArgs.PublicHostType = $PublicHostType
    $launchArgs.PublicP2pPort = $PublicP2pPort
    $launchArgs.PublicWsPort = $PublicWsPort
  }
  if ($SkipFirewall) { $launchArgs.SkipFirewall = $true }
  if ($JoinBootstrap) { $launchArgs.JoinBootstrap = $JoinBootstrap }
  if ($StewardOnly) { $launchArgs.StewardOnly = $true }
  & (Join-Path $PSScriptRoot "launch-mainnet-fresh.ps1") @launchArgs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  [pscustomobject]@{
    found = $true
    address = $matchResult.Address
    source = $matchResult.Source
    launch = $true
    message = if ($NoReset) { "Mainnet restarted without resetting local state. Launch authority is active on the bootstrap role only." } else { "Fresh mainnet launched with launch authority active on the bootstrap role only." }
  } | ConvertTo-Json -Depth 4
} finally {
  $env:ZIRA_FOUNDER_KEY = $null
}

