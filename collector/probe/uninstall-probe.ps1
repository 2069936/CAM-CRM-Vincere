[CmdletBinding()]
param(
    [string]$NinjaTraderDocumentsPath = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'NinjaTrader 8')
)

$ErrorActionPreference = 'Stop'

if (Get-Process -Name 'NinjaTrader' -ErrorAction SilentlyContinue) {
    throw 'Close NinjaTrader completely before removing the probe.'
}

$targetPath = Join-Path $NinjaTraderDocumentsPath 'bin\Custom\AddOns\Vincere.AutoExport.Probe.cs'
if (Test-Path -LiteralPath $targetPath -PathType Leaf) {
    Remove-Item -LiteralPath $targetPath -Force
    Write-Host "Removed $targetPath"
} else {
    Write-Host "Probe source was not installed at $targetPath"
}
