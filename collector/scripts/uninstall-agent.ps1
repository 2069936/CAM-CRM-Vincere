<#
.SYNOPSIS
    Removes the Vincere Auto Export agent installed by install-agent.ps1.

.DESCRIPTION
    Stops and deletes the service, removes the program files, and optionally the
    NinjaTrader AddOn. The data folder is kept by default because it holds the
    device pairing; use -RemoveData to drop it and force a re-pair.

    Run from an elevated PowerShell, with NinjaTrader closed if removing the AddOn.

.EXAMPLE
    .\uninstall-agent.ps1

.EXAMPLE
    .\uninstall-agent.ps1 -RemoveData
#>
[CmdletBinding()]
param(
    [string]$NinjaTraderDocumentsPath = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'NinjaTrader 8'),
    [switch]$RemoveData,
    [switch]$KeepAddOn
)

$ErrorActionPreference = 'Stop'

$ServiceName = 'Vincere Auto Export'
$InstallRoot = Join-Path ${env:ProgramFiles} 'Vincere\Auto Export'
$DataRoot = Join-Path ${env:ProgramData} 'Vincere\AutoExport'

function Write-Step { param([string]$Text) Write-Host "==> $Text" -ForegroundColor Cyan }

$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this from an elevated PowerShell (right-click > Run as administrator).'
}

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($service) {
    Write-Step "Stopping and removing the $ServiceName service"
    if ($service.Status -ne 'Stopped') {
        Stop-Service -Name $ServiceName -Force
    }
    sc.exe delete "$ServiceName" | Out-Null
    Start-Sleep -Seconds 2
}

if (Test-Path -LiteralPath $InstallRoot) {
    Write-Step "Removing $InstallRoot"
    Remove-Item -LiteralPath $InstallRoot -Recurse -Force
}

if (-not $KeepAddOn) {
    if (Get-Process -Name 'NinjaTrader' -ErrorAction SilentlyContinue) {
        Write-Warning 'NinjaTrader is running - the AddOn was left in place. Close it and re-run to remove the AddOn.'
    } else {
        $addOnTarget = Join-Path $NinjaTraderDocumentsPath 'bin\Custom'
        $addOnFiles = Get-ChildItem -LiteralPath $addOnTarget -Filter 'Vincere.AutoExport*' -ErrorAction SilentlyContinue
        if ($addOnFiles) {
            Write-Step 'Removing the NinjaTrader AddOn'
            $addOnFiles | Remove-Item -Recurse -Force
        }
    }
}

if ($RemoveData) {
    if (Test-Path -LiteralPath $DataRoot) {
        Write-Step "Removing $DataRoot (this drops the device pairing)"
        Remove-Item -LiteralPath $DataRoot -Recurse -Force
    }
} elseif (Test-Path -LiteralPath $DataRoot) {
    Write-Host ''
    Write-Host "Kept $DataRoot (device pairing). Re-run with -RemoveData to drop it." -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Removed.' -ForegroundColor Green
