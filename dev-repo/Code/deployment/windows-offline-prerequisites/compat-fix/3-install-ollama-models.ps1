$ErrorActionPreference = "Stop"

$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

function Find-PackageFile([string]$Name) {
  $packageRoot = Split-Path $PSScriptRoot -Parent
  $match = Get-ChildItem -LiteralPath $packageRoot -Filter $Name -File -Recurse -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $match) {
    throw "未找到文件：$Name。请将 WINDOWS-COMPAT-FIX 文件夹放在昨天部署包的根目录中。"
  }
  return $match.FullName
}

$installer = Find-PackageFile "OllamaSetup-0.32.1-Windows-amd64.exe"
$modelArchive = Find-PackageFile "ollama-models-qwen3.5-9b-bge-m3.tar"
$ollamaPaths = @(
  "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe",
  "$env:ProgramFiles\Ollama\ollama.exe"
)
$ollama = $ollamaPaths | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($ollama) {
  Write-Host "已检测到 Ollama，跳过安装步骤。" -ForegroundColor Green
} else {
  Write-Host "正在安装 Ollama...安装完成后请关闭安装窗口。" -ForegroundColor Cyan
  $process = Start-Process -FilePath $installer -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "Ollama 安装失败，错误码：$($process.ExitCode)"
  }
  $ollama = $ollamaPaths | Where-Object { Test-Path $_ } | Select-Object -First 1
}

Get-Process ollama -ErrorAction SilentlyContinue | Stop-Process -Force
$modelRoot = Join-Path $env:USERPROFILE ".ollama\models"
New-Item -ItemType Directory -Path $modelRoot -Force | Out-Null

Write-Host "正在导入 qwen3.5:9b 和 bge-m3。解压期间可能不显示进度，请勿关闭窗口..." -ForegroundColor Cyan
tar.exe -xf $modelArchive -C $modelRoot
if ($LASTEXITCODE -ne 0) {
  throw "模型文件导入失败。"
}

[Environment]::SetEnvironmentVariable("OLLAMA_HOST", "0.0.0.0:11434", "User")
$env:OLLAMA_HOST = "0.0.0.0:11434"

if (-not $ollama) {
  throw "未找到 ollama.exe，请重新打开 PowerShell 后运行 ollama list 检查安装。"
}

Start-Process -FilePath $ollama -ArgumentList "serve" -WindowStyle Hidden
Start-Sleep -Seconds 5
& $ollama list

Write-Host "Ollama 和离线模型安装完成。项目地址使用 http://host.docker.internal:11434。" -ForegroundColor Green
