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
$evidencePath = (Resolve-Path -LiteralPath $ParityEvidencePath -ErrorAction Stop).Path
$evidence = Get-Content -LiteralPath $evidencePath -Raw | ConvertFrom-Json
if ($evidence.schemaVersion -ne 1 -or -not $evidence.allFourSectionsPassed -or $evidence.captureMethod -ne 'supported-api') {
    throw 'Parity evidence must prove all four SnapshotV1 sections through supported NinjaTrader APIs.'
}
$evidenceProperties = @($evidence.PSObject.Properties.Name)
if ('comparisonSha256' -notin $evidenceProperties -or $evidence.comparisonSha256 -notmatch '^[a-fA-F0-9]{64}$') {
    throw 'Parity evidence comparisonSha256 must bind the review to the exact comparison report.'
}
foreach ($name in 'reviewer', 'reviewedAt', 'environment', 'checks', 'sections', 'decisions') {
    if ($name -notin $evidenceProperties) { throw "Parity evidence is missing $name." }
}
if ([string]::IsNullOrWhiteSpace($evidence.reviewer)) { throw 'Parity evidence reviewer is required.' }
try { [void][DateTimeOffset]::Parse($evidence.reviewedAt, [Globalization.CultureInfo]::InvariantCulture) }
catch { throw 'Parity evidence reviewedAt must be a valid timestamp.' }

foreach ($name in 'windowsVersion', 'ninjaTraderVersion', 'connectionProvider', 'localTimeZone') {
    if ($name -notin @($evidence.environment.PSObject.Properties.Name) -or
        [string]::IsNullOrWhiteSpace($evidence.environment.$name)) {
        throw "Parity evidence environment.$name is required."
    }
}
foreach ($name in 'sameMinuteCapture', 'postResetRealizedGrossVerified',
    'twoStrategyAlgorithmsVerified', 'currentSessionExecutionsConfirmed') {
    if ($name -notin @($evidence.checks.PSObject.Properties.Name) -or $evidence.checks.$name -ne $true) {
        throw "Parity evidence checks.$name must be true."
    }
}
foreach ($name in 'accounts', 'strategies', 'orders', 'executions') {
    if ($name -notin @($evidence.sections.PSObject.Properties.Name)) {
        throw "Parity evidence is missing the $name section."
    }
    $section = $evidence.sections.$name
    if ($section.passed -ne $true -or $section.apiRowCount -lt 1 -or $section.gridRowCount -lt 1) {
        throw "Parity evidence $name must pass with at least one API and grid row."
    }
}

$allowedActions = @(
    'accept-supported-api',
    'derive-in-crm',
    'preserve-null-optional',
    'version-guarded-reflection'
)
foreach ($decision in @($evidence.decisions)) {
    if ($decision.action -notin $allowedActions -or
        ($decision.required -eq $true -and $decision.action -eq 'preserve-null-optional')) {
        throw "Parity evidence contains an invalid production action: $($decision.action)."
    }
    if ($decision.status -eq 'missing-grid' -and $decision.action -ne 'accept-supported-api') {
        throw "Parity evidence contains an invalid production action for missing-grid: $($decision.action)."
    }
    if ($decision.status -eq 'missing-api' -and $decision.action -eq 'accept-supported-api') {
        throw "Parity evidence contains an invalid production action for missing-api: $($decision.action)."
    }
    if ([string]::IsNullOrWhiteSpace($decision.section) -or
        [string]::IsNullOrWhiteSpace($decision.field) -or
        [string]::IsNullOrWhiteSpace($decision.rationale)) {
        throw 'Parity evidence decisions require section, field, and rationale.'
    }
}
$receipt = [ordered]@{
    schemaVersion = 1
    version = $Version
    contract = 'SnapshotV1'
    sha256 = (Get-FileHash -LiteralPath $addOn -Algorithm SHA256).Hash.ToLowerInvariant()
    supportedApiParityPassed = $true
    parityComparisonSha256 = $evidence.comparisonSha256.ToLowerInvariant()
    parityEvidenceSha256 = (Get-FileHash -LiteralPath $evidencePath -Algorithm SHA256).Hash.ToLowerInvariant()
    parityReviewedAt = ([DateTimeOffset]::Parse(
        $evidence.reviewedAt,
        [Globalization.CultureInfo]::InvariantCulture)).ToUniversalTime().ToString('O')
    verifiedAt = [DateTimeOffset]::UtcNow.ToString('O')
    runner = $env:RUNNER_NAME
}
$destination = [IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($destination)) -Force | Out-Null
[IO.File]::WriteAllText($destination, ($receipt | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
Get-Item -LiteralPath $destination
