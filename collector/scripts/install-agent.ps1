<#
.SYNOPSIS
    Installs the Vincere Auto Export agent on a Windows trading machine.

.DESCRIPTION
    Does what the MSI does, without needing a signed installer: lays down the
    self-contained agent, registers the Windows service, deploys the NinjaTrader
    AddOn, and opens the setup window so the machine can be paired to a client.

    Use this when you would rather run one script than distribute a signed MSI.
    The agent publish is self-contained win-x64, so the machine needs no .NET
    runtime installed.

    Run it from an elevated PowerShell, with NinjaTrader closed.

.PARAMETER PackagePath
    Folder or .zip holding the published agent (Agent\, Setup\ and the AddOn).
    Use this when the build artifact is already on the machine.

.PARAMETER PackageUrl
    URL of the published agent .zip. Downloaded to a temp folder and extracted.
    Use whichever of PackagePath / PackageUrl you have.

.PARAMETER NinjaTraderDocumentsPath
    NinjaTrader 8 Documents folder. Defaults to the current user's.

.PARAMETER SkipAddOn
    Install the service only and leave NinjaTrader untouched. Useful when
    re-running the script to update the agent.

.PARAMETER NoPairing
    Don't open the setup window at the end. Pair later from the Start menu
    shortcut or by running Setup\Vincere.AutoExport.Agent.UI.exe.

.EXAMPLE
    .\install-agent.ps1 -PackagePath C:\Users\me\Downloads\vincere-agent

.EXAMPLE
    .\install-agent.ps1 -PackageUrl https://example.com/vincere-agent-1.0.0.zip
#>
[CmdletBinding(DefaultParameterSetName = 'Local')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Local')]
    [string]$PackagePath,

    [Parameter(Mandatory = $true, ParameterSetName = 'Remote')]
    [string]$PackageUrl,

    [string]$NinjaTraderDocumentsPath = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'NinjaTrader 8'),

    [switch]$SkipAddOn,

    [switch]$NoPairing
)

$ErrorActionPreference = 'Stop'

$ServiceName = 'Vincere Auto Export'
$InstallRoot = Join-Path ${env:ProgramFiles} 'Vincere\Auto Export'
$DataRoot = Join-Path ${env:ProgramData} 'Vincere\AutoExport'

function Write-Step { param([string]$Text) Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok { param([string]$Text) Write-Host "    $Text" -ForegroundColor Green }

# --- preflight -------------------------------------------------------------

$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this from an elevated PowerShell (right-click > Run as administrator). Registering a Windows service needs admin.'
}

if (-not $SkipAddOn -and (Get-Process -Name 'NinjaTrader' -ErrorAction SilentlyContinue)) {
    throw 'Close NinjaTrader completely before installing, then run this again. The AddOn cannot be replaced while it is loaded.'
}

# --- resolve the package ---------------------------------------------------

$tempRoot = $null
if ($PSCmdlet.ParameterSetName -eq 'Remote') {
    Write-Step "Downloading agent package"
    $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("vincere-agent-" + [Guid]::NewGuid().ToString('n'))
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    $zipPath = Join-Path $tempRoot 'package.zip'
    Invoke-WebRequest -Uri $PackageUrl -OutFile $zipPath -UseBasicParsing
    Expand-Archive -LiteralPath $zipPath -DestinationPath (Join-Path $tempRoot 'package') -Force
    $PackagePath = Join-Path $tempRoot 'package'
    Write-Ok "Extracted to $PackagePath"
}

if (-not (Test-Path -LiteralPath $PackagePath)) {
    throw "Package not found: $PackagePath"
}

# A .zip passed to -PackagePath is extracted the same way.
if ((Get-Item -LiteralPath $PackagePath).Extension -eq '.zip') {
    $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("vincere-agent-" + [Guid]::NewGuid().ToString('n'))
    Expand-Archive -LiteralPath $PackagePath -DestinationPath $tempRoot -Force
    $PackagePath = $tempRoot
}

# Tolerate the payload sitting one folder deep (a zip that contains a root dir).
if (-not (Test-Path -LiteralPath (Join-Path $PackagePath 'Agent'))) {
    $nested = Get-ChildItem -LiteralPath $PackagePath -Directory |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'Agent') } |
        Select-Object -First 1
    if ($nested) { $PackagePath = $nested.FullName }
}

$agentSource = Join-Path $PackagePath 'Agent'
$agentExe = Join-Path $agentSource 'Vincere.AutoExport.Agent.exe'
if (-not (Test-Path -LiteralPath $agentExe)) {
    throw "The package does not contain Agent\Vincere.AutoExport.Agent.exe (looked in $PackagePath)."
}

# --- stop any existing install --------------------------------------------

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Step "Stopping the existing $ServiceName service"
    if ($existing.Status -ne 'Stopped') {
        Stop-Service -Name $ServiceName -Force
    }
    # Remove it so the binary can be replaced; it is re-created below.
    sc.exe delete "$ServiceName" | Out-Null
    Start-Sleep -Seconds 2
    Write-Ok 'Existing service removed (settings in ProgramData are kept).'
}

# --- lay down the files ----------------------------------------------------

Write-Step "Installing to $InstallRoot"
New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
Copy-Item -Path (Join-Path $PackagePath '*') -Destination $InstallRoot -Recurse -Force
Write-Ok 'Agent and setup files copied.'

# --- data folder, locked to LocalSystem + Administrators -------------------

Write-Step "Preparing $DataRoot"
New-Item -ItemType Directory -Path $DataRoot -Force | Out-Null
# The agent stores its device token here, so keep it off limits to normal users.
# Well-known SIDs, not names: on a non-English Windows the local groups are
# called something else ("Administradores"), and a name lookup would fail.
$acl = Get-Acl -LiteralPath $DataRoot
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {   # LocalSystem, Administrators
    $account = New-Object Security.Principal.SecurityIdentifier($sid)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
        $account, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $DataRoot -AclObject $acl
Write-Ok 'Data folder restricted to SYSTEM and Administrators.'

# --- NinjaTrader AddOn -----------------------------------------------------

if (-not $SkipAddOn) {
    Write-Step 'Deploying the NinjaTrader AddOn'
    $customPath = Join-Path $NinjaTraderDocumentsPath 'bin\Custom'
    if (-not (Test-Path -LiteralPath $customPath)) {
        throw "NinjaTrader folder not found: $customPath`nOpen NinjaTrader 8 once so it creates its Documents folder, or pass -NinjaTraderDocumentsPath."
    }
    $addOnSource = Join-Path $PackagePath 'AddOn'
    if (Test-Path -LiteralPath $addOnSource) {
        $addOnTarget = Join-Path $customPath 'AddOns'
        New-Item -ItemType Directory -Path $addOnTarget -Force | Out-Null
        Copy-Item -Path (Join-Path $addOnSource '*') -Destination $addOnTarget -Recurse -Force
        Write-Ok "AddOn deployed to $addOnTarget"
    } else {
        Write-Warning 'No AddOn folder in the package - skipping. The service will install, but NinjaTrader capture stays off until the AddOn is deployed.'
    }
}

# --- register and start the service ---------------------------------------

Write-Step "Registering the $ServiceName service"
$serviceBinary = Join-Path $InstallRoot 'Agent\Vincere.AutoExport.Agent.exe'
# New-Service rather than sc.exe: it quotes the binary path itself, so a path
# with spaces (Program Files) can't break the registration. Runs as LocalSystem
# by default, matching the MSI.
New-Service -Name $ServiceName `
    -BinaryPathName "`"$serviceBinary`"" `
    -DisplayName $ServiceName `
    -Description 'Collects NinjaTrader data for the Vincere CRM.' `
    -StartupType Automatic | Out-Null

# Delayed start and restart-on-failure have no New-Service equivalent.
# Three restarts, 15s apart, matching the MSI.
& sc.exe config "$ServiceName" start= delayed-auto | Out-Null
& sc.exe failure "$ServiceName" reset= 86400 actions= restart/15000/restart/15000/restart/15000 | Out-Null
Write-Ok 'Service registered (delayed auto start, restarts on failure).'

Write-Step 'Starting the service'
Start-Service -Name $ServiceName
(Get-Service -Name $ServiceName).WaitForStatus('Running', '00:00:30')
Write-Ok 'Service running.'

# --- pairing ---------------------------------------------------------------

$setupUi = Join-Path $InstallRoot 'Setup\Vincere.AutoExport.Agent.UI.exe'
Write-Host ''
Write-Host 'Installed.' -ForegroundColor Green
Write-Host ''

if ($NoPairing -or -not (Test-Path -LiteralPath $setupUi)) {
    Write-Host 'Next: pair this machine to its client.'
    Write-Host "  Run: $setupUi"
    Write-Host '  Then paste the pairing code from the CRM (Auto Collection > the client).'
} else {
    Write-Host 'Opening the setup window so you can paste the pairing code from the CRM'
    Write-Host '(Auto Collection > the client > Generate code).'
    Start-Process -FilePath $setupUi
}

if ($tempRoot -and (Test-Path -LiteralPath $tempRoot)) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
