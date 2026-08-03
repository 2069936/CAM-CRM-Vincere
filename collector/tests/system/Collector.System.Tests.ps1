BeforeAll {
    if (-not $IsWindows) { throw 'Collector system tests require Windows.' }
    if ($env:VINCERE_SYSTEM_TEST -ne '1') { throw 'Set VINCERE_SYSTEM_TEST=1 only on the disposable controlled VPS.' }
    $serviceName = 'Vincere Auto Export'
    $dataRoot = Join-Path $env:ProgramData 'Vincere\AutoExport'
    $pipePath = '\\.\pipe\Vincere.AutoExport.Control.v1'

    function Invoke-CollectorControl {
        param(
            [Parameter(Mandatory)][string]$Command,
            [string]$EnrollmentCode,
            [string]$ScheduleTime,
            [bool]$Confirmed = $false
        )
        $pipe = [IO.Pipes.NamedPipeClientStream]::new('.', 'Vincere.AutoExport.Control.v1', [IO.Pipes.PipeDirection]::InOut)
        try {
            $pipe.Connect(5000)
            $requestId = [guid]::NewGuid()
            $body = [Text.Encoding]::UTF8.GetBytes((@{
                command = $Command
                requestId = $requestId
                enrollmentCode = $EnrollmentCode
                scheduleTime = $ScheduleTime
                confirmed = $Confirmed
            } | ConvertTo-Json -Compress))
            if ($body.Length -gt 65536) { throw 'Control request exceeded its contract limit.' }
            $length = [BitConverter]::GetBytes([int]$body.Length)
            $pipe.Write($length, 0, $length.Length)
            $pipe.Write($body, 0, $body.Length)
            $pipe.Flush()
            $lengthBytes = [byte[]]::new(4)
            $pipe.ReadExactly($lengthBytes, 0, $lengthBytes.Length)
            $responseLength = [BitConverter]::ToInt32($lengthBytes)
            if ($responseLength -le 0 -or $responseLength -gt 65536) { throw 'Control response length was invalid.' }
            $responseBytes = [byte[]]::new($responseLength)
            $pipe.ReadExactly($responseBytes, 0, $responseBytes.Length)
            $response = [Text.Encoding]::UTF8.GetString($responseBytes) | ConvertFrom-Json
            if ($response.requestId -ne $requestId) { throw 'Control response ID mismatch.' }
            return $response
        }
        finally {
            $pipe.Dispose()
        }
    }
}

Describe 'Signed installation and Windows service' {
    It 'has a validly signed production bundle when a bundle path is supplied' -Skip:(-not $env:VINCERE_SIGNED_SETUP_PATH) {
        (Get-AuthenticodeSignature -LiteralPath $env:VINCERE_SIGNED_SETUP_PATH).Status | Should -Be 'Valid'
    }

    It 'runs automatically as LocalSystem with delayed start and recovery actions' {
        $service = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
        $service | Should -Not -BeNullOrEmpty
        $service.StartName | Should -Be 'LocalSystem'
        $service.StartMode | Should -Be 'Auto'
        (Get-ItemProperty -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Services\$serviceName").DelayedAutoStart | Should -Be 1
        $failure = (sc.exe qfailure $serviceName | Out-String)
        $failure | Should -Match 'RESTART'
    }

    It 'starts, stops, and resumes without an interactive desktop dependency' {
        Stop-Service -Name $serviceName -Force
        (Get-Service -Name $serviceName).Status | Should -Be 'Stopped'
        Start-Service -Name $serviceName
        (Get-Service -Name $serviceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(20))
        (Get-Service -Name $serviceName).Status | Should -Be 'Running'
    }
}

Describe 'Local security boundaries' {
    It 'protects ProgramData state for SYSTEM and Administrators only' {
        $acl = Get-Acl -LiteralPath $dataRoot
        $unexpected = @($acl.Access | Where-Object {
            $_.AccessControlType -eq 'Allow' -and
            $_.IdentityReference.Value -notmatch '(?i)(SYSTEM|Administrators)$'
        })
        $unexpected | Should -BeNullOrEmpty
    }

    It 'protects the control pipe with the same administrator boundary' {
        $acl = Get-Acl -LiteralPath $pipePath
        $allowed = @($acl.Access | ForEach-Object IdentityReference | ForEach-Object Value)
        ($allowed -join ',') | Should -Match '(?i)SYSTEM'
        ($allowed -join ',') | Should -Match '(?i)Administrators'
        ($allowed -join ',') | Should -Not -Match '(?i)Everyone|Authenticated Users|Users$'
    }

    It 'does not write the enrollment code into config, logs, diagnostics, registry, or Event Log' -Skip:(-not $env:VINCERE_TEST_ENROLLMENT_CODE) {
        $needle = ($env:VINCERE_TEST_ENROLLMENT_CODE -replace '[\s-]', '')
        $files = @(Get-ChildItem -LiteralPath $dataRoot -File -Recurse -ErrorAction SilentlyContinue |
            Where-Object Name -ne 'secret.bin')
        $foundInFiles = @($files | Where-Object {
            ([IO.File]::ReadAllText($_.FullName) -replace '[\s-]', '').Contains($needle, [StringComparison]::OrdinalIgnoreCase)
        })
        $foundInFiles.Count | Should -Be 0
        $eventText = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'Vincere Auto Export' } -ErrorAction SilentlyContinue |
            ForEach-Object Message) -join "`n"
        $eventText.Contains($needle, [StringComparison]::OrdinalIgnoreCase) | Should -BeFalse
    }
}

Describe 'Collector behavior through the administrative pipe' {
    It 'returns bounded status without snapshot rows or credentials' {
        $response = Invoke-CollectorControl -Command status
        $response.ok | Should -BeTrue
        $json = $response | ConvertTo-Json -Depth 10 -Compress
        $json | Should -Not -Match '(?i)deviceToken|authorization|accounts|strategies|orders|executions'
    }

    It 'reports NinjaTrader unavailable without synthesizing a capture when NinjaTrader is closed' -Skip:([bool](Get-Process NinjaTrader -ErrorAction SilentlyContinue)) {
        $response = Invoke-CollectorControl -Command testCapture
        $response.ok | Should -BeFalse
        $response.code | Should -BeIn 'ninjatrader_not_running', 'addon_unavailable'
    }

    It 'pairs only when an explicit disposable enrollment code is supplied' -Skip:(-not $env:VINCERE_TEST_ENROLLMENT_CODE) {
        $response = Invoke-CollectorControl -Command pair -EnrollmentCode $env:VINCERE_TEST_ENROLLMENT_CODE
        $response.ok | Should -BeTrue
        $response.code | Should -Be 'paired'
        ($response | ConvertTo-Json -Depth 10) | Should -Not -Match '(?i)deviceToken|credential'
    }
}
