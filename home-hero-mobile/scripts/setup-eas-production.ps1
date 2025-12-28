param(
  [Parameter(Mandatory = $false)]
  [string]$StripePublishableKey
)

$ErrorActionPreference = 'Stop'

function Require-Command([string]$Name) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $cmd) {
    throw "Required command not found: $Name"
  }
}

Write-Host "Setting up EAS production secrets/env (no values will be committed)." -ForegroundColor Cyan

Require-Command node
Require-Command npx

Write-Host "Checking EAS CLI..." -ForegroundColor Cyan
& npx -y eas --version | Out-Host
if ($LASTEXITCODE -ne 0) {
  throw "Failed to run EAS CLI via npx. Ensure Node/npm can run npx, then try again."
}

if (-not $StripePublishableKey -or -not $StripePublishableKey.Trim()) {
  $StripePublishableKey = Read-Host "Enter Stripe LIVE publishable key (pk_live_...)"
}

if (-not $StripePublishableKey.StartsWith('pk_live_')) {
  Write-Warning "This does not look like a live publishable key (expected pk_live_...)."
}

# NOTE: EAS CLI must be authenticated (it will prompt/login if not).
Write-Host "Creating/updating EAS secret EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY..." -ForegroundColor Cyan

& npx -y eas secret:create --scope project --name EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY --value $StripePublishableKey
if ($LASTEXITCODE -eq 0) {
  Write-Host "Created secret." -ForegroundColor Green
} else {
  Write-Warning "Secret may already exist or EAS needs login. Attempting to replace it..."

  & npx -y eas secret:delete --scope project --name EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Could not delete existing secret (it may not exist, or you may need to login: 'npx eas login')."
  }

  & npx -y eas secret:create --scope project --name EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY --value $StripePublishableKey
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to create EAS secret. Ensure you're logged in ('npx eas login') and have access to this project." 
  }

  Write-Host "Replaced secret." -ForegroundColor Green
}

Write-Host "Done." -ForegroundColor Green
Write-Host "Next: run an EAS production build (e.g., 'npx eas build -p android --profile production')." -ForegroundColor Green
