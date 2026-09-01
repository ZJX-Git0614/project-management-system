param(
  [int]$Port = 8766,
  [string]$RuntimeDirectory = ""
)

$ErrorActionPreference = "Stop"
if (-not $RuntimeDirectory) { $RuntimeDirectory = Join-Path $env:ProgramData "Ceastar-PMS\assistant-services" }
$managerPath = Join-Path $RuntimeDirectory "assistant-services.ps1"
$tokenPath = Join-Path $RuntimeDirectory "bridge-token.txt"
$logDirectory = Join-Path $RuntimeDirectory "logs"
if (-not (Test-Path $logDirectory)) { New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null }
if (-not (Test-Path $managerPath)) { throw "缺少服务管理脚本：$managerPath" }
if (-not (Test-Path $tokenPath)) { throw "缺少服务桥接令牌：$tokenPath" }
$token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
if (-not $token) { throw "服务桥接令牌为空。" }

function Write-JsonResponse([System.Net.HttpListenerContext]$Context, [int]$StatusCode, [object]$Body) {
  $json = $Body | ConvertTo-Json -Depth 8 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $Context.Response.StatusCode = $StatusCode
  $Context.Response.ContentType = "application/json; charset=utf-8"
  $Context.Response.ContentLength64 = $bytes.Length
  $Context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $Context.Response.OutputStream.Close()
}

function Get-RequestBody([System.Net.HttpListenerRequest]$Request) {
  $reader = New-Object System.IO.StreamReader($Request.InputStream, $Request.ContentEncoding)
  try {
    $raw = $reader.ReadToEnd()
    return if ($raw) { $raw | ConvertFrom-Json } else { [pscustomobject]@{} }
  } finally {
    $reader.Dispose()
  }
}

function Invoke-Manager([string]$Action, [string]$Service = "All", [string[]]$ExtraArguments = @()) {
  $arguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $managerPath, "-Action", $Action, "-Service", $Service) + $ExtraArguments
  $output = @(& powershell.exe @arguments 2>&1 | ForEach-Object { $_.ToString() })
  if ($LASTEXITCODE -ne 0) { throw (($output | Select-Object -Last 12) -join "`n") }
  return ($output -join "`n").Trim()
}

function Get-StatusObject {
  $json = Invoke-Manager "StatusJson"
  return $json | ConvertFrom-Json
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://+:$Port/")
$listener.Start()
try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    try {
      if ($context.Request.Headers["Authorization"] -ne "Bearer $token") {
        Write-JsonResponse $context 401 @{ error = "主机服务管理令牌无效" }
        continue
      }
      $path = $context.Request.Url.AbsolutePath.TrimEnd("/")
      if ($context.Request.HttpMethod -eq "GET" -and $path -eq "/status") {
        Write-JsonResponse $context 200 (Get-StatusObject)
        continue
      }
      if ($context.Request.HttpMethod -eq "POST" -and $path -eq "/action") {
        $body = Get-RequestBody $context.Request
        $service = [string]$body.service
        $action = [string]$body.action
        if ($service -notin @("Ollama", "RagLite") -or $action -notin @("Start", "Stop", "Restart", "EnableAutoStart", "DisableAutoStart")) {
          Write-JsonResponse $context 400 @{ error = "服务操作参数无效" }
          continue
        }
        Invoke-Manager $action $service | Out-Null
        Write-JsonResponse $context 200 @{ message = "$service 操作已完成"; status = (Get-StatusObject) }
        continue
      }
      if ($context.Request.HttpMethod -eq "POST" -and $path -eq "/configure-raglite") {
        $body = Get-RequestBody $context.Request
        $directory = [string]$body.directory
        $executable = [string]$body.executable
        $ragArguments = [string]$body.arguments
        $extra = @(
          "-RagLiteDirectory", $directory,
          "-RagLiteExecutable", $executable,
          "-RagLiteArguments", $ragArguments
        )
        Invoke-Manager "ConfigureRagLite" "RagLite" $extra | Out-Null
        Write-JsonResponse $context 200 @{ message = "RAGLite 启动配置已保存"; status = (Get-StatusObject) }
        continue
      }
      Write-JsonResponse $context 404 @{ error = "接口不存在" }
    } catch {
      Write-JsonResponse $context 500 @{ error = $_.Exception.Message }
    }
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
