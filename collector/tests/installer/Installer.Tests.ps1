BeforeAll {
    $collectorRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    $installerRoot = Join-Path $collectorRoot 'src\Vincere.AutoExport.Installer'
    . (Join-Path $installerRoot 'CustomActions\DetectNinjaTrader.ps1')
}

Describe 'NinjaTrader profile detection' {
    BeforeEach {
        $script:testRoot = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
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

Describe 'One download, one movement' {
    BeforeAll {
        $script:installScript = Get-Content -LiteralPath (Join-Path $collectorRoot 'scripts\install-agent.ps1') -Raw
        $script:windowsWorkflow = Get-Content -LiteralPath (
            [IO.Path]::GetFullPath((Join-Path $collectorRoot '..\.github\workflows\collector-windows.yml'))) -Raw
    }

    It 'ships the AddOn source in the package, laid out so the project references resolve' {
        # The AddOn csproj reaches its two dependencies through `../Vincere...`,
        # so the three folders have to stay siblings under AddOnSource and
        # Directory.Build.props has to sit above them.
        $windowsWorkflow | Should -Match 'AddOnSource'
        $windowsWorkflow | Should -Match ([regex]::Escape("Copy-Item -LiteralPath 'collector\Directory.Build.props'"))
        foreach ($project in 'Vincere.AutoExport.Contracts',
            'Vincere.AutoExport.NinjaTrader.Core', 'Vincere.AutoExport.NinjaTrader') {
            $windowsWorkflow | Should -Match ([regex]::Escape($project))
        }
        # This runner's build leftovers must not travel.
        $windowsWorkflow | Should -Match ([regex]::Escape("notin @('bin', 'obj')"))
    }

    It 'builds the AddOn on the machine when the package carries no compiled one' {
        # THE REGRESSION THIS CLOSES. The package shipped without an AddOn, the
        # installer warned and carried on, and the machine ran a service that
        # captured nothing until somebody deployed four DLLs by hand.
        $installScript | Should -Match ([regex]::Escape('AddOnSource\Vincere.AutoExport.NinjaTrader\Vincere.AutoExport.NinjaTrader.csproj'))
        $installScript | Should -Match 'NINJATRADER_HOME'
        $installScript | Should -Match 'dotnet build'
    }

    It 'fetches the build SDK itself rather than asking for it first' {
        # Requiring a preinstalled SDK would have made this two movements again.
        $installScript | Should -Match 'dotnet-install\.ps1'
        $installScript | Should -Match '-Channel'
        # Under the install root, which uninstall removes outright, so the
        # toolchain leaves with everything else.
        $installScript | Should -Match ([regex]::Escape("Join-Path `$InstallRoot 'build\dotnet'"))
    }

    It 'verifies every DLL the AddOn needs before calling the build a success' {
        foreach ($dll in 'Vincere.AutoExport.NinjaTrader.dll',
            'Vincere.AutoExport.NinjaTrader.Core.dll',
            'Vincere.AutoExport.Contracts.dll', 'Newtonsoft.Json.dll') {
            $installScript | Should -Match ([regex]::Escape($dll))
        }
        $installScript | Should -Match 'is missing from'
    }

    It 'closes the Setup window before replacing the files it holds open' {
        # THE HALF-INSTALL THIS CLOSES. This script opens the Setup window at the
        # end of every run, so a reinstall meets the previous window still
        # holding its own DLLs. Copy-Item failed on the first locked file, after
        # the service had already been deleted, leaving the machine with no agent
        # and an install stopped halfway.
        $installScript | Should -Match ([regex]::Escape("Get-Process -Name 'Vincere.AutoExport.Agent.UI'"))
        $installScript | Should -Match 'CloseMainWindow'

        # Before the copy, not after it, which is the whole point.
        $closeAt = $installScript.IndexOf('CloseMainWindow')
        $copyAt = $installScript.IndexOf('Copy-Item -Path (Join-Path $PackagePath')
        $closeAt | Should -BeGreaterThan 0
        $copyAt | Should -BeGreaterThan 0
        $closeAt | Should -BeLessThan $copyAt
    }

    It 'uses no syntax that Windows PowerShell 5.1 cannot parse' {
        # Windows Server opens 5.1, which has no null-conditional operator and no
        # ternary. A script that only runs under PowerShell 7 would fail on the
        # VPSes this is written for, and it would fail at the top before
        # installing anything.
        $installScript | Should -Not -Match '\)\?\.'
        $installScript | Should -Not -Match '\?\?'
        { [scriptblock]::Create($installScript) } | Should -Not -Throw
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
        $addon | Should -Match 'NinjaTraderCustomFolder'
        $addon | Should -Not -Match 'RemoveFile[^>]*Name="\*'
    }

    It 'links every harvested payload group into the machine feature' {
        $machine | Should -Match '<ComponentGroup Id="AgentPayloadComponents">\s*<Files'
        $machine | Should -Match '<ComponentGroup Id="SetupPayloadComponents">\s*<Files'
        $machine | Should -Match '<ComponentGroupRef Id="AgentPayloadComponents"'
        $machine | Should -Match '<ComponentGroupRef Id="SetupPayloadComponents"'
    }

    It 'uses an advertised Start menu shortcut in the per-machine UI component' {
        $machine | Should -Match '<Shortcut[^>]*Id="SetupStartMenuShortcut"[^>]*Advertise="yes"'
        $machine | Should -Not -Match '<Shortcut[^>]*Id="SetupStartMenuShortcut"[^>]*Advertise="no"'
    }

    It 'closes NinjaTrader before AddOn replacement and chains rollback-capable MSIs' {
        $addon | Should -Match 'CloseApplication[^>]*Target="NinjaTrader.exe"'
        $bundle | Should -Match 'MsiPackage Id="MachinePackage"[^>]*Vital="yes"'
        $bundle | Should -Match 'MsiPackage Id="AddOnPackage"[^>]*Vital="yes"'
    }

    It 'passes one detected interactive-user profile into the per-machine AddOn MSI' {
        $bundle | Should -Match 'Variable Name="NinjaTraderDocuments"[^>]*Value="\[PersonalFolder\]"[^>]*Persisted="yes"'
        $bundle | Should -Match 'DirectorySearch[^>]*Path="\[NinjaTraderDocuments\]NinjaTrader 8"[^>]*Variable="NinjaTraderProfileFound"'
        $bundle | Should -Match 'MsiProperty Name="NINJATRADERDOCUMENTS" Value="\[NinjaTraderDocuments\]"'
        $addon | Should -Match 'Scope="perMachine"'
        $addon | Should -Match 'Directory Id="NINJATRADERDOCUMENTS" Name="Documents"'
        $addon | Should -Not -Match 'StandardDirectory Id="PersonalFolder"'
    }

    It 'retains runtime data by default during uninstall' {
        $machine | Should -Match 'ProgramDataAclComponent[^>]*Permanent="yes"'
        $machine | Should -Not -Match 'RemoveFolderEx'
    }

    It 'contains rollback fault-injection support in the Windows test workflow contract' {
        $plan = Get-Content -LiteralPath (Join-Path $collectorRoot '..\docs\superpowers\plans\2026-07-23-ninjatrader-windows-collector-plan.md') -Raw
        $plan | Should -Match 'WIXFAILWHENDEFERRED=1|forced rollback|Force a custom-action failure'
    }

    It 'places the complete verified AddOn runtime payload in the compiled MSI' -Skip:(-not $env:VINCERE_TEST_ADDON_MSI_PATH) {
        $installer = New-Object -ComObject WindowsInstaller.Installer
        $database = $installer.GetType().InvokeMember(
            'OpenDatabase',
            [Reflection.BindingFlags]::InvokeMethod,
            $null,
            $installer,
            @((Resolve-Path -LiteralPath $env:VINCERE_TEST_ADDON_MSI_PATH).Path, 0))
        $view = $database.GetType().InvokeMember(
            'OpenView',
            [Reflection.BindingFlags]::InvokeMethod,
            $null,
            $database,
            @('SELECT `FileName` FROM `File`'))
        [void]$view.GetType().InvokeMember(
            'Execute',
            [Reflection.BindingFlags]::InvokeMethod,
            $null,
            $view,
            $null)
        $fileNames = @()
        while ($record = $view.GetType().InvokeMember(
            'Fetch',
            [Reflection.BindingFlags]::InvokeMethod,
            $null,
            $view,
            $null)) {
            $storedName = $record.GetType().InvokeMember(
                'StringData',
                [Reflection.BindingFlags]::GetProperty,
                $null,
                $record,
                @(1))
            $fileNames += ($storedName -split '\|')[-1]
        }

        foreach ($required in
            'Vincere.AutoExport.NinjaTrader.dll',
            'Vincere.AutoExport.NinjaTrader.Core.dll',
            'Vincere.AutoExport.Contracts.dll',
            'Newtonsoft.Json.dll') {
            $fileNames | Should -Contain $required
        }
    }

    It 'installs the compiled AddOn payload in the NinjaTrader Custom assembly discovery folder' -Skip:(-not $env:VINCERE_TEST_ADDON_MSI_PATH) {
        $installer = New-Object -ComObject WindowsInstaller.Installer
        $database = $installer.GetType().InvokeMember(
            'OpenDatabase',
            [Reflection.BindingFlags]::InvokeMethod,
            $null,
            $installer,
            @((Resolve-Path -LiteralPath $env:VINCERE_TEST_ADDON_MSI_PATH).Path, 0))
        $view = $database.GetType().InvokeMember(
            'OpenView',
            [Reflection.BindingFlags]::InvokeMethod,
            $null,
            $database,
            @("SELECT `Directory_` FROM `Component` WHERE `Component` = 'ProductionAddOnComponent'"))
        [void]$view.GetType().InvokeMember(
            'Execute',
            [Reflection.BindingFlags]::InvokeMethod,
            $null,
            $view,
            $null)
        $record = $view.GetType().InvokeMember(
            'Fetch',
            [Reflection.BindingFlags]::InvokeMethod,
            $null,
            $view,
            $null)
        $directory = $record.GetType().InvokeMember(
            'StringData',
            [Reflection.BindingFlags]::GetProperty,
            $null,
            $record,
            @(1))

        $directory | Should -Be 'NinjaTraderCustomFolder'
    }
}
