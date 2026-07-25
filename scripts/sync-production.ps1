$env:KAKEBO_ENV_FILE = Join-Path $PSScriptRoot "..\.env.production"
Set-Location (Join-Path $PSScriptRoot "..")
npm run cli -- sync-all
exit $LASTEXITCODE
