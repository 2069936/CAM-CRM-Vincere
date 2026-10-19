<#
.SYNOPSIS
    Installs a staged Vincere Auto Export agent and puts the old one back if the
    new one does not come up.

.DESCRIPTION
    Run by the "Vincere Auto Export update" scheduled task, as SYSTEM, when a
    Manager presses Update in the CRM. The agent downloads and verifies the
    package, extracts it under ProgramData\Vincere\AutoExport\updates\<version>,
    and starts this task outside the 15:45 to 17:45 New York window. Not meant to
    be run by hand.

    1. Copies the install root (Program Files\Vincere\Auto Export) to
       ProgramData\Vincere\AutoExport\updates\rollback, replacing the last copy.
    2. Runs the package's install-agent.ps1 with -SkipAddOn -SkipBackup -NoPairing.
       -SkipAddOn leaves NinjaTrader, its Documents folder, the AddOn and the
       client's strategies alone, and does not need NinjaTrader closed.
    3. Checks the service is Running within 120 seconds, still Running a little
       later, and that the installed agent is the version that was asked for.
    4. On any failure, stops the service, copies the backup back, re-creates the
       service if it is gone, starts it, and re-registers the watchdog.
    5. Writes updates\last-result.json, which the agent reports to the CRM, and
       removes its own scheduled task.

    Everything is logged to ProgramData\Vincere\AutoExport\logs\update-<version>-<time>.log.

    Nothing of NinjaTrader's is opened, stopped, read or written by this script:
    not the program, not its Documents folder, not the AddOn, not the strategies.

.PARAMETER PackagePath
    The extracted package folder under ProgramData\Vincere\AutoExport\updates.

.PARAMETER ExpectedVersion
    The version the package must install, x.y.z.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PackagePath,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedVersion
)

$ErrorActionPreference = 'Stop'

$ServiceName = 'Vincere Auto Export'
$WatchdogTaskName = 'Vincere Auto Export watchdog'
$UpdateTaskName = 'Vincere Auto Export update'
$InstallRoot = Join-Path ${env:ProgramFiles} 'Vincere\Auto Export'
$DataRoot = Join-Path ${env:ProgramData} 'Vincere\AutoExport'
$UpdatesRoot = Join-Path $DataRoot 'updates'
$RollbackRoot = Join-Path $UpdatesRoot 'rollback'
$LastResultPath = Join-Path $UpdatesRoot 'last-result.json'
$LogRoot = Join-Path $DataRoot 'logs'
$AgentExeRelative = 'Agent\Vincere.AutoExport.Agent.exe'

function Write-Step { param([string]$Text) Write-Host "==> $Text" }
function Write-Ok { param([string]$Text) Write-Host "    $Text" }

# --- the result the agent reads -----------------------------------------------

# Written to a temporary file and moved into place, so the agent never reads half
# a file. UTF-8 without a byte order mark, built by hand rather than with
# Set-Content, which adds one on Windows PowerShell 5.1.
function Write-UpdateResult {
    param(
        [Parameter(Mandatory = $true)][string]$Outcome,
        [string]$ErrorCode
    )
    $result = [ordered]@{
        version   = $ExpectedVersion
        outcome   = $Outcome
        errorCode = $ErrorCode
        at        = [DateTime]::UtcNow.ToString('o')
    }
    if (-not $ErrorCode) { $result.errorCode = $null }
    $json = $result | ConvertTo-Json
    New-Item -ItemType Directory -Path $UpdatesRoot -Force | Out-Null
    $temporary = "$LastResultPath.tmp"
    [IO.File]::WriteAllText($temporary, $json, (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporary -Destination $LastResultPath -Force
    Write-Ok "Result recorded: $Outcome $ErrorCode"
}

# --- the service -----------------------------------------------------------------

function Wait-AgentServiceRunning {
    param([int]$TimeoutSeconds)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($service -and $service.Status -eq 'Running') { return $true }
        Start-Sleep -Seconds 3
    }
    return $false
}

function Test-AgentServiceStaysRunning {
    param([int]$Seconds)
    for ($elapsed = 0; $elapsed -lt $Seconds; $elapsed += 5) {
        Start-Sleep -Seconds 5
        $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if (-not $service -or $service.Status -ne 'Running') { return $false }
    }
    return $true
}

# ProductVersion is the informational version, "1.3.1+<commit>" from CI. It must
# BE the expected version, not merely start with its text: "1.3.10" starts with
# "1.3.1".
function Test-InstalledAgentVersion {
    $exe = Join-Path $InstallRoot $AgentExeRelative
    if (-not (Test-Path -LiteralPath $exe)) { return $false }
    $productVersion = (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion
    if (-not $productVersion) { return $false }
    $pattern = '^' + [regex]::Escape($ExpectedVersion) + '([+.-]|$)'
    Write-Ok "Installed agent reports $productVersion."
    return [bool]($productVersion -match $pattern)
}

function Stop-AgentService {
    $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if (-not $service -or $service.Status -eq 'Stopped') { return }
    Write-Step "Stopping the $ServiceName service"
    try {
        Stop-Service -Name $ServiceName -Force
        (Get-Service -Name $ServiceName).WaitForStatus('Stopped', '00:01:00')
    }
    catch {
        # Only this service's own process, found by the service's own record.
        $record = Get-CimInstance -ClassName Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
        if ($record -and $record.ProcessId) {
            Stop-Process -Id $record.ProcessId -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
        }
    }
}

# Exactly as install-agent.ps1 registers it: LocalSystem, delayed auto start, three
# restarts on failure, and the failure flag so the restarts also cover a service
# that stops itself with an error.
function Register-AgentService {
    $serviceBinary = Join-Path $InstallRoot $AgentExeRelative
    # A service deleted while something held a handle to it stays "marked for
    # deletion" for a few seconds, and New-Service fails until it is gone.
    for ($attempt = 1; ; $attempt++) {
        try {
            New-Service -Name $ServiceName `
                -BinaryPathName "`"$serviceBinary`"" `
                -DisplayName $ServiceName `
                -Description 'Collects NinjaTrader data for the Vincere CRM.' `
                -StartupType Automatic | Out-Null
            break
        }
        catch {
            if ($attempt -ge 6) { throw }
            Start-Sleep -Seconds 5
        }
    }
    & sc.exe config "$ServiceName" start= delayed-auto | Out-Null
    & sc.exe failure "$ServiceName" reset= 86400 actions= restart/15000/restart/15000/restart/15000 | Out-Null
    & sc.exe failureflag "$ServiceName" 1 | Out-Null
    Write-Ok 'Service registered (delayed auto start, restarts on failure).'
}

# --- the watchdog ------------------------------------------------------------------

# The watchdog's XML lives in install-agent.ps1 as New-AgentWatchdogTaskXml. It is
# lifted out of the package's copy by its syntax tree, the way the installer tests
# do it, and defined here on its own: running install-agent.ps1 again just to
# register a task would reinstall the agent.
function Register-AgentWatchdogIfMissing {
    if (Get-ScheduledTask -TaskName $WatchdogTaskName -ErrorAction SilentlyContinue) { return }
    try {
        $installScript = Join-Path $PackagePath 'install-agent.ps1'
        $tokens = $null
        $parseErrors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($installScript, [ref]$tokens, [ref]$parseErrors)
        $definition = $ast.Find({
            param($node)
            $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
                $node.Name -eq 'New-AgentWatchdogTaskXml'
        }, $true)
        if (-not $definition) { throw 'install-agent.ps1 does not define New-AgentWatchdogTaskXml.' }
        . ([scriptblock]::Create($definition.Extent.Text))
        $watchdogXml = New-AgentWatchdogTaskXml -ServiceName $ServiceName -StartBoundary (Get-Date)
        Register-ScheduledTask -TaskName $WatchdogTaskName -Xml $watchdogXml -Force | Out-Null
        Write-Ok 'Watchdog registered.'
    }
    catch {
        Write-Warning "The watchdog task could not be registered: $($_.Exception.Message)"
    }
}

# --- backup and restore ------------------------------------------------------------

# Everything in the install root except build\, which holds the .NET SDK the AddOn
# build fetched. The update never touches it and it is several hundred megabytes.
# Copied to a new folder first and swapped in only when complete, so a backup that
# fails half way never replaces a good one.
function Backup-InstallRoot {
    if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot $AgentExeRelative))) {
        throw "There is no installed agent at $InstallRoot to back up."
    }
    Write-Step "Backing up $InstallRoot"
    $staging = "$RollbackRoot.new"
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $InstallRoot -Force) {
        if ($item.Name -eq 'build') { continue }
        Copy-Item -LiteralPath $item.FullName -Destination $staging -Recurse -Force
    }
    if (-not (Test-Path -LiteralPath (Join-Path $staging $AgentExeRelative))) {
        throw 'The backup does not contain the agent.'
    }
    if (Test-Path -LiteralPath $RollbackRoot) { Remove-Item -LiteralPath $RollbackRoot -Recurse -Force }
    Move-Item -LiteralPath $staging -Destination $RollbackRoot
    Write-Ok "Backup at $RollbackRoot"
}

function Restore-AgentInstall {
    Write-Step 'Putting the previous agent back'

    # The watchdog would start the service again in the middle of the restore.
    if (Get-ScheduledTask -TaskName $WatchdogTaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $WatchdogTaskName -Confirm:$false
    }
    Stop-AgentService

    # The Setup window holds its own DLLs open. Ours, by name, and nothing else.
    Get-Process -Name 'Vincere.AutoExport.Agent.UI' -ErrorAction SilentlyContinue |
        Stop-Process -Force -ErrorAction SilentlyContinue

    New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $RollbackRoot -Force) {
        $target = Join-Path $InstallRoot $item.Name
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
        Copy-Item -LiteralPath $item.FullName -Destination $InstallRoot -Recurse -Force
    }
    Write-Ok 'Previous files restored.'

    if (-not (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) {
        Write-Step "Re-creating the $ServiceName service"
        Register-AgentService
    }

    Write-Step 'Starting the service'
    Start-Service -Name $ServiceName
    if (-not (Wait-AgentServiceRunning -TimeoutSeconds 120)) {
        throw 'The restored service did not reach Running.'
    }
    Write-Ok 'Service running.'

    Register-AgentWatchdogIfMissing
}

# --- run -----------------------------------------------------------------------------

$transcriptStarted = $false
try {
    New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null
    $safeVersion = $ExpectedVersion -replace '[^0-9.]', '_'
    $logPath = Join-Path $LogRoot ('update-{0}-{1}.log' -f $safeVersion, (Get-Date -Format 'yyyyMMddHHmmss'))
    Start-Transcript -Path $logPath -Force | Out-Null
    $transcriptStarted = $true
}
catch {
    Write-Warning "The update log could not be started: $($_.Exception.Message)"
}

$installed = $false
$changed = $false
$errorCode = 'package_invalid'
try {
    Write-Step "Updating the Vincere Auto Export agent to $ExpectedVersion"

    # Only a package the agent staged, and only the version it asked for.
    if ($ExpectedVersion -notmatch '^\d{1,5}\.\d{1,5}\.\d{1,5}$') {
        throw "Not a version: $ExpectedVersion"
    }
    $PackagePath = [IO.Path]::GetFullPath($PackagePath)
    $updatesPrefix = [IO.Path]::GetFullPath($UpdatesRoot).TrimEnd('\') + '\'
    if (-not $PackagePath.StartsWith($updatesPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "The package is not under $UpdatesRoot."
    }
    $installScript = Join-Path $PackagePath 'install-agent.ps1'
    foreach ($required in @($installScript, (Join-Path $PackagePath $AgentExeRelative))) {
        if (-not (Test-Path -LiteralPath $required)) { throw "The package is missing $required." }
    }

    $errorCode = 'backup_failed'
    Backup-InstallRoot

    # From here on the machine may have changed, so a failure restores.
    $errorCode = 'install_failed'
    $changed = $true
    Write-Step 'Running the installer from the package'
    & $installScript -PackagePath $PackagePath -SkipAddOn -SkipBackup -NoPairing

    $errorCode = 'service_not_running'
    if (-not (Wait-AgentServiceRunning -TimeoutSeconds 120)) {
        throw 'The service did not reach Running within 120 seconds.'
    }
    $errorCode = 'version_mismatch'
    if (-not (Test-InstalledAgentVersion)) {
        throw "The installed agent is not $ExpectedVersion."
    }
    # A service that starts and dies a few seconds later is the failure the
    # checks above would miss. Windows restarts a crashed service after 15
    # seconds, so a crash loop is Stopped for part of every 15: sampled every 5
    # seconds for 30, it cannot look Running throughout.
    $errorCode = 'service_not_running'
    if (-not (Test-AgentServiceStaysRunning -Seconds 30)) {
        throw 'The service stopped again after starting.'
    }

    $installed = $true
    $errorCode = $null
    Write-Ok "Agent $ExpectedVersion installed and running."
}
catch {
    Write-Warning "The update failed ($errorCode): $($_.Exception.Message)"
}

if ($installed) {
    # install-agent.ps1 registers it, but treats a failure there as a warning.
    Register-AgentWatchdogIfMissing
    try { Write-UpdateResult -Outcome 'installed' } catch { Write-Warning "The result could not be written: $($_.Exception.Message)" }
}
else {
    if ($changed) {
        try {
            Restore-AgentInstall
        }
        catch {
            Write-Warning "The previous agent could not be put back: $($_.Exception.Message)"
            $errorCode = 'rollback_failed'
            # Whatever state the files are in, a service that exists is started and
            # the watchdog is put back, so it keeps trying every 15 minutes.
            try {
                if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
                    Start-Service -Name $ServiceName -ErrorAction SilentlyContinue
                }
            }
            catch {
                Write-Warning "The service could not be started: $($_.Exception.Message)"
            }
            Register-AgentWatchdogIfMissing
        }
    }
    try { Write-UpdateResult -Outcome 'rolled_back' -ErrorCode $errorCode } catch { Write-Warning "The result could not be written: $($_.Exception.Message)" }
}

# Last, after the result is on disk: this is the task running this script.
try {
    if (Get-ScheduledTask -TaskName $UpdateTaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $UpdateTaskName -Confirm:$false
    }
}
catch {
    Write-Warning "The update task could not be removed: $($_.Exception.Message)"
}

if ($transcriptStarted) {
    try { Stop-Transcript | Out-Null } catch { }
}
