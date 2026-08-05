param(
  [ValidateSet("Menu", "Status", "StatusJson", "Start", "Stop", "Restart", "Ensure", "EnableAutoStart", "DisableAutoStart", "ConfigureRagLite")]
  [string]$Action = "Menu",
  [ValidateSet("All", "Ollama", "RagLite")]
  [string]$Service = "All",
  [switch]$Interactive,
  [string]$RagLiteDirectory = "",
  [string]$RagLiteExecutable = "",
  [string]$RagLiteArguments = ""
)

$ErrorActionPreference = "Stop"
$script:SourceDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:RuntimeDirectory = Join-Path $env:ProgramData "Ceastar-PMS\assistant-services"
$script:LogDirectory = Join-Path $script:RuntimeDirectory "logs"
$script:ConfigPath = Join-Path $script:RuntimeDirectory "assistant-services.json"
$script:RagLiteDataDirectory = Join-Path $env:ProgramData "Ceastar-PMS\raglite-data"

function Ensure-Directories {
  foreach ($directory in @($script:RuntimeDirectory, $script:LogDirectory, $script:RagLiteDataDirectory)) {
    if (-not (Test-Path $directory)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
  }
}

function New-DefaultConfig {
  $ollamaModelsDirectory = Join-Path $env:USERPROFILE ".ollama\models"
  if (-not (Test-Path $ollamaModelsDirectory)) {
    $discoveredModelsDirectory = Get-ChildItem -Path (Join-Path $env:SystemDrive "Users") -Directory -ErrorAction SilentlyContinue |
      ForEach-Object { Join-Path $_.FullName ".ollama\models" } |
      Where-Object { Test-Path $_ } |
      Select-Object -First 1
    if ($discoveredModelsDirectory) { $ollamaModelsDirectory = $discoveredModelsDirectory }
  }
  return @{
    OllamaExecutable = ""
    OllamaHost = "0.0.0.0:11434"
    OllamaHealthUrl = "http://127.0.0.1:11434/api/tags"
    OllamaModelsDirectory = $ollamaModelsDirectory
    RagLiteDirectory = ""
    RagLiteExecutable = ""
    RagLiteArguments = ""
    RagLiteHealthUrl = "http://127.0.0.1:8001/health"
    RagLiteDataDirectory = $script:RagLiteDataDirectory
  }
}

function Save-Config([hashtable]$Config) {
  Ensure-Directories
  $Config | ConvertTo-Json -Depth 4 | Set-Content -Path $script:ConfigPath -Encoding UTF8
}

function Get-Config {
  Ensure-Directories
  $defaults = New-DefaultConfig
  if (-not (Test-Path $script:ConfigPath)) {
    Save-Config $defaults
    return $defaults
  }
  try {
    $saved = Get-Content $script:ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($key in @($defaults.Keys)) {
      if ($null -ne $saved.$key -and [string]$saved.$key -ne "") { $defaults[$key] = [string]$saved.$key }
    }
  } catch {
    $backupPath = "$script:ConfigPath.invalid-$(Get-Date -Format yyyyMMddHHmmss)"
    Copy-Item $script:ConfigPath $backupPath -Force
    Save-Config $defaults
  }
  return $defaults
}

function Test-HttpHealth([string]$Url) {
  if (-not $Url) { return $false }
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    return $false
  }
}

function Resolve-OllamaExecutable([hashtable]$Config) {
  $candidates = @(
    $Config.OllamaExecutable,
    (Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"),
    (Join-Path $env:ProgramFiles "Ollama\ollama.exe")
  ) | Where-Object { $_ }
  $candidates += Get-ChildItem -Path (Join-Path $env:SystemDrive "Users") -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName "AppData\Local\Programs\Ollama\ollama.exe" } |
    Where-Object { Test-Path $_ }
  $command = Get-Command ollama.exe -ErrorAction SilentlyContinue
  if ($command) { $candidates += $command.Source }
  return $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}

function Resolve-RagLiteExecutable([hashtable]$Config) {
  $candidates = @(
    $Config.RagLiteExecutable,
    (Join-Path $env:ProgramData "Ceastar-PMS\raglite\raglite.exe"),
    (Join-Path $env:ProgramData "Ceastar-PMS\raglite\venv\Scripts\python.exe"),
    (Join-Path $env:ProgramData "Ceastar-PMS\raglite\.venv\Scripts\python.exe")
  ) | Where-Object { $_ }
  if ($Config.RagLiteDirectory) {
    $candidates += @(
      (Join-Path $Config.RagLiteDirectory "raglite.exe"),
      (Join-Path $Config.RagLiteDirectory "venv\Scripts\raglite.exe"),
      (Join-Path $Config.RagLiteDirectory ".venv\Scripts\raglite.exe"),
      (Join-Path $Config.RagLiteDirectory "venv\Scripts\python.exe"),
      (Join-Path $Config.RagLiteDirectory ".venv\Scripts\python.exe")
    )
  }
  return $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}

function Start-DetachedProcess {
  param(
    [string]$FilePath,
    [string]$Arguments,
    [string]$WorkingDirectory,
    [hashtable]$Environment,
    [string]$LogName
  )
  $savedEnvironment = @{}
  foreach ($key in $Environment.Keys) {
    $savedEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
    [Environment]::SetEnvironmentVariable($key, [string]$Environment[$key], "Process")
  }
  try {
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $stdout = Join-Path $script:LogDirectory "$LogName-$timestamp.out.log"
    $stderr = Join-Path $script:LogDirectory "$LogName-$timestamp.err.log"
    $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    return $process.Id
  } finally {
    foreach ($key in $savedEnvironment.Keys) {
      [Environment]::SetEnvironmentVariable($key, $savedEnvironment[$key], "Process")
    }
  }
}

function Start-Ollama([hashtable]$Config) {
  if (Test-HttpHealth $Config.OllamaHealthUrl) { return $true }
  $executable = Resolve-OllamaExecutable $Config
  if (-not $executable) { throw "未找到 Ollama。请先安装 Ollama，或在 $script:ConfigPath 中填写 OllamaExecutable。" }
  $workingDirectory = Split-Path -Parent $executable
  $processId = Start-DetachedProcess -FilePath $executable -Arguments "serve" -WorkingDirectory $workingDirectory -Environment @{
    OLLAMA_HOST = $Config.OllamaHost
    OLLAMA_MODELS = $Config.OllamaModelsDirectory
  } -LogName "ollama"
  Set-Content -LiteralPath (Join-Path $script:RuntimeDirectory "Ollama.pid") -Value $processId -Encoding ASCII
  for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
    Start-Sleep -Seconds 1
    if (Test-HttpHealth $Config.OllamaHealthUrl) { return $true }
  }
  throw "Ollama 已启动但健康检查未通过，请查看 $script:LogDirectory。"
}

function Start-RagLite([hashtable]$Config) {
  if (Test-HttpHealth $Config.RagLiteHealthUrl) { return $true }
  $executable = Resolve-RagLiteExecutable $Config
  if (-not $executable) { throw "未配置 RAGLite。请在菜单中指定 RAGLite 安装目录和启动命令。" }
  $workingDirectory = if ($Config.RagLiteDirectory) { $Config.RagLiteDirectory } else { Split-Path -Parent $executable }
  $arguments = $Config.RagLiteArguments
  if (-not $arguments -and [System.IO.Path]::GetFileName($executable).ToLowerInvariant() -eq "python.exe") {
    $arguments = "-m raglite"
  }
  $processId = Start-DetachedProcess -FilePath $executable -Arguments $arguments -WorkingDirectory $workingDirectory -Environment @{
    RAGLITE_DATA_DIR = $Config.RagLiteDataDirectory
  } -LogName "raglite"
  Set-Content -LiteralPath (Join-Path $script:RuntimeDirectory "RagLite.pid") -Value $processId -Encoding ASCII
  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    Start-Sleep -Seconds 1
    if (Test-HttpHealth $Config.RagLiteHealthUrl) { return $true }
  }
  throw "RAGLite 已启动但健康检查未通过，请核对启动参数并查看 $script:LogDirectory。"
}

function Stop-ServiceProcess([string]$Name, [hashtable]$Config) {
  $pausePath = Join-Path $script:RuntimeDirectory ("paused-" + $Name + ".flag")
  New-Item -ItemType File -Path $pausePath -Force | Out-Null
  $pidPath = Join-Path $script:RuntimeDirectory ("$Name.pid")
  if (Test-Path $pidPath) {
    $processId = 0
    $storedProcessId = [string](Get-Content -LiteralPath $pidPath -Raw -ErrorAction SilentlyContinue)
    [void][int]::TryParse($storedProcessId.Trim(), [ref]$processId)
    if ($processId -gt 0) { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
  }
  if ($Name -eq "Ollama") {
    Get-Process -Name "ollama", "ollama app" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    return
  }
  $executable = Resolve-RagLiteExecutable $Config
  if (-not $executable) { return }
  $targetPath = [System.IO.Path]::GetFullPath($executable).ToLowerInvariant()
  $directoryFragment = ([string]$Config.RagLiteDirectory).ToLowerInvariant()
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ExecutablePath -and $_.ExecutablePath.ToLowerInvariant() -eq $targetPath -and
      (-not $directoryFragment -or ([string]$_.CommandLine).ToLowerInvariant().Contains($directoryFragment))
    } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Start-ServiceByName([string]$Name, [hashtable]$Config) {
  $pausePath = Join-Path $script:RuntimeDirectory ("paused-" + $Name + ".flag")
  Remove-Item $pausePath -Force -ErrorAction SilentlyContinue
  if ($Name -eq "Ollama") { return Start-Ollama $Config }
  return Start-RagLite $Config
}

function Get-TaskName([string]$Name) { return "Ceastar-PMS-$Name-Watchdog" }

function Enable-AutoStart([string]$Name) {
  Ensure-Directories
  foreach ($fileName in @("assistant-services.ps1", "assistant-service-watchdog.ps1")) {
    $sourcePath = Join-Path $script:SourceDirectory $fileName
    if (-not (Test-Path $sourcePath)) { throw "缺少服务管理文件：$sourcePath" }
    $destinationPath = Join-Path $script:RuntimeDirectory $fileName
    if ([System.IO.Path]::GetFullPath($sourcePath) -ne [System.IO.Path]::GetFullPath($destinationPath)) {
      Copy-Item $sourcePath $destinationPath -Force
    }
  }
  $watchdogPath = Join-Path $script:RuntimeDirectory "assistant-service-watchdog.ps1"
  $taskName = Get-TaskName $Name
  $taskAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdogPath`" -ServiceName $Name"
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 3650) -StartWhenAvailable
  Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName
}

function Disable-AutoStart([string]$Name) {
  $taskName = Get-TaskName $Name
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  }
}

function Is-AutoStartEnabled([string]$Name) {
  return $null -ne (Get-ScheduledTask -TaskName (Get-TaskName $Name) -ErrorAction SilentlyContinue)
}

function Show-Status([hashtable]$Config) {
  $ollamaHealthy = Test-HttpHealth $Config.OllamaHealthUrl
  $ragLiteHealthy = Test-HttpHealth $Config.RagLiteHealthUrl
  Write-Host ""
  Write-Host "Ollama : $(if ($ollamaHealthy) { '运行正常' } else { '未运行或连接失败' })；开机自启：$(if (Is-AutoStartEnabled 'Ollama') { '已开启' } else { '已关闭' })" -ForegroundColor $(if ($ollamaHealthy) { 'Green' } else { 'Yellow' })
  Write-Host "RAGLite: $(if ($ragLiteHealthy) { '运行正常' } else { '未运行、未配置或连接失败' })；开机自启：$(if (Is-AutoStartEnabled 'RagLite') { '已开启' } else { '已关闭' })" -ForegroundColor $(if ($ragLiteHealthy) { 'Green' } else { 'Yellow' })
  Write-Host "配置文件：$script:ConfigPath" -ForegroundColor DarkGray
  Write-Host "日志目录：$script:LogDirectory" -ForegroundColor DarkGray
  Write-Host "RAGLite 数据目录：$($Config.RagLiteDataDirectory)" -ForegroundColor DarkGray
}

function Get-StatusData([hashtable]$Config) {
  $ollamaExecutable = Resolve-OllamaExecutable $Config
  $ragLiteExecutable = Resolve-RagLiteExecutable $Config
  return [ordered]@{
    available = $true
    message = "主机服务管理桥接运行正常"
    services = @(
      [ordered]@{
        name = "Ollama"
        label = "Ollama"
        healthy = (Test-HttpHealth $Config.OllamaHealthUrl)
        autoStartEnabled = (Is-AutoStartEnabled "Ollama")
        configured = [bool]$ollamaExecutable
        healthUrl = $Config.OllamaHealthUrl
        message = if ($ollamaExecutable) { "已找到启动程序" } else { "未找到 Ollama 启动程序" }
      },
      [ordered]@{
        name = "RagLite"
        label = "RAGLite"
        healthy = (Test-HttpHealth $Config.RagLiteHealthUrl)
        autoStartEnabled = (Is-AutoStartEnabled "RagLite")
        configured = [bool]$ragLiteExecutable
        healthUrl = $Config.RagLiteHealthUrl
        message = if ($ragLiteExecutable) { "已配置启动程序" } else { "尚未配置 RAGLite 启动程序" }
      }
    )
    ragLiteConfiguration = [ordered]@{
      directory = $Config.RagLiteDirectory
      executable = $Config.RagLiteExecutable
      arguments = $Config.RagLiteArguments
    }
  }
}

function Configure-RagLite([hashtable]$Config) {
  $allowPrompt = $Interactive -or $Action -eq "Menu"
  $directory = if ($RagLiteDirectory) { $RagLiteDirectory } elseif ($allowPrompt) { Read-Host "请输入 RAGLite 安装目录" } else { "" }
  if ($directory -and -not (Test-Path $directory)) { throw "RAGLite 安装目录不存在。" }
  $executable = if ($RagLiteExecutable) { $RagLiteExecutable } elseif ($allowPrompt) { Read-Host "启动程序路径（可留空自动查找 raglite.exe 或 venv\Scripts\python.exe）" } else { "" }
  if ($executable -and -not (Test-Path $executable)) { throw "RAGLite 启动程序不存在。" }
  if (-not $directory -and -not $executable) { throw "请填写 RAGLite 安装目录或启动程序路径。" }
  $arguments = if ($RagLiteArguments) { $RagLiteArguments } elseif ($allowPrompt) { Read-Host "启动参数（python 环境通常填 -m raglite，可留空自动判断）" } else { "" }
  $Config.RagLiteDirectory = if ($directory) { [System.IO.Path]::GetFullPath($directory) } else { "" }
  $Config.RagLiteExecutable = if ($executable) { [System.IO.Path]::GetFullPath($executable) } else { "" }
  $Config.RagLiteArguments = $arguments
  Save-Config $Config
  Write-Host "RAGLite 配置已保存。" -ForegroundColor Green
}

function Invoke-ForSelection([string]$SelectedService, [scriptblock]$Operation) {
  $names = if ($SelectedService -eq "All") { @("Ollama", "RagLite") } else { @($SelectedService) }
  foreach ($name in $names) { & $Operation $name }
}

function Invoke-Action([string]$RequestedAction, [string]$SelectedService, [hashtable]$Config) {
  switch ($RequestedAction) {
    "Status" { Show-Status $Config }
    "StatusJson" { Get-StatusData $Config | ConvertTo-Json -Depth 6 -Compress }
    "Start" { Invoke-ForSelection $SelectedService { param($name) Start-ServiceByName $name $Config | Out-Null; Write-Host "$name 已启动并通过健康检查。" -ForegroundColor Green } }
    "Ensure" { Invoke-ForSelection $SelectedService { param($name) if ($name -eq "Ollama" -and -not (Test-HttpHealth $Config.OllamaHealthUrl)) { Start-ServiceByName $name $Config | Out-Null }; if ($name -eq "RagLite" -and (Resolve-RagLiteExecutable $Config) -and -not (Test-HttpHealth $Config.RagLiteHealthUrl)) { Start-ServiceByName $name $Config | Out-Null } } }
    "Stop" { Invoke-ForSelection $SelectedService { param($name) Stop-ServiceProcess $name $Config; Write-Host "$name 已停止；若已设置开机自启，下次开机将恢复。" -ForegroundColor Yellow } }
    "Restart" { Invoke-ForSelection $SelectedService { param($name) Stop-ServiceProcess $name $Config; Start-Sleep -Seconds 1; Start-ServiceByName $name $Config | Out-Null; Write-Host "$name 已重启并通过健康检查。" -ForegroundColor Green } }
    "EnableAutoStart" { Invoke-ForSelection $SelectedService {
      param($name)
      if ($name -eq "Ollama") {
        $executable = Resolve-OllamaExecutable $Config
        if (-not $executable) { throw "请先安装 Ollama，再开启自启。" }
        $Config.OllamaExecutable = [System.IO.Path]::GetFullPath($executable)
      } else {
        $executable = Resolve-RagLiteExecutable $Config
        if (-not $executable) { throw "请先配置 RAGLite，再开启自启。" }
        $Config.RagLiteExecutable = [System.IO.Path]::GetFullPath($executable)
      }
      Save-Config $Config
      Enable-AutoStart $name
      Write-Host "$name 开机自启和异常恢复已开启。" -ForegroundColor Green
    } }
    "DisableAutoStart" { Invoke-ForSelection $SelectedService { param($name) Disable-AutoStart $name; Write-Host "$name 开机自启和异常恢复已关闭。" -ForegroundColor Yellow } }
    "ConfigureRagLite" { Configure-RagLite $Config }
    default { throw "未知操作：$RequestedAction" }
  }
}

function Show-Menu {
  while ($true) {
    $config = Get-Config
    Clear-Host
    Write-Host "Ceastar PMS 智能助手服务管理" -ForegroundColor Cyan
    Write-Host "================================"
    Show-Status $config
    Write-Host ""
    Write-Host "1. 启动 Ollama"
    Write-Host "2. 停止 Ollama"
    Write-Host "3. 重启 Ollama"
    Write-Host "4. 开启 Ollama 开机自启与异常恢复"
    Write-Host "5. 关闭 Ollama 开机自启与异常恢复"
    Write-Host "6. 配置 RAGLite 安装目录和启动命令"
    Write-Host "7. 启动 RAGLite"
    Write-Host "8. 停止 RAGLite"
    Write-Host "9. 重启 RAGLite"
    Write-Host "10. 开启 RAGLite 开机自启与异常恢复"
    Write-Host "11. 关闭 RAGLite 开机自启与异常恢复"
    Write-Host "0. 退出"
    $choice = Read-Host "请选择"
    try {
      switch ($choice) {
        "1" { Invoke-Action "Start" "Ollama" $config }
        "2" { Invoke-Action "Stop" "Ollama" $config }
        "3" { Invoke-Action "Restart" "Ollama" $config }
        "4" { Invoke-Action "EnableAutoStart" "Ollama" $config }
        "5" { Invoke-Action "DisableAutoStart" "Ollama" $config }
        "6" { Invoke-Action "ConfigureRagLite" "RagLite" $config }
        "7" { Invoke-Action "Start" "RagLite" $config }
        "8" { Invoke-Action "Stop" "RagLite" $config }
        "9" { Invoke-Action "Restart" "RagLite" $config }
        "10" { Invoke-Action "EnableAutoStart" "RagLite" $config }
        "11" { Invoke-Action "DisableAutoStart" "RagLite" $config }
        "0" { return }
        default { Write-Host "无效选择。" -ForegroundColor Yellow }
      }
    } catch {
      Write-Host $_.Exception.Message -ForegroundColor Red
    }
    Write-Host ""
    Read-Host "按 Enter 返回菜单" | Out-Null
  }
}

Ensure-Directories
if ($Interactive -or $Action -eq "Menu") {
  Show-Menu
} else {
  $config = Get-Config
  if ($Action -eq "ConfigureRagLite") {
    Configure-RagLite $config
  } else {
    Invoke-Action $Action $Service $config
  }
}
