<#
.SYNOPSIS
    Builds the Vincere NinjaTrader AddOn on this machine and installs it into
    NinjaTrader, for local capture testing.

.DESCRIPTION
    The AddOn compiles against NinjaTrader's own assemblies, so it can only be
    built on a machine where NinjaTrader 8 is installed — which is why CI cannot
    produce it and the agent package ships without it.

    This builds it here and drops the four DLLs into NinjaTrader's AddOns folder.
    Nothing is uploaded and no CRM connection is involved; afterwards the Control
    Center gains "Vincere: Export Snapshot to File (local test)".

    Needs the .NET SDK 8 (free: https://dotnet.microsoft.com/download) and a
    checkout of this repository.

.PARAMETER NinjaTraderHome
    NinjaTrader's install folder — the one containing bin\NinjaTrader.Core.dll.
    Defaults to the standard location.

.PARAMETER NinjaTraderDocumentsPath
    NinjaTrader's Documents folder. Defaults to the current user's.

.PARAMETER NoInstall
    Build only; leave NinjaTrader untouched and just report where the DLLs are.

.EXAMPLE
    .\build-addon-local.ps1
#>
[CmdletBinding()]
param(
    [string]$NinjaTraderHome = "${env:ProgramFiles}\NinjaTrader 8",
    [string]$NinjaTraderDocumentsPath = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'NinjaTrader 8'),
    [switch]$NoInstall
)

$ErrorActionPreference = 'Stop'

function Write-Step { param([string]$Text) Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok { param([string]$Text) Write-Host "    $Text" -ForegroundColor Green }

# --- preflight -------------------------------------------------------------

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    throw @'
The .NET SDK is not installed on this machine.

Install .NET SDK 8 from https://dotnet.microsoft.com/download (free), reopen
PowerShell, and run this again.
'@
}

$coreDll = Join-Path $NinjaTraderHome 'bin\NinjaTrader.Core.dll'
if (-not (Test-Path -LiteralPath $coreDll)) {
    throw "NinjaTrader was not found at: $NinjaTraderHome`n" +
          "Pass -NinjaTraderHome with the folder that contains bin\NinjaTrader.Core.dll."
}
Write-Ok "NinjaTrader found at $NinjaTraderHome"

if (Get-Process -Name 'NinjaTrader' -ErrorAction SilentlyContinue) {
    throw 'Close NinjaTrader completely before installing the AddOn, then run this again.'
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$project = Join-Path $repoRoot 'collector\src\Vincere.AutoExport.NinjaTrader\Vincere.AutoExport.NinjaTrader.csproj'
if (-not (Test-Path -LiteralPath $project)) {
    throw "Could not find the AddOn project at: $project`nRun this from a checkout of the repository."
}

# --- build -----------------------------------------------------------------

Write-Step 'Building the AddOn against this NinjaTrader install'
# The project resolves NinjaTrader's assemblies through this variable.
$env:NINJATRADER_HOME = $NinjaTraderHome
& dotnet build $project -c Release
if ($LASTEXITCODE -ne 0) { throw "Build failed (dotnet exit $LASTEXITCODE)." }

$outputDir = Join-Path $repoRoot 'collector\src\Vincere.AutoExport.NinjaTrader\bin\Release\net48'
$dlls = @(
    'Vincere.AutoExport.NinjaTrader.dll',
    'Vincere.AutoExport.NinjaTrader.Core.dll',
    'Vincere.AutoExport.Contracts.dll',
    'Newtonsoft.Json.dll'
) | ForEach-Object { Join-Path $outputDir $_ }

foreach ($dll in $dlls) {
    if (-not (Test-Path -LiteralPath $dll)) { throw "Build finished but $dll is missing." }
}
Write-Ok "Built into $outputDir"

if ($NoInstall) {
    Write-Host ''
    Write-Host 'Built, not installed. The four DLLs to copy are in:' -ForegroundColor Green
    Write-Host "  $outputDir"
    return
}

# --- install ---------------------------------------------------------------

$addOnTarget = Join-Path $NinjaTraderDocumentsPath 'bin\Custom\AddOns'
if (-not (Test-Path -LiteralPath (Join-Path $NinjaTraderDocumentsPath 'bin\Custom'))) {
    throw "NinjaTrader's Documents folder was not found at: $NinjaTraderDocumentsPath`n" +
          'Open NinjaTrader 8 once so it creates the folder, or pass -NinjaTraderDocumentsPath.'
}

Write-Step "Installing the AddOn into $addOnTarget"
New-Item -ItemType Directory -Path $addOnTarget -Force | Out-Null
foreach ($dll in $dlls) {
    Copy-Item -LiteralPath $dll -Destination $addOnTarget -Force
}
Write-Ok 'Installed.'

Write-Host ''
Write-Host 'Next:' -ForegroundColor Green
Write-Host '  1. Open NinjaTrader 8 and let the accounts connect.'
Write-Host '  2. Control Center: New > "Vincere: Export Snapshot to File (local test)".'
Write-Host '  3. It reports where it saved the JSON. Nothing is sent anywhere.'
