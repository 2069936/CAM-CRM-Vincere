BeforeAll {
    $collectorRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    $scriptPath = Join-Path $collectorRoot 'scripts\create-addon-verification.ps1'
    $addOnPath = Join-Path $TestDrive 'Vincere.AutoExport.NinjaTrader.dll'
    [IO.File]::WriteAllText($addOnPath, 'test-addon-binary')

    function New-ValidParityEvidence {
        $section = [ordered]@{ passed = $true; apiRowCount = 1; gridRowCount = 1; statusCounts = @{} }
        return [ordered]@{
            schemaVersion = 1
            captureMethod = 'supported-api'
            comparisonSha256 = ('a' * 64)
            allFourSectionsPassed = $true
            reviewer = 'Approved Operator'
            reviewedAt = '2026-07-23T21:00:00.000Z'
            environment = [ordered]@{
                windowsVersion = 'Windows Server 2025'
                ninjaTraderVersion = '8.1.5.2'
                connectionProvider = 'Approved provider'
                localTimeZone = 'Eastern Standard Time'
            }
            checks = [ordered]@{
                sameMinuteCapture = $true
                postResetRealizedGrossVerified = $true
                twoStrategyAlgorithmsVerified = $true
                currentSessionExecutionsConfirmed = $true
            }
            sections = [ordered]@{
                accounts = $section
                strategies = $section
                orders = $section
                executions = $section
            }
            decisions = @()
        }
    }
}

Describe 'AddOn supported-API verification receipt' {
    It 'accepts report-bound, reviewed, populated four-section evidence' {
        $evidencePath = Join-Path $TestDrive 'valid-evidence.json'
        $outputPath = Join-Path $TestDrive 'receipt.json'
        [IO.File]::WriteAllText($evidencePath, (New-ValidParityEvidence | ConvertTo-Json -Depth 8))

        & $scriptPath -AddOnPath $addOnPath -ParityEvidencePath $evidencePath `
            -Version '1.2.3' -OutputPath $outputPath

        $receipt = Get-Content -LiteralPath $outputPath -Raw | ConvertFrom-Json
        $receipt.supportedApiParityPassed | Should -BeTrue
        $receipt.parityComparisonSha256 | Should -Be ('a' * 64)
    }

    It 'rejects the old boolean-only evidence shape' {
        $evidencePath = Join-Path $TestDrive 'weak-evidence.json'
        [IO.File]::WriteAllText(
            $evidencePath,
            '{"schemaVersion":1,"captureMethod":"supported-api","allFourSectionsPassed":true}')

        { & $scriptPath -AddOnPath $addOnPath -ParityEvidencePath $evidencePath `
            -Version '1.2.3' -OutputPath (Join-Path $TestDrive 'weak-receipt.json') } |
            Should -Throw '*comparisonSha256*'
    }

    It 'rejects empty sections and non-production decisions' {
        $emptySectionEvidence = New-ValidParityEvidence
        $emptySectionEvidence.sections.executions.apiRowCount = 0
        $emptyPath = Join-Path $TestDrive 'empty-section.json'
        [IO.File]::WriteAllText($emptyPath, ($emptySectionEvidence | ConvertTo-Json -Depth 8))
        { & $scriptPath -AddOnPath $addOnPath -ParityEvidencePath $emptyPath `
            -Version '1.2.3' -OutputPath (Join-Path $TestDrive 'empty-receipt.json') } |
            Should -Throw '*executions*'

        $blockedEvidence = New-ValidParityEvidence
        $blockedEvidence.decisions = @([ordered]@{
            section = 'accounts'; field = 'weeklyPnl'; status = 'missing-api';
            required = $false; action = 'pixel-automation'; rationale = 'not allowed'
        })
        $blockedPath = Join-Path $TestDrive 'blocked-decision.json'
        [IO.File]::WriteAllText($blockedPath, ($blockedEvidence | ConvertTo-Json -Depth 8))
        { & $scriptPath -AddOnPath $addOnPath -ParityEvidencePath $blockedPath `
            -Version '1.2.3' -OutputPath (Join-Path $TestDrive 'blocked-receipt.json') } |
            Should -Throw '*production action*'
    }
}
