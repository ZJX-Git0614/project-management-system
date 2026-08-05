param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Ollama", "RagLite")]
  [string]$ServiceName
)

$ErrorActionPreference = "Continue"
$runtimeDirectory = Join-Path $env:ProgramData "Ceastar-PMS\assistant-services"
$managerPath = Join-Path $runtimeDirectory "assistant-services.ps1"
$pausePath = Join-Path $runtimeDirectory ("paused-" + $ServiceName + ".flag")

# “停止”只暂停到下次开机；新一轮系统启动时恢复用户设置的自动守护。
if (Test-Path $pausePath) {
  Remove-Item $pausePath -Force -ErrorAction SilentlyContinue
}

while ($true) {
  if ((Test-Path $managerPath) -and -not (Test-Path $pausePath)) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $managerPath -Action Ensure -Service $ServiceName *> $null
  }
  Start-Sleep -Seconds 15
}
