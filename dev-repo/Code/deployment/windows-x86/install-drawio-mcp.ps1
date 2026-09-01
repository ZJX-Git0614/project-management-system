[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$SourceDirectory
)

$ErrorActionPreference = "Stop"

$runtimeDirectory = Join-Path $env:ProgramData "Ceastar-PMS"
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null

foreach ($fileName in @("drawio-mcp.ps1", "drawio-mcp-config.json")) {
  $sourcePath = Join-Path $SourceDirectory $fileName
  if (-not (Test-Path -LiteralPath $sourcePath)) {
    throw "缺少 Draw.io MCP 文件：$sourcePath"
  }

  Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $runtimeDirectory $fileName) -Force
}

Write-Host "Draw.io MCP 启动器和配置已写入：$runtimeDirectory" -ForegroundColor Green
