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

Describe 'The service is started again when Windows leaves it stopped' {
    # 2026-10-18: the VPS provider powered machines off at 06:50 New York time.
    # On 34 of them the agent missed Windows' 30 second start window after the
    # reboot (System log 7009 then 7000) and stayed stopped for a day, because
    # the restart-on-failure actions do not cover a start that timed out. The
    # installer now registers a SYSTEM task that starts the service after boot
    # and every 15 minutes. These tests pin the task, its place in the install
    # and its removal.
    BeforeAll {
        $script:installPath = Join-Path $collectorRoot 'scripts\install-agent.ps1'
        $script:installText = Get-Content -LiteralPath $installPath -Raw
        $script:uninstallText = Get-Content -LiteralPath (Join-Path $collectorRoot 'scripts\uninstall-agent.ps1') -Raw

        # The function is lifted out of the script by its syntax tree and defined
        # here on its own. Running install-agent.ps1 would install a service.
        $tokens = $null
        $parseErrors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($installPath, [ref]$tokens, [ref]$parseErrors)
        $definition = $ast.Find({
            param($node)
            $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
                $node.Name -eq 'New-AgentWatchdogTaskXml'
        }, $true)
        if (-not $definition) { throw 'install-agent.ps1 no longer defines New-AgentWatchdogTaskXml.' }
        . ([scriptblock]::Create($definition.Extent.Text))

        $script:xmlText = New-AgentWatchdogTaskXml -ServiceName 'Vincere Auto Export' -StartBoundary ([datetime]'2026-10-19T08:00:00')
        $script:task = [xml]$xmlText
        $script:ns = New-Object System.Xml.XmlNamespaceManager($task.NameTable)
        $ns.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
    }

    It 'starts the service five minutes after boot' {
        $task.SelectSingleNode('//t:Triggers/t:BootTrigger/t:Delay', $ns).InnerText | Should -Be 'PT5M'
        $task.SelectSingleNode('//t:Triggers/t:BootTrigger/t:Enabled', $ns).InnerText | Should -Be 'true'
    }

    It 'checks again every 15 minutes, with no end' {
        $repetition = $task.SelectSingleNode('//t:Triggers/t:TimeTrigger/t:Repetition', $ns)
        $repetition.SelectSingleNode('t:Interval', $ns).InnerText | Should -Be 'PT15M'
        # A Duration would end the repetition; without one it never ends.
        $repetition.SelectSingleNode('t:Duration', $ns) | Should -BeNullOrEmpty
        $task.SelectSingleNode('//t:Triggers/t:TimeTrigger/t:StartBoundary', $ns).InnerText |
            Should -Be '2026-10-19T08:00:00'
    }

    It 'runs as SYSTEM, without a logged on user and on any power source' {
        $task.SelectSingleNode('//t:Principals/t:Principal/t:UserId', $ns).InnerText | Should -Be 'S-1-5-18'
        $task.SelectSingleNode('//t:Settings/t:DisallowStartIfOnBatteries', $ns).InnerText | Should -Be 'false'
        $task.SelectSingleNode('//t:Settings/t:StopIfGoingOnBatteries', $ns).InnerText | Should -Be 'false'
        $task.SelectSingleNode('//t:Settings/t:RunOnlyIfNetworkAvailable', $ns).InnerText | Should -Be 'false'
        $task.SelectSingleNode('//t:Settings/t:StartWhenAvailable', $ns).InnerText | Should -Be 'true'
        $task.SelectSingleNode('//t:Settings/t:MultipleInstancesPolicy', $ns).InnerText | Should -Be 'IgnoreNew'
        $task.SelectSingleNode('//t:Settings/t:ExecutionTimeLimit', $ns).InnerText | Should -Be 'PT5M'
    }

    It 'only ever starts the named service, through sc.exe' {
        $exec = $task.SelectSingleNode('//t:Actions/t:Exec', $ns)
        $exec.SelectSingleNode('t:Command', $ns).InnerText | Should -Be '%SystemRoot%\System32\sc.exe'
        $exec.SelectSingleNode('t:Arguments', $ns).InnerText | Should -Be 'start "Vincere Auto Export"'
        @($task.SelectNodes('//t:Actions/*', $ns)).Count | Should -Be 1
    }

    It 'escapes the service name into the XML' {
        $odd = [xml](New-AgentWatchdogTaskXml -ServiceName 'A & B <test>' -StartBoundary ([datetime]'2026-10-19T08:00:00'))
        $oddNs = New-Object System.Xml.XmlNamespaceManager($odd.NameTable)
        $oddNs.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
        $odd.SelectSingleNode('//t:Actions/t:Exec/t:Arguments', $oddNs).InnerText | Should -Be 'start "A & B <test>"'
    }

    It 'removes the watchdog before stopping the old service and registers it after the new one runs' {
        $unregister = $installText.IndexOf('Unregister-ScheduledTask -TaskName $WatchdogTaskName')
        $stop = $installText.IndexOf('Stop-Service -Name $ServiceName')
        $start = $installText.IndexOf('Start-Service -Name $ServiceName')
        $register = $installText.IndexOf('Register-ScheduledTask -TaskName $WatchdogTaskName -Xml')
        $unregister | Should -BeGreaterThan -1
        $register | Should -BeGreaterThan -1
        $unregister | Should -BeLessThan $stop
        $register | Should -BeGreaterThan $start
        $installText | Should -Match ([regex]::Escape("`$WatchdogTaskName = 'Vincere Auto Export watchdog'"))
    }

    It 'installs the agent only, without the AddOn or the backup, while NinjaTrader is open' {
        $check = $installText.IndexOf("if (-not `$SkipAddOn -and (Get-Process -Name 'NinjaTrader'")
        $check | Should -BeGreaterThan -1
        $block = $installText.Substring($check, 500)
        $block | Should -Match ([regex]::Escape('$SkipAddOn = [switch]$true'))
        $block | Should -Match ([regex]::Escape('$SkipBackup = [switch]$true'))
        $block | Should -Match 'Write-Warning'
        $installText | Should -Not -Match 'Close NinjaTrader completely before installing'
        # Decided before the backup and the AddOn steps read the switches.
        $check | Should -BeLessThan $installText.IndexOf('if (-not $SkipBackup) {')
        $check | Should -BeLessThan $installText.IndexOf('if (-not $SkipAddOn) {')
    }

    It 'gives the service three tries of two minutes to start, not one of thirty seconds' {
        $installText | Should -Match ([regex]::Escape("WaitForStatus('Running', '00:02:00')"))
        $installText | Should -Not -Match ([regex]::Escape("WaitForStatus('Running', '00:00:30')"))
        $installText | Should -Match ([regex]::Escape('if ($startAttempt -ge 3) { throw }'))
    }

    It 'lets the recovery actions run when the service stops itself with an error' {
        $installText | Should -Match ([regex]::Escape('& sc.exe failureflag "$ServiceName" 1'))
    }

    It 'never fails an install that already has a running service because the task could not be registered' {
        $registerAt = $installText.IndexOf('Register-ScheduledTask -TaskName $WatchdogTaskName -Xml')
        $tryAt = $installText.LastIndexOf('try {', $registerAt)
        $catchAt = $installText.IndexOf('catch {', $registerAt)
        $tryAt | Should -BeGreaterThan $installText.IndexOf('Start-Service -Name $ServiceName')
        $catchAt | Should -BeGreaterThan $registerAt
        $installText.Substring($catchAt, 400) | Should -Match 'Write-Warning'
    }

    It 'removes the watchdog in the uninstaller before the service' {
        $unregister = $uninstallText.IndexOf('Unregister-ScheduledTask -TaskName $WatchdogTaskName')
        $stop = $uninstallText.IndexOf('Stop-Service -Name $ServiceName')
        $unregister | Should -BeGreaterThan -1
        $unregister | Should -BeLessThan $stop
        $uninstallText | Should -Match ([regex]::Escape("`$WatchdogTaskName = 'Vincere Auto Export watchdog'"))
    }

    It 'is a task Windows accepts, with the triggers and action it was given' -Skip:(
        [Environment]::OSVersion.Platform -ne 'Win32NT' -or
        -not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
            [Security.Principal.WindowsBuiltInRole]::Administrator)) {
        # Registered for real on the CI runner under a throwaway name and a
        # service that does not exist, read back, and removed. Never run.
        $name = "Vincere watchdog test $([guid]::NewGuid().ToString('N'))"
        $xml = New-AgentWatchdogTaskXml -ServiceName 'Vincere Watchdog Test Missing Service' -StartBoundary (Get-Date)
        try {
            Register-ScheduledTask -TaskName $name -Xml $xml -Force | Out-Null
            $registered = Get-ScheduledTask -TaskName $name
            $registered.Principal.UserId | Should -BeIn @('SYSTEM', 'S-1-5-18', 'NT AUTHORITY\SYSTEM')
            @($registered.Triggers).Count | Should -Be 2
            ($registered.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskBootTrigger' }).Delay | Should -Be 'PT5M'
            ($registered.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskTimeTrigger' }).Repetition.Interval | Should -Be 'PT15M'
            $registered.Actions[0].Arguments | Should -Be 'start "Vincere Watchdog Test Missing Service"'
        }
        finally {
            Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
        }
    }
}

Describe 'An update from the CRM installs the agent, never NinjaTrader, and puts it back if it fails' {
    # update-agent.ps1 runs as SYSTEM from a scheduled task the agent starts when
    # a Manager presses Update in the CRM. It is read here as a syntax tree and as
    # text and never run: running it would replace the service on this machine.
    BeforeAll {
        $script:updatePath = Join-Path $collectorRoot 'scripts\update-agent.ps1'
        $script:updateText = Get-Content -LiteralPath $updatePath -Raw
        $script:installText = Get-Content -LiteralPath (Join-Path $collectorRoot 'scripts\install-agent.ps1') -Raw
        $script:uninstallText = Get-Content -LiteralPath (Join-Path $collectorRoot 'scripts\uninstall-agent.ps1') -Raw
        $script:windowsWorkflow = Get-Content -LiteralPath (
            [IO.Path]::GetFullPath((Join-Path $collectorRoot '..\.github\workflows\collector-windows.yml'))) -Raw

        $tokens = $null
        $parseErrors = $null
        $script:updateAst = [System.Management.Automation.Language.Parser]::ParseFile($updatePath, [ref]$tokens, [ref]$parseErrors)
        $script:updateParseErrors = $parseErrors

        function script:Get-UpdateFunction {
            param([string]$Name)
            $found = $updateAst.Find({
                param($node)
                $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $Name
            }, $true)
            if (-not $found) { throw "update-agent.ps1 no longer defines $Name." }
            return $found
        }

        # Every command the script itself runs, outside the function definitions
        # too, with comments excluded because the syntax tree has none.
        $script:updateCommands = @($updateAst.FindAll({
            param($node) $node -is [System.Management.Automation.Language.CommandAst]
        }, $true))
        $script:updateStrings = @($updateAst.FindAll({
            param($node)
            $node -is [System.Management.Automation.Language.StringConstantExpressionAst] -or
                $node -is [System.Management.Automation.Language.ExpandableStringExpressionAst]
        }, $true) | ForEach-Object { $_.Value })

        $script:installCall = $updateAst.Find({
            param($node)
            $node -is [System.Management.Automation.Language.CommandAst] -and
                $node.InvocationOperator -eq [System.Management.Automation.Language.TokenKind]::Ampersand -and
                $node.CommandElements[0].Extent.Text -eq '$installScript'
        }, $true)
    }

    It 'parses, uses only Windows PowerShell 5.1 syntax, and is ASCII' {
        $updateParseErrors | Should -BeNullOrEmpty
        $updateText | Should -Not -Match '\)\?\.'
        $updateText | Should -Not -Match '\?\?'
        $bytes = [IO.File]::ReadAllBytes($updatePath)
        @($bytes | Where-Object { $_ -gt 127 }).Count | Should -Be 0
    }

    It 'takes exactly the two parameters the agent passes it' {
        # The agent's task runs: -File update-agent.ps1 -PackagePath "..." -ExpectedVersion "x.y.z"
        $names = @($updateAst.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
        $names | Should -Be @('PackagePath', 'ExpectedVersion')
    }

    It 'runs the package installer with -SkipAddOn -SkipBackup -NoPairing' {
        $installCall | Should -Not -BeNullOrEmpty
        $switches = @($installCall.CommandElements |
            Where-Object { $_ -is [System.Management.Automation.Language.CommandParameterAst] } |
            ForEach-Object { $_.ParameterName })
        $switches | Should -Contain 'PackagePath'
        $switches | Should -Contain 'SkipAddOn'
        $switches | Should -Contain 'SkipBackup'
        $switches | Should -Contain 'NoPairing'
        $updateText | Should -Match ([regex]::Escape("`$installScript = Join-Path `$PackagePath 'install-agent.ps1'"))
    }

    It 'relies on install-agent.ps1 checking for an open NinjaTrader only without -SkipAddOn, and prompting for nothing' {
        # The two places install-agent.ps1 reaches NinjaTrader are behind the two
        # switches the update passes. Neither script waits for a person.
        $installText | Should -Match ([regex]::Escape("if (-not `$SkipAddOn -and (Get-Process -Name 'NinjaTrader'"))
        $installText | Should -Match ([regex]::Escape('if (-not $SkipBackup) {'))
        $installText | Should -Match ([regex]::Escape('if (-not $SkipAddOn) {'))
        $installText | Should -Not -Match 'Read-Host'
        $updateText | Should -Not -Match 'Read-Host'
    }

    It 'never names a NinjaTrader path, folder or process' {
        foreach ($value in $updateStrings) {
            $value | Should -Not -Match 'NinjaTrader 8|bin\\Custom|AddOns|MyDocuments|Documents\\|NinjaTrader\.exe'
        }
        $updateText | Should -Not -Match 'NinjaTraderDocumentsPath|NinjaTraderHome|GetFolderPath'
        # The only processes it may stop are this agent's own.
        foreach ($command in $updateCommands | Where-Object { $_.GetCommandName() -in @('Get-Process', 'Stop-Process') }) {
            $command.Extent.Text | Should -Not -Match 'NinjaTrader'
        }
        @($updateCommands | Where-Object { $_.GetCommandName() -eq 'Get-Process' } |
            ForEach-Object { $_.Extent.Text }) | Should -Be @("Get-Process -Name 'Vincere.AutoExport.Agent.UI' -ErrorAction SilentlyContinue")
    }

    It 'refuses a package from anywhere but the updates folder, before it changes anything' {
        $updateText | Should -Match ([regex]::Escape('$PackagePath.StartsWith($updatesPrefix, [StringComparison]::OrdinalIgnoreCase)'))
        $updateText | Should -Match ([regex]::Escape('$ExpectedVersion -notmatch ''^\d{1,5}\.\d{1,5}\.\d{1,5}$'''))
        $updateText.IndexOf('$updatesPrefix') | Should -BeLessThan $updateText.IndexOf("`$errorCode = 'backup_failed'")
    }

    It 'backs up the install root before it runs the installer, and keeps the old backup until the new one is whole' {
        $backupCall = $updateAst.Find({
            param($node)
            $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Backup-InstallRoot'
        }, $true)
        $backupCall | Should -Not -BeNullOrEmpty
        $backupCall.Extent.StartOffset | Should -BeLessThan $installCall.Extent.StartOffset
        $updateText | Should -Match ([regex]::Escape("`$RollbackRoot = Join-Path `$UpdatesRoot 'rollback'"))
        $backup = (Get-UpdateFunction 'Backup-InstallRoot').Extent.Text
        $backup.IndexOf('Move-Item -LiteralPath $staging -Destination $RollbackRoot') |
            Should -BeGreaterThan $backup.IndexOf('Copy-Item -LiteralPath $item.FullName -Destination $staging')
    }

    It 'only restores when the installer was started, and restores whenever it was' {
        $updateText | Should -Match 'if \(\$changed\) \{\s*try \{\s*Restore-AgentInstall'
        $updateText.IndexOf('$changed = $true') | Should -BeLessThan $installCall.Extent.StartOffset
        $updateText.IndexOf('$changed = $true') | Should -BeGreaterThan $updateText.IndexOf("`$errorCode = 'backup_failed'")
    }

    It 'restores with the watchdog off and the service stopped, then re-creates the service if it is gone and starts it' {
        $restore = (Get-UpdateFunction 'Restore-AgentInstall').Extent.Text
        $unregisterAt = $restore.IndexOf('Unregister-ScheduledTask -TaskName $WatchdogTaskName')
        $stopAt = $restore.IndexOf('Stop-AgentService')
        $copyAt = $restore.IndexOf('Copy-Item -LiteralPath $item.FullName -Destination $InstallRoot')
        $registerAt = $restore.IndexOf('Register-AgentService')
        $startAt = $restore.IndexOf('Start-Service -Name $ServiceName')
        $watchdogAt = $restore.IndexOf('Register-AgentWatchdogIfMissing')
        foreach ($at in @($unregisterAt, $stopAt, $copyAt, $registerAt, $startAt, $watchdogAt)) { $at | Should -BeGreaterThan -1 }
        $unregisterAt | Should -BeLessThan $stopAt
        $stopAt | Should -BeLessThan $copyAt
        $copyAt | Should -BeLessThan $registerAt
        $registerAt | Should -BeLessThan $startAt
        $startAt | Should -BeLessThan $watchdogAt
        $restore | Should -Match ([regex]::Escape('if (-not (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue))'))
    }

    It 're-creates the service exactly as install-agent.ps1 registers it' {
        $register = (Get-UpdateFunction 'Register-AgentService').Extent.Text
        foreach ($line in @(
            '-BinaryPathName "`"$serviceBinary`""',
            '-DisplayName $ServiceName',
            "-Description 'Collects NinjaTrader data for the Vincere CRM.'",
            '-StartupType Automatic',
            '& sc.exe config "$ServiceName" start= delayed-auto',
            '& sc.exe failure "$ServiceName" reset= 86400 actions= restart/15000/restart/15000/restart/15000',
            '& sc.exe failureflag "$ServiceName" 1'
        )) {
            $register | Should -Match ([regex]::Escape($line))
            $installText | Should -Match ([regex]::Escape($line))
        }
        $updateText | Should -Match ([regex]::Escape("`$ServiceName = 'Vincere Auto Export'"))
        $updateText | Should -Match ([regex]::Escape("`$WatchdogTaskName = 'Vincere Auto Export watchdog'"))
    }

    It 'puts the watchdog back from the package installer by its syntax tree, never by running it' {
        $watchdog = (Get-UpdateFunction 'Register-AgentWatchdogIfMissing').Extent.Text
        $watchdog | Should -Match ([regex]::Escape('[System.Management.Automation.Language.Parser]::ParseFile($installScript'))
        $watchdog | Should -Match ([regex]::Escape("`$node.Name -eq 'New-AgentWatchdogTaskXml'"))
        $watchdog | Should -Match ([regex]::Escape('Register-ScheduledTask -TaskName $WatchdogTaskName -Xml $watchdogXml -Force'))
        # And the function it lifts is one the installer still defines.
        $installAst = [System.Management.Automation.Language.Parser]::ParseInput($installText, [ref]$null, [ref]$null)
        $installAst.Find({
            param($node)
            $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'New-AgentWatchdogTaskXml'
        }, $true) | Should -Not -BeNullOrEmpty
        # Even when the restore itself fails.
        $updateText | Should -Match "rollback_failed'[\s\S]*Register-AgentWatchdogIfMissing"
    }

    It 'calls it installed only when the service runs the expected version' {
        $updateText | Should -Match ([regex]::Escape('Wait-AgentServiceRunning -TimeoutSeconds 120'))
        $updateText.IndexOf('if (-not (Test-InstalledAgentVersion))') | Should -BeGreaterThan $installCall.Extent.StartOffset
        $updateText.IndexOf('$installed = $true') | Should -BeGreaterThan $updateText.IndexOf('if (-not (Test-InstalledAgentVersion))')
        # And still running half a minute later, which a crash loop never is.
        $updateText.IndexOf('$installed = $true') |
            Should -BeGreaterThan $updateText.IndexOf('if (-not (Test-AgentServiceStaysRunning -Seconds 30))')
        $updateText.IndexOf('if (-not (Test-AgentServiceStaysRunning -Seconds 30))') | Should -BeGreaterThan -1
        # A whole version, not a prefix: 1.3.10 must not pass for 1.3.1.
        $updateText | Should -Match ([regex]::Escape("'^' + [regex]::Escape(`$ExpectedVersion) + '([+.-]|`$)'"))
        $pattern = '^' + [regex]::Escape('1.3.1') + '([+.-]|$)'
        '1.3.1+abcdef' | Should -Match $pattern
        '1.3.1' | Should -Match $pattern
        '1.3.1.0' | Should -Match $pattern
        '1.3.10' | Should -Not -Match $pattern
    }

    It 'writes last-result.json for both outcomes and removes its own task last' {
        $updateText | Should -Match ([regex]::Escape("`$LastResultPath = Join-Path `$UpdatesRoot 'last-result.json'"))
        $updateText | Should -Match ([regex]::Escape("`$UpdateTaskName = 'Vincere Auto Export update'"))
        $installedAt = $updateText.LastIndexOf("Write-UpdateResult -Outcome 'installed'")
        $rolledBackAt = $updateText.LastIndexOf("Write-UpdateResult -Outcome 'rolled_back' -ErrorCode `$errorCode")
        $unregisterAt = $updateText.LastIndexOf('Unregister-ScheduledTask -TaskName $UpdateTaskName')
        $installedAt | Should -BeGreaterThan -1
        $rolledBackAt | Should -BeGreaterThan -1
        $unregisterAt | Should -BeGreaterThan $installedAt
        $unregisterAt | Should -BeGreaterThan $rolledBackAt
    }

    It 'writes a result the agent can read: the four keys, no byte order mark' {
        . ([scriptblock]::Create((Get-UpdateFunction 'Write-Ok').Extent.Text))
        . ([scriptblock]::Create((Get-UpdateFunction 'Write-UpdateResult').Extent.Text))
        $UpdatesRoot = Join-Path $TestDrive 'updates'
        $LastResultPath = Join-Path $UpdatesRoot 'last-result.json'
        $ExpectedVersion = '1.3.1'

        Write-UpdateResult -Outcome 'rolled_back' -ErrorCode 'service_not_running'

        $bytes = [IO.File]::ReadAllBytes($LastResultPath)
        $bytes[0] | Should -Not -Be 0xEF
        $result = [IO.File]::ReadAllText($LastResultPath) | ConvertFrom-Json
        @($result.PSObject.Properties.Name) | Should -Be @('version', 'outcome', 'errorCode', 'at')
        $result.version | Should -Be '1.3.1'
        $result.outcome | Should -Be 'rolled_back'
        $result.errorCode | Should -Be 'service_not_running'
        $result.at | Should -Not -BeNullOrEmpty
        Test-Path -LiteralPath "$LastResultPath.tmp" | Should -BeFalse

        Write-UpdateResult -Outcome 'installed'
        $installed = [IO.File]::ReadAllText($LastResultPath) | ConvertFrom-Json
        $installed.outcome | Should -Be 'installed'
        $installed.errorCode | Should -BeNullOrEmpty
    }

    It 'ships in the package next to install-agent.ps1' {
        $windowsWorkflow | Should -Match ([regex]::Escape("'collector\scripts\update-agent.ps1',"))
    }

    It 'is removed by the uninstaller, before the service' {
        $unregisterAt = $uninstallText.IndexOf('Unregister-ScheduledTask -TaskName $UpdateTaskName')
        $unregisterAt | Should -BeGreaterThan -1
        $unregisterAt | Should -BeLessThan $uninstallText.IndexOf('Stop-Service -Name $ServiceName')
        $uninstallText | Should -Match ([regex]::Escape("`$UpdateTaskName = 'Vincere Auto Export update'"))
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
        @{ Name = 'update-agent.ps1' }
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
