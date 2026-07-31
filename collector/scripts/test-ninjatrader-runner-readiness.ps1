[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$NinjaTraderHome,
    [Parameter(Mandatory)][string]$ParityEvidencePath,
    [Parameter(Mandatory)][string]$CheckoutPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-ControlledPath {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$MissingCode
    )

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
        throw $MissingCode
    }
    try {
        return (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    }
    catch {
        throw $MissingCode
    }
}

function Test-PathWithin {
    param(
        [Parameter(Mandatory)][string]$Candidate,
        [Parameter(Mandatory)][string]$Parent
    )

    $separator = [IO.Path]::DirectorySeparatorChar
    $candidatePath = [IO.Path]::GetFullPath($Candidate).TrimEnd($separator)
    $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd($separator)
    return $candidatePath.Equals($parentPath, [StringComparison]::OrdinalIgnoreCase) -or
        $candidatePath.StartsWith($parentPath + $separator, [StringComparison]::OrdinalIgnoreCase)
}

function New-PassedCheck {
    param([Parameter(Mandatory)][string]$Name)
    return [pscustomobject][ordered]@{ name = $Name; passed = $true }
}

$checkout = Resolve-ControlledPath -Path $CheckoutPath -MissingCode 'runner_missing_checkout'
$ninjaTraderRoot = Resolve-ControlledPath -Path $NinjaTraderHome -MissingCode 'runner_missing_ninjatrader_home'
if (Test-PathWithin -Candidate $ninjaTraderRoot -Parent $checkout) {
    throw 'runner_ninjatrader_inside_checkout'
}

$checks = [Collections.Generic.List[object]]::new()
$checks.Add((New-PassedCheck 'ninjatrader_outside_checkout'))
$requiredAssemblies = [ordered]@{
    'NinjaTrader.Core.dll' = 'core'
    'NinjaTrader.Gui.dll' = 'gui'
    'NinjaTrader.NinjaScript.dll' = 'ninjascript'
}
foreach ($assembly in $requiredAssemblies.GetEnumerator()) {
    $path = Join-Path $ninjaTraderRoot "bin\$($assembly.Key)"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "runner_missing_ninjatrader_$($assembly.Value)"
    }
    if ((Get-Item -LiteralPath $path).Length -lt 1) {
        throw "runner_empty_ninjatrader_$($assembly.Value)"
    }
    $checks.Add((New-PassedCheck "ninjatrader_$($assembly.Value)"))
}

if (Test-PathWithin -Candidate ([IO.Path]::GetFullPath($ParityEvidencePath)) -Parent $checkout) {
    throw 'runner_parity_evidence_inside_checkout'
}
$checks.Add((New-PassedCheck 'parity_evidence_outside_checkout'))
$evidence = Resolve-ControlledPath -Path $ParityEvidencePath -MissingCode 'runner_missing_parity_evidence'
$checks.Add((New-PassedCheck 'parity_evidence_present'))
if (-not (Test-Path -LiteralPath $evidence -PathType Leaf) -or
    (Get-Item -LiteralPath $evidence).Length -lt 1) {
    throw 'runner_empty_parity_evidence'
}
$checks.Add((New-PassedCheck 'parity_evidence_nonempty'))

return [pscustomobject][ordered]@{
    ready = $true
    code = 'runner_ready'
    checks = @($checks)
}
