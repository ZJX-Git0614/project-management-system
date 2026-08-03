param(
  [string]$ComposeCompatibilityTestDirectory = ""
)

$ErrorActionPreference = "Stop"

function Assert-LastExitCode([string]$Message) {
  if ($LASTEXITCODE -ne 0) {
    throw $Message
  }
}

function Find-DeploymentDirectory {
  $candidates = @(
    $PSScriptRoot,
    (Split-Path -Parent $PSScriptRoot)
  )

  foreach ($candidate in $candidates) {
    if ((Test-Path (Join-Path $candidate "docker-compose.yml")) -and
        (Test-Path (Join-Path $candidate "backup.ps1"))) {
      return $candidate
    }
  }

  throw "Deployment directory was not found. Put this update folder directly inside the installed Ceastar PMS directory."
}

function Wait-ForApplication {
  Write-Host "Waiting for Ceastar PMS..." -ForegroundColor Cyan
  for ($attempt = 1; $attempt -le 90; $attempt++) {
    try {
      $response = Invoke-WebRequest -Uri "http://localhost:3000/login" -UseBasicParsing -TimeoutSec 5
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
        return
      }
    } catch {
      Start-Sleep -Seconds 2
    }
  }
  throw "Ceastar PMS did not become ready within 180 seconds."
}

function Assert-VerifiedBackup([string]$BackupDirectory) {
  $manifestPath = Join-Path $BackupDirectory "backup-manifest.json"
  if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "The pre-update backup manifest is missing: $manifestPath"
  }

  try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  } catch {
    throw "The pre-update backup manifest cannot be read: $manifestPath"
  }

  if (-not $manifest.files -or $manifest.files.Count -lt 2) {
    throw "The pre-update backup manifest is incomplete: $manifestPath"
  }

  foreach ($file in $manifest.files) {
    $filePath = Join-Path $BackupDirectory ([string]$file.name)
    if (-not (Test-Path -LiteralPath $filePath)) {
      throw "The pre-update backup file is missing: $filePath"
    }
    $actualHash = (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne ([string]$file.sha256).ToLowerInvariant()) {
      throw "The pre-update backup checksum does not match: $filePath"
    }
  }
}

function Show-StorageProtectionStatus([string]$Directory) {
  $drive = [System.IO.Path]::GetPathRoot((Resolve-Path -LiteralPath $Directory).Path)
  if (-not $drive) {
    Write-Host "Storage encryption status could not be determined." -ForegroundColor Yellow
    return
  }

  $bitLockerCommand = Get-Command Get-BitLockerVolume -ErrorAction SilentlyContinue
  if (-not $bitLockerCommand) {
    Write-Host "Storage encryption was not checked automatically. Protect the drive containing $Directory with BitLocker or device encryption." -ForegroundColor Yellow
    return
  }

  try {
    $volume = Get-BitLockerVolume -MountPoint $drive -ErrorAction Stop
    if ($volume.ProtectionStatus -eq "On") {
      Write-Host "Database storage protection: BitLocker is enabled on $drive" -ForegroundColor Green
    } else {
      Write-Host "Database storage protection warning: BitLocker is not enabled on $drive. Enable BitLocker or move the deployment to an encrypted drive." -ForegroundColor Yellow
    }
  } catch {
    Write-Host "Storage encryption was not checked automatically. Protect the drive containing $Directory with BitLocker or device encryption." -ForegroundColor Yellow
  }
}

function Ensure-CompatibleSystemBackupConfiguration([string]$Directory) {
  $composePath = Join-Path $Directory "docker-compose.yml"
  $content = [System.IO.File]::ReadAllText($composePath)
  $lineBreak = if ($content.Contains("`r`n")) { "`r`n" } else { "`n" }
  $updated = $content.Replace("`r`n", "`n")
  $changed = $false

  $backupDirectoryPattern = '(?m)^([ \t]*)(?:-[ \t]*)?SYSTEM_BACKUP_DIR(?::|=)[^\n]*$'
  if (-not [regex]::IsMatch($updated, $backupDirectoryPattern)) {
    $environmentAnchorPattern = '(?m)^([ \t]*)(-?[ \t]*)(?:PROJECT_DOCUMENT_STORAGE_DIR|DATABASE_URL)(?::|=)[^\n]*$'
    $environmentAnchorMatch = [regex]::Match($updated, $environmentAnchorPattern)
    if (-not $environmentAnchorMatch.Success) {
      throw "The deployment docker-compose.yml does not contain a supported PMS environment section. The file cannot be upgraded safely."
    }
    $backupDirectoryLine = if ($environmentAnchorMatch.Groups[2].Value.Trim().StartsWith("-")) {
      '- SYSTEM_BACKUP_DIR=/app/.local-runtime/system-backups'
    } else {
      'SYSTEM_BACKUP_DIR: /app/.local-runtime/system-backups'
    }
    $environmentLines = $environmentAnchorMatch.Value + "`n" + $environmentAnchorMatch.Groups[1].Value + $backupDirectoryLine
    $updated = $updated.Substring(0, $environmentAnchorMatch.Index) + $environmentLines + $updated.Substring($environmentAnchorMatch.Index + $environmentAnchorMatch.Length)
    $changed = $true
  }

  $allowedRootsPattern = '(?m)^([ \t]*)(?:-[ \t]*)?SYSTEM_BACKUP_ALLOWED_ROOTS(?::|=)[^\n]*$'
  if (-not [regex]::IsMatch($updated, $allowedRootsPattern)) {
    $backupDirectoryMatch = [regex]::Match($updated, $backupDirectoryPattern)
    $allowedRootsLine = if ($backupDirectoryMatch.Value.TrimStart().StartsWith("-")) {
      '- SYSTEM_BACKUP_ALLOWED_ROOTS=/app/.local-runtime/system-backups,/data/system-backups'
    } else {
      'SYSTEM_BACKUP_ALLOWED_ROOTS: /app/.local-runtime/system-backups,/data/system-backups'
    }
    $environmentLines = $backupDirectoryMatch.Value + "`n" + $backupDirectoryMatch.Groups[1].Value + $allowedRootsLine
    $updated = $updated.Substring(0, $backupDirectoryMatch.Index) + $environmentLines + $updated.Substring($backupDirectoryMatch.Index + $backupDirectoryMatch.Length)
    $changed = $true
  }

  $configurableMountPattern = '(?m)^[ \t]*-[ \t]*[^\n#]+:/data/system-backups[ \t]*(?:#.*)?$'
  if (-not [regex]::IsMatch($updated, $configurableMountPattern)) {
    $backupMountPattern = '(?m)^([ \t]*)-[ \t]*[^\n#]+:/app/\.local-runtime/system-backups[ \t]*(?:#.*)?$'
    $backupMountMatch = [regex]::Match($updated, $backupMountPattern)
    if ($backupMountMatch.Success) {
      $mountLines = $backupMountMatch.Value.TrimEnd() + "`n" + $backupMountMatch.Groups[1].Value + '- ${PMS_BACKUP_HOST_DIR:-./backups}:/data/system-backups'
      $updated = $updated.Substring(0, $backupMountMatch.Index) + $mountLines + $updated.Substring($backupMountMatch.Index + $backupMountMatch.Length)
    } else {
      $documentMountPattern = '(?m)^([ \t]*)-[ \t]*[^\n#]+:/app/\.local-runtime/project-documents[ \t]*(?:#.*)?$'
      $documentMountMatch = [regex]::Match($updated, $documentMountPattern)
      if (-not $documentMountMatch.Success) {
        throw "The deployment docker-compose.yml does not contain the PMS volume section. The file cannot be upgraded safely."
      }
      $mountLines = $documentMountMatch.Value.TrimEnd() + "`n" + $documentMountMatch.Groups[1].Value + '- ./backups:/app/.local-runtime/system-backups' + "`n" + $documentMountMatch.Groups[1].Value + '- ${PMS_BACKUP_HOST_DIR:-./backups}:/data/system-backups'
      $updated = $updated.Substring(0, $documentMountMatch.Index) + $mountLines + $updated.Substring($documentMountMatch.Index + $documentMountMatch.Length)
    }
    $changed = $true
  }

  if (-not $changed) {
    return
  }

  $backupPath = "$composePath.before-update-20260803-3"
  if (-not (Test-Path $backupPath)) {
    [System.IO.File]::Copy($composePath, $backupPath, $false)
  }
  if ($lineBreak -eq "`r`n") {
    $updated = $updated.Replace("`n", "`r`n")
  }
  [System.IO.File]::WriteAllText($composePath, $updated, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "System backup configuration upgraded. Original compose file: $backupPath" -ForegroundColor Cyan
}

if ($ComposeCompatibilityTestDirectory) {
  Ensure-CompatibleSystemBackupConfiguration $ComposeCompatibilityTestDirectory
  return
}

$deploymentDirectory = Find-DeploymentDirectory
Show-StorageProtectionStatus $deploymentDirectory
$imageNameFile = Join-Path $PSScriptRoot "image-name.txt"
$imageHashFile = Join-Path $PSScriptRoot "image.sha256"
$imageDirectory = Join-Path $PSScriptRoot "images"
$packagedBackupScript = Join-Path $PSScriptRoot "backup.ps1"

if (-not (Test-Path $imageNameFile)) {
  throw "Missing image-name.txt in the update package."
}
if (-not (Test-Path $imageHashFile)) {
  throw "Missing image.sha256 in the update package."
}

$imageFiles = @(Get-ChildItem -Path $imageDirectory -Filter "*.tar" -File -ErrorAction SilentlyContinue)
if ($imageFiles.Count -ne 1) {
  throw "The update package must contain exactly one Docker image tar file."
}

$newImage = (Get-Content -Path $imageNameFile -Raw).Trim()
if (-not $newImage) {
  throw "image-name.txt is empty."
}

$hashContent = (Get-Content -LiteralPath $imageHashFile -Raw).Trim()
$hashMatch = [regex]::Match($hashContent, '(?i)(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])')
if (-not $hashMatch.Success) {
  throw "image.sha256 does not contain a valid SHA256 checksum."
}
$expectedHash = $hashMatch.Value.ToLowerInvariant()
$actualHash = (Get-FileHash -LiteralPath $imageFiles[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant()
if ($expectedHash -ne $actualHash) {
  throw "The update image checksum does not match. Expected: $expectedHash; actual: $actualHash. Copy the complete update package again."
}

Set-Location $deploymentDirectory

docker info *> $null
Assert-LastExitCode "Docker Desktop is not running."

$composeImage = ""
$containerId = docker ps -a --filter "name=^/pms$" --format "{{.ID}}" | Select-Object -First 1
if ($containerId) {
  $composeImage = (docker inspect pms --format "{{.Config.Image}}").Trim()
  Assert-LastExitCode "Failed to inspect the current PMS container."
} else {
  $composeImage = docker compose config --images |
    Where-Object { $_ -like "ceastar-project-management:*" } |
    Select-Object -First 1
}

if (-not $composeImage) {
  throw "The current Ceastar PMS image name could not be determined."
}

$rollbackImage = "ceastar-project-management:rollback-20260803-3-amd64"
docker image inspect $composeImage *> $null
Assert-LastExitCode "The current Ceastar PMS image is missing."
docker tag $composeImage $rollbackImage
Assert-LastExitCode "Failed to preserve the rollback image."

if (Test-Path $packagedBackupScript) {
  Copy-Item -LiteralPath $packagedBackupScript -Destination (Join-Path $deploymentDirectory "backup.ps1") -Force
}

Write-Host "Creating a database and document backup..." -ForegroundColor Cyan
$backupOutput = @(& (Join-Path $deploymentDirectory "backup.ps1") 2>&1 | ForEach-Object { $_.ToString() })
$backupOutput | ForEach-Object { Write-Host $_ }
$backupDirectoryLine = $backupOutput |
  Where-Object { $_ -like "CEASTAR_PMS_BACKUP_DIRECTORY=*" } |
  Select-Object -Last 1
if (-not $backupDirectoryLine) {
  throw "The pre-update backup did not report its directory. The update was stopped before changing the application."
}
$preUpdateBackupDirectory = $backupDirectoryLine.Substring("CEASTAR_PMS_BACKUP_DIRECTORY=".Length)
Assert-VerifiedBackup $preUpdateBackupDirectory
Write-Host "Pre-update backup verified: $preUpdateBackupDirectory" -ForegroundColor Green
Ensure-CompatibleSystemBackupConfiguration $deploymentDirectory

Write-Host "MPP export service setup was skipped during update." -ForegroundColor DarkYellow
Write-Host "After the update completes, run repair-mpp-export-service.bat as Administrator only when binary MPP export is required." -ForegroundColor DarkYellow

Write-Host "Loading the offline update image..." -ForegroundColor Cyan
docker load --input $imageFiles[0].FullName
Assert-LastExitCode "Failed to load the update image."
docker image inspect $newImage *> $null
Assert-LastExitCode "The expected update image was not found after loading."

if ($newImage -ne $composeImage) {
  docker tag $newImage $composeImage
  Assert-LastExitCode "Failed to activate the update image tag."
}

Write-Host "Recreating the application container..." -ForegroundColor Cyan
docker compose up -d --no-deps --force-recreate pms
Assert-LastExitCode "Failed to recreate the Ceastar PMS container."
Wait-ForApplication

$state = @(
  "composeImage=$composeImage",
  "newImage=$newImage",
  "rollbackImage=$rollbackImage",
  "updatedAt=$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
)
Set-Content -Path (Join-Path $deploymentDirectory ".ceastar-update-20260803-3.state") -Value $state -Encoding ASCII

Write-Host ""
Write-Host "Ceastar PMS update completed successfully." -ForegroundColor Green
Write-Host "URL: http://localhost:3000"
Write-Host "Rollback image: $rollbackImage"
