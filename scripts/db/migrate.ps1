[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$DatabaseUrl = $env:DATABASE_URL,

  [Parameter(Mandatory = $false)]
  [switch]$NoLock
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name not found. Ensure it is installed and on PATH."
  }
}

Assert-Command -Name 'psql'
Assert-Command -Name 'npx'

if ([string]::IsNullOrWhiteSpace($DatabaseUrl)) {
  throw "Missing DB URL. Set DATABASE_URL or pass -DatabaseUrl."
}

$lockKeySql = "hashtext('home-hero-backend-prisma-migrate')"
$lockAcquired = $false

function Release-Lock {
  if ($lockAcquired) {
    Write-Host "[migrate] releasing advisory lock" -ForegroundColor DarkCyan
    try {
      & psql $DatabaseUrl -v ON_ERROR_STOP=1 -tAc "SELECT pg_advisory_unlock($lockKeySql);" | Out-Null
    } catch {
      Write-Warning "Failed to release lock (best-effort): $($_.Exception.Message)"
    }
  }
}

try {
  if (-not $NoLock) {
    Write-Host "[migrate] acquiring advisory lock" -ForegroundColor Cyan
    & psql $DatabaseUrl -v ON_ERROR_STOP=1 -tAc "SELECT pg_advisory_lock($lockKeySql);" | Out-Null
    $lockAcquired = $true
  } else {
    Write-Host "[migrate] -NoLock set; skipping advisory lock" -ForegroundColor Yellow
  }

  Write-Host "[migrate] prisma migrate status (pre)" -ForegroundColor Cyan
  & npx prisma migrate status
  if ($LASTEXITCODE -ne 0) { throw "prisma migrate status failed ($LASTEXITCODE)" }

  Write-Host "[migrate] prisma migrate deploy" -ForegroundColor Cyan
  & npx prisma migrate deploy
  if ($LASTEXITCODE -ne 0) { throw "prisma migrate deploy failed ($LASTEXITCODE)" }

  Write-Host "[migrate] prisma migrate status (post)" -ForegroundColor Cyan
  & npx prisma migrate status
  if ($LASTEXITCODE -ne 0) { throw "prisma migrate status failed ($LASTEXITCODE)" }

  Write-Host "[migrate] done" -ForegroundColor Green
} finally {
  Release-Lock
}
