BeforeAll {
    $collectorRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    $installerRoot = Join-Path $collectorRoot 'src\Vincere.AutoExport.Installer'
    . (Join-Path $installerRoot 'CustomActions\DetectNinjaTrader.ps1')
}

Describe 'NinjaTrader profile detection' {
    BeforeEach {
        $script:testRoot = Join-Path $TestDrive 'Users'
        New-Item -ItemType Directory -Path $script:testRoot | Out-Null
    }

    It 'finds a single profile through its Documents folder' {
        New-Item -ItemType Directory -Path (Join-Path $testRoot 'Trader\Documents\NinjaTrader 8') -Force | Out-Null
        $result = @(Get-NinjaTraderProfileCandidates -UsersRoot $testRoot)
        $result.Count | Should -Be 1
        $result[0].UserName | Should -Be 'Trader'
    }

    It 'does not silently select when multiple profiles contain NinjaTrader' {
        New-Item -ItemType Directory -Path (Join-Path $testRoot 'TraderA\Documents\NinjaTrader 8') -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $testRoot 'TraderB\Documents\NinjaTrader 8') -Force | Out-Null
        { Resolve-NinjaTraderDocuments -UsersRoot $testRoot } | Should -Throw '*More than one*'
    }

    It 'fails clearly when NinjaTrader is absent' {
        { Resolve-NinjaTraderDocuments -UsersRoot $testRoot } | Should -Throw '*not found*'
    }

    It 'honors an explicitly selected Documents folder' {
        $documents = Join-Path $testRoot 'Chosen\Documents'
        New-Item -ItemType Directory -Path (Join-Path $documents 'NinjaTrader 8') -Force | Out-Null
        Resolve-NinjaTraderDocuments -ExplicitDocumentsPath $documents -UsersRoot $testRoot |
            Should -Be ([IO.Path]::GetFullPath($documents))
    }

    It 'blocks AddOn downgrades and allows same-version repair' {
        { Assert-AddOnUpgradeAllowed -InstalledVersion '2.0.0' -RequestedVersion '1.9.9' } | Should -Throw '*downgrade*'
        { Assert-AddOnUpgradeAllowed -InstalledVersion '2.0.0' -RequestedVersion '2.0.0' } | Should -Not -Throw
    }
}

Describe 'Installer safety authoring' {
    BeforeAll {
        $machine = Get-Content -LiteralPath (Join-Path $installerRoot 'Package.wxs') -Raw
        $addon = Get-Content -LiteralPath (Join-Path $installerRoot 'AddOn.Package.wxs') -Raw
        $bundle = Get-Content -LiteralPath (Join-Path $installerRoot 'Bundle.wxs') -Raw
    }

    It 'installs LocalSystem delayed-auto service with recovery and strict data ACLs' {
        $machine | Should -Match 'Account="LocalSystem"'
        $machine | Should -Match 'DelayedAutoStart="yes"'
        $machine | Should -Match 'FirstFailureActionType="restart"'
        $machine | Should -Match 'WIX_ACCOUNT_LOCALSYSTEM_NODOMAIN'
        $machine | Should -Match 'WIX_ACCOUNT_ADMINISTRATORS_NODOMAIN'
    }

    It 'uses major upgrades, blocks downgrades, and owns only Vincere paths' {
        $machine | Should -Match '<MajorUpgrade'
        $addon | Should -Match '<MajorUpgrade'
        $machine | Should -Match 'ProgramFiles64Folder'
        $addon | Should -Match 'NinjaTraderAddOnsFolder'
        $addon | Should -Not -Match 'RemoveFile[^>]*Name="\*'
    }

    It 'closes NinjaTrader before AddOn replacement and chains rollback-capable MSIs' {
        $addon | Should -Match 'CloseApplication[^>]*Target="NinjaTrader.exe"'
        $bundle | Should -Match 'MsiPackage Id="MachinePackage"[^>]*Vital="yes"'
        $bundle | Should -Match 'MsiPackage Id="AddOnPackage"[^>]*Vital="yes"'
    }

    It 'retains runtime data by default during uninstall' {
        $machine | Should -Match 'ProgramDataAclComponent[^>]*Permanent="yes"'
        $machine | Should -Not -Match 'RemoveFolderEx'
    }

    It 'contains rollback fault-injection support in the Windows test workflow contract' {
        $plan = Get-Content -LiteralPath (Join-Path $collectorRoot '..\docs\superpowers\plans\2026-07-23-ninjatrader-windows-collector-plan.md') -Raw
        $plan | Should -Match 'WIXFAILWHENDEFERRED=1|forced rollback|Force a custom-action failure'
    }
}
