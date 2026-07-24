Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-NinjaTraderRunning {
    return [bool](Get-Process -Name 'NinjaTrader' -ErrorAction SilentlyContinue)
}

function Get-NinjaTraderProfileCandidates {
    [CmdletBinding()]
    param([string]$UsersRoot = (Join-Path $env:SystemDrive 'Users'))

    if (-not (Test-Path -LiteralPath $UsersRoot -PathType Container)) { return @() }
    $excluded = @('All Users', 'Default', 'Default User', 'Public', 'defaultuser0')
    return @(Get-ChildItem -LiteralPath $UsersRoot -Directory -Force | Where-Object {
        $_.Name -notin $excluded
    } | ForEach-Object {
        $documentCandidates = @(
            (Join-Path $_.FullName 'Documents'),
            (Join-Path $_.FullName 'OneDrive\Documents')
        ) | Select-Object -Unique
        foreach ($documents in $documentCandidates) {
            $ninjaTrader = Join-Path $documents 'NinjaTrader 8'
            if (Test-Path -LiteralPath $ninjaTrader -PathType Container) {
                [pscustomobject]@{
                    UserName = $_.Name
                    DocumentsPath = $documents
                    NinjaTraderPath = $ninjaTrader
                }
            }
        }
    })
}

function Resolve-NinjaTraderDocuments {
    [CmdletBinding()]
    param(
        [string]$ExplicitDocumentsPath,
        [string]$UsersRoot = (Join-Path $env:SystemDrive 'Users')
    )

    if ($ExplicitDocumentsPath) {
        $resolved = [IO.Path]::GetFullPath($ExplicitDocumentsPath)
        if (-not (Test-Path -LiteralPath (Join-Path $resolved 'NinjaTrader 8') -PathType Container)) {
            throw "The selected Documents folder does not contain NinjaTrader 8."
        }
        return $resolved
    }

    $currentDocuments = [Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments)
    if ($currentDocuments -and (Test-Path -LiteralPath (Join-Path $currentDocuments 'NinjaTrader 8') -PathType Container)) {
        return [IO.Path]::GetFullPath($currentDocuments)
    }

    $candidates = @(Get-NinjaTraderProfileCandidates -UsersRoot $UsersRoot)
    if ($candidates.Count -eq 0) { throw "NinjaTrader 8 was not found in any Windows user Documents folder." }
    if ($candidates.Count -gt 1) { throw "More than one NinjaTrader profile was found. Select the intended Documents folder explicitly." }
    return [IO.Path]::GetFullPath($candidates[0].DocumentsPath)
}

function Get-InstalledVincereAddOnVersion {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$DocumentsPath)
    $path = Join-Path $DocumentsPath 'NinjaTrader 8\bin\Custom\AddOns\Vincere.AutoExport.NinjaTrader.dll'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    return [Diagnostics.FileVersionInfo]::GetVersionInfo($path).FileVersion
}

function Assert-AddOnUpgradeAllowed {
    [CmdletBinding()]
    param(
        [string]$InstalledVersion,
        [Parameter(Mandatory)][string]$RequestedVersion
    )
    if (-not $InstalledVersion) { return }
    if ([version]$InstalledVersion -gt [version]$RequestedVersion) {
        throw "A newer Vincere AddOn is already installed; downgrade is blocked."
    }
}
