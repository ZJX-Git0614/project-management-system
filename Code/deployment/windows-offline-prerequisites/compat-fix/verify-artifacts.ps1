$ErrorActionPreference = "Stop"

$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

$packageRoot = Split-Path $PSScriptRoot -Parent
$artifacts = @(
  @{ Name = "DockerDesktopInstaller-Windows-amd64.exe"; Hash = "d812d89da0cda66c97cdf9decb60debf17d71c358900db33c48eb9ee9604f40c" },
  @{ Name = "wsl.2.7.10.0.x64.msi"; Hash = "1a62f90a43c03cc5bda47dfd0b6faf496ac70fd4389190518120a4f84fc895cf" },
  @{ Name = "Ceastar-PMS-Windows-x86-20260723.zip"; Hash = "6122edd18f2b0abae351119eb7056ec39d0944c9db78fd4a955dd03b702928c8" },
  @{ Name = "OllamaSetup-0.32.1-Windows-amd64.exe"; Hash = "2f53afab45547896e66b2879174ee78bb1f079f4a20b0858e0e377da0c3631f0" },
  @{ Name = "ollama-models-qwen3.5-9b-bge-m3.tar"; Hash = "b459f1ed9baf70da2081638f48632e85d4ae246305c9cdfeb8fa8bdb6b303687" }
)

$failed = $false
foreach ($artifact in $artifacts) {
  $file = Get-ChildItem -LiteralPath $packageRoot -Filter $artifact.Name -File -Recurse -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $file) {
    Write-Host "缺少文件：$($artifact.Name)" -ForegroundColor Red
    $failed = $true
    continue
  }

  $actual = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $artifact.Hash) {
    Write-Host "校验失败：$($artifact.Name)" -ForegroundColor Red
    $failed = $true
  } else {
    Write-Host "通过：$($artifact.Name)" -ForegroundColor Green
  }
}

if ($failed) {
  throw "存在缺失或损坏文件，请重新复制后再安装。"
}

Write-Host "全部核心文件校验通过。" -ForegroundColor Green
