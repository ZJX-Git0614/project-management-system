$ErrorActionPreference = "Stop"
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

$script:CurrentStep = "初始化回退"
$script:SafetyBackupDirectory = ""
$script:CandidateContainer = ""
$script:DeploymentDirectory = ""
$script:ComposeImage = ""
$script:ActiveImageReference = ""
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

function Assert-LastExitCode([string]$Message) {
  if ($LASTEXITCODE -ne 0) {
    throw $Message
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

function Restore-CurrentApplication {
  if (-not $script:TagSwitched -or -not $script:ComposeImage -or -not $script:ActiveImageReference) {
    return
  }

  Set-Location $script:DeploymentDirectory
  docker tag $script:ActiveImageReference $script:ComposeImage
  Assert-LastExitCode "无法恢复回退前的应用镜像标签。"
  if ($script:CutoverStarted) {
    Invoke-DockerCommand -Arguments @("compose", "up", "-d", "--no-deps", "--force-recreate", "pms") -FailureMessage "无法自动恢复回退前的应用容器。"
    Wait-ForApplication "http://localhost:3000/login"
  }
  $script:TagSwitched = $false
}

trap {
  $originalError = $_.Exception.Message
  Remove-CandidateContainer
  $recoveryMessage = ""
  if ($script:TagSwitched) {
    try {
      Restore-CurrentApplication
      $recoveryMessage = if ($script:CutoverStarted) {
        "旧版本回退失败，已自动恢复回退前的应用并重新通过健康检查。"
      } else {
        "旧版本候选环境未通过，正式应用容器未切换。"
      }
    } catch {
      $recoveryMessage = "自动恢复失败：$($_.Exception.Message)。请联系管理员并保留当前备份。"
    }
  }
  Write-Host ""
  Write-Host "[回退失败] 当前步骤：$script:CurrentStep" -ForegroundColor Red
  Write-Host "错误详情：$originalError" -ForegroundColor Red
  if ($script:SafetyBackupDirectory) {
    Write-Host "回退前备份已保留：$script:SafetyBackupDirectory" -ForegroundColor Yellow
  }
  if ($recoveryMessage) {
    Write-Host $recoveryMessage -ForegroundColor Yellow
  }
  exit 1
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

function Wait-ForApplication([string]$Url = "http://localhost:3000/login") {
  Write-Host "  正在等待 Ceastar PMS 健康检查通过：$Url" -ForegroundColor DarkCyan
  for ($attempt = 1; $attempt -le 90; $attempt++) {
    try {
      $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
        return
      }
    } catch {
      Start-Sleep -Seconds 2
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
  throw "本机 3101-3110 端口均被占用，无法启动回退候选环境。"
}

function Start-RollbackCandidate([string]$ReleaseId, [int]$Port) {
  $safeReleaseId = $ReleaseId -replace '[^0-9A-Za-z_.-]', '-'
  $candidateName = "ceastar-pms-rollback-$safeReleaseId"
  $existingCandidate = docker ps -aq --filter "name=^/$candidateName$" | Select-Object -First 1
  if ($existingCandidate) {
    docker rm -f $candidateName *> $null
    Assert-LastExitCode "无法清理同名的旧回退候选容器。"
  }
  $publish = "127.0.0.1:${Port}:3000"
  $script:CandidateContainer = $candidateName
  Invoke-DockerCommand -Arguments @("compose", "run", "--detach", "--no-deps", "--name", $candidateName, "--publish", $publish, "--env", "PMS_WEB_WORKERS=1", "pms") -FailureMessage "回退候选容器启动失败。"
}

function Assert-VerifiedBackup([string]$BackupDirectory) {
  $manifestPath = Join-Path $BackupDirectory "backup-manifest.json"
  if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "缺少回退前备份校验清单：$manifestPath"
  }

  try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  } catch {
    throw "无法读取回退前备份校验清单：$manifestPath"
  }

  if (-not $manifest.files -or $manifest.files.Count -lt 2) {
    throw "回退前备份校验清单不完整：$manifestPath"
  }

  foreach ($file in $manifest.files) {
    $filePath = Join-Path $BackupDirectory ([string]$file.name)
    if (-not (Test-Path -LiteralPath $filePath)) {
      throw "回退前备份文件缺失：$filePath"
    }
    $actualHash = (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne ([string]$file.sha256).ToLowerInvariant()) {
      throw "回退前备份文件校验失败：$filePath"
    }
  }
}

$deploymentDirectory = Find-DeploymentDirectory
$script:DeploymentDirectory = $deploymentDirectory
$releaseIdFile = Join-Path $PSScriptRoot "release-id.txt"
if (-not (Test-Path $releaseIdFile)) {
  throw "更新包中缺少 release-id.txt。"
}
$releaseId = (Get-Content -Path $releaseIdFile -Raw).Trim()
if ($releaseId -notmatch '^[0-9]{8}-[0-9A-Za-z.-]+$') {
  throw "release-id.txt 格式无效。"
}

Write-Step 1 8 "读取本次更新状态"
$stateFile = Join-Path $deploymentDirectory ".ceastar-update-$releaseId.state"
if (-not (Test-Path $stateFile)) {
  throw "未找到本次更新状态文件 $stateFile，无法自动确定回退镜像。"
}

$state = @{}
Get-Content $stateFile | ForEach-Object {
  $parts = $_ -split "=", 2
  if ($parts.Count -eq 2) {
    $state[$parts[0]] = $parts[1]
  }
}

$composeImage = [string]$state["composeImage"]
$newImage = [string]$state["newImage"]
$rollbackImage = [string]$state["rollbackImage"]
if (-not $composeImage -or -not $newImage -or -not $rollbackImage) {
  throw "更新状态不完整，无法安全回退。"
}
if ($state["releaseId"] -and $state["releaseId"] -ne $releaseId) {
  throw "更新状态与 release-id.txt 不一致，已停止回退。"
}
Write-Success "已读取发布 $releaseId 的回退状态"

Set-Location $deploymentDirectory
Write-Step 2 8 "检查 Docker 与镜像"
docker info *> $null
Assert-LastExitCode "Docker Desktop 未运行，请先启动 Docker Desktop。"
docker image inspect $rollbackImage *> $null
Assert-LastExitCode "更新时保留的回退镜像不存在：$rollbackImage"

$containerId = docker ps -a --filter "name=^/pms$" --format "{{.ID}}" | Select-Object -First 1
if ($containerId) {
  $activeImageReference = (docker inspect pms --format "{{.Image}}").Trim()
  Assert-LastExitCode "无法读取当前 PMS 容器镜像。"
} else {
  $activeImageReference = $newImage
  docker image inspect $activeImageReference *> $null
  Assert-LastExitCode "当前应用镜像不存在，无法建立回退失败保护。"
}
$script:ComposeImage = $composeImage
$script:ActiveImageReference = $activeImageReference
Write-Success "Docker 与回退镜像检查通过"

Write-Step 3 8 "备份当前数据库与项目文档"
$backupOutput = @(& (Join-Path $deploymentDirectory "backup.ps1") 2>&1 | ForEach-Object { $_.ToString() })
$backupOutput | ForEach-Object { Write-Host $_ }
$backupDirectoryLine = $backupOutput |
  Where-Object { $_ -like "CEASTAR_PMS_BACKUP_DIRECTORY=*" } |
  Select-Object -Last 1
if (-not $backupDirectoryLine) {
  throw "回退前备份未返回备份目录，已在更改应用前停止回退。"
}
$safetyBackupDirectory = $backupDirectoryLine.Substring("CEASTAR_PMS_BACKUP_DIRECTORY=".Length)
$script:SafetyBackupDirectory = $safetyBackupDirectory
Assert-VerifiedBackup $safetyBackupDirectory
Write-Success "回退前备份完成并通过校验：$safetyBackupDirectory"

Write-Step 4 8 "准备旧版本候选镜像"
docker tag $rollbackImage $composeImage
Assert-LastExitCode "无法激活回退镜像标签。"
$script:TagSwitched = $true
Write-Success "旧版本镜像已准备"

Write-Step 5 8 "启动旧版本候选环境"
$candidatePort = Get-AvailableCandidatePort
Start-RollbackCandidate $releaseId $candidatePort
Write-Success "旧版本候选环境已启动，正式应用容器尚未切换"

Write-Step 6 8 "验证旧版本候选环境"
Wait-ForApplication "http://127.0.0.1:$candidatePort/login"
Write-Success "旧版本候选环境健康检查通过"
Remove-CandidateContainer

Write-Step 7 8 "切换 3000 端口到旧版本"
$script:CutoverStarted = $true
Invoke-DockerCommand -Arguments @("compose", "up", "-d", "--no-deps", "--force-recreate", "pms") -FailureMessage "重建 Ceastar PMS 应用容器失败。"
Write-Success "旧版本已接管 3000 端口"

Write-Step 8 8 "执行切换后健康检查并保存状态"
Wait-ForApplication "http://localhost:3000/login"
$stateLines = @(
  "releaseId=$releaseId",
  "strategy=blue-green-staged",
  "composeImage=$composeImage",
  "newImage=$newImage",
  "rollbackImage=$rollbackImage",
  "updatedAt=$($state['updatedAt'])",
  "rolledBackAt=$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
)
Set-Content -Path $stateFile -Value $stateLines -Encoding ASCII
$script:TagSwitched = $false
Write-Success "旧版本已正常响应"

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "Ceastar PMS 应用版本回退成功" -ForegroundColor Green
Write-Host "访问地址：http://localhost:3000"
Write-Host "数据库与项目文档未被反向覆盖"
Write-Host "回退前备份：$safetyBackupDirectory"
Write-Host "========================================" -ForegroundColor Green
