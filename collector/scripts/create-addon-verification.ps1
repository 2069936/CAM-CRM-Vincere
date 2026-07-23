[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$AddOnPath,
    [Parameter(Mandatory)][string]$ParityEvidencePath,
    [Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+(?:\.\d+)?$')][string]$Version,
    [Parameter(Mandatory)][string]$OutputPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$addOn = (Resolve-Path -LiteralPath $AddOnPath -ErrorAction Stop).Path
$evidence = Get-Content -LiteralPath $ParityEvidencePath -Raw | ConvertFrom-Json
if ($evidence.schemaVersion -ne 1 -or -not $evidence.allFourSectionsPassed -or $evidence.captureMethod -ne 'supported-api') {
    throw 'Parity evidence must prove all four SnapshotV1 sections through supported NinjaTrader APIs.'
}
$receipt = [ordered]@{
    schemaVersion = 1
    version = $Version
    contract = 'SnapshotV1'
    sha256 = (Get-FileHash -LiteralPath $addOn -Algorithm SHA256).Hash.ToLowerInvariant()
    supportedApiParityPassed = $true
    verifiedAt = [DateTimeOffset]::UtcNow.ToString('O')
    runner = $env:RUNNER_NAME
}
$destination = [IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($destination)) -Force | Out-Null
[IO.File]::WriteAllText($destination, ($receipt | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
Get-Item -LiteralPath $destination
