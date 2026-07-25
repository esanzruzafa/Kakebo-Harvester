$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$privateDirectory = Join-Path $projectRoot "private"
$pfxPath = Join-Path $privateDirectory "local-https-production.pfx"
$passphrasePath = Join-Path $privateDirectory "local-https-production.passphrase"
$caThumbprintPath = Join-Path $privateDirectory "local-https-production-ca.thumbprint"

New-Item -ItemType Directory -Path $privateDirectory -Force | Out-Null

if (
  (Test-Path -LiteralPath $pfxPath) -or
  (Test-Path -LiteralPath $passphrasePath) -or
  (Test-Path -LiteralPath $caThumbprintPath)
) {
  throw "Ya existe la configuración TLS local. Elimina manualmente los tres archivos si quieres regenerarla."
}

$randomBytes = New-Object byte[] 32
$randomNumberGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $randomNumberGenerator.GetBytes($randomBytes)
} finally {
  $randomNumberGenerator.Dispose()
}

$passphrase = [Convert]::ToBase64String($randomBytes)
$securePassphrase = ConvertTo-SecureString $passphrase -AsPlainText -Force
$certificateAuthority = New-SelfSignedCertificate `
  -Type Custom `
  -Subject "CN=Kakebo Harvester Local CA" `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -KeyAlgorithm RSA `
  -KeyLength 2048 `
  -HashAlgorithm SHA256 `
  -KeyUsage CertSign, CRLSign, DigitalSignature `
  -KeyExportPolicy NonExportable `
  -NotAfter (Get-Date).AddYears(5) `
  -TextExtension @("2.5.29.19={critical}{text}ca=1") `
  -FriendlyName "Kakebo Harvester Local CA"

$serverCertificate = New-SelfSignedCertificate `
  -Type Custom `
  -Subject "CN=localhost" `
  -DnsName "localhost" `
  -Signer $certificateAuthority `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -KeyAlgorithm RSA `
  -KeyLength 2048 `
  -HashAlgorithm SHA256 `
  -KeyUsage DigitalSignature, KeyEncipherment `
  -KeyExportPolicy Exportable `
  -NotAfter (Get-Date).AddYears(2) `
  -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.1") `
  -FriendlyName "Kakebo Harvester localhost"

$temporaryCertificate = Join-Path ([IO.Path]::GetTempPath()) "kakebo-harvester-localhost-$([guid]::NewGuid()).cer"
try {
  Export-Certificate -Cert $certificateAuthority -FilePath $temporaryCertificate | Out-Null
  Import-Certificate -FilePath $temporaryCertificate -CertStoreLocation "Cert:\CurrentUser\Root" |
    Out-Null
  Export-PfxCertificate -Cert $serverCertificate -FilePath $pfxPath -Password $securePassphrase |
    Out-Null
  Set-Content -LiteralPath $passphrasePath -Value $passphrase -Encoding Ascii -NoNewline
  Set-Content -LiteralPath $caThumbprintPath -Value $certificateAuthority.Thumbprint -Encoding Ascii -NoNewline
} finally {
  if (Test-Path -LiteralPath $temporaryCertificate) {
    Remove-Item -LiteralPath $temporaryCertificate -Force
  }
  Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($serverCertificate.Thumbprint)" -Force
  Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($certificateAuthority.Thumbprint)" -Force
}

Write-Host "CA local y certificado HTTPS de localhost creados para el usuario actual."
Write-Host "PFX: $pfxPath"
Write-Host "Contraseña: $passphrasePath"
