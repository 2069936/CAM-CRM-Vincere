Set-StrictMode -Version Latest

$script:AddOnPayloadFiles = @(
    [pscustomobject]@{ Name = 'Vincere.AutoExport.NinjaTrader.dll'; Code = 'ninjatrader' }
    [pscustomobject]@{ Name = 'Vincere.AutoExport.NinjaTrader.Core.dll'; Code = 'ninjatrader_core' }
    [pscustomobject]@{ Name = 'Vincere.AutoExport.Contracts.dll'; Code = 'contracts' }
    [pscustomobject]@{ Name = 'Newtonsoft.Json.dll'; Code = 'newtonsoft_json' }
)

function Get-AddOnPayloadManifest {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$AddOnPath)

    $resolvedAddOn = (Resolve-Path -LiteralPath $AddOnPath -ErrorAction Stop).Path
    if ([IO.Path]::GetFileName($resolvedAddOn) -ne $script:AddOnPayloadFiles[0].Name) {
        throw 'addon_payload_invalid_entrypoint'
    }

    $payloadDirectory = [IO.Path]::GetDirectoryName($resolvedAddOn)
    $manifest = foreach ($required in $script:AddOnPayloadFiles) {
        $path = Join-Path $payloadDirectory $required.Name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "addon_payload_missing_$($required.Code)"
        }
        $file = Get-Item -LiteralPath $path
        if ($file.Length -eq 0) {
            throw "addon_payload_empty_$($required.Code)"
        }
        [ordered]@{
            name = $required.Name
            sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    return @($manifest)
}

function Assert-AddOnPayloadReceipt {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$AddOnPath,
        [Parameter(Mandatory)][psobject]$Verification
    )

    $actual = @(Get-AddOnPayloadManifest -AddOnPath $AddOnPath)
    $properties = @($Verification.PSObject.Properties.Name)
    if ('payload' -notin $properties) { throw 'addon_payload_receipt_mismatch' }
    $recorded = @($Verification.payload)
    if ($recorded.Count -ne $actual.Count) { throw 'addon_payload_receipt_mismatch' }

    for ($index = 0; $index -lt $actual.Count; $index++) {
        $recordedProperties = @($recorded[$index].PSObject.Properties.Name)
        if ('name' -notin $recordedProperties -or 'sha256' -notin $recordedProperties -or
            $recorded[$index].name -cne $actual[$index].name -or
            $recorded[$index].sha256 -cne $actual[$index].sha256) {
            throw 'addon_payload_receipt_mismatch'
        }
    }
    return $actual
}
