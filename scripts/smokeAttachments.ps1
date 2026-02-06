$ErrorActionPreference = 'Stop'

$root = 'c:\Users\cscot\Desktop\home-hero-backend'
Set-Location $root

$port = 4010
$base = "http://localhost:$port"

function New-TinyPng([string] $path) {
  $b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO8VJ4cAAAAASUVORK5CYII='
  [IO.File]::WriteAllBytes($path, [Convert]::FromBase64String($b64))
}

function Curl-FormUpload([
  string] $url,
  [string] $token,
  [string] $filePath,
  [string] $mimeType,
  [string] $outPath
) {
  $code = & curl.exe -s -o $outPath -w "%{http_code}" -X POST $url -H "Authorization: Bearer $token" -F "file=@$filePath;type=$mimeType"
  return $code
}

# Start server in a separate process so this script can run requests.
$env:PORT = "$port"
$outLog = Join-Path $env:TEMP ("home-hero-server-" + (Get-Date -Format 'yyyyMMddHHmmss') + '.out.log')
$errLog = Join-Path $env:TEMP ("home-hero-server-" + (Get-Date -Format 'yyyyMMddHHmmss') + '.err.log')

$proc = $null
$tmpDir = Join-Path $env:TEMP ("home-hero-smoke-" + (Get-Date -Format 'yyyyMMddHHmmss'))
New-Item -ItemType Directory -Path $tmpDir | Out-Null

try {
  # Ensure dist exists
  if (-not (Test-Path (Join-Path $root 'dist/server.js'))) {
    npm run build | Out-Null
  }

  $proc = Start-Process -FilePath 'node' -ArgumentList @('dist/server.js') -WorkingDirectory $root -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog

  # Wait for server
  $ready = $false
  for ($i = 0; $i -lt 20; $i++) {
    try {
      Invoke-RestMethod -Method Post -Uri "$base/auth/login" -ContentType 'application/json' -Body (@{ email = 'x'; password = 'y' } | ConvertTo-Json) -TimeoutSec 2 | Out-Null
      $ready = $true
      break
    } catch {
      # Any HTTP response means server is reachable
      if ($_.Exception.Response) {
        $ready = $true
        break
      }
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $ready) {
    throw "Server did not become reachable on $base"
  }

  # Signup a new consumer
  $stamp = Get-Date -Format 'yyyyMMddHHmmss'
  $email = "consumer+$stamp@example.com"
  $password = 'DevTestPassphrase!2345'

  $signup = Invoke-RestMethod -Method Post -Uri "$base/auth/signup" -ContentType 'application/json' -Body (@{ role = 'CONSUMER'; name = 'Test Consumer'; email = $email; password = $password } | ConvertTo-Json) -TimeoutSec 30
  $token = $signup.token

  # Create job
  $job = Invoke-RestMethod -Method Post -Uri "$base/jobs" -ContentType 'application/json' -Headers @{ Authorization = "Bearer $token" } -Body (@{ title = 'Test job'; description = 'Testing attachments'; budgetMin = 10; budgetMax = 50; location = 'Testville' } | ConvertTo-Json) -TimeoutSec 30
  $jobId = $job.id

  # Create tiny png
  $pngPath = Join-Path $tmpDir 'tiny.png'
  New-TinyPng -path $pngPath

  # Upload job attachment
  $jobUploadOut = Join-Path $tmpDir 'jobUpload.json'
  $jobUploadCode = Curl-FormUpload -url "$base/jobs/$jobId/attachments/upload" -token $token -filePath $pngPath -mimeType 'image/png' -outPath $jobUploadOut

  # Send message attachment (no text)
  $msgUploadOut = Join-Path $tmpDir 'msgUpload.json'
  $msgUploadCode = Curl-FormUpload -url "$base/jobs/$jobId/messages" -token $token -filePath $pngPath -mimeType 'image/png' -outPath $msgUploadOut

  # Fetch messages (should include attachments)
  $msgs = Invoke-RestMethod -Method Get -Uri "$base/jobs/$jobId/messages" -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 30
  $first = $msgs.items | Select-Object -First 1
  $hasMsgAttachment = [bool]($first.attachments -and $first.attachments.Count -gt 0)

  # Unsupported type
  $txtPath = Join-Path $tmpDir 'note.txt'
  Set-Content -Path $txtPath -Value 'hello'
  $unsupportedOut = Join-Path $tmpDir 'unsupported.json'
  $unsupportedCode = Curl-FormUpload -url "$base/jobs/$jobId/attachments/upload" -token $token -filePath $txtPath -mimeType 'text/plain' -outPath $unsupportedOut

  # Oversize (16MB)
  $bigPath = Join-Path $tmpDir 'big.bin'
  $bigBytes = New-Object byte[] (16 * 1024 * 1024)
  [Random]::new().NextBytes($bigBytes)
  [IO.File]::WriteAllBytes($bigPath, $bigBytes)
  $tooBigOut = Join-Path $tmpDir 'toobig.json'
  $tooBigCode = Curl-FormUpload -url "$base/jobs/$jobId/attachments/upload" -token $token -filePath $bigPath -mimeType 'image/png' -outPath $tooBigOut

  Write-Host "OK email=$email jobId=$jobId"
  Write-Host "JobUpload HTTP=$jobUploadCode"
  Write-Host "MsgUpload HTTP=$msgUploadCode"
  Write-Host "HasMsgAttachment=$hasMsgAttachment"
  Write-Host "Unsupported HTTP=$unsupportedCode"
  Write-Host "TooBig HTTP=$tooBigCode"
  Write-Host "Artifacts: $tmpDir"
  Write-Host "Server logs: $outLog ; $errLog"

  if ($jobUploadCode -ne '201') { throw "Expected 201 for job upload, got $jobUploadCode" }
  if ($msgUploadCode -ne '201') { throw "Expected 201 for message upload, got $msgUploadCode" }
  if (-not $hasMsgAttachment) { throw 'Expected message to include attachments.' }
  if ($unsupportedCode -ne '415') { throw "Expected 415 for unsupported type, got $unsupportedCode" }
  if ($tooBigCode -ne '413') { throw "Expected 413 for too-big file, got $tooBigCode" }

} finally {
  if ($proc -and -not $proc.HasExited) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  }
}
