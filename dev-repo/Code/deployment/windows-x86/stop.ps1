$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

docker compose stop
if ($LASTEXITCODE -ne 0) {
  throw "Failed to stop Ceastar PMS."
}

Write-Host "Ceastar PMS has stopped. Database and documents are preserved." -ForegroundColor Green
