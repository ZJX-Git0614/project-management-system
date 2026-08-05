param(
  [Parameter(Mandatory = $true)]
  [string]$DeploymentDirectory,
  [string]$SourceDirectory = $PSScriptRoot
)

$ErrorActionPreference = "Stop"
$runtimeDirectory = Join-Path $env:ProgramData "Ceastar-PMS\assistant-services"
$tokenPath = Join-Path $runtimeDirectory "bridge-token.txt"
$environmentPath = Join-Path $DeploymentDirectory ".env"
$composePath = Join-Path $DeploymentDirectory "docker-compose.yml"
$taskName = "Ceastar-PMS-Assistant-Service-Bridge"
$firewallRuleName = "Ceastar PMS Assistant Service Bridge"

function New-PrivateToken {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return ([System.BitConverter]::ToString($bytes)).Replace("-", "").ToLowerInvariant()
}

function Read-EnvironmentValues {
  $values = @{}
  if (-not (Test-Path $environmentPath)) { return $values }
  foreach ($line in Get-Content -LiteralPath $environmentPath) {
    if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*"?([^"#\r\n]*)') { $values[$matches[1]] = $matches[2].Trim() }
  }
  return $values
}

function Set-EnvironmentValue([string]$Name, [string]$Value) {
  $lines = if (Test-Path $environmentPath) { @(Get-Content -LiteralPath $environmentPath) } else { @() }
  $replacement = "$Name=$Value"
  $matched = $false
  $next = foreach ($line in $lines) {
    if ($line -match "^\s*$([regex]::Escape($Name))=") {
      $matched = $true
      $replacement
    } else { $line }
  }
  if (-not $matched) { $next += $replacement }
  Set-Content -LiteralPath $environmentPath -Value $next -Encoding UTF8
}

function Ensure-ComposeEnvironment {
  $content = [System.IO.File]::ReadAllText($composePath).Replace("`r`n", "`n")
  $anchor = [regex]::Match($content, '(?m)^([ \t]*)(-?[ \t]*)ASSISTANT_CONFIG_ENCRYPTION_KEY(?::|=)[^\n]*$')
  if (-not $anchor.Success) { throw "docker-compose.yml 中未找到智能助手环境变量区域。" }
  $isList = $anchor.Groups[2].Value.Trim().StartsWith("-")
  $indent = $anchor.Groups[1].Value
  $lines = @()
  if ($content -notmatch '(?m)^\s*-?\s*ASSISTANT_SERVICE_MANAGER_URL(?::|=)') {
    $lines += if ($isList) { '- ASSISTANT_SERVICE_MANAGER_URL=${ASSISTANT_SERVICE_MANAGER_URL:-http://host.docker.internal:8766}' } else { 'ASSISTANT_SERVICE_MANAGER_URL: ${ASSISTANT_SERVICE_MANAGER_URL:-http://host.docker.internal:8766}' }
  }
  if ($content -notmatch '(?m)^\s*-?\s*ASSISTANT_SERVICE_MANAGER_TOKEN(?::|=)') {
    $lines += if ($isList) { '- ASSISTANT_SERVICE_MANAGER_TOKEN=${ASSISTANT_SERVICE_MANAGER_TOKEN:-}' } else { 'ASSISTANT_SERVICE_MANAGER_TOKEN: ${ASSISTANT_SERVICE_MANAGER_TOKEN:-}' }
  }
  if ($lines.Count -gt 0) {
    $insertion = $anchor.Value + "`n" + (($lines | ForEach-Object { $indent + $_ }) -join "`n")
    $content = $content.Substring(0, $anchor.Index) + $insertion + $content.Substring($anchor.Index + $anchor.Length)
    [System.IO.File]::WriteAllText($composePath, $content, (New-Object System.Text.UTF8Encoding($false)))
  }
}

New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
foreach ($fileName in @("assistant-services.ps1", "assistant-service-watchdog.ps1", "assistant-service-bridge.ps1")) {
  $sourcePath = Join-Path $SourceDirectory $fileName
  if (-not (Test-Path $sourcePath)) { throw "缺少智能助手服务文件：$sourcePath" }
  Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $runtimeDirectory $fileName) -Force
}

$values = Read-EnvironmentValues
$token = [string]$values.ASSISTANT_SERVICE_MANAGER_TOKEN
if (-not $token) { $token = New-PrivateToken }
Set-Content -LiteralPath $tokenPath -Value $token -Encoding ASCII
Set-EnvironmentValue "ASSISTANT_SERVICE_MANAGER_URL" "http://host.docker.internal:8766"
Set-EnvironmentValue "ASSISTANT_SERVICE_MANAGER_TOKEN" $token
Ensure-ComposeEnvironment

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $runtimeDirectory "assistant-services.ps1") -Action Status *> $null
$bridgePath = Join-Path $runtimeDirectory "assistant-service-bridge.ps1"
$taskAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$bridgePath`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 3650) -StartWhenAvailable
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}
Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
if (-not (Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName $firewallRuleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8766 -RemoteAddress LocalSubnet -Profile Any | Out-Null
}
Start-ScheduledTask -TaskName $taskName
