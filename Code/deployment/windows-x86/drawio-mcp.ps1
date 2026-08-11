[CmdletBinding()]
param(
  [switch]$Install,
  [switch]$Help
)

$ErrorActionPreference = "Stop"
$drawioMcpPackage = "@drawio/mcp@1.5.0"

if ($Help) {
  Write-Host "Ceastar PMS Draw.io MCP 启动器"
  Write-Host "用法：powershell -ExecutionPolicy Bypass -File .\\drawio-mcp.ps1"
  Write-Host "首次使用可加 -Install 预下载官方 $drawioMcpPackage 包。"
  exit 0
}

$npx = Get-Command "npx.cmd" -ErrorAction SilentlyContinue
if (-not $npx) {
  throw "未找到 npx.cmd。请先安装 Node.js LTS，然后重新运行此脚本。"
}
$npxCommand = $npx.Path
if ([string]::IsNullOrWhiteSpace($npxCommand)) {
  $npxCommand = $npx.Source
}
if ([string]::IsNullOrWhiteSpace($npxCommand)) {
  throw "无法定位 npx.cmd 的可执行路径。请重新安装 Node.js LTS 后再试。"
}

if ($Install) {
  Write-Host "正在下载官方 $drawioMcpPackage 包..."
  & $npxCommand -y $drawioMcpPackage "--help"
  if ($LASTEXITCODE -ne 0) { throw "$drawioMcpPackage 下载或验证失败，退出码：$LASTEXITCODE" }
  Write-Host "Draw.io MCP 已准备完成。"
  exit 0
}

Write-Host "正在启动官方 Draw.io MCP。"
Write-Host "该 MCP 由客户端调用，用于打开并编辑 Ceastar PMS 导出的 .drawio 文件。"
& $npxCommand -y $drawioMcpPackage
exit $LASTEXITCODE
