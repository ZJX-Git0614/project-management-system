param(
  [string]$RootPath = $PSScriptRoot
)

$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$manifestPath = Join-Path $RootPath "SHA256SUMS.txt"

if (-not (Test-Path -LiteralPath $manifestPath)) {
  Write-Host "未找到 SHA256SUMS.txt，无法校验。" -ForegroundColor Red
  exit 1
}

$failed = $false
$entries = Get-Content -LiteralPath $manifestPath -Encoding UTF8 | Where-Object {
  $_ -and -not $_.StartsWith("#")
}

foreach ($entry in $entries) {
  if ($entry -notmatch '^([0-9a-fA-F]{64})\s+\*?(.+)$') {
    Write-Host "无法解析校验记录：$entry" -ForegroundColor Red
    $failed = $true
    continue
  }

  $expected = $Matches[1].ToLowerInvariant()
  $relativePath = $Matches[2]
  $filePath = Join-Path $RootPath $relativePath

  if (-not (Test-Path -LiteralPath $filePath)) {
    Write-Host "缺少文件：$relativePath" -ForegroundColor Red
    $failed = $true
    continue
  }

  $actual = (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) {
    Write-Host "校验失败：$relativePath" -ForegroundColor Red
    $failed = $true
  } else {
    Write-Host "通过：$relativePath" -ForegroundColor Green
  }
}

if ($failed) {
  Write-Host "存在缺失或损坏文件，请重新复制后再安装。" -ForegroundColor Red
  exit 1
}

Write-Host "全部文件校验通过，可以开始安装。" -ForegroundColor Green
