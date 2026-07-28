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
    if (Test-Path (Join-Path $candidate "docker-compose.yml")) {
      return $candidate
    }
  }

  throw "Deployment directory was not found. Put this update folder directly inside the installed Ceastar PMS directory."
}

function Wait-ForApplication {
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

$deploymentDirectory = Find-DeploymentDirectory
$stateFile = Join-Path $deploymentDirectory ".ceastar-update-20260728-2.state"
if (-not (Test-Path $stateFile)) {
  throw "Update state was not found. Rollback is unavailable."
}

$state = @{}
Get-Content $stateFile | ForEach-Object {
  $parts = $_ -split "=", 2
  if ($parts.Count -eq 2) {
    $state[$parts[0]] = $parts[1]
  }
}

$composeImage = $state["composeImage"]
$rollbackImage = $state["rollbackImage"]
if (-not $composeImage -or -not $rollbackImage) {
  throw "Update state is incomplete. Rollback is unavailable."
}

Set-Location $deploymentDirectory
docker info *> $null
Assert-LastExitCode "Docker Desktop is not running."
docker image inspect $rollbackImage *> $null
Assert-LastExitCode "The preserved rollback image is missing."

Write-Host "Creating a safety backup before rollback..." -ForegroundColor Cyan
& (Join-Path $deploymentDirectory "backup.ps1")

docker tag $rollbackImage $composeImage
Assert-LastExitCode "Failed to activate the rollback image."
docker compose up -d --no-deps --force-recreate pms
Assert-LastExitCode "Failed to recreate the Ceastar PMS container."
Wait-ForApplication

Write-Host "Ceastar PMS rollback completed." -ForegroundColor Green
Write-Host "URL: http://localhost:3000"
