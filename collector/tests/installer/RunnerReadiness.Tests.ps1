BeforeAll {
    $collectorRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    $scriptPath = Join-Path $collectorRoot 'scripts\test-ninjatrader-runner-readiness.ps1'

    function New-RunnerFixture {
        param([string]$Name)

        $root = Join-Path $TestDrive $Name
        $checkout = Join-Path $root 'checkout'
        $ninjaTraderHome = Join-Path $root 'ninjatrader'
        $bin = Join-Path $ninjaTraderHome 'bin'
        $evidence = Join-Path $root 'private\parity-review.json'
        New-Item -ItemType Directory -Path $checkout, $bin, (Split-Path $evidence) -Force | Out-Null
        foreach ($assembly in 'NinjaTrader.Core.dll', 'NinjaTrader.Gui.dll', 'NinjaTrader.NinjaScript.dll') {
            [IO.File]::WriteAllText((Join-Path $bin $assembly), "fixture-$assembly")
        }
        [IO.File]::WriteAllText($evidence, '{"schemaVersion":1}')

        return [ordered]@{
            CheckoutPath = $checkout
            NinjaTraderHome = $ninjaTraderHome
            ParityEvidencePath = $evidence
        }
    }
}

Describe 'Controlled NinjaTrader runner readiness' {
    It 'accepts nonempty proprietary references and parity evidence outside the checkout' {
        $fixture = New-RunnerFixture 'valid'

        $result = & $scriptPath @fixture

        $result.ready | Should -BeTrue
        $result.code | Should -Be 'runner_ready'
        @($result.checks).Count | Should -Be 7
        @($result.checks | Where-Object passed -ne $true).Count | Should -Be 0
    }

    It 'rejects a missing required NinjaTrader assembly with a stable path-free error' {
        $fixture = New-RunnerFixture 'missing-assembly'
        Remove-Item -LiteralPath (Join-Path $fixture.NinjaTraderHome 'bin\NinjaTrader.Gui.dll')

        $message = try { & $scriptPath @fixture; '' } catch { $_.Exception.Message }

        $message | Should -Be 'runner_missing_ninjatrader_gui'
        $message | Should -Not -Match [regex]::Escape($TestDrive)
    }

    It 'rejects proprietary references located inside the checkout' {
        $fixture = New-RunnerFixture 'embedded-home'
        $embeddedHome = Join-Path $fixture.CheckoutPath 'NinjaTrader 8'
        Move-Item -LiteralPath $fixture.NinjaTraderHome -Destination $embeddedHome
        $fixture.NinjaTraderHome = $embeddedHome

        { & $scriptPath @fixture } | Should -Throw 'runner_ninjatrader_inside_checkout'
    }

    It 'rejects parity evidence located inside the checkout' {
        $fixture = New-RunnerFixture 'embedded-evidence'
        $embeddedEvidence = Join-Path $fixture.CheckoutPath 'parity-review.json'
        Move-Item -LiteralPath $fixture.ParityEvidencePath -Destination $embeddedEvidence
        $fixture.ParityEvidencePath = $embeddedEvidence

        { & $scriptPath @fixture } | Should -Throw 'runner_parity_evidence_inside_checkout'
    }

    It 'rejects empty proprietary references and empty parity evidence' {
        $fixture = New-RunnerFixture 'empty-inputs'
        [IO.File]::WriteAllBytes(
            (Join-Path $fixture.NinjaTraderHome 'bin\NinjaTrader.NinjaScript.dll'),
            [byte[]]::new(0))

        { & $scriptPath @fixture } | Should -Throw 'runner_empty_ninjatrader_ninjascript'

        $fixture = New-RunnerFixture 'empty-evidence'
        [IO.File]::WriteAllBytes($fixture.ParityEvidencePath, [byte[]]::new(0))

        { & $scriptPath @fixture } | Should -Throw 'runner_empty_parity_evidence'
    }
}
