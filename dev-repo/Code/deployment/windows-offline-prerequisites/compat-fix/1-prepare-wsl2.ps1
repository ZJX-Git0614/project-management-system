$ErrorActionPreference = "Stop"

$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "请右键 1-prepare-wsl2.bat，并选择以管理员身份运行。"
  }
}

function Find-PackageFile([string]$Name) {
  $packageRoot = Split-Path $PSScriptRoot -Parent
  $match = Get-ChildItem -LiteralPath $packageRoot -Filter $Name -File -Recurse -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $match) {
    throw "未找到文件：$Name。请将 WINDOWS-COMPAT-FIX 文件夹放在昨天部署包的根目录中。"
  }
  return $match.FullName
}

Assert-Administrator

$os = Get-CimInstance Win32_OperatingSystem
$processor = Get-CimInstance Win32_Processor | Select-Object -First 1
$computerSystem = Get-CimInstance Win32_ComputerSystem
$build = [int]$os.BuildNumber

if ($env:PROCESSOR_ARCHITECTURE -ne "AMD64") {
  throw "目标电脑不是 x86-64/AMD64 系统，不能使用本部署包。"
}
if ($build -lt 19045) {
  throw "Windows 版本过低。最低要求是 Windows 10 22H2 Build 19045。当前 Build：$build"
}
if ($processor.VirtualizationFirmwareEnabled -or $computerSystem.HypervisorPresent) {
  Write-Host "Windows 已检测到硬件虚拟化支持。" -ForegroundColor Green
} else {
  Write-Host "Windows WMI 暂未报告硬件虚拟化状态，但该检测在部分设备上不准确。" -ForegroundColor Yellow
  Write-Host "脚本将继续配置 WSL2；如果 BIOS 中已启用 Intel Virtualization Technology，无需再次修改 BIOS。" -ForegroundColor Yellow
}

$wslInstaller = Find-PackageFile "wsl.2.7.10.0.x64.msi"

Write-Host "正在启用 WSL 和虚拟机平台功能..." -ForegroundColor Cyan
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
if ($LASTEXITCODE -notin @(0, 3010)) {
  throw "启用 Windows Subsystem for Linux 失败，错误码：$LASTEXITCODE"
}
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
if ($LASTEXITCODE -notin @(0, 3010)) {
  throw "启用 Virtual Machine Platform 失败，错误码：$LASTEXITCODE"
}

Write-Host "正在将 Windows Hypervisor 启动方式设置为自动..." -ForegroundColor Cyan
bcdedit.exe /set hypervisorlaunchtype auto | Out-Host
if ($LASTEXITCODE -ne 0) {
  Write-Host "未能修改 Hypervisor 启动项，错误码：$LASTEXITCODE。脚本将继续安装 WSL。" -ForegroundColor Yellow
}

Write-Host "正在安装 WSL 2.7.10..." -ForegroundColor Cyan
$process = Start-Process msiexec.exe -ArgumentList "/i `"$wslInstaller`" /qn /norestart" -Wait -PassThru
if ($process.ExitCode -notin @(0, 3010, 1641)) {
  throw "WSL2 安装失败，错误码：$($process.ExitCode)"
}

Write-Host "WSL2 准备完成。请重启 Windows，随后运行 2-install-docker-desktop.bat。" -ForegroundColor Green
