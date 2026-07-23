[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ManifestPath,
    [Parameter(Mandatory)][string]$OutputSignaturePath,
    [string]$CertificateBase64 = $env:WINDOWS_SIGNING_CERT_BASE64,
    [string]$CertificatePassword = $env:WINDOWS_SIGNING_CERT_PASSWORD
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $CertificateBase64 -or -not $CertificatePassword) { throw 'Windows signing certificate secrets are required.' }

$certificateBytes = [Convert]::FromBase64String($CertificateBase64)
$certificate = $null
try {
    $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new(
        $certificateBytes,
        $CertificatePassword,
        [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet)
    $content = [Security.Cryptography.Pkcs.ContentInfo]::new([IO.File]::ReadAllBytes($ManifestPath))
    $signed = [Security.Cryptography.Pkcs.SignedCms]::new($content, $true)
    $signer = [Security.Cryptography.Pkcs.CmsSigner]::new($certificate)
    $signer.IncludeOption = [Security.Cryptography.X509Certificates.X509IncludeOption]::EndCertOnly
    $signed.ComputeSignature($signer)
    $encoded = $signed.Encode()
    [IO.File]::WriteAllBytes([IO.Path]::GetFullPath($OutputSignaturePath), $encoded)
    $verification = [Security.Cryptography.Pkcs.SignedCms]::new($content, $true)
    $verification.Decode($encoded)
    $verification.CheckSignature($true)
}
finally {
    if ($certificateBytes) { [Security.Cryptography.CryptographicOperations]::ZeroMemory($certificateBytes) }
    if ($certificate) { $certificate.Dispose() }
}
