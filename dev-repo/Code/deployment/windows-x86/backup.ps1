$ErrorActionPreference = "Stop"
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
Set-Location $PSScriptRoot

trap {
  Write-Host "  [备份失败] $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDirectory = Join-Path $PSScriptRoot "backups\$timestamp"
New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
Write-Host "  备份目录：$backupDirectory" -ForegroundColor DarkCyan

Write-Host "  [1/4] 导出 PostgreSQL 数据库..." -ForegroundColor Cyan
docker exec pms-postgres pg_dump -U pms -Fc --no-owner --no-privileges -f "/tmp/database-$timestamp.dump" pms
if ($LASTEXITCODE -ne 0) {
  throw "PostgreSQL 数据库导出失败。"
}
Write-Host "    [成功] PostgreSQL 数据库已导出" -ForegroundColor Green

Write-Host "  [2/4] 复制数据库备份到宿主机..." -ForegroundColor Cyan
docker cp "pms-postgres:/tmp/database-$timestamp.dump" "$backupDirectory\database.dump"
if ($LASTEXITCODE -ne 0) {
  throw "PostgreSQL 备份文件复制失败。"
}
Write-Host "    [成功] 数据库备份已保存" -ForegroundColor Green

Write-Host "  [3/4] 备份项目上传文档..." -ForegroundColor Cyan
docker exec pms sh -c "tar -czf /tmp/project-documents-$timestamp.tar.gz -C /app/.local-runtime project-documents"
$documentBackupCreated = $LASTEXITCODE -eq 0
if ($documentBackupCreated) {
  docker cp "pms:/tmp/project-documents-$timestamp.tar.gz" "$backupDirectory\project-documents.tar.gz"
  $documentBackupCreated = $LASTEXITCODE -eq 0
}

if (-not $documentBackupCreated) {
  Write-Host "    [提醒] PMS 容器不可用，正在通过临时容器备份文档..." -ForegroundColor Yellow
  $pmsImage = (docker inspect pms --format "{{.Config.Image}}").Trim()
  if ($LASTEXITCODE -ne 0 -or -not $pmsImage) {
    throw "无法读取 PMS 容器信息，不能继续备份项目文档。"
  }

  $backupContainer = "pms-document-backup-$timestamp"
  try {
    docker create --name $backupContainer --volumes-from pms --entrypoint sh $pmsImage -c "tar -czf /tmp/project-documents.tar.gz -C /app/.local-runtime project-documents" *> $null
    if ($LASTEXITCODE -ne 0) {
      throw "创建临时文档备份容器失败。"
    }
    docker start --attach $backupContainer
    if ($LASTEXITCODE -ne 0) {
      throw "项目上传文档备份失败。"
    }
    docker cp "${backupContainer}:/tmp/project-documents.tar.gz" "$backupDirectory\project-documents.tar.gz"
    if ($LASTEXITCODE -ne 0) {
      throw "文档备份文件复制失败。"
    }
  } finally {
    docker rm -f $backupContainer *> $null
  }
}
Write-Host "    [成功] 项目上传文档已备份" -ForegroundColor Green

Write-Host "  [4/4] 生成 SHA256 校验清单..." -ForegroundColor Cyan
$backupFiles = @(
  (Get-Item -LiteralPath (Join-Path $backupDirectory "database.dump"))
  (Get-Item -LiteralPath (Join-Path $backupDirectory "project-documents.tar.gz"))
)
$manifest = [ordered]@{
  schemaVersion = 1
  createdAt = (Get-Date).ToString("o")
  database = "database.dump"
  documents = "project-documents.tar.gz"
  files = @(
    $backupFiles | ForEach-Object {
      [ordered]@{
        name = $_.Name
        bytes = $_.Length
        sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      }
    }
  )
}
$manifestPath = Join-Path $backupDirectory "backup-manifest.json"
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

Write-Host "    [成功] 备份文件 SHA256 校验清单已生成" -ForegroundColor Green
Write-Host "  备份完成：$backupDirectory" -ForegroundColor Green
Write-Host "  校验清单：$manifestPath" -ForegroundColor DarkGray
# update.ps1 parses this stable marker and verifies the hashes before it replaces the application image.
Write-Output "CEASTAR_PMS_BACKUP_DIRECTORY=$backupDirectory"
