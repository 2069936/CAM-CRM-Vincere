[CmdletBinding()]
param(
    [Parameter(Mandatory)][string[]]$Paths,
    [string]$CertificateBase64 = $env:WINDOWS_SIGNING_CERT_BASE64,
    [string]$CertificatePassword = $env:WINDOWS_SIGNING_CERT_PASSWORD,
    [string]$TimestampUrl = $env:WINDOWS_SIGNING_TIMESTAMP_URL
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $IsWindows) { throw 'Authenticode signing requires Windows.' }
if (-not $CertificateBase64 -or -not $CertificatePassword -or -not $TimestampUrl) {
    throw 'All Windows signing secrets are required.'
}
$signtool = (Get-Command signtool.exe -ErrorAction Stop).Source
$certificatePath = Join-Path ([IO.Path]::GetTempPath()) ("vincere-signing-{0}.pfx" -f [guid]::NewGuid().ToString('N'))
try {
    [IO.File]::WriteAllBytes($certificatePath, [Convert]::FromBase64String($CertificateBase64))
    foreach ($path in $Paths) {
        $resolved = (Resolve-Path -LiteralPath $path -ErrorAction Stop).Path
        & $signtool sign /fd SHA256 /f $certificatePath /p $CertificatePassword /tr $TimestampUrl /td SHA256 $resolved
        if ($LASTEXITCODE -ne 0) { throw "signtool failed for $resolved" }
        $signature = Get-AuthenticodeSignature -LiteralPath $resolved
        if ($signature.Status -ne 'Valid') { throw "Invalid Authenticode signature for $resolved: $($signature.Status)" }
    }
}
finally {
    if (Test-Path -LiteralPath $certificatePath) {
        [IO.File]::WriteAllBytes($certificatePath, [byte[]]::new(0))
        Remove-Item -LiteralPath $certificatePath -Force
    }
}
