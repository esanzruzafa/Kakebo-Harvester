$env:KAKEBO_ENV_FILE = Join-Path $PSScriptRoot "..\private\.env.production"
Set-Location (Join-Path $PSScriptRoot "..")
npm run cli -- sync-all
exit $LASTEXITCODE
