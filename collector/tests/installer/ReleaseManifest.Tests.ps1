BeforeAll {
    $collectorRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    $scriptPath = Join-Path $collectorRoot 'scripts\create-release-manifest.ps1'
    $artifactPaths = @('machine.msi.zip', 'addon.msi.zip', 'setup.exe.zip') | ForEach-Object {
        $path = Join-Path $TestDrive $_
        [IO.File]::WriteAllText($path, "artifact-$_")
        $path
    }
}

Describe 'Release manifest generation' {
    It 'writes HTTPS URLs, exact hashes, sizes, versions, and signer thumbprint' {
        $output = Join-Path $TestDrive 'release-manifest.json'
        & $scriptPath -Version '1.2.3' -MinimumAgentVersion '1.2.0' -MinimumSchemaVersion 1 `
            -ArtifactPaths $artifactPaths -BaseUrl 'https://downloads.example.test/collector' `
            -SigningThumbprint ('A' * 40) -OutputPath $output

        $manifest = Get-Content -LiteralPath $output -Raw | ConvertFrom-Json
        $manifest.version | Should -Be '1.2.3'
        $manifest.minimumAgentVersion | Should -Be '1.2.0'
        $manifest.signingThumbprint | Should -Be ('A' * 40)
        $manifest.artifacts.Count | Should -Be 3
        $manifest.artifacts | ForEach-Object {
            $_.url | Should -Match '^https://'
            $_.sha256 | Should -Match '^[a-f0-9]{64}$'
            $_.size | Should -BeGreaterThan 0
        }
    }

    It 'blocks non-HTTPS distribution and non-monotonic versions' {
        $output = Join-Path $TestDrive 'current.json'
        { & $scriptPath -Version '1.2.3' -MinimumAgentVersion '1.2.3' -MinimumSchemaVersion 1 `
            -ArtifactPaths $artifactPaths -BaseUrl 'http://downloads.example.test' `
            -SigningThumbprint ('A' * 40) -OutputPath $output } | Should -Throw '*HTTPS*'

        $previous = Join-Path $TestDrive 'previous.json'
        [IO.File]::WriteAllText($previous, '{"version":"1.2.3"}')
        { & $scriptPath -Version '1.2.3' -MinimumAgentVersion '1.2.3' -MinimumSchemaVersion 1 `
            -ArtifactPaths $artifactPaths -BaseUrl 'https://downloads.example.test' `
            -SigningThumbprint ('A' * 40) -OutputPath $output -PreviousManifestPath $previous } |
            Should -Throw '*monotonically*'
    }
}
