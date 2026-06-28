param(
  [string]$DownloadDir = "local-private\launch-models",
  [switch]$FirstOnly
)

# scripts/download-and-provide-launch-models.ps1
# Resumable operator path for large launch GGUFs: download with curl, verify the GGUF header, then
# ask the active launch-authority node to hash/sign/announce the local file into the model field.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
if (-not [System.IO.Path]::IsPathRooted($DownloadDir)) { $DownloadDir = Join-Path $root $DownloadDir }
New-Item -ItemType Directory -Force $DownloadDir | Out-Null

$models = @(
  @{
    Index = 0
    Name = "Qwen3 8B Q8 GGUF"
    File = "Qwen3-8B-Q8_0.gguf"
    Url = "https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q8_0.gguf"
  }
)
if ($FirstOnly) { $models = @($models[0]) }

function Assert-Gguf {
  param([string]$Path)
  $fs = [System.IO.File]::OpenRead($Path)
  try {
    $bytes = New-Object byte[] 4
    if ($fs.Read($bytes, 0, 4) -ne 4 -or [System.Text.Encoding]::ASCII.GetString($bytes) -ne "GGUF") {
      throw "Downloaded file is not a valid GGUF: $Path"
    }
  } finally {
    $fs.Dispose()
  }
}

foreach ($model in $models) {
  $path = Join-Path $DownloadDir $model.File
  Write-Host "Downloading $($model.Name) -> $path"
  & curl.exe -L --fail --continue-at - --output $path $model.Url
  if ($LASTEXITCODE -ne 0) { throw "curl failed for $($model.Name) with exit code $LASTEXITCODE" }
  Assert-Gguf $path
  Write-Host "Providing $($model.Name) to active launch-authority node"
  & node (Join-Path $root "scripts\provide-launch-models.mjs") "--local-dir=$DownloadDir" "--only-index=$($model.Index)"
  if ($LASTEXITCODE -ne 0) { throw "model provide failed for $($model.Name) with exit code $LASTEXITCODE" }
}
