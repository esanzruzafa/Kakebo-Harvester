param(
  [string]$PrivateDirectory = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")).Path "private"),
  [string]$PfxPath = "",
  [string]$PassphrasePath = "",
  [string]$CaThumbprintPath = "",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$privateDirectoryPath = [IO.Path]::GetFullPath($PrivateDirectory)
$resolvedPfxPath = if ($PfxPath) {
  [IO.Path]::GetFullPath($PfxPath)
} else {
  Join-Path $privateDirectoryPath "local-https-production.pfx"
}
$resolvedPassphrasePath = if ($PassphrasePath) {
  [IO.Path]::GetFullPath($PassphrasePath)
} else {
  Join-Path $privateDirectoryPath "local-https-production.passphrase"
}
$resolvedCaThumbprintPath = if ($CaThumbprintPath) {
  [IO.Path]::GetFullPath($CaThumbprintPath)
} else {
  Join-Path $privateDirectoryPath "local-https-production-ca.thumbprint"
}

@(
  $privateDirectoryPath,
  [IO.Path]::GetDirectoryName($resolvedPfxPath),
  [IO.Path]::GetDirectoryName($resolvedPassphrasePath),
  [IO.Path]::GetDirectoryName($resolvedCaThumbprintPath)
) | Select-Object -Unique | ForEach-Object {
  New-Item -ItemType Directory -Path $_ -Force | Out-Null
}

$existingPaths = @($resolvedPfxPath, $resolvedPassphrasePath, $resolvedCaThumbprintPath) |
  Where-Object { Test-Path -LiteralPath $_ }

if ($existingPaths.Count -gt 0 -and -not $Force) {
  throw "Local TLS files already exist. Use -Force only when you intend to regenerate them."
}

if ($Force -and (Test-Path -LiteralPath $resolvedCaThumbprintPath)) {
  $previousThumbprint = (Get-Content -LiteralPath $resolvedCaThumbprintPath -Raw).Trim()
  if ($previousThumbprint -match "^[A-Fa-f0-9]{40}$") {
    $previousTrustedCertificate = "Cert:\CurrentUser\Root\$previousThumbprint"
    if (Test-Path -LiteralPath $previousTrustedCertificate) {
      Remove-Item -LiteralPath $previousTrustedCertificate -Force
    }
  }
}

if ($Force) {
  foreach ($path in $existingPaths) {
    Remove-Item -LiteralPath $path -Force
  }
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
  Export-PfxCertificate -Cert $serverCertificate -FilePath $resolvedPfxPath -Password $securePassphrase |
    Out-Null
  Set-Content -LiteralPath $resolvedPassphrasePath -Value $passphrase -Encoding Ascii -NoNewline
  Set-Content -LiteralPath $resolvedCaThumbprintPath -Value $certificateAuthority.Thumbprint -Encoding Ascii -NoNewline
} finally {
  if (Test-Path -LiteralPath $temporaryCertificate) {
    Remove-Item -LiteralPath $temporaryCertificate -Force
  }
  Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($serverCertificate.Thumbprint)" -Force
  Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($certificateAuthority.Thumbprint)" -Force
}

Write-Host "The local certificate authority and localhost HTTPS certificate are ready."
Write-Host "PFX: $resolvedPfxPath"
Write-Host "Passphrase: $resolvedPassphrasePath"
