param(
  [string]$SecretFile = "C:\AI\projects\Z2\zira\local-private\ZIRA_WALLETS_AND_KEYS_LOCAL.dm",
  [string]$Bootstrap = "/ip4/157.173.106.50/tcp/9645/p2p/12D3KooWK1284RKM9TX25ikBRAywEGpy3tCoG8FHo38xW5XEVv6Z",
  [int]$RpcPort = 8655,
  [int]$P2pPort = 9655,
  [int]$WsPort = 9656
)
# Start ONE local founder node that JOINS the live mainnet (fast-sync), runs as steward (launch
# authority) so it may provide a model, holds + serves the bytes (storage on), mining OFF. The
# founder key is read here and inherited only by this node process; never printed, never copied.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$founderAddresses = @(
  "zir1km32wyjkya4h6utahkuckm56zgshnevy4v3a7t",
  "zir1c7q2fzk6lmaxsnx4s7twftzlpcd749xa6v0r7z",
  "zir1czsjyrjf8wts662kd7s9um4nmyaapjhcvr0x7n"
)

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
} catch { process.exit(2); }
'@ | Set-Content -LiteralPath $validator -Encoding UTF8
    $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    $address = & node $validator 2>$null
    $ErrorActionPreference = $old
    if ($LASTEXITCODE -ne 0) { return "" }
    return $address
  } finally {
    $env:ZIRA_CANDIDATE_PRIVATE_KEY = $null
    Remove-Item -LiteralPath $validator -Force -ErrorAction SilentlyContinue
  }
}

$text = Get-Content -LiteralPath $SecretFile -Raw
$key = ""
foreach ($match in [regex]::Matches($text, '(?i)(?:0x)?[0-9a-f]{64}')) {
  $hex = $match.Value.ToLowerInvariant() -replace '^0x', ''
  if ($founderAddresses -contains (Address-From-Private $hex)) { $key = $hex; break }
}
if (-not $key) { throw "No founder key found in $SecretFile" }

$runtime = Join-Path $root "local-private\runtime-founder-live"
$logs = Join-Path $runtime "logs"
$data = Join-Path $runtime "data"
New-Item -ItemType Directory -Force $logs, $data | Out-Null
$log = Join-Path $logs "founder.log"
$nodeEntry = Join-Path $root "node\dist\index.js"

$runner = Join-Path $runtime "run.ps1"
$lines = @(
  '$ErrorActionPreference = "Stop"',
  "Set-Location '$root'",
  "`$env:ZIRA_NETWORK = 'mainnet'",
  "`$env:ZIRA_RESET = '0'",
  "`$env:ZIRA_KEEP_MODELS = '1'",
  "`$env:ZIRA_DATA_DIR = '$data'",
  "`$env:ZIRA_RPC_HOST = '127.0.0.1'",
  "`$env:ZIRA_RPC_PORT = '$RpcPort'",
  "`$env:ZIRA_P2P_PORT = '$P2pPort'",
  "`$env:ZIRA_WS_PORT = '$WsPort'",
  "`$env:ZIRA_BOOTSTRAP = '$Bootstrap'",
  "`$env:ZIRA_SERVE_CONSOLE = '0'",
  "`$env:ZIRA_MINE = '0'",
  "`$env:ZIRA_STORAGE = '1'",
  "`$env:ZIRA_STORAGE_GB = '4'",
  "`$env:ZIRA_LOCAL_TASKS = '0'",
  "`$env:ZIRA_FOUNDER_KEY = '$key'",
  "& node '$nodeEntry' *>&1 | Tee-Object -FilePath '$log'"
)
$lines | Set-Content -LiteralPath $runner -Encoding UTF8
if (Test-Path $log) { Remove-Item -LiteralPath $log -Force }
Start-Process -FilePath "powershell" -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File",$runner) -WindowStyle Hidden | Out-Null

[pscustomobject]@{ started = $true; rpc = "http://127.0.0.1:$RpcPort"; log = $log; data = $data } | ConvertTo-Json
