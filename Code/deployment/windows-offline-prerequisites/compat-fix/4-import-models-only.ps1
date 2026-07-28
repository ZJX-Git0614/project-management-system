$ErrorActionPreference = "Stop"

$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

$packageRoot = Split-Path $PSScriptRoot -Parent
$modelArchive = Get-ChildItem -LiteralPath $packageRoot -Filter "ollama-models-qwen3.5-9b-bge-m3.tar" -File -Recurse -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty FullName -First 1
if (-not $modelArchive) {
  throw "未找到离线模型文件。请将 WINDOWS-COMPAT-FIX 文件夹放在完整部署包根目录中。"
}

$ollama = @(
  "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe",
  "$env:ProgramFiles\Ollama\ollama.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $ollama) {
  $ollamaCommand = Get-Command ollama.exe -ErrorAction SilentlyContinue
  if ($ollamaCommand) {
    $ollama = $ollamaCommand.Source
  }
}
if (-not $ollama) {
  throw "未找到 ollama.exe。请先确认 Ollama 已安装完成。"
}

Get-Process ollama -ErrorAction SilentlyContinue | Stop-Process -Force
$modelRoot = Join-Path $env:USERPROFILE ".ollama\models"
New-Item -ItemType Directory -Path $modelRoot -Force | Out-Null

Write-Host "正在导入 qwen3.5:9b 和 bge-m3。文件约 7.2 GB，期间可能不显示进度，请勿关闭窗口..." -ForegroundColor Cyan
tar.exe -xf $modelArchive -C $modelRoot
if ($LASTEXITCODE -ne 0) {
  throw "模型文件导入失败，错误码：$LASTEXITCODE"
}

[Environment]::SetEnvironmentVariable("OLLAMA_HOST", "0.0.0.0:11434", "User")
$env:OLLAMA_HOST = "0.0.0.0:11434"
Start-Process -FilePath $ollama -ArgumentList "serve" -WindowStyle Hidden
Start-Sleep -Seconds 5

Write-Host "正在检查模型列表..." -ForegroundColor Cyan
& $ollama list
Write-Host "模型导入完成。列表中应包含 qwen3.5:9b 和 bge-m3:latest。" -ForegroundColor Green
