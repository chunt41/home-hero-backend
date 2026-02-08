[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$File,

  [Parameter(Mandatory = $false)]
  [string]$DatabaseUrl = $env:DATABASE_URL,

  [Parameter(Mandatory = $true)]
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name not found. Install Postgres client tools and ensure it is on PATH."
  }
}

Assert-Command -Name 'psql'

if (-not (Test-Path -LiteralPath $File)) {
  throw "Backup file not found: $File"
}

if ([string]::IsNullOrWhiteSpace($DatabaseUrl)) {
  throw "Missing target DB URL. Set DATABASE_URL or pass -DatabaseUrl."
}

if (-not $Force) {
  throw "Refusing to restore without -Force (this can overwrite the target DB)."
}

Write-Host "[restore] starting" -ForegroundColor Cyan
Write-Host "[restore] file=$File" -ForegroundColor Cyan

# Confirm connectivity
& psql $DatabaseUrl -v ON_ERROR_STOP=1 -tAc "SELECT 1;" | Out-Null

$ext = [System.IO.Path]::GetExtension($File)

if ($ext -ieq '.gz') {
  # Stream-decompress into psql stdin.
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'psql'
  $psi.Arguments = "$DatabaseUrl -v ON_ERROR_STOP=1"
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true

  $p = New-Object System.Diagnostics.Process
  $p.StartInfo = $psi
  if (-not $p.Start()) { throw 'Failed to start psql' }

  try {
    $fileStream = [System.IO.File]::OpenRead($File)
    try {
      $gzipStream = New-Object System.IO.Compression.GZipStream($fileStream, [System.IO.Compression.CompressionMode]::Decompress)
      try {
        $buffer = New-Object byte[] 65536
        while (($read = $gzipStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
          $p.StandardInput.BaseStream.Write($buffer, 0, $read)
        }
      } finally {
        $gzipStream.Dispose()
      }
    } finally {
      $fileStream.Dispose()
    }

    $p.StandardInput.Close()

    $stdout = $p.StandardOutput.ReadToEnd()
    $stderr = $p.StandardError.ReadToEnd()
    $p.WaitForExit()

    if (-not [string]::IsNullOrWhiteSpace($stdout)) {
      Write-Host $stdout
    }

    if ($p.ExitCode -ne 0) {
      if (-not [string]::IsNullOrWhiteSpace($stderr)) { Write-Error $stderr }
      throw "psql restore failed with exit code $($p.ExitCode)"
    }

    if (-not [string]::IsNullOrWhiteSpace($stderr)) {
      Write-Warning $stderr.Trim()
    }
  } finally {
    if (-not $p.HasExited) { $p.Kill() }
    $p.Dispose()
  }
} else {
  # Plain SQL file
  & psql $DatabaseUrl -v ON_ERROR_STOP=1 -f $File
  if ($LASTEXITCODE -ne 0) {
    throw "psql restore failed with exit code $LASTEXITCODE"
  }
}

# Verify DB responds
& psql $DatabaseUrl -v ON_ERROR_STOP=1 -tAc "SELECT now();" | Out-Null

Write-Host "[restore] done" -ForegroundColor Green
