param(
  [string]$DeploymentDirectory = $PSScriptRoot,
  [int]$Port = 3210,
  [string]$ProjectPowerShellPath = "",
  [string]$ProjectProgId = "",
  [switch]$SkipContainerRestart
)

$ErrorActionPreference = "Stop"

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Set-EnvValue([string]$Path, [string]$Name, [string]$Value) {
  $content = if (Test-Path $Path) { [System.IO.File]::ReadAllText($Path) } else { "" }
  $line = "$Name=$Value"
  $pattern = "(?m)^$([regex]::Escape($Name))=.*$"
  if ([regex]::IsMatch($content, $pattern)) {
    $content = [regex]::Replace($content, $pattern, $line)
  } else {
    if ($content -and -not $content.EndsWith("`n")) { $content += "`r`n" }
    $content += "$line`r`n"
  }
  [System.IO.File]::WriteAllText($Path, $content, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-EnvValue([string]$Path, [string]$Name) {
  if (-not (Test-Path $Path)) { return "" }
  $content = [System.IO.File]::ReadAllText($Path)
  $pattern = "(?m)^$([regex]::Escape($Name))=(.*)$"
  $match = [regex]::Match($content, $pattern)
  if (-not $match.Success) { return "" }
  return $match.Groups[1].Value.Trim()
}

function New-ServiceToken {
  $bytes = New-Object byte[] 32
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
  return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function Test-ProjectComAutomation([string]$PowerShellPath) {
  $probe = @'
$ErrorActionPreference = "Stop"
$progIds = @("MSProject.Application", "MSProject.Application.16", "MSProject.Application.15", "MSProject.Application.14", "MSProject.Application.12")
foreach ($progId in $progIds) {
  $application = $null
  try {
    $application = New-Object -ComObject $progId
    $application.Visible = $false
    [Console]::Out.Write($progId)
    exit 0
  } catch {
    # Try the next registered Microsoft Project COM ProgID.
  } finally {
    if ($application) {
      try { $application.Quit() } catch {}
      try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($application) } catch {}
    }
  }
}
exit 1
'@
  $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($probe))
  $output = & $PowerShellPath -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded 2>$null
  if ($LASTEXITCODE -ne 0) { return "" }
  return (($output | Select-Object -Last 1) -as [string]).Trim()
}

function Find-ProjectAutomationHost {
  $candidates = @(
    (Join-Path $env:WINDIR "System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
    (Join-Path $env:WINDIR "SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe")
  )
  if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) {
    $candidates += (Join-Path $env:WINDIR "Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe")
  }

  foreach ($candidate in ($candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique)) {
    $progId = Test-ProjectComAutomation $candidate
    if ($progId) {
      return [pscustomobject]@{ PowerShellPath = $candidate; ProgId = $progId }
    }
  }
  return $null
}

function Wait-ForServiceHealth([int]$ServicePort, [string]$ServiceToken) {
  $headers = @{ Authorization = "Bearer $ServiceToken" }
  $lastError = "No response"
  for ($attempt = 1; $attempt -le 15; $attempt++) {
    try {
      $health = Invoke-WebRequest -Uri "http://127.0.0.1:$ServicePort/health" -Headers $headers -UseBasicParsing -TimeoutSec 5
      if ($health.StatusCode -eq 200) { return }
      $lastError = "HTTP $($health.StatusCode)"
    } catch {
      $lastError = $_.Exception.Message
    }
    Start-Sleep -Seconds 1
  }
  throw "MPP export service health check failed after restart: $lastError"
}

$requestedDeploymentDirectory = $DeploymentDirectory
$requestedComposePath = Join-Path $requestedDeploymentDirectory "docker-compose.yml"
if (-not (Test-Path $requestedComposePath)) {
  $parentDirectory = Split-Path -Parent $PSScriptRoot
  if (Test-Path (Join-Path $parentDirectory "docker-compose.yml")) {
    $DeploymentDirectory = $parentDirectory
  }
}

$serviceSource = Join-Path $PSScriptRoot "mpp-export-service.ps1"
$serviceDirectory = Join-Path $DeploymentDirectory "tools\mpp-export-service"
$servicePath = Join-Path $serviceDirectory "mpp-export-service.ps1"
$envPath = Join-Path $DeploymentDirectory ".env"
$composePath = Join-Path $DeploymentDirectory "docker-compose.yml"

if (-not (Test-Path $serviceSource)) { throw "Missing mpp-export-service.ps1." }
if (-not (Test-Path $composePath)) { throw "The deployment docker-compose.yml was not found." }

$projectAutomation = $null
if ($ProjectPowerShellPath -and $ProjectProgId -and (Test-Path $ProjectPowerShellPath)) {
  $verifiedProgId = Test-ProjectComAutomation $ProjectPowerShellPath
  if ($verifiedProgId -eq $ProjectProgId) {
    $projectAutomation = [pscustomobject]@{ PowerShellPath = $ProjectPowerShellPath; ProgId = $ProjectProgId }
  }
}
if (-not $projectAutomation) {
  $projectAutomation = Find-ProjectAutomationHost
}
if (-not $projectAutomation) {
  Write-Host "No usable Microsoft Project COM automation interface was detected. MPP export remains disabled; Excel and Project XML export are still available." -ForegroundColor Yellow
  Write-Host "The check covers both 32-bit and 64-bit Windows PowerShell. Repair the Microsoft Project installation or run this script under the Windows account that installed Project." -ForegroundColor Yellow
  return
}

if (-not (Test-Administrator)) {
  $arguments = @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"",
    "-DeploymentDirectory", "`"$DeploymentDirectory`"", "-Port", $Port,
    "-ProjectPowerShellPath", "`"$($projectAutomation.PowerShellPath)`"",
    "-ProjectProgId", "`"$($projectAutomation.ProgId)`""
  )
  if ($SkipContainerRestart) { $arguments += "-SkipContainerRestart" }
  $process = Start-Process powershell.exe -Verb RunAs -ArgumentList $arguments -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "MPP export service installation was cancelled or failed." }
  return
}

New-Item -ItemType Directory -Path $serviceDirectory -Force | Out-Null
Copy-Item -Path $serviceSource -Destination $servicePath -Force

$token = Get-EnvValue $envPath "PROJECT_MPP_EXPORT_SERVICE_TOKEN"
if (-not $token) { $token = New-ServiceToken }
Set-EnvValue $envPath "PROJECT_MPP_EXPORT_SERVICE_URL" "http://host.docker.internal:$Port/convert"
Set-EnvValue $envPath "PROJECT_MPP_EXPORT_SERVICE_HEALTH_URL" "http://host.docker.internal:$Port/health"
Set-EnvValue $envPath "PROJECT_MPP_EXPORT_SERVICE_TOKEN" $token

$compose = [System.IO.File]::ReadAllText($composePath)
$missingComposeVariables = @(
  "PROJECT_MPP_EXPORT_SERVICE_URL",
  "PROJECT_MPP_EXPORT_SERVICE_HEALTH_URL",
  "PROJECT_MPP_EXPORT_SERVICE_TOKEN"
) | Where-Object { $compose -notmatch "(?m)^\s*-?\s*$([regex]::Escape($_))(?::|=)" }
if ($missingComposeVariables.Count -gt 0) {
  $pattern = '(?m)^([ \t]*)(-?[ \t]*)(?:PROJECT_MPP_EXPORT_SERVICE_URL|PROJECT_DOCUMENT_STORAGE_DIR|DATABASE_URL)(?::|=)[^\n]*$'
  $match = [regex]::Match($compose, $pattern)
  if (-not $match.Success) { throw "The PMS environment section was not found in docker-compose.yml." }
  $listStyle = $match.Groups[2].Value.Trim().StartsWith("-")
  $newLines = $missingComposeVariables | ForEach-Object {
    if ($listStyle) {
      '- ' + $_ + '=${' + $_ + ':-}'
    } else {
      $_ + ': ${' + $_ + ':-}'
    }
  }
  $lineBreak = if ($compose.Contains("`r`n")) { "`r`n" } else { "`n" }
  $replacement = $match.Value + $lineBreak + (($newLines | ForEach-Object { $match.Groups[1].Value + $_ }) -join $lineBreak)
  $compose = $compose.Substring(0, $match.Index) + $replacement + $compose.Substring($match.Index + $match.Length)
  [System.IO.File]::WriteAllText($composePath, $compose, (New-Object System.Text.UTF8Encoding($false)))
}

$user = "$env:USERDOMAIN\$env:USERNAME"
& netsh http delete urlacl url="http://+:$Port/" *> $null
& netsh http add urlacl url="http://+:$Port/" user="$user" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Failed to reserve the MPP export service URL." }

$firewallRuleName = "Ceastar PMS MPP Export Service"
Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $firewallRuleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Private | Out-Null

$taskName = "Ceastar PMS MPP Export Service"
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existingTask) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  for ($attempt = 1; $attempt -le 10; $attempt++) {
    $state = (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue).State
    if ($state -ne "Running") { break }
    Start-Sleep -Milliseconds 500
  }
}
$actionArguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$servicePath`" -Port $Port -ConfigPath `"$envPath`" -ProjectProgId `"$($projectAutomation.ProgId)`""
$action = New-ScheduledTaskAction -Execute $projectAutomation.PowerShellPath -Argument $actionArguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -User $user -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Wait-ForServiceHealth $Port $token

if (-not $SkipContainerRestart) {
  Push-Location $DeploymentDirectory
  try { docker compose up -d --no-deps --force-recreate pms | Out-Null } finally { Pop-Location }
}
Write-Host "MPP export service installed and enabled with $($projectAutomation.ProgId)." -ForegroundColor Green
