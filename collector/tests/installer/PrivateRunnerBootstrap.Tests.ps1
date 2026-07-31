BeforeAll {
    $collectorRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    $scriptPath = Join-Path $collectorRoot 'scripts\install-private-ninjatrader-runner.ps1'
    . $scriptPath
}

Describe 'Private NinjaTrader runner bootstrap' {
    It 'targets only the CAM-owned private validation repository' {
        $plan = New-PrivateNinjaTraderRunnerPlan `
            -RunnerDirectory 'C:\actions-runner-vincere' `
            -RunnerName 'cam-builder-01'

        $plan.RepositoryUrl | Should -Be 'https://github.com/pedro-cmyks/CAM-CRM-Vincere-collector-build'
        $plan.RepositoryUrl | Should -Not -Be 'https://github.com/pedro-cmyks/CAM-CRM-Vincere'
        $plan.Labels | Should -Be @('ninjatrader8')
        $plan.RunAsService | Should -BeTrue
    }

    It 'rejects a runner directory inside the repository checkout' {
        $checkout = Join-Path $TestDrive 'checkout'
        $runnerDirectory = Join-Path $checkout 'actions-runner'
        New-Item -ItemType Directory -Path $runnerDirectory -Force | Out-Null

        {
            Assert-PrivateNinjaTraderRunnerDirectory `
                -RunnerDirectory $runnerDirectory `
                -CheckoutPath $checkout
        } | Should -Throw 'runner_directory_inside_checkout'
    }

    It 'rejects an existing or nonempty runner directory instead of overwriting it' {
        $checkout = Join-Path $TestDrive 'checkout-existing'
        $registered = Join-Path $TestDrive 'registered-runner'
        $nonempty = Join-Path $TestDrive 'nonempty-runner'
        New-Item -ItemType Directory -Path $checkout, $registered, $nonempty -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $registered '.runner'), '{}')
        [IO.File]::WriteAllText((Join-Path $nonempty 'foreign.txt'), 'owned by another process')

        {
            Assert-PrivateNinjaTraderRunnerDirectory `
                -RunnerDirectory $registered `
                -CheckoutPath $checkout
        } | Should -Throw 'runner_already_registered'
        {
            Assert-PrivateNinjaTraderRunnerDirectory `
                -RunnerDirectory $nonempty `
                -CheckoutPath $checkout
        } | Should -Throw 'runner_directory_not_empty'
    }

    It 'rejects a downloaded runner archive when its SHA-256 differs' {
        $archive = Join-Path $TestDrive 'runner.zip'
        [IO.File]::WriteAllText($archive, 'tampered archive')

        {
            Assert-RunnerArchiveIntegrity `
                -ArchivePath $archive `
                -ExpectedSha256 ('0' * 64)
        } | Should -Throw 'runner_archive_hash_mismatch'

        $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
        {
            Assert-RunnerArchiveIntegrity `
                -ArchivePath $archive `
                -ExpectedSha256 $actual
        } | Should -Not -Throw
    }

    It 'passes the registration token through the runner input environment and clears it afterward' {
        $runnerDirectory = Join-Path $TestDrive 'config-runner'
        New-Item -ItemType Directory -Path $runnerDirectory -Force | Out-Null
        $argumentsPath = Join-Path $runnerDirectory 'arguments.txt'
        $tokenStatePath = Join-Path $runnerDirectory 'token-state.txt'
        $configPath = Join-Path $runnerDirectory 'config.cmd'
        @"
@echo off
echo %* > "$argumentsPath"
if defined ACTIONS_RUNNER_INPUT_TOKEN (echo present> "$tokenStatePath") else (echo missing> "$tokenStatePath")
exit /b 0
"@ | Set-Content -LiteralPath $configPath -Encoding Ascii
        $secretLiteral = 'short-lived-registration-token'
        $secureToken = ConvertTo-SecureString $secretLiteral -AsPlainText -Force
        Remove-Item Env:ACTIONS_RUNNER_INPUT_TOKEN -ErrorAction SilentlyContinue

        Invoke-PrivateNinjaTraderRunnerConfiguration `
            -RunnerDirectory $runnerDirectory `
            -RunnerName 'cam-builder-01' `
            -RegistrationToken $secureToken

        $arguments = Get-Content -LiteralPath $argumentsPath -Raw
        $arguments | Should -Not -Match [regex]::Escape($secretLiteral)
        $arguments | Should -Match '--url https://github.com/pedro-cmyks/CAM-CRM-Vincere-collector-build'
        $arguments | Should -Match '--labels ninjatrader8'
        $arguments | Should -Match '--runasservice'
        (Get-Content -LiteralPath $tokenStatePath -Raw).Trim() | Should -Be 'present'
        Test-Path Env:ACTIONS_RUNNER_INPUT_TOKEN | Should -BeFalse
    }
}
