[CmdletBinding()]
param(
    [string]$NinjaTraderDocumentsPath = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'NinjaTrader 8')
)

$ErrorActionPreference = 'Stop'

if (Get-Process -Name 'NinjaTrader' -ErrorAction SilentlyContinue) {
    throw 'Close NinjaTrader completely before installing the probe.'
}

$sourcePath = Join-Path $PSScriptRoot 'Vincere.AutoExport.Probe.cs'
$targetDirectory = Join-Path $NinjaTraderDocumentsPath 'bin\Custom\AddOns'
$targetPath = Join-Path $targetDirectory 'Vincere.AutoExport.Probe.cs'

if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    throw "Probe source not found: $sourcePath"
}
if (-not (Test-Path -LiteralPath $targetDirectory -PathType Container)) {
    throw "NinjaTrader AddOns directory not found: $targetDirectory"
}

Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force
Write-Host "Installed Vincere probe source at $targetPath"
Write-Host 'Open NinjaTrader, compile in NinjaScript Editor (F5), then restart NinjaTrader.'

