Set-StrictMode -Version Latest

function Complete-OwnedPayload {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string[]]$OwnedPaths,
        [string[]]$SignablePaths = @(),
        [Parameter(Mandatory)][string]$StagingDirectory,
        [Parameter(Mandatory)][string]$ManifestPath,
        [string]$SigningScriptPath
    )

    $staging = [IO.Path]::GetFullPath($StagingDirectory)
    $owned = @($OwnedPaths | ForEach-Object {
        (Resolve-Path -LiteralPath $_ -ErrorAction Stop).Path
    } | Select-Object -Unique)
    if ($owned.Count -eq 0) { throw 'ownership_manifest_empty' }

    if ($SigningScriptPath) {
        $signer = (Resolve-Path -LiteralPath $SigningScriptPath -ErrorAction Stop).Path
        $signable = @($SignablePaths | ForEach-Object {
            (Resolve-Path -LiteralPath $_ -ErrorAction Stop).Path
        } | Select-Object -Unique)
        if ($signable.Count -eq 0) { throw 'ownership_manifest_signable_payload_empty' }
        & $signer -Paths $signable
    }

    $manifest = @($owned | ForEach-Object {
        $file = Get-Item -LiteralPath $_
        [ordered]@{
            name = $file.Name
            relativePath = [IO.Path]::GetRelativePath($staging, $file.FullName)
            sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    })
    $destination = [IO.Path]::GetFullPath($ManifestPath)
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($destination)) -Force | Out-Null
    [IO.File]::WriteAllText(
        $destination,
        ($manifest | ConvertTo-Json -Depth 4),
        [Text.UTF8Encoding]::new($false))
    Get-Item -LiteralPath $destination
}
