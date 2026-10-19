# Installing the collector on a client machine

The agent is installed with a PowerShell script. The CRM hands out the exact
command: **Auto Collection → the client → step 1**, with a copy button.

## What the install does

`collector/scripts/install-agent.ps1`:

1. Copies NinjaTrader's `db\NinjaTrader.sqlite*`, `workspaces\` and
   `templates\Strategy\` into `C:\ProgramData\Vincere\AutoExport\backups\<date-time>`
   before touching anything, keeping the last three. This runs first, so a
   failed backup stops the install with the machine untouched.
2. Copies the self-contained agent to `C:\Program Files\Vincere\Auto Export`.
   The build is `win-x64` self-contained, so the machine needs no .NET runtime.
3. Creates `C:\ProgramData\Vincere\AutoExport`, restricted to LocalSystem and
   Administrators — it holds the device pairing token.
4. Deploys the NinjaTrader AddOn to `Documents\NinjaTrader 8\bin\Custom\AddOns`
   when the package carries one.
5. Registers the `Vincere Auto Export` service as LocalSystem, delayed auto
   start, restarting three times on failure.
6. Starts the service.
7. Registers the `Vincere Auto Export watchdog` scheduled task, which runs as
   SYSTEM five minutes after boot and every 15 minutes and starts the service
   if it is stopped. Windows gives a service 30 seconds to start and does not
   try again when it misses them, which is what left 34 machines silent after
   the reboot of 2026-10-18. To keep the agent off on purpose, set the service
   to Disabled; a service that is only stopped is started again.
8. Opens the pairing window.

`uninstall-agent.ps1` reverses it, including the `Vincere Auto Export update`
task an update from the CRM leaves behind if it is interrupted. The data folder
is kept by default so a re-install stays paired; `-RemoveData` forces a fresh
pairing.

## Running it

On the client's VPS, from an **elevated** PowerShell, with **NinjaTrader
closed**, paste the command from the CRM. It downloads the package and runs the
installer in one step.

To install from a package already on the machine:

```powershell
.\install-agent.ps1 -PackagePath C:\Users\me\Downloads\vincere-agent
```

Then paste the pairing code from the CRM into the window that opens.

Updating the agent later, leaving NinjaTrader alone:

```powershell
.\install-agent.ps1 -PackagePath <new package> -SkipAddOn
```

## Updating from the CRM

From agent 1.3.0 on, a machine can be updated without anyone opening the VPS.

**What the Manager does.** Presses **Update** for the machine in the CRM. The
CRM records the version to install; nothing else is sent to the machine.

**What the machine does.** Every five minutes the agent asks the CRM whether an
update is waiting and reports how the last one went. When one is:

1. It checks the request. The version must be newer than the one running, and
   the manifest address must be this repository's own GitHub release for that
   version (`agent-v<version>/release-manifest.json`). Anything else is refused.
2. It downloads the release manifest and checks it against the SHA-256 the CRM
   pinned, then downloads `Vincere-AutoExport-Agent.zip` and checks its size and
   SHA-256 against the manifest. It needs three times the package size free on
   the ProgramData drive and refuses otherwise.
3. It extracts the package to
   `C:\ProgramData\Vincere\AutoExport\updates\<version>\package` and reports
   **staged**.
4. It waits until it is **outside 15:45 to 17:45 New York time on a weekday**
   (the daily capture and upload) and until nothing is uploading. Weekends are
   always allowed.
5. It reports **applying** and starts the `Vincere Auto Export update` scheduled
   task, which runs `update-agent.ps1` as SYSTEM. The script copies
   `C:\Program Files\Vincere\Auto Export` to `updates\rollback`, runs the package's
   `install-agent.ps1 -SkipAddOn -SkipBackup -NoPairing`, and checks that the
   service is running the new version within two minutes. If not, it puts the
   backup back, re-creates and starts the service, and re-registers the watchdog.
   The service is stopped for a minute or two either way, and an open Setup
   window is closed.

A machine tries at most three times per press of Update; a failed download
counts as a try, and tries are at least 45 minutes apart once an install has
started. A failure that would only repeat (`package_invalid`, `manifest_invalid`,
`version_mismatch`, `addon_update_required`) ends the tries at once. Pressing
Update again starts a new count. Each failure is reported to the CRM as
**failed** with a code, for example `disk_space`, `package_hash_mismatch`,
`install_failed` or `service_not_running`.

**The NinjaTrader AddOn is never updated this way.** The update runs with
`-SkipAddOn`, so NinjaTrader, its Documents folder, the AddOn and the strategies
are not touched and NinjaTrader can stay open. A release that needs a newer AddOn
says so in its manifest (`minimumAddonVersion`), and a machine whose AddOn is
older, or has not reported one yet, refuses it with `addon_update_required`.
Update the AddOn by hand with the full installer first.

**Where to look on the machine.**

- the script's log: `C:\ProgramData\Vincere\AutoExport\logs\update-<version>-<time>.log`
- the outcome of the last install: `C:\ProgramData\Vincere\AutoExport\updates\last-result.json`
  (`installed` or `rolled_back`, with the error code)
- what the agent reports to the CRM: `C:\ProgramData\Vincere\AutoExport\updates\state.json`

**To stop it.** Set the `Vincere Auto Export` service to Disabled (a disabled
agent asks for nothing and the watchdog leaves it alone), or uninstall it with
`uninstall-agent.ps1`, which also removes the update task. Both stop the agent
altogether, captures included; the machine has no switch that turns off only
updates. A machine nobody presses Update for is never updated.

## The backup, and getting a strategy set back

On 2026-09-28 two machines came out of an update with an empty Strategies table
and an emptied workspace, and the desk had nothing to restore from. Every
install now copies the database, the workspaces and the strategy templates
aside first.

To put them back: close NinjaTrader, then copy the files from the newest folder
under `C:\ProgramData\Vincere\AutoExport\backups` back over
`Documents\NinjaTrader 8`. NinjaTrader must be closed for the database, or it
overwrites what you restore on the way out.

`-SkipBackup` skips the copy. Only for a machine whose database is too large to
copy in the time available, and it costs you the restore.

## If Windows blocks the script

The package is not code-signed, so a downloaded `.ps1` may be blocked. Either
unblock it:

```powershell
Unblock-File .\install-agent.ps1
```

or run it for that one process:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-agent.ps1 -PackagePath <path>
```

The download itself is still verified: the CRM pins the release manifest by
SHA-256, and the manifest carries the package's own SHA-256.

## The NinjaTrader AddOn

The AddOn is not in the CI-built package — CI only ever authors it against a
disposable payload, so the real one is deployed from a NinjaTrader-licensed
machine. `install-agent.ps1` warns and continues when it is absent, so the
service can be installed and paired first; NinjaTrader capture starts once the
AddOn is in place.

## Before rolling out to every machine

Install on **one** VPS first and confirm:

- the service is running — `Get-Service 'Vincere Auto Export'`
- the watchdog is registered — `Get-ScheduledTask 'Vincere Auto Export watchdog'`
- the machine appears under **Auto Collection** in the CRM after pairing
- the next scheduled capture lands as that client's daily close, and its four
  sections match what a manual upload produces for the same day
