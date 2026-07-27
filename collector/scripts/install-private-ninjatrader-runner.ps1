[CmdletBinding()]
param(
    [string]$RunnerDirectory = 'C:\actions-runner-vincere',
    [string]$RunnerName = $env:COMPUTERNAME,
    [string]$CheckoutPath = (Get-Location).Path,
    [switch]$PlanOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:PrivateRepositoryUrl = 'https://github.com/pedro-cmyks/CAM-CRM-Vincere-collector-build'
$script:RunnerVersion = '2.336.0'
$script:RunnerArchiveUri = "https://github.com/actions/runner/releases/download/v$($script:RunnerVersion)/actions-runner-win-x64-$($script:RunnerVersion).zip"
$script:RunnerArchiveSha256 = 'd59123a43003e357b0805b5d0f611d0bd2f65ab67d51bd070dd4e7a0f685c162'
$script:RunnerLabels = @('ninjatrader8')

function Test-ControlledPathWithin {
    param(
        [Parameter(Mandatory)][string]$Candidate,
        [Parameter(Mandatory)][string]$Parent
    )

    $separator = [IO.Path]::DirectorySeparatorChar
    $candidatePath = [IO.Path]::GetFullPath($Candidate).TrimEnd($separator)
    $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd($separator)
    return $candidatePath.Equals($parentPath, [StringComparison]::OrdinalIgnoreCase) -or
        $candidatePath.StartsWith($parentPath + $separator, [StringComparison]::OrdinalIgnoreCase)
}

function New-PrivateNinjaTraderRunnerPlan {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$RunnerDirectory,
        [Parameter(Mandatory)][string]$RunnerName
    )

    if ([string]::IsNullOrWhiteSpace($RunnerName)) {
        throw 'runner_name_required'
    }

    return [pscustomobject][ordered]@{
        RepositoryUrl = $script:PrivateRepositoryUrl
        RunnerDirectory = [IO.Path]::GetFullPath($RunnerDirectory)
        RunnerName = $RunnerName.Trim()
        Labels = @($script:RunnerLabels)
        RunAsService = $true
        RunnerVersion = $script:RunnerVersion
        ArchiveUri = $script:RunnerArchiveUri
        ArchiveSha256 = $script:RunnerArchiveSha256
        ProprietaryBuildEnabled = $false
    }
}

function Assert-PrivateNinjaTraderRunnerDirectory {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$RunnerDirectory,
        [Parameter(Mandatory)][string]$CheckoutPath
    )

    $resolvedRunnerDirectory = [IO.Path]::GetFullPath($RunnerDirectory)
    $resolvedCheckout = [IO.Path]::GetFullPath($CheckoutPath)
    if (Test-ControlledPathWithin -Candidate $resolvedRunnerDirectory -Parent $resolvedCheckout) {
        throw 'runner_directory_inside_checkout'
    }

    if (-not (Test-Path -LiteralPath $resolvedRunnerDirectory)) {
        return
    }
    if (-not (Test-Path -LiteralPath $resolvedRunnerDirectory -PathType Container)) {
        throw 'runner_directory_not_empty'
    }
    if (Test-Path -LiteralPath (Join-Path $resolvedRunnerDirectory '.runner') -PathType Leaf) {
        throw 'runner_already_registered'
    }
    if (@(Get-ChildItem -LiteralPath $resolvedRunnerDirectory -Force).Count -gt 0) {
        throw 'runner_directory_not_empty'
    }
}

function Assert-RunnerArchiveIntegrity {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ArchivePath,
        [Parameter(Mandatory)][string]$ExpectedSha256
    )

    if (-not (Test-Path -LiteralPath $ArchivePath -PathType Leaf)) {
        throw 'runner_archive_missing'
    }
    $actual = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash
    if (-not $actual.Equals($ExpectedSha256, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'runner_archive_hash_mismatch'
    }
}

function Assert-WindowsAdministrator {
    if ($env:OS -ne 'Windows_NT') {
        throw 'runner_windows_required'
    }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'runner_administrator_required'
    }
}

function Invoke-PrivateNinjaTraderRunnerConfiguration {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$RunnerDirectory,
        [Parameter(Mandatory)][string]$RunnerName,
        [Parameter(Mandatory)][Security.SecureString]$RegistrationToken
    )

    $configPath = Join-Path ([IO.Path]::GetFullPath($RunnerDirectory)) 'config.cmd'
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        throw 'runner_config_missing'
    }

    $tokenVariable = 'ACTIONS_RUNNER_INPUT_TOKEN'
    $previousToken = [Environment]::GetEnvironmentVariable($tokenVariable, 'Process')
    $tokenPointer = [IntPtr]::Zero
    $tokenText = $null
    Push-Location -LiteralPath $RunnerDirectory
    try {
        $tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($RegistrationToken)
        $tokenText = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
        [Environment]::SetEnvironmentVariable($tokenVariable, $tokenText, 'Process')

        & $configPath --unattended `
            --url $script:PrivateRepositoryUrl `
            --name $RunnerName.Trim() `
            --labels ($script:RunnerLabels -join ',') `
            --work '_work' `
            --runasservice
        if ($LASTEXITCODE -ne 0) {
            throw 'runner_configuration_failed'
        }
    }
    finally {
        [Environment]::SetEnvironmentVariable($tokenVariable, $previousToken, 'Process')
        $tokenText = $null
        if ($tokenPointer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
        }
        Pop-Location
    }
}

function Install-PrivateNinjaTraderRunner {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$RunnerDirectory,
        [Parameter(Mandatory)][string]$RunnerName,
        [Parameter(Mandatory)][string]$CheckoutPath,
        [Parameter(Mandatory)][Security.SecureString]$RegistrationToken
    )

    Assert-WindowsAdministrator
    Assert-PrivateNinjaTraderRunnerDirectory `
        -RunnerDirectory $RunnerDirectory `
        -CheckoutPath $CheckoutPath

    $plan = New-PrivateNinjaTraderRunnerPlan `
        -RunnerDirectory $RunnerDirectory `
        -RunnerName $RunnerName
    $archivePath = Join-Path ([IO.Path]::GetTempPath()) "actions-runner-win-x64-$($plan.RunnerVersion)-$([guid]::NewGuid().ToString('N')).zip"
    try {
        Invoke-WebRequest -Uri $plan.ArchiveUri -OutFile $archivePath -UseBasicParsing
        Assert-RunnerArchiveIntegrity `
            -ArchivePath $archivePath `
            -ExpectedSha256 $plan.ArchiveSha256
        New-Item -ItemType Directory -Path $plan.RunnerDirectory -Force | Out-Null
        Expand-Archive -LiteralPath $archivePath -DestinationPath $plan.RunnerDirectory
        Invoke-PrivateNinjaTraderRunnerConfiguration `
            -RunnerDirectory $plan.RunnerDirectory `
            -RunnerName $plan.RunnerName `
            -RegistrationToken $RegistrationToken
    }
    finally {
        if (Test-Path -LiteralPath $archivePath -PathType Leaf) {
            Remove-Item -LiteralPath $archivePath -Force
        }
    }

    return [pscustomobject][ordered]@{
        installed = $true
        code = 'runner_registered_private'
        repository = $plan.RepositoryUrl
        runnerName = $plan.RunnerName
        labels = $plan.Labels
        proprietaryBuildEnabled = $false
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    $plan = New-PrivateNinjaTraderRunnerPlan `
        -RunnerDirectory $RunnerDirectory `
        -RunnerName $RunnerName
    if ($PlanOnly) {
        return $plan
    }

    Write-Host 'This installs a CAM build runner for the private validation repository.'
    Write-Host 'The proprietary NinjaTrader build gate will remain disabled.'
    $registrationToken = Read-Host 'Paste the short-lived GitHub runner registration token' -AsSecureString
    Install-PrivateNinjaTraderRunner `
        -RunnerDirectory $plan.RunnerDirectory `
        -RunnerName $plan.RunnerName `
        -CheckoutPath $CheckoutPath `
        -RegistrationToken $registrationToken
}
