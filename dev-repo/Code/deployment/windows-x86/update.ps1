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

function Ensure-ConfigurableBackupMount([string]$Directory) {
  $composePath = Join-Path $Directory "docker-compose.yml"
  $content = [System.IO.File]::ReadAllText($composePath)
  if ($content.Contains('/data/system-backups')) {
    return
  }

  $lineBreak = if ($content.Contains("`r`n")) { "`r`n" } else { "`n" }
  $pattern = '(?m)^([ \t]*-[ \t]*\./backups:/app/\.local-runtime/system-backups[ \t]*)$'
  if (-not [regex]::IsMatch($content, $pattern)) {
    throw "The deployment docker-compose.yml does not contain the expected backup volume mapping. Add a /data/system-backups mount before updating."
  }

  $backupPath = "$composePath.before-update-20260727-3"
  [System.IO.File]::Copy($composePath, $backupPath, $true)
  $replacement = '$1' + $lineBreak + '      - ${PMS_BACKUP_HOST_DIR:-./backups}:/data/system-backups'
  $composeMatcher = New-Object System.Text.RegularExpressions.Regex($pattern)
  $updated = $composeMatcher.Replace($content, $replacement, 1)
  [System.IO.File]::WriteAllText($composePath, $updated, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "Configurable backup directory mount added. Original compose file: $backupPath" -ForegroundColor Cyan
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

$rollbackImage = "ceastar-project-management:rollback-20260727-3-amd64"
docker image inspect $composeImage *> $null
Assert-LastExitCode "The current Ceastar PMS image is missing."
docker tag $composeImage $rollbackImage
Assert-LastExitCode "Failed to preserve the rollback image."

Write-Host "Creating a database and document backup..." -ForegroundColor Cyan
& (Join-Path $deploymentDirectory "backup.ps1")
Ensure-ConfigurableBackupMount $deploymentDirectory

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
Set-Content -Path (Join-Path $deploymentDirectory ".ceastar-update-20260727-3.state") -Value $state -Encoding ASCII

Write-Host ""
Write-Host "Ceastar PMS update completed successfully." -ForegroundColor Green
Write-Host "URL: http://localhost:3000"
Write-Host "Rollback image: $rollbackImage"
