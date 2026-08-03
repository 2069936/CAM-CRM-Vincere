[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+(?:\.\d+)?$')][string]$Version,
    [Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+(?:\.\d+)?$')][string]$MinimumAgentVersion,
    [Parameter(Mandatory)][int]$MinimumSchemaVersion,
    [Parameter(Mandatory)][string[]]$ArtifactPaths,
    [Parameter(Mandatory)][string]$BaseUrl,
    [Parameter(Mandatory)][string]$SigningThumbprint,
    [Parameter(Mandatory)][string]$OutputPath,
    [string]$PreviousManifestPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $BaseUrl.StartsWith('https://', [StringComparison]::OrdinalIgnoreCase)) { throw 'BaseUrl must use HTTPS.' }
$thumbprint = ($SigningThumbprint -replace '\s', '').ToUpperInvariant()
if ($thumbprint -notmatch '^[A-F0-9]{40,128}$') { throw 'Signing thumbprint is invalid.' }
if ($PreviousManifestPath) {
    $previous = Get-Content -LiteralPath $PreviousManifestPath -Raw | ConvertFrom-Json
    if ([version]$Version -le [version]$previous.version) { throw 'Release version must increase monotonically.' }
}

$artifacts = @($ArtifactPaths | ForEach-Object {
    $item = Get-Item -LiteralPath $_ -ErrorAction Stop
    if ($IsWindows -and $item.Extension -in '.exe', '.msi', '.dll') {
        $signature = Get-AuthenticodeSignature -LiteralPath $item.FullName
        if ($signature.Status -ne 'Valid') { throw "Production artifact is not validly signed: $($item.Name)" }
        if (($signature.SignerCertificate.Thumbprint -replace '\s', '').ToUpperInvariant() -ne $thumbprint) {
            throw "Artifact signer does not match the release thumbprint: $($item.Name)"
        }
    }
    [ordered]@{
        name = $item.Name
        url = $BaseUrl.TrimEnd('/') + '/' + [Uri]::EscapeDataString($item.Name)
        sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        size = $item.Length
    }
})
$manifest = [ordered]@{
    schemaVersion = 1
    version = $Version
    minimumAgentVersion = $MinimumAgentVersion
    minimumSchemaVersion = $MinimumSchemaVersion
    publishedAt = [DateTimeOffset]::UtcNow.ToString('O')
    signingThumbprint = $thumbprint
    artifacts = $artifacts
}
$destination = [IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($destination)) -Force | Out-Null
[IO.File]::WriteAllText($destination, ($manifest | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
$schema = Join-Path $PSScriptRoot '..\release\release-manifest.schema.json'
if (-not (Get-Content -LiteralPath $destination -Raw | Test-Json -SchemaFile $schema)) {
    throw 'Generated release manifest failed schema validation.'
}
Get-Item -LiteralPath $destination
