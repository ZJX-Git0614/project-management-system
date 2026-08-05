param(
  [switch]$Force
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Assert-LastExitCode([string]$Message) {
  if ($LASTEXITCODE -ne 0) {
    throw $Message
  }
}

function Wait-ForPostgres {
  Write-Host "Waiting for PostgreSQL..." -ForegroundColor Cyan
  for ($attempt = 1; $attempt -le 60; $attempt++) {
    docker exec pms-postgres pg_isready -U pms -d pms *> $null
    if ($LASTEXITCODE -eq 0) {
      return
    }
    Start-Sleep -Seconds 2
  }
  throw "PostgreSQL did not become ready within 120 seconds."
}

function Wait-ForApplication {
  Write-Host "Waiting for Ceastar PMS..." -ForegroundColor Cyan
  for ($attempt = 1; $attempt -le 90; $attempt++) {
    try {
      $response = Invoke-WebRequest -Uri "http://localhost:3000" -UseBasicParsing -TimeoutSec 5
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
        return
      }
    } catch {
      Start-Sleep -Seconds 2
    }
  }
  throw "Ceastar PMS did not become ready within 180 seconds."
}

function New-PrivateSecret {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return ([System.BitConverter]::ToString($bytes)).Replace("-", "").ToLowerInvariant()
}

function Ensure-PrivateEnvironment {
  $environmentPath = Join-Path $PSScriptRoot ".env"
  $existing = if (Test-Path $environmentPath) { Get-Content -LiteralPath $environmentPath } else { @() }
  $values = @{}
  foreach ($line in $existing) {
    if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*"?([^"#\r\n]*)') {
      $values[$matches[1]] = $matches[2].Trim()
    }
  }

  foreach ($key in @("POSTGRES_PASSWORD", "JWT_SECRET", "ASSISTANT_CONFIG_ENCRYPTION_KEY")) {
    $current = [string]($values[$key])
    if (-not $current -or $current -match 'replace-on-install|replace-with|pms-dev-secret') {
      $values[$key] = New-PrivateSecret
    }
  }

  $preserved = $existing | Where-Object { $_ -notmatch '^\s*(POSTGRES_PASSWORD|JWT_SECRET|ASSISTANT_CONFIG_ENCRYPTION_KEY)=' }
  $privateLines = @(
    "POSTGRES_PASSWORD=$($values.POSTGRES_PASSWORD)",
    "JWT_SECRET=$($values.JWT_SECRET)",
    "ASSISTANT_CONFIG_ENCRYPTION_KEY=$($values.ASSISTANT_CONFIG_ENCRYPTION_KEY)"
  )
  Set-Content -LiteralPath $environmentPath -Value @($privateLines + $preserved) -Encoding UTF8
}

if (Test-Path ".installed") {
  if (-not $Force) {
    throw "This package has already been installed. Use start.ps1 to start it. Re-running install requires -Force and will overwrite the target database."
  }
  Write-Host "WARNING: -Force will replace the target database with the packaged backup." -ForegroundColor Yellow
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "Docker Desktop is not installed or docker.exe is not in PATH."
}

Ensure-PrivateEnvironment

$assistantBridgeInstaller = Join-Path $PSScriptRoot "install-assistant-service-bridge.ps1"
if (-not (Test-Path $assistantBridgeInstaller)) {
  throw "Missing deployment file: install-assistant-service-bridge.ps1"
}
& $assistantBridgeInstaller -DeploymentDirectory $PSScriptRoot -SourceDirectory $PSScriptRoot

docker info *> $null
Assert-LastExitCode "Docker Desktop is not running. Start Docker Desktop and retry."

$requiredFiles = @(
  ".env",
  "docker-compose.yml",
  "images\ceastar-pms-linux-amd64.tar",
  "images\postgres-16-alpine-linux-amd64.tar",
  "data\database.dump",
  "data\project-documents.tar.gz"
)

foreach ($file in $requiredFiles) {
  if (-not (Test-Path $file)) {
    throw "Missing deployment file: $file"
  }
}

Write-Host "Loading offline Docker images..." -ForegroundColor Cyan
docker load --input ".\images\postgres-16-alpine-linux-amd64.tar"
Assert-LastExitCode "Failed to load the PostgreSQL image."
docker load --input ".\images\ceastar-pms-linux-amd64.tar"
Assert-LastExitCode "Failed to load the Ceastar PMS image."

Write-Host "Starting PostgreSQL..." -ForegroundColor Cyan
docker compose up -d postgres
Assert-LastExitCode "Failed to start PostgreSQL."
Wait-ForPostgres

docker compose stop pms *> $null

Write-Host "Restoring the packaged database..." -ForegroundColor Cyan
docker cp ".\data\database.dump" "pms-postgres:/tmp/database.dump"
Assert-LastExitCode "Failed to copy the database backup into PostgreSQL."
docker exec pms-postgres dropdb -U pms --if-exists --force pms
Assert-LastExitCode "Failed to reset the target database."
docker exec pms-postgres createdb -U pms -O pms pms
Assert-LastExitCode "Failed to create the target database."
docker exec pms-postgres pg_restore -U pms -d pms --exit-on-error --no-owner --no-privileges /tmp/database.dump
Assert-LastExitCode "Failed to restore the database backup."

Write-Host "Starting Ceastar PMS..." -ForegroundColor Cyan
docker compose up -d pms
Assert-LastExitCode "Failed to start Ceastar PMS."
Wait-ForApplication

Write-Host "Restoring uploaded project documents..." -ForegroundColor Cyan
docker cp ".\data\project-documents.tar.gz" "pms:/tmp/project-documents.tar.gz"
Assert-LastExitCode "Failed to copy the document backup into Ceastar PMS."
docker exec pms sh -c "mkdir -p /app/.local-runtime && tar -xzf /tmp/project-documents.tar.gz -C /app/.local-runtime"
Assert-LastExitCode "Failed to restore uploaded project documents."
docker compose restart pms
Assert-LastExitCode "Failed to restart Ceastar PMS."

Wait-ForApplication

Write-Host "MPP export service setup was skipped during installation." -ForegroundColor DarkYellow
Write-Host "After installation completes, run repair-mpp-export-service.bat as Administrator only when binary MPP export is required." -ForegroundColor DarkYellow

Set-Content -Path ".installed" -Value (Get-Date -Format "yyyy-MM-dd HH:mm:ss") -Encoding UTF8

try {
  $ruleName = "Ceastar PMS TCP 3000"
  $existingRule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
  if (-not $existingRule) {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 | Out-Null
  }
} catch {
  Write-Host "Port 3000 firewall rule was not created. Run this script as Administrator or allow TCP 3000 manually." -ForegroundColor Yellow
}

$lanIp = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
  Select-Object -ExpandProperty IPAddress -First 1

Write-Host ""
Write-Host "Installation completed." -ForegroundColor Green
Write-Host "Local URL: http://localhost:3000"
if ($lanIp) {
  Write-Host "LAN URL:   http://${lanIp}:3000"
}
Write-Host "Use start.ps1 and stop.ps1 for normal service control."
