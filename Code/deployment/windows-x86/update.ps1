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

  $backupPath = "$composePath.before-update-20260729-1"
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
$imageNameFile = Join-Path $PSScriptRoot "image-name.txt"
$imageHashFile = Join-Path $PSScriptRoot "image.sha256"
$imageDirectory = Join-Path $PSScriptRoot "images"

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

$expectedHash = (Get-Content -Path $imageHashFile -Raw).Trim().ToLowerInvariant()
$actualHash = (Get-FileHash -Path $imageFiles[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant()
if ($expectedHash -ne $actualHash) {
  throw "The update image checksum does not match. Copy the update package again."
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

$rollbackImage = "ceastar-project-management:rollback-20260729-1-amd64"
docker image inspect $composeImage *> $null
Assert-LastExitCode "The current Ceastar PMS image is missing."
docker tag $composeImage $rollbackImage
Assert-LastExitCode "Failed to preserve the rollback image."

Write-Host "Creating a database and document backup..." -ForegroundColor Cyan
& (Join-Path $deploymentDirectory "backup.ps1")
Ensure-CompatibleSystemBackupConfiguration $deploymentDirectory

$mppInstaller = Join-Path $PSScriptRoot "install-mpp-export-service.ps1"
if (Test-Path $mppInstaller) {
  try {
    & $mppInstaller -DeploymentDirectory $deploymentDirectory -SkipContainerRestart
  } catch {
    Write-Host "MPP export service was not enabled: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host "The PMS update will continue. Excel and Project XML export remain available." -ForegroundColor Yellow
  }
}

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
Set-Content -Path (Join-Path $deploymentDirectory ".ceastar-update-20260729-1.state") -Value $state -Encoding ASCII

Write-Host ""
Write-Host "Ceastar PMS update completed successfully." -ForegroundColor Green
Write-Host "URL: http://localhost:3000"
Write-Host "Rollback image: $rollbackImage"
