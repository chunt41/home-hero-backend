[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$DatabaseUrl = $env:DATABASE_URL,

  [Parameter(Mandatory = $false)]
  [string]$Out,

  [Parameter(Mandatory = $false)]
  [switch]$NoGzip,

  [Parameter(Mandatory = $false)]
  [switch]$IncludeDrop
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name not found. Install Postgres client tools and ensure it is on PATH."
  }
}

Assert-Command -Name 'pg_dump'

if ([string]::IsNullOrWhiteSpace($DatabaseUrl) -and [string]::IsNullOrWhiteSpace($env:PGDATABASE)) {
  throw "Missing database connection settings. Set DATABASE_URL or set PGDATABASE (and PGHOST/PGUSER/PGPASSWORD as needed)."
}

$timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmssZ')
if ([string]::IsNullOrWhiteSpace($Out)) {
  New-Item -ItemType Directory -Force -Path 'backups' | Out-Null
  if ($NoGzip) {
    $Out = "backups/db-backup-$timestamp.sql"
  } else {
    $Out = "backups/db-backup-$timestamp.sql.gz"
  }
}

$dumpArgs = @('--no-owner', '--no-privileges', '--format=plain')
if ($IncludeDrop) {
  $dumpArgs += @('--clean', '--if-exists')
}

Write-Host "[backup] starting" -ForegroundColor Cyan
Write-Host "[backup] out=$Out" -ForegroundColor Cyan

# If DATABASE_URL is set, pass it as the final argument; otherwise rely on PG* env vars.
$finalArgs = @()
$finalArgs += $dumpArgs
if (-not [string]::IsNullOrWhiteSpace($DatabaseUrl)) {
  $finalArgs += $DatabaseUrl
}

function Invoke-PgDumpToFile([string]$TargetPath) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'pg_dump'
  $psi.Arguments = ($finalArgs -join ' ')
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true

  $p = New-Object System.Diagnostics.Process
  $p.StartInfo = $psi

  if (-not $p.Start()) { throw 'Failed to start pg_dump' }

  try {
    $outStream = [System.IO.File]::Open($TargetPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
      $buffer = New-Object byte[] 65536
      while (($read = $p.StandardOutput.BaseStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
        $outStream.Write($buffer, 0, $read)
      }
    } finally {
      $outStream.Dispose()
    }

    $stderr = $p.StandardError.ReadToEnd()
    $p.WaitForExit()

    if ($p.ExitCode -ne 0) {
      if (-not [string]::IsNullOrWhiteSpace($stderr)) { Write-Error $stderr }
      throw "pg_dump failed with exit code $($p.ExitCode)"
    }

    if (-not [string]::IsNullOrWhiteSpace($stderr)) {
      # pg_dump can emit warnings; surface them.
      Write-Warning $stderr.Trim()
    }
  } finally {
    if (-not $p.HasExited) { $p.Kill() }
    $p.Dispose()
  }
}

if ($NoGzip) {
  Invoke-PgDumpToFile -TargetPath $Out
} else {
  # Stream pg_dump -> GZipStream to avoid buffering large dumps in memory.
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'pg_dump'
  $psi.Arguments = ($finalArgs -join ' ')
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true

  $p = New-Object System.Diagnostics.Process
  $p.StartInfo = $psi

  if (-not $p.Start()) { throw 'Failed to start pg_dump' }

  try {
    $fileStream = [System.IO.File]::Open($Out, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
      $gzipStream = New-Object System.IO.Compression.GZipStream($fileStream, [System.IO.Compression.CompressionLevel]::Optimal)
      try {
        $buffer = New-Object byte[] 65536
        while (($read = $p.StandardOutput.BaseStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
          $gzipStream.Write($buffer, 0, $read)
        }
      } finally {
        $gzipStream.Dispose()
      }
    } finally {
      $fileStream.Dispose()
    }

    $stderr = $p.StandardError.ReadToEnd()
    $p.WaitForExit()

    if ($p.ExitCode -ne 0) {
      if (-not [string]::IsNullOrWhiteSpace($stderr)) { Write-Error $stderr }
      throw "pg_dump failed with exit code $($p.ExitCode)"
    }

    if (-not [string]::IsNullOrWhiteSpace($stderr)) {
      Write-Warning $stderr.Trim()
    }
  } finally {
    if (-not $p.HasExited) { $p.Kill() }
    $p.Dispose()
  }
}

# Best-effort checksum (built-in on Windows)
try {
  $hash = Get-FileHash -Algorithm SHA256 -Path $Out
  $hashPath = "$Out.sha256"
  "$($hash.Hash)  $([System.IO.Path]::GetFileName($Out))" | Set-Content -NoNewline -Encoding ASCII -Path $hashPath
  Write-Host "[backup] wrote checksum $hashPath" -ForegroundColor DarkCyan
} catch {
  Write-Warning "Could not write checksum: $($_.Exception.Message)"
}

Write-Host "[backup] done" -ForegroundColor Green
