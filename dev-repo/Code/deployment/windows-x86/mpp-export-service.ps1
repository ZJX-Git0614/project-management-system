param(
  [int]$Port = 3210,
  [string]$ConfigPath = ""
)

$ErrorActionPreference = "Stop"
$MaxRequestBytes = 50MB

function Read-EnvValue([string]$Path, [string]$Name) {
  if (-not $Path -or -not (Test-Path $Path)) { return "" }
  $line = Get-Content -Path $Path | Where-Object { $_ -match "^$([regex]::Escape($Name))=" } | Select-Object -Last 1
  if (-not $line) { return "" }
  return ($line -split "=", 2)[1].Trim()
}

function Write-JsonResponse($Response, [int]$StatusCode, [hashtable]$Payload) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes(($Payload | ConvertTo-Json -Compress))
  $Response.StatusCode = $StatusCode
  $Response.ContentType = "application/json; charset=utf-8"
  $Response.ContentLength64 = $bytes.Length
  $Response.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Test-Authorization($Request, [string]$ExpectedToken) {
  if (-not $ExpectedToken) { return $true }
  return $Request.Headers["Authorization"] -eq "Bearer $ExpectedToken"
}

$token = Read-EnvValue $ConfigPath "PROJECT_MPP_EXPORT_SERVICE_TOKEN"
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://+:$Port/")
$listener.Start()
Write-Host "Ceastar PMS MPP export service is listening on port $Port."

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $request = $context.Request
    $response = $context.Response
    $temporaryDirectory = ""
    $projectApplication = $null
    try {
      if (-not (Test-Authorization $request $token)) {
        Write-JsonResponse $response 401 @{ ok = $false; error = "Unauthorized" }
        continue
      }

      if ($request.HttpMethod -eq "GET" -and $request.Url.AbsolutePath -eq "/health") {
        Write-JsonResponse $response 200 @{ ok = $true; converter = "Microsoft Project COM" }
        continue
      }

      if ($request.HttpMethod -ne "POST" -or $request.Url.AbsolutePath -ne "/convert") {
        Write-JsonResponse $response 404 @{ ok = $false; error = "Not found" }
        continue
      }
      if ($request.ContentLength64 -lt 1 -or $request.ContentLength64 -gt $MaxRequestBytes) {
        Write-JsonResponse $response 413 @{ ok = $false; error = "Invalid request size" }
        continue
      }

      $temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("ceastar-mpp-" + [guid]::NewGuid().ToString("N"))
      [System.IO.Directory]::CreateDirectory($temporaryDirectory) | Out-Null
      $inputPath = Join-Path $temporaryDirectory "project.xml"
      $outputPath = Join-Path $temporaryDirectory "project.mpp"
      $inputStream = [System.IO.File]::Create($inputPath)
      try {
        $request.InputStream.CopyTo($inputStream)
      } finally {
        $inputStream.Dispose()
      }

      $projectApplication = New-Object -ComObject MSProject.Application
      $projectApplication.Visible = $false
      $projectApplication.DisplayAlerts = $false
      $projectApplication.FileOpenEx($inputPath, $true)
      $projectApplication.FileSaveAs($outputPath, 0)
      $projectApplication.FileCloseAll(0)

      if (-not (Test-Path $outputPath)) {
        throw "Microsoft Project did not create the MPP file."
      }
      $bytes = [System.IO.File]::ReadAllBytes($outputPath)
      $response.StatusCode = 200
      $response.ContentType = "application/vnd.ms-project"
      $response.ContentLength64 = $bytes.Length
      $response.OutputStream.Write($bytes, 0, $bytes.Length)
    } catch {
      if ($response.OutputStream.CanWrite) {
        Write-JsonResponse $response 500 @{ ok = $false; error = $_.Exception.Message }
      }
    } finally {
      if ($projectApplication) {
        try { $projectApplication.FileCloseAll(0) } catch {}
        try { $projectApplication.Quit() } catch {}
        try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($projectApplication) } catch {}
      }
      if ($temporaryDirectory) {
        Remove-Item -Path $temporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
      }
      try { $response.OutputStream.Close() } catch {}
    }
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
