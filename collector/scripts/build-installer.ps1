[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+(?:\.\d+)?$')][string]$Version,
    [Parameter(Mandatory)][string]$AddOnSource,
    [Parameter(Mandatory)][string]$AddOnVerificationPath,
    [string]$ArtifactsDirectory = (Join-Path $PSScriptRoot '..\artifacts'),
    [switch]$ProductionSign
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $IsWindows) { throw 'The WiX installer build requires Windows.' }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repoRoot = [IO.Path]::GetFullPath((Join-Path $root '..'))
$addOn = (Resolve-Path -LiteralPath $AddOnSource -ErrorAction Stop).Path
if ([IO.Path]::GetFileName($addOn) -ne 'Vincere.AutoExport.NinjaTrader.dll') {
    throw 'AddOnSource must be the verified production Vincere.AutoExport.NinjaTrader.dll.'
}
$verification = Get-Content -LiteralPath $AddOnVerificationPath -Raw | ConvertFrom-Json
$actualAddOnHash = (Get-FileHash -LiteralPath $addOn -Algorithm SHA256).Hash.ToLowerInvariant()
if ($verification.schemaVersion -ne 1 -or
    $verification.contract -ne 'SnapshotV1' -or
    $verification.sha256 -ne $actualAddOnHash -or
    -not $verification.supportedApiParityPassed) {
    throw 'The AddOn verification receipt is missing, stale, or does not prove supported-API parity.'
}
. (Join-Path $root 'src\Vincere.AutoExport.Installer\CustomActions\DetectNinjaTrader.ps1')
if (Test-NinjaTraderRunning) { throw 'Close NinjaTrader before building or installing the AddOn.' }

$artifacts = [IO.Path]::GetFullPath($ArtifactsDirectory)
$staging = Join-Path $artifacts 'staging'
$agentPublish = Join-Path $staging 'agent'
$uiPublish = Join-Path $staging 'ui'
New-Item -ItemType Directory -Path $agentPublish, $uiPublish, $artifacts -Force | Out-Null

dotnet publish (Join-Path $root 'src\Vincere.AutoExport.Agent\Vincere.AutoExport.Agent.csproj') -c Release -r win-x64 --self-contained true -p:Version=$Version -o $agentPublish
if ($LASTEXITCODE -ne 0) { throw 'Agent publish failed.' }
dotnet publish (Join-Path $root 'src\Vincere.AutoExport.Agent.UI\Vincere.AutoExport.Agent.UI.csproj') -c Release -r win-x64 --self-contained true -p:Version=$Version -o $uiPublish
if ($LASTEXITCODE -ne 0) { throw 'UI publish failed.' }

$owned = @(
    Get-ChildItem -LiteralPath $agentPublish, $uiPublish -File -Recurse
    Get-Item -LiteralPath $addOn
) | ForEach-Object {
    [ordered]@{
        name = $_.Name
        relativePath = [IO.Path]::GetRelativePath($staging, $_.FullName)
        sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}
$ownershipManifest = Join-Path $staging 'ownership-manifest.json'
[IO.File]::WriteAllText($ownershipManifest, ($owned | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath $ownershipManifest -Destination $agentPublish -Force

if ($ProductionSign) {
    & (Join-Path $PSScriptRoot 'sign-artifacts.ps1') -Paths @(
        Get-ChildItem -LiteralPath $agentPublish, $uiPublish -File -Recurse |
            Where-Object { $_.Extension -in '.exe', '.dll' } |
            Select-Object -ExpandProperty FullName
        $addOn
    )
}

$installerRoot = Join-Path $root 'src\Vincere.AutoExport.Installer'
$machineProject = Join-Path $installerRoot 'Vincere.AutoExport.Installer.wixproj'
$addOnProject = Join-Path $installerRoot 'Vincere.AutoExport.AddOn.Installer.wixproj'
$bundleProject = Join-Path $installerRoot 'Vincere.AutoExport.Bundle.wixproj'
dotnet build $machineProject -c Release -p:ProductVersion=$Version -p:AgentPublishDir=$agentPublish -p:UiPublishDir=$uiPublish -p:OutputPath=$artifacts
if ($LASTEXITCODE -ne 0) { throw 'Machine MSI build failed.' }
dotnet build $addOnProject -c Release -p:ProductVersion=$Version -p:AddOnSource=$addOn -p:OutputPath=$artifacts
if ($LASTEXITCODE -ne 0) { throw 'AddOn MSI build failed.' }

$machineMsi = Join-Path $artifacts 'Vincere.AutoExport.Machine.msi'
$addOnMsi = Join-Path $artifacts 'Vincere.AutoExport.AddOn.msi'
if ($ProductionSign) { & (Join-Path $PSScriptRoot 'sign-artifacts.ps1') -Paths $machineMsi, $addOnMsi }
dotnet build $bundleProject -c Release -p:ProductVersion=$Version -p:MachineMsi=$machineMsi -p:AddOnMsi=$addOnMsi -p:OutputPath=$artifacts
if ($LASTEXITCODE -ne 0) { throw 'Bundle build failed.' }
$bundle = Join-Path $artifacts 'Vincere-AutoExport-Setup.exe'
if ($ProductionSign) { & (Join-Path $PSScriptRoot 'sign-artifacts.ps1') -Paths $bundle }

Get-Item -LiteralPath $machineMsi, $addOnMsi, $bundle
