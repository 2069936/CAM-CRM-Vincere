<#
.SYNOPSIS
    Installs the Vincere Auto Export agent on a Windows trading machine.

.DESCRIPTION
    Lays down the self-contained agent, registers the Windows service, deploys
    the NinjaTrader AddOn, and opens the setup window so the machine can be
    paired to a client.

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

    # NinjaTrader's install folder, the one holding bin\NinjaTrader.Core.dll. The
    # AddOn is compiled against the assemblies in there.
    [string]$NinjaTraderHome = "${env:ProgramFiles}\NinjaTrader 8",

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

# THE SETUP WINDOW HOLDS THE FILES THIS IS ABOUT TO REPLACE.
#
# Stopping the service was not enough. install-agent.ps1 opens the Setup window
# at the end of every run, so the window from the previous install is still
# running on a reinstall, and it holds its own DLLs open. Copy-Item then fails on
# the first locked file with "being used by another process" — after the service
# has already been deleted, which leaves the machine with no agent at all and an
# install that got halfway. That is the worst possible place to stop.
#
# Closed politely first so a window mid-pairing gets to shut down on its own, and
# only killed if it does not. The pairing token lives in ProgramData, not in that
# process, so nothing is lost either way.
$setupProcesses = Get-Process -Name 'Vincere.AutoExport.Agent.UI' -ErrorAction SilentlyContinue
if ($setupProcesses) {
    Write-Step 'Closing the Vincere Auto Export Setup window'
    foreach ($process in $setupProcesses) {
        $process.CloseMainWindow() | Out-Null
    }
    Start-Sleep -Seconds 2
    $stubborn = Get-Process -Name 'Vincere.AutoExport.Agent.UI' -ErrorAction SilentlyContinue
    if ($stubborn) {
        $stubborn | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }
    Write-Ok 'Setup window closed.'
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
    # bin\Custom, not bin\Custom\AddOns: that subfolder is for NinjaScript
    # source NinjaTrader compiles, and a compiled DLL there is never loaded.
    $addOnTarget = $customPath
    $addOnSource = Join-Path $PackagePath 'AddOn'
    $addOnProject = Join-Path $PackagePath 'AddOnSource\Vincere.AutoExport.NinjaTrader\Vincere.AutoExport.NinjaTrader.csproj'

    if (Test-Path -LiteralPath $addOnSource) {
        New-Item -ItemType Directory -Path $addOnTarget -Force | Out-Null
        Copy-Item -Path (Join-Path $addOnSource '*') -Destination $addOnTarget -Recurse -Force
        Write-Ok "AddOn deployed to $addOnTarget"
    }
    elseif (Test-Path -LiteralPath $addOnProject) {
        # WHY THIS COMPILES HERE INSTEAD OF ARRIVING BUILT.
        #
        # The AddOn references NinjaTrader's own assemblies, which are licensed
        # and never leave the machines that have them, so CI cannot produce it.
        # The package used to ship without one: the service installed, the
        # console said it was finished, and the machine captured nothing until
        # somebody deployed four DLLs by hand. One download was not one movement.
        #
        # This machine is the one place the NinjaTrader assemblies are certain to
        # exist, because it is the machine that runs NinjaTrader. So it builds
        # what it is about to load, from the source it just downloaded. No
        # prebuilt binary of unclear provenance goes near a client's accounts.
        Write-Step 'Building the NinjaTrader AddOn on this machine'

        $ninjaCore = Join-Path $NinjaTraderHome 'bin\NinjaTrader.Core.dll'
        if (-not (Test-Path -LiteralPath $ninjaCore)) {
            throw "NinjaTrader 8 was not found at: $NinjaTraderHome`n" +
                  'Pass -NinjaTraderHome with the folder that contains bin\NinjaTrader.Core.dll.'
        }

        # The SDK is a build dependency, not something the desk should have to
        # install first, and requiring it would have made this two movements
        # again. Fetched under the install root rather than system-wide: it needs
        # no PATH change and no second elevated session, and uninstall-agent.ps1
        # removes the install root outright, so it leaves with everything else
        # rather than lingering as a toolchain nobody remembers installing.
        # Written the long way on purpose: Windows Server ships Windows PowerShell
        # 5.1, which has no null-conditional operator, and this script has to run
        # under whatever PowerShell the VPS opens.
        $dotnet = $null
        $dotnetCommand = Get-Command dotnet -ErrorAction SilentlyContinue
        if ($dotnetCommand) {
            # A machine can have the runtime and no SDK, which cannot build.
            $sdks = & $dotnetCommand.Source --list-sdks 2>$null
            if ($LASTEXITCODE -eq 0 -and $sdks) { $dotnet = $dotnetCommand.Source }
        }
        if (-not $dotnet) {
            $sdkRoot = Join-Path $InstallRoot 'build\dotnet'
            $dotnet = Join-Path $sdkRoot 'dotnet.exe'
            if (-not (Test-Path -LiteralPath $dotnet)) {
                Write-Step 'Downloading the .NET SDK to build the AddOn'
                $bootstrap = Join-Path ([IO.Path]::GetTempPath()) 'dotnet-install.ps1'
                Invoke-WebRequest 'https://dot.net/v1/dotnet-install.ps1' -OutFile $bootstrap -UseBasicParsing
                & $bootstrap -Channel '8.0' -InstallDir $sdkRoot -NoPath
                Remove-Item -LiteralPath $bootstrap -Force -ErrorAction SilentlyContinue
            }
            if (-not (Test-Path -LiteralPath $dotnet)) {
                throw 'The .NET SDK could not be installed, so the AddOn cannot be built here.'
            }
            Write-Ok "Build SDK at $sdkRoot"
        }

        $env:NINJATRADER_HOME = $NinjaTraderHome
        & $dotnet build $addOnProject -c Release --nologo
        if ($LASTEXITCODE -ne 0) { throw "The AddOn did not build (dotnet exit $LASTEXITCODE)." }

        $built = Join-Path (Split-Path -Parent $addOnProject) 'bin\Release\net48'
        $dlls = @(
            'Vincere.AutoExport.NinjaTrader.dll',
            'Vincere.AutoExport.NinjaTrader.Core.dll',
            'Vincere.AutoExport.Contracts.dll',
            'Newtonsoft.Json.dll'
        )
        foreach ($dll in $dlls) {
            if (-not (Test-Path -LiteralPath (Join-Path $built $dll))) {
                throw "The AddOn build finished but $dll is missing from $built."
            }
        }

        # --- the one file that is not ours to overwrite --------------------
        #
        # bin\Custom is NinjaTrader's own assembly folder, and NinjaTrader ships
        # its own Newtonsoft.Json. Dropping a different build of it there is the
        # only thing this installer does that can reach NinjaScript compilation,
        # and NinjaScript failing to compile is how an account ends up showing no
        # strategies at all. That is a client's stack going quiet because of an
        # exporter, which is not a trade worth making for any feature.
        #
        # So NinjaTrader's copy wins whenever it has one. Ours is only laid down
        # when there is nothing to conflict with, and if theirs is too old for
        # the code we just compiled this stops BEFORE touching anything, leaving
        # NinjaTrader exactly as it was.
        $ourJson = Join-Path $built 'Newtonsoft.Json.dll'
        $ninjaJson = Join-Path $NinjaTraderHome 'bin\Newtonsoft.Json.dll'
        $shipJson = $true
        if (Test-Path -LiteralPath $ninjaJson) {
            $theirJsonVersion = [Version](Get-Item -LiteralPath $ninjaJson).VersionInfo.FileVersion
            $ourJsonVersion = [Version](Get-Item -LiteralPath $ourJson).VersionInfo.FileVersion
            if ($theirJsonVersion.Major -lt $ourJsonVersion.Major) {
                throw @"
NinjaTrader ships Newtonsoft.Json $theirJsonVersion and this AddOn was built against $ourJsonVersion.
Installing the AddOn could stop NinjaScript from compiling, which would leave the
strategies on this machine not loading at all.

Nothing has been changed. Update NinjaTrader 8 and run this again, or pass
-SkipAddOn to install the service only and deploy the AddOn separately.
"@
            }
            $shipJson = $false
            Write-Ok "Using NinjaTrader's own Newtonsoft.Json $theirJsonVersion."
        }

        # OUR files only, matched by name, and never Newtonsoft: an earlier
        # install put these in bin\Custom\AddOns where they are never loaded, and
        # a blanket delete by name would take a Newtonsoft that belonged to
        # somebody else.
        $ourDlls = @(
            'Vincere.AutoExport.NinjaTrader.dll',
            'Vincere.AutoExport.NinjaTrader.Core.dll',
            'Vincere.AutoExport.Contracts.dll'
        )
        $stale = Join-Path $NinjaTraderDocumentsPath 'bin\Custom\AddOns'
        if (Test-Path -LiteralPath $stale) {
            Get-ChildItem -LiteralPath $stale -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -in $ourDlls } |
                Remove-Item -Force -ErrorAction SilentlyContinue
        }

        New-Item -ItemType Directory -Path $addOnTarget -Force | Out-Null
        foreach ($dll in $ourDlls) {
            Copy-Item -LiteralPath (Join-Path $built $dll) -Destination $addOnTarget -Force
        }
        if ($shipJson) { Copy-Item -LiteralPath $ourJson -Destination $addOnTarget -Force }
        Write-Ok "AddOn built and deployed to $addOnTarget"
    }
    else {
        Write-Warning 'No AddOn and no AddOn source in the package - skipping. The service will install, but NinjaTrader capture stays off until the AddOn is deployed.'
    }
}

# --- register and start the service ---------------------------------------

# --- shortcuts, so the window can be found again ---------------------------
#
# The MSI has always laid one down. This installer never did, and it is the one
# the desk actually uses, so the Setup window could only be reopened by someone
# who knew it lived under Program Files and could type the path. People closed
# it and were told to re-run the whole install, which downloads a hundred
# megabytes and rebuilds the AddOn to reach a window that was already there.
#
# Desktop and Start menu both: the desktop for the machine someone is looking
# at, the Start menu so typing "Vincere" finds it.
Write-Step 'Creating the Vincere Auto Export shortcuts'
$shortcutTarget = Join-Path $InstallRoot 'Setup\Vincere.AutoExport.Agent.UI.exe'
if (Test-Path -LiteralPath $shortcutTarget) {
    $shell = New-Object -ComObject WScript.Shell
    $startMenu = Join-Path ${env:ProgramData} 'Microsoft\Windows\Start Menu\Programs'
    foreach ($dir in @([Environment]::GetFolderPath('CommonDesktopDirectory'), $startMenu)) {
        if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { continue }
        $link = $shell.CreateShortcut((Join-Path $dir 'Vincere Auto Export.lnk'))
        $link.TargetPath = $shortcutTarget
        $link.WorkingDirectory = Split-Path -Parent $shortcutTarget
        $link.Description = 'Open the Vincere Auto Export setup and status window'
        $link.Save()
    }
    [Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null
    Write-Ok 'Shortcut on the desktop and in the Start menu.'
} else {
    Write-Warning 'Setup window not found in the package, so no shortcut was created.'
}

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
