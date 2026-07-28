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

$installer = Find-PackageFile "DockerDesktopInstaller-Windows-amd64.exe"

try {
  wsl.exe --version | Out-Host
} catch {
  throw "WSL2 尚未就绪。请先运行 1-prepare-wsl2.bat 并重启 Windows。"
}

Write-Host "正在安装 Docker Desktop，安装过程可能需要几分钟..." -ForegroundColor Cyan
$process = Start-Process -FilePath $installer -ArgumentList "install", "--accept-license", "--backend=wsl-2" -Wait -PassThru
if ($process.ExitCode -ne 0) {
  throw "Docker Desktop 安装失败，错误码：$($process.ExitCode)"
}

$dockerDesktop = @(
  "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe",
  "$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($dockerDesktop) {
  Start-Process $dockerDesktop
}

Write-Host "Docker Desktop 安装完成。请等待界面显示 Engine running。" -ForegroundColor Green
