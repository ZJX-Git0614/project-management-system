$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

$installer = Join-Path $PSScriptRoot "DockerDesktopInstaller-Windows-amd64.exe"
if (-not (Test-Path $installer)) {
  throw "缺少 Docker Desktop 安装包：$installer"
}

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

$dockerDesktopPaths = @(
  "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe",
  "$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe"
)
$dockerDesktop = $dockerDesktopPaths | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($dockerDesktop) {
  Start-Process $dockerDesktop
}

Write-Host ""
Write-Host "Docker Desktop 安装完成。" -ForegroundColor Green
Write-Host "首次启动时请等待 Docker Desktop 显示 Engine running。"
Write-Host "随后解压 02-项目部署包中的 ZIP，并运行其中的 install.bat。"
