$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDirectory = Join-Path $PSScriptRoot "backups\$timestamp"
New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null

docker exec pms-postgres pg_dump -U pms -Fc --no-owner --no-privileges -f "/tmp/database-$timestamp.dump" pms
if ($LASTEXITCODE -ne 0) {
  throw "Failed to back up PostgreSQL."
}
docker cp "pms-postgres:/tmp/database-$timestamp.dump" "$backupDirectory\database.dump"
if ($LASTEXITCODE -ne 0) {
  throw "Failed to copy the PostgreSQL backup."
}

docker exec pms sh -c "tar -czf /tmp/project-documents-$timestamp.tar.gz -C /app/.local-runtime project-documents"
$documentBackupCreated = $LASTEXITCODE -eq 0
if ($documentBackupCreated) {
  docker cp "pms:/tmp/project-documents-$timestamp.tar.gz" "$backupDirectory\project-documents.tar.gz"
  $documentBackupCreated = $LASTEXITCODE -eq 0
}

if (-not $documentBackupCreated) {
  Write-Host "The PMS container is not available. Backing up documents through a temporary container..." -ForegroundColor Yellow
  $pmsImage = (docker inspect pms --format "{{.Config.Image}}").Trim()
  if ($LASTEXITCODE -ne 0 -or -not $pmsImage) {
    throw "Failed to inspect the PMS container for document backup."
  }

  $backupContainer = "pms-document-backup-$timestamp"
  try {
    docker create --name $backupContainer --volumes-from pms --entrypoint sh $pmsImage -c "tar -czf /tmp/project-documents.tar.gz -C /app/.local-runtime project-documents" *> $null
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to create the temporary document backup container."
    }
    docker start --attach $backupContainer
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to back up uploaded project documents."
    }
    docker cp "${backupContainer}:/tmp/project-documents.tar.gz" "$backupDirectory\project-documents.tar.gz"
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to copy the document backup."
    }
  } finally {
    docker rm -f $backupContainer *> $null
  }
}

$backupFiles = @(
  Get-Item -LiteralPath (Join-Path $backupDirectory "database.dump"),
  Get-Item -LiteralPath (Join-Path $backupDirectory "project-documents.tar.gz")
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

Write-Host "Backup completed: $backupDirectory" -ForegroundColor Green
Write-Host "Backup manifest: $manifestPath" -ForegroundColor DarkGray
# update.ps1 parses this stable marker and verifies the hashes before it replaces the application image.
Write-Output "CEASTAR_PMS_BACKUP_DIRECTORY=$backupDirectory"
