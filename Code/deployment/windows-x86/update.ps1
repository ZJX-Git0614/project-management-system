param(
  [string]$ComposeCompatibilityTestDirectory = ""
)

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

$script:CurrentStep = "初始化更新"
$script:PreUpdateBackupDirectory = ""
$script:CandidateContainer = ""
$script:CandidateDatabase = ""
$script:ComposeImage = ""
$script:RollbackImage = ""
$script:DeploymentDirectory = ""
$script:TagSwitched = $false
$script:CutoverStarted = $false

function Write-Step([int]$Number, [int]$Total, [string]$Message) {
  $script:CurrentStep = $Message
  Write-Host ""
  Write-Host "[$Number/$Total] $Message" -ForegroundColor Cyan
}

function Write-Success([string]$Message) {
  Write-Host "  [成功] $Message" -ForegroundColor Green
}

function Invoke-DockerCommand([string[]]$Arguments, [string]$FailureMessage) {
  $previousErrorActionPreference = $ErrorActionPreference
  $output = @()
  $exitCode = -1
  try {
    # Windows PowerShell 5.1 exposes normal Docker Compose progress on stderr as ErrorRecord objects.
    $ErrorActionPreference = "Continue"
    $output = @(& docker @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }

  if ($exitCode -ne 0) {
    $details = (($output | Select-Object -Last 20 | ForEach-Object { $_.ToString() }) -join "`n").Trim()
    if ($details) {
      throw "$FailureMessage`nDocker 退出码：$exitCode`n$details"
    }
    throw "$FailureMessage Docker 退出码：$exitCode"
  }
}

function Remove-CandidateContainer {
  if (-not $script:CandidateContainer) {
    return
  }
  $candidateId = docker ps -aq --filter "name=^/$($script:CandidateContainer)$" | Select-Object -First 1
  if ($candidateId) {
    docker rm -f $script:CandidateContainer *> $null
  }
  $script:CandidateContainer = ""
}

function Remove-CandidateDatabase {
  if (-not $script:CandidateDatabase) {
    return
  }
  & docker exec pms-postgres dropdb -U pms --if-exists --force $script:CandidateDatabase *> $null
  $script:CandidateDatabase = ""
}

function Restore-BlueApplication {
  if (-not $script:TagSwitched -or -not $script:ComposeImage -or -not $script:RollbackImage) {
    return
  }

  Set-Location $script:DeploymentDirectory
  docker tag $script:RollbackImage $script:ComposeImage
  Assert-LastExitCode "无法恢复更新前镜像标签。"
  if ($script:CutoverStarted) {
    Invoke-DockerCommand -Arguments @("compose", "up", "-d", "--no-deps", "--force-recreate", "pms") -FailureMessage "无法自动恢复更新前应用容器。"
    Wait-ForApplication "http://localhost:3000/login"
  }
  $script:TagSwitched = $false
}

trap {
  $originalError = $_.Exception.Message
  Remove-CandidateContainer
  Remove-CandidateDatabase
  $recoveryMessage = ""
  if ($script:TagSwitched) {
    try {
      Restore-BlueApplication
      $recoveryMessage = if ($script:CutoverStarted) {
        "已自动恢复蓝色旧版本并重新通过健康检查。"
      } else {
        "绿色候选环境未通过，正式应用容器未切换。"
      }
    } catch {
      $recoveryMessage = "自动恢复失败：$($_.Exception.Message)。请运行 rollback.bat 或联系管理员。"
    }
  }
  Write-Host ""
  Write-Host "[更新失败] 当前步骤：$script:CurrentStep" -ForegroundColor Red
  Write-Host "错误详情：$originalError" -ForegroundColor Red
  if ($script:PreUpdateBackupDirectory) {
    Write-Host "更新前备份已保留：$script:PreUpdateBackupDirectory" -ForegroundColor Yellow
  }
  if ($recoveryMessage) {
    Write-Host $recoveryMessage -ForegroundColor Yellow
  }
  Write-Host "更新已停止，未继续执行后续步骤。请根据上方错误修复后重新运行 update.bat。" -ForegroundColor Yellow
  exit 1
}

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

  throw "未找到 Ceastar PMS 部署目录。请将整个更新包文件夹直接放入已安装的 Ceastar PMS 目录后再运行。"
}

function Wait-ForApplication([string]$Url = "http://localhost:3000/login", [string]$DiagnosticContainer = "") {
  Write-Host "  正在等待 Ceastar PMS 健康检查通过：$Url" -ForegroundColor DarkCyan
  for ($attempt = 1; $attempt -le 90; $attempt++) {
    try {
      $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
        return
      }
    } catch {
      # Continue waiting below. The candidate may still be applying an additive schema migration.
    }

    if ($attempt -eq 1 -or $attempt % 5 -eq 0) {
      $containerSuffix = ""
      if ($DiagnosticContainer) {
        $candidateStatus = (docker inspect $DiagnosticContainer --format "{{.State.Status}}" 2>$null).Trim()
        if ($candidateStatus) {
          $containerSuffix = "；候选容器状态：$candidateStatus"
        }
      }
      Write-Host "  健康检查仍未通过（第 $attempt/90 次，已等待约 $($attempt * 2) 秒$containerSuffix）" -ForegroundColor DarkYellow
    }

    if ($attempt -lt 90) {
      Start-Sleep -Seconds 2
    }
  }

  if ($DiagnosticContainer) {
    $candidateLogs = @(& docker logs --tail 80 $DiagnosticContainer 2>&1 | ForEach-Object { $_.ToString() })
    $candidateLogText = ($candidateLogs -join "`n").Trim()
    if ($candidateLogText) {
      throw "Ceastar PMS 在 180 秒内未就绪。候选容器最近日志：`n$candidateLogText"
    }
  }
  throw "Ceastar PMS 在 180 秒内未就绪，请检查 Docker 容器日志。"
}

function Get-AvailableCandidatePort {
  foreach ($port in 3101..3110) {
    $listener = $null
    try {
      $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
      $listener.Start()
      return $port
    } catch {
      continue
    } finally {
      if ($listener) {
        $listener.Stop()
      }
    }
  }
  throw "本机 3101-3110 端口均被占用，无法启动绿色候选环境。"
}

function New-CandidateDatabase([string]$ReleaseId, [string]$BackupDirectory) {
  $safeReleaseId = ($ReleaseId -replace '[^0-9A-Za-z]', '_').ToLowerInvariant()
  $databaseName = "pms_candidate_$safeReleaseId"
  $dumpPath = Join-Path $BackupDirectory "database.dump"
  if (-not (Test-Path -LiteralPath $dumpPath)) {
    throw "候选数据库缺少已校验的更新前备份：$dumpPath"
  }
  $containerDumpPath = "/tmp/$databaseName.dump"
  Invoke-DockerCommand -Arguments @("cp", $dumpPath, "pms-postgres:$containerDumpPath") -FailureMessage "无法复制候选数据库备份。"
  Invoke-DockerCommand -Arguments @("exec", "pms-postgres", "dropdb", "-U", "pms", "--if-exists", "--force", $databaseName) -FailureMessage "无法清理旧候选数据库。"
  Invoke-DockerCommand -Arguments @("exec", "pms-postgres", "createdb", "-U", "pms", "-O", "pms", $databaseName) -FailureMessage "无法创建候选数据库。"
  Invoke-DockerCommand -Arguments @("exec", "pms-postgres", "pg_restore", "-U", "pms", "-d", $databaseName, "--exit-on-error", "--no-owner", "--no-privileges", $containerDumpPath) -FailureMessage "无法恢复候选数据库。"
  & docker exec pms-postgres rm -f $containerDumpPath *> $null
  $script:CandidateDatabase = $databaseName

  $databaseEnvironment = @(& docker inspect pms --format '{{range .Config.Env}}{{println .}}{{end}}') |
    Where-Object { $_ -like "DATABASE_URL=*" } |
    Select-Object -First 1
  if (-not $databaseEnvironment) {
    throw "无法从当前 PMS 容器读取数据库连接配置。"
  }
  $databaseUrl = $databaseEnvironment.Substring("DATABASE_URL=".Length).Trim()
  if ($databaseUrl -notmatch '^(postgres(?:ql)?://[^/]+/)([^?]+)(.*)$') {
    throw "当前 PMS 数据库连接格式无法用于候选库。"
  }
  return $matches[1] + $databaseName + $matches[3]
}

function Start-GreenCandidate([string]$ReleaseId, [int]$Port, [string]$CandidateDatabaseUrl) {
  $safeReleaseId = $ReleaseId -replace '[^0-9A-Za-z_.-]', '-'
  $candidateName = "ceastar-pms-green-$safeReleaseId"
  $existingCandidate = docker ps -aq --filter "name=^/$candidateName$" | Select-Object -First 1
  if ($existingCandidate) {
    docker rm -f $candidateName *> $null
    Assert-LastExitCode "无法清理同名的旧绿色候选容器。"
  }
  $publish = "127.0.0.1:${Port}:3000"
  $script:CandidateContainer = $candidateName
  # The production compose service skips schema pushes after deployment. A cloned candidate database
  # must explicitly enable the additive migration path or the new application cannot validate it.
  Invoke-DockerCommand -Arguments @("compose", "run", "--detach", "--no-deps", "--name", $candidateName, "--publish", $publish, "--env", "PMS_WEB_WORKERS=1", "--env", "SKIP_PRISMA_DB_PUSH=false", "--env", "SKIP_PRISMA_SEED=true", "--env", "DATABASE_URL=$CandidateDatabaseUrl", "pms") -FailureMessage "绿色候选容器启动失败。"
}

function Upgrade-ProductionDatabase {
  Write-Host "  正在将已验证的安全结构迁移应用到正式数据库..." -ForegroundColor DarkCyan
  # The image entrypoint runs pre-schema and manual migrations before executing this no-op command.
  # It contains no destructive data-loss override and runs only after the cloned candidate is healthy.
  Invoke-DockerCommand -Arguments @("compose", "run", "--rm", "--no-deps", "--env", "SKIP_PRISMA_DB_PUSH=false", "--env", "SKIP_PRISMA_SEED=true", "pms", "sh", "-c", "exit 0") -FailureMessage "正式数据库结构同步失败，未切换 3000 端口。"
}

function Assert-VerifiedBackup([string]$BackupDirectory) {
  $manifestPath = Join-Path $BackupDirectory "backup-manifest.json"
  if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "缺少更新前备份校验清单：$manifestPath"
  }

  try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  } catch {
    throw "无法读取更新前备份校验清单：$manifestPath"
  }

  if (-not $manifest.files -or $manifest.files.Count -lt 2) {
    throw "更新前备份校验清单不完整：$manifestPath"
  }

  foreach ($file in $manifest.files) {
    $filePath = Join-Path $BackupDirectory ([string]$file.name)
    if (-not (Test-Path -LiteralPath $filePath)) {
      throw "更新前备份文件缺失：$filePath"
    }
    $actualHash = (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne ([string]$file.sha256).ToLowerInvariant()) {
      throw "更新前备份文件校验失败：$filePath"
    }
  }
}

function Show-StorageProtectionStatus([string]$Directory) {
  $drive = [System.IO.Path]::GetPathRoot((Resolve-Path -LiteralPath $Directory).Path)
  if (-not $drive) {
    Write-Host "  [提醒] 无法确定部署目录所在磁盘的加密状态。" -ForegroundColor Yellow
    return
  }

  $bitLockerCommand = Get-Command Get-BitLockerVolume -ErrorAction SilentlyContinue
  if (-not $bitLockerCommand) {
    Write-Host "  [提醒] 无法自动检查磁盘加密。建议对 $Directory 所在磁盘启用 BitLocker 或设备加密。" -ForegroundColor Yellow
    return
  }

  try {
    $volume = Get-BitLockerVolume -MountPoint $drive -ErrorAction Stop
    if ($volume.ProtectionStatus -eq "On") {
      Write-Host "  [安全] $drive 已启用 BitLocker，数据库静态存储受保护。" -ForegroundColor Green
    } else {
      Write-Host "  [安全提醒] $drive 未启用 BitLocker。建议启用 BitLocker，或将部署目录移到已加密磁盘。此提醒不会中断更新。" -ForegroundColor Yellow
    }
  } catch {
    Write-Host "  [提醒] 磁盘加密状态检查失败。建议对 $Directory 所在磁盘启用 BitLocker 或设备加密。" -ForegroundColor Yellow
  }
}

function Ensure-CompatibleSystemBackupConfiguration([string]$Directory, [string]$ReleaseId = "compatibility-test") {
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
      throw "docker-compose.yml 中未找到可兼容的 PMS 环境变量区域，无法安全升级。"
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
        throw "docker-compose.yml 中未找到 PMS 数据卷配置，无法安全升级。"
      }
      $mountLines = $documentMountMatch.Value.TrimEnd() + "`n" + $documentMountMatch.Groups[1].Value + '- ./backups:/app/.local-runtime/system-backups' + "`n" + $documentMountMatch.Groups[1].Value + '- ${PMS_BACKUP_HOST_DIR:-./backups}:/data/system-backups'
      $updated = $updated.Substring(0, $documentMountMatch.Index) + $mountLines + $updated.Substring($documentMountMatch.Index + $documentMountMatch.Length)
    }
    $changed = $true
  }

  if (-not $changed) {
    return
  }

  $safeReleaseId = $ReleaseId -replace '[^0-9A-Za-z_.-]', '-'
  $backupPath = "$composePath.before-update-$safeReleaseId"
  if (-not (Test-Path $backupPath)) {
    [System.IO.File]::Copy($composePath, $backupPath, $false)
  }
  if ($lineBreak -eq "`r`n") {
    $updated = $updated.Replace("`n", "`r`n")
  }
  [System.IO.File]::WriteAllText($composePath, $updated, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "  已补充系统备份挂载配置，原配置已保留：$backupPath" -ForegroundColor DarkCyan
}

if ($ComposeCompatibilityTestDirectory) {
  Ensure-CompatibleSystemBackupConfiguration $ComposeCompatibilityTestDirectory
  return
}

$deploymentDirectory = Find-DeploymentDirectory
$script:DeploymentDirectory = $deploymentDirectory
Write-Step 1 10 "检查部署目录与磁盘保护"
Write-Host "  部署目录：$deploymentDirectory"
Show-StorageProtectionStatus $deploymentDirectory
Write-Success "已找到有效的 Ceastar PMS 部署目录"
$imageNameFile = Join-Path $PSScriptRoot "image-name.txt"
$imageHashFile = Join-Path $PSScriptRoot "image.sha256"
$releaseIdFile = Join-Path $PSScriptRoot "release-id.txt"
$imageDirectory = Join-Path $PSScriptRoot "images"
$packagedBackupScript = Join-Path $PSScriptRoot "backup.ps1"

if (-not (Test-Path $imageNameFile)) {
  throw "更新包中缺少 image-name.txt。"
}
if (-not (Test-Path $imageHashFile)) {
  throw "更新包中缺少 image.sha256。"
}
if (-not (Test-Path $releaseIdFile)) {
  throw "更新包中缺少 release-id.txt。"
}

$imageFiles = @(Get-ChildItem -Path $imageDirectory -Filter "*.tar" -File -ErrorAction SilentlyContinue)
Write-Step 2 10 "校验更新包与 Docker 镜像"
if ($imageFiles.Count -ne 1) { throw "更新包必须且只能包含一个 Docker 镜像 tar 文件。" }

$newImage = (Get-Content -Path $imageNameFile -Raw).Trim()
if (-not $newImage) {
  throw "image-name.txt 为空。"
}
$releaseId = (Get-Content -Path $releaseIdFile -Raw).Trim()
if ($releaseId -notmatch '^[0-9]{8}-[0-9A-Za-z.-]+$') {
  throw "release-id.txt 格式无效，应类似 20260804-1。"
}

$hashContent = (Get-Content -LiteralPath $imageHashFile -Raw).Trim()
$hashMatch = [regex]::Match($hashContent, '(?i)(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])')
if (-not $hashMatch.Success) {
  throw "image.sha256 中不包含有效的 SHA256 校验值。"
}
$expectedHash = $hashMatch.Value.ToLowerInvariant()
$actualHash = (Get-FileHash -LiteralPath $imageFiles[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant()
if ($expectedHash -ne $actualHash) {
  throw "更新镜像校验值不匹配。预期：$expectedHash；实际：$actualHash。请重新复制完整的更新包。"
}
Write-Success "更新包完整，镜像 SHA256 校验通过"

Set-Location $deploymentDirectory

Write-Step 3 10 "检查 Docker 并保留蓝色回滚镜像"
docker info *> $null
Assert-LastExitCode "Docker Desktop 未运行，请先启动 Docker Desktop。"

$composeImage = ""
$currentImageReference = ""
$containerId = docker ps -a --filter "name=^/pms$" --format "{{.ID}}" | Select-Object -First 1
if ($containerId) {
  $composeImage = (docker inspect pms --format "{{.Config.Image}}").Trim()
  Assert-LastExitCode "无法读取当前 PMS 容器信息。"
  $currentImageReference = (docker inspect pms --format "{{.Image}}").Trim()
  Assert-LastExitCode "无法读取当前 PMS 容器镜像。"
} else {
  $composeImage = docker compose config --images |
    Where-Object { $_ -like "ceastar-project-management:*" } |
    Select-Object -First 1
  $currentImageReference = $composeImage
}

if (-not $composeImage) {
  throw "无法确定当前 Ceastar PMS 镜像名称。"
}

$rollbackImage = "ceastar-project-management:rollback-$releaseId-amd64"
$script:ComposeImage = $composeImage
$script:RollbackImage = $rollbackImage
docker image inspect $currentImageReference *> $null
Assert-LastExitCode "当前 Ceastar PMS 镜像不存在。"
docker tag $currentImageReference $rollbackImage
Assert-LastExitCode "保留回滚镜像失败。"
Write-Success "已保留回滚镜像：$rollbackImage"

if (Test-Path $packagedBackupScript) {
  Copy-Item -LiteralPath $packagedBackupScript -Destination (Join-Path $deploymentDirectory "backup.ps1") -Force
}

Write-Step 4 10 "备份数据库与项目文档"
$backupOutput = @(& (Join-Path $deploymentDirectory "backup.ps1") 2>&1 | ForEach-Object { $_.ToString() })
$backupOutput | ForEach-Object { Write-Host $_ }
$backupDirectoryLine = $backupOutput |
  Where-Object { $_ -like "CEASTAR_PMS_BACKUP_DIRECTORY=*" } |
  Select-Object -Last 1
if (-not $backupDirectoryLine) {
  throw "更新前备份未返回备份目录，已在更改应用前停止更新。"
}
$preUpdateBackupDirectory = $backupDirectoryLine.Substring("CEASTAR_PMS_BACKUP_DIRECTORY=".Length)
$script:PreUpdateBackupDirectory = $preUpdateBackupDirectory
Assert-VerifiedBackup $preUpdateBackupDirectory
Write-Success "更新前备份完成并通过校验：$preUpdateBackupDirectory"

Write-Step 5 10 "升级部署配置"
Ensure-CompatibleSystemBackupConfiguration $deploymentDirectory $releaseId
$assistantBridgeInstaller = Join-Path $PSScriptRoot "install-assistant-service-bridge.ps1"
if (-not (Test-Path $assistantBridgeInstaller)) {
  throw "更新包中缺少 install-assistant-service-bridge.ps1。"
}
& $assistantBridgeInstaller -DeploymentDirectory $deploymentDirectory -SourceDirectory $PSScriptRoot
$drawioMcpInstaller = Join-Path $PSScriptRoot "install-drawio-mcp.ps1"
if (-not (Test-Path $drawioMcpInstaller)) {
  throw "更新包中缺少 install-drawio-mcp.ps1。"
}
& $drawioMcpInstaller -SourceDirectory $PSScriptRoot
Write-Success "docker-compose.yml 兼容性检查通过"
Write-Success "Ollama/RAGLite 主机服务管理桥接已安装"
Write-Success "Draw.io MCP 启动器和配置已安装"

Write-Host "  [说明] 本次更新不自动修复 MPP 导出服务。如需二进制 MPP 导出，更新完成后以管理员身份运行 repair-mpp-export-service.bat。" -ForegroundColor DarkYellow

Write-Step 6 10 "加载绿色离线 Docker 更新镜像"
docker load --input $imageFiles[0].FullName
Assert-LastExitCode "加载更新镜像失败。"
docker image inspect $newImage *> $null
Assert-LastExitCode "镜像加载完成后未找到预期的更新镜像。"
$newImageArchitecture = (docker image inspect $newImage --format "{{.Architecture}}").Trim()
Assert-LastExitCode "无法读取更新镜像架构。"
if ($newImageArchitecture -ne "amd64") {
  throw "更新镜像架构为 $newImageArchitecture，Windows x86-64 部署要求 linux/amd64 镜像。"
}

if ($newImage -ne $composeImage) {
  docker tag $newImage $composeImage
  Assert-LastExitCode "激活更新镜像标签失败。"
}
$script:TagSwitched = $true
Write-Success "离线更新镜像已加载"

Write-Step 7 10 "启动绿色候选环境"
$candidatePort = Get-AvailableCandidatePort
$candidateDatabaseUrl = New-CandidateDatabase $releaseId $preUpdateBackupDirectory
Start-GreenCandidate $releaseId $candidatePort $candidateDatabaseUrl
Write-Success "绿色候选环境已启动，蓝色旧版本继续在 3000 端口提供服务"

Write-Step 8 10 "验证绿色候选环境"
Wait-ForApplication "http://127.0.0.1:$candidatePort/api/health/ready" $script:CandidateContainer
Write-Success "绿色候选环境健康检查通过"
Remove-CandidateContainer
Remove-CandidateDatabase
Upgrade-ProductionDatabase
Write-Success "正式数据库已完成已验证的安全结构同步"

Write-Step 9 10 "切换 3000 端口到绿色版本"
$script:CutoverStarted = $true
Invoke-DockerCommand -Arguments @("compose", "up", "-d", "--no-deps", "--force-recreate", "pms") -FailureMessage "重建 Ceastar PMS 应用容器失败。"
Write-Success "绿色版本已接管 3000 端口"

Write-Step 10 10 "执行切换后健康检查并保存状态"
Wait-ForApplication "http://localhost:3000/api/health/ready"
Write-Success "Ceastar PMS 已正常响应"

$state = @(
  "releaseId=$releaseId",
  "strategy=blue-green-staged",
  "composeImage=$composeImage",
  "newImage=$newImage",
  "rollbackImage=$rollbackImage",
  "updatedAt=$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
)
Set-Content -Path (Join-Path $deploymentDirectory ".ceastar-update-$releaseId.state") -Value $state -Encoding ASCII
$script:TagSwitched = $false

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "Ceastar PMS 更新成功" -ForegroundColor Green
Write-Host "访问地址：http://localhost:3000"
Write-Host "发布策略：蓝绿候选预检 + 健康切换 + 失败自动回退"
Write-Host "更新前备份：$preUpdateBackupDirectory"
Write-Host "回滚镜像：$rollbackImage"
Write-Host "========================================" -ForegroundColor Green
