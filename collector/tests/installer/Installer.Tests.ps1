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
        # BOTH props files, by wildcard. Shipping only Directory.Build.props left
        # Directory.Packages.props behind, which is what supplies the version for
        # every versionless PackageReference. Newtonsoft.Json then resolved to
        # 3.5.8, the lowest that has ever existed, and the AddOn failed to build
        # on a real VPS because JsonException is not a type in it.
        $windowsWorkflow | Should -Match ([regex]::Escape("Copy-Item -Path 'collector\Directory.*.props'"))
        $windowsWorkflow | Should -Match ([regex]::Escape('Build configuration is missing from the package'))
        foreach ($project in 'Vincere.AutoExport.Contracts',
            'Vincere.AutoExport.NinjaTrader.Core', 'Vincere.AutoExport.NinjaTrader') {
            $windowsWorkflow | Should -Match ([regex]::Escape($project))
        }
        # This runner's build leftovers must not travel.
        $windowsWorkflow | Should -Match ([regex]::Escape("notin @('bin', 'obj')"))
    }

    It 'pins a version for every package the AddOn source resolves' {
        # The guard on the real cause rather than on the workflow text: a
        # versionless PackageReference is only safe while central package
        # management ships alongside it, and CS0246 on a client's VPS is a poor
        # place to discover it did not.
        $packages = Get-Content -LiteralPath (Join-Path $collectorRoot 'Directory.Packages.props') -Raw
        $packages | Should -Match 'ManagePackageVersionsCentrally>true<'
        foreach ($project in 'Vincere.AutoExport.Contracts',
            'Vincere.AutoExport.NinjaTrader.Core', 'Vincere.AutoExport.NinjaTrader') {
            $csproj = Get-Content -LiteralPath (
                Join-Path $collectorRoot "src\$project\$project.csproj") -Raw
            foreach ($match in [regex]::Matches($csproj, '<PackageReference\s+Include="([^"]+)"')) {
                $package = $match.Groups[1].Value
                # Built by concatenation: PowerShell escapes with a backtick, not
                # a backslash, and `\"` inside a double-quoted string is a parse
                # error rather than a quote.
                $needle = '<PackageVersion Include="' + $package + '"'
                $packages | Should -Match ([regex]::Escape($needle))
            }
        }
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

    It 'leaves a way back to the Setup window that is not the install command' {
        # People closed the window and were told to re-run the whole install,
        # which downloads a hundred megabytes and rebuilds the AddOn to reach a
        # window that was already sitting on the disk. The MSI has always laid a
        # shortcut down; this installer, the one the desk actually uses, did not.
        $installScript | Should -Match ([regex]::Escape('Vincere Auto Export.lnk'))
        $installScript | Should -Match 'CommonDesktopDirectory'
        $installScript | Should -Match ([regex]::Escape('Start Menu\Programs'))
        $installScript | Should -Match ([regex]::Escape('Setup\Vincere.AutoExport.Agent.UI.exe'))
    }

    It 'takes the shortcuts away with the program' {
        # A shortcut to a program that is gone is worse than no shortcut.
        $uninstallScript = Get-Content -LiteralPath (Join-Path $collectorRoot 'scripts\uninstall-agent.ps1') -Raw
        $uninstallScript | Should -Match ([regex]::Escape('Vincere Auto Export.lnk'))
        $uninstallScript | Should -Match 'Remove-Item'
    }

    It 'reports a version the published release can actually satisfy' {
        # Undeclared it was 1.0.0, the SDK default, against a release tagged
        # agent-v1.0.3 whose manifest asks for a minimum of 1.0.3. The server
        # then marks every machine update_required forever, because no build can
        # ever report the number being asked for.
        $csproj = Get-Content -LiteralPath (
            Join-Path $collectorRoot 'src\Vincere.AutoExport.Agent\Vincere.AutoExport.Agent.csproj') -Raw
        $csproj | Should -Match '<Version>\d+\.\d+\.\d+</Version>'
    }

    It 'never overwrites the Newtonsoft NinjaTrader ships with its own' {
        # bin\Custom is NinjaTrader's assembly folder, and it ships its own
        # Newtonsoft.Json. Dropping a different build there is the only thing
        # this installer does that can reach NinjaScript compilation, and
        # NinjaScript failing to compile is how an account shows no strategies.
        $installScript | Should -Match ([regex]::Escape("Join-Path `$NinjaTraderHome 'bin\Newtonsoft.Json.dll'"))
        $installScript | Should -Match ([regex]::Escape('$shipJson = $false'))
    }

    It 'stops before touching anything when the shipped Newtonsoft is too old' {
        # Refusing after the copy would be worse than not checking: the machine
        # would already be in the state the check exists to prevent.
        $refuseAt = $installScript.IndexOf('this AddOn was built against')
        $copyAt = $installScript.IndexOf('foreach ($dll in $ourDlls)')
        $refuseAt | Should -BeGreaterThan 0
        $copyAt | Should -BeGreaterThan 0
        $refuseAt | Should -BeLessThan $copyAt
    }

    It 'clears only its own files out of the AddOns folder' {
        # The cleanup matched by name against a list that included
        # Newtonsoft.Json.dll, so it would have deleted one that belonged to
        # somebody else.
        $ourList = [regex]::Match($installScript, '\$ourDlls = @\(([^)]*)\)').Groups[1].Value
        $ourList | Should -Match 'Vincere\.AutoExport\.NinjaTrader\.dll'
        $ourList | Should -Not -Match 'Newtonsoft'
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

Describe 'Every helper a script calls is a helper that script defines' {
    # uninstall-agent.ps1 called Write-Ok at line 56 and never defined it. It
    # defines only Write-Step. With $ErrorActionPreference = 'Stop' set at the
    # top, that call aborted the uninstall at the first shortcut it removed,
    # leaving the service files and the data root behind on every machine that
    # has a shortcut, which is every machine installed since shortcuts existed.
    #
    # Nothing caught it because this suite reads these scripts as text and never
    # runs them, and a parse succeeds on a call to a function that does not
    # exist. This is the cheapest check that would have.
    BeforeAll {
        $script:scriptRoot = Join-Path $collectorRoot 'scripts'
        $script:builtInWriters = @(
            'Write-Host', 'Write-Error', 'Write-Warning', 'Write-Output',
            'Write-Verbose', 'Write-Debug', 'Write-Information',
            'Write-Progress', 'Write-EventLog'
        )
    }

    It 'defines every Write- helper called in <Name>' -ForEach @(
        @{ Name = 'install-agent.ps1' }
        @{ Name = 'uninstall-agent.ps1' }
    ) {
        $text = Get-Content -LiteralPath (Join-Path $scriptRoot $Name) -Raw
        $defined = @([regex]::Matches($text, '(?m)^function\s+(Write-[A-Za-z]+)') |
            ForEach-Object { $_.Groups[1].Value })
        $called = @([regex]::Matches($text, '(?m)^\s*(Write-[A-Za-z]+)\s') |
            ForEach-Object { $_.Groups[1].Value })
        $missing = @($called |
            Where-Object { $builtInWriters -notcontains $_ -and $defined -notcontains $_ } |
            Select-Object -Unique)
        $missing -join ', ' | Should -BeNullOrEmpty
    }
}
