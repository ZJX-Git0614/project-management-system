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
if ($LASTEXITCODE -ne 0) {
  throw "Failed to back up uploaded project documents."
}
docker cp "pms:/tmp/project-documents-$timestamp.tar.gz" "$backupDirectory\project-documents.tar.gz"
if ($LASTEXITCODE -ne 0) {
  throw "Failed to copy the document backup."
}

Write-Host "Backup completed: $backupDirectory" -ForegroundColor Green
