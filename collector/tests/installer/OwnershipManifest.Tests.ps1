Describe 'Signed payload ownership manifest' {
    It 'hashes the final bytes after signing and includes unsigned runtime dependencies' {
        $collectorRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
        $scriptPath = Join-Path $collectorRoot 'scripts\complete-owned-payload.ps1'
        Test-Path -LiteralPath $scriptPath -PathType Leaf | Should -BeTrue
        . $scriptPath

        $staging = Join-Path $TestDrive 'staging'
        $agentDirectory = Join-Path $staging 'agent'
        $addOnDirectory = Join-Path $TestDrive 'addon'
        New-Item -ItemType Directory -Path $agentDirectory, $addOnDirectory -Force | Out-Null
        $agentPath = Join-Path $agentDirectory 'Vincere.AutoExport.Agent.dll'
        $jsonPath = Join-Path $addOnDirectory 'Newtonsoft.Json.dll'
        [IO.File]::WriteAllText($agentPath, 'agent-before')
        [IO.File]::WriteAllText($jsonPath, 'third-party-unchanged')

        $signerPath = Join-Path $TestDrive 'fake-signer.ps1'
        [IO.File]::WriteAllText($signerPath, @'
param([Parameter(Mandatory)][string[]]$Paths)
foreach ($path in $Paths) { [IO.File]::AppendAllText($path, '-signed') }
'@)
        $manifestPath = Join-Path $staging 'ownership-manifest.json'

        Complete-OwnedPayload -OwnedPaths $agentPath, $jsonPath -SignablePaths $agentPath `
            -StagingDirectory $staging -ManifestPath $manifestPath -SigningScriptPath $signerPath

        [IO.File]::ReadAllText($agentPath) | Should -BeExactly 'agent-before-signed'
        $manifest = @(Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json)
        $manifest.Count | Should -Be 2
        ($manifest | Where-Object name -eq 'Vincere.AutoExport.Agent.dll').sha256 |
            Should -Be 'd01bf9d8bf506fad0bcd881934d0caf932f098e1c61944a74a0af58a65c15fc1'
        ($manifest | Where-Object name -eq 'Newtonsoft.Json.dll').sha256 |
            Should -Be '68ff27dd7351223d518656ca6765d67d615ed16a389c65d31672756946290b95'
    }
}
