<#
.SYNOPSIS
    One-shot setup for the local capture test: gets the .NET SDK if needed,
    downloads this repository, builds the NinjaTrader AddOn against the local
    NinjaTrader install, and installs it.

.DESCRIPTION
    Meant to be pasted into PowerShell on a VPS that already runs NinjaTrader 8.
    Nothing is uploaded and no CRM connection is involved. Afterwards the Control
    Center gains "Vincere: Export Snapshot to File (local test)", which writes the
    snapshot to a file for review.

    Downloads a source zip rather than cloning, so git is not required.

.PARAMETER Branch
    Branch to download. Defaults to dev/natanel.

.PARAMETER WorkFolder
    Where to unpack and build. Defaults to a Vincere folder under the user profile.

.PARAMETER NinjaTraderHome
    NinjaTrader's install folder — the one containing bin\NinjaTrader.Core.dll.
#>
[CmdletBinding()]
param(
    [string]$Branch = 'dev/natanel',
    [string]$WorkFolder = (Join-Path $env:USERPROFILE 'Vincere-LocalTest'),
    [string]$NinjaTraderHome = "${env:ProgramFiles}\NinjaTrader 8"
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is far faster without the progress UI

$Repository = 'pedro-cmyks/CAM-CRM-Vincere'

function Write-Step { param([string]$Text) Write-Host "`n==> $Text" -ForegroundColor Cyan }
function Write-Ok { param([string]$Text) Write-Host "    $Text" -ForegroundColor Green }

Write-Host 'Vincere - local capture test setup' -ForegroundColor Cyan
Write-Host 'Nothing is uploaded and the CRM is not contacted.'

# --- preflight -------------------------------------------------------------

Write-Step 'Checking NinjaTrader'
$coreDll = Join-Path $NinjaTraderHome 'bin\NinjaTrader.Core.dll'
if (-not (Test-Path -LiteralPath $coreDll)) {
    throw "NinjaTrader 8 was not found at: $NinjaTraderHome`n" +
          'Re-run with -NinjaTraderHome "<path>" pointing at the folder that contains bin\NinjaTrader.Core.dll.'
}
Write-Ok "Found at $NinjaTraderHome"

if (Get-Process -Name 'NinjaTrader' -ErrorAction SilentlyContinue) {
    throw 'NinjaTrader is running. Close it completely and run this again — the AddOn cannot be replaced while loaded.'
}

# --- .NET SDK --------------------------------------------------------------

Write-Step 'Checking the .NET SDK'
$dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
if ($dotnet) {
    Write-Ok "Already installed ($(& dotnet --version))"
} else {
    Write-Host '    Not installed. Installing .NET SDK 8 for this user (no admin needed)...'
    $installer = Join-Path $env:TEMP 'dotnet-install.ps1'
    # Microsoft's official installer; per-user, so it needs no elevation.
    Invoke-WebRequest -Uri 'https://dot.net/v1/dotnet-install.ps1' -OutFile $installer -UseBasicParsing
    & $installer -Channel 8.0 -InstallDir (Join-Path $env:USERPROFILE '.dotnet')
    $env:PATH = (Join-Path $env:USERPROFILE '.dotnet') + ';' + $env:PATH
    if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
        throw 'The .NET SDK install did not complete. Install it manually from https://dotnet.microsoft.com/download and run this again.'
    }
    Write-Ok "Installed ($(& dotnet --version))"
}

# --- source ----------------------------------------------------------------

Write-Step "Downloading the repository ($Branch)"
New-Item -ItemType Directory -Path $WorkFolder -Force | Out-Null
$zipPath = Join-Path $WorkFolder 'source.zip'
$extractPath = Join-Path $WorkFolder 'source'

if (Test-Path -LiteralPath $extractPath) {
    Remove-Item -LiteralPath $extractPath -Recurse -Force
}
Invoke-WebRequest `
    -Uri "https://codeload.github.com/$Repository/zip/refs/heads/$Branch" `
    -OutFile $zipPath -UseBasicParsing
Expand-Archive -LiteralPath $zipPath -DestinationPath $extractPath -Force
Remove-Item -LiteralPath $zipPath -Force

# The zip unpacks into a single folder named after the repo and branch.
$repoRoot = Get-ChildItem -LiteralPath $extractPath -Directory | Select-Object -First 1
if (-not $repoRoot) { throw "The download did not contain a source folder." }
Write-Ok "Unpacked to $($repoRoot.FullName)"

# --- build + install -------------------------------------------------------

$buildScript = Join-Path $repoRoot.FullName 'collector\scripts\build-addon-local.ps1'
if (-not (Test-Path -LiteralPath $buildScript)) {
    throw "The downloaded source has no build script at: $buildScript"
}

& $buildScript -NinjaTraderHome $NinjaTraderHome

Write-Host ''
Write-Host '================================================================' -ForegroundColor Green
Write-Host ' Setup done. Two steps left, both in NinjaTrader:' -ForegroundColor Green
Write-Host '================================================================' -ForegroundColor Green
Write-Host ''
Write-Host '  1. Open NinjaTrader 8 and wait for the accounts to connect.'
Write-Host '     (The capture reads whatever NinjaTrader has loaded at that moment,'
Write-Host '      so let the account list fill in first.)'
Write-Host ''
Write-Host '  2. Control Center menu:  New > "Vincere: Export Snapshot to File (local test)"'
Write-Host ''
Write-Host '     A box tells you where it saved the JSON and how many rows it found.'
Write-Host '     It saves under Documents\VincereAutoExport\.'
Write-Host ''
Write-Host '  Then send that JSON file back for review.'
Write-Host ''
