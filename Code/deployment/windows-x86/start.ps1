$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

docker info *> $null
if ($LASTEXITCODE -ne 0) {
  throw "Docker Desktop is not running."
}

docker compose up -d
if ($LASTEXITCODE -ne 0) {
  throw "Failed to start Ceastar PMS."
}

Write-Host "Ceastar PMS is running at http://localhost:3000" -ForegroundColor Green
