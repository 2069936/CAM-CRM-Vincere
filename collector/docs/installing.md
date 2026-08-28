# Installing the collector on a client machine

The agent is installed with a PowerShell script. The CRM hands out the exact
command: **Auto Collection → the client → step 1**, with a copy button.

## What the install does

`collector/scripts/install-agent.ps1`:

1. Copies the self-contained agent to `C:\Program Files\Vincere\Auto Export`.
   The build is `win-x64` self-contained, so the machine needs no .NET runtime.
2. Creates `C:\ProgramData\Vincere\AutoExport`, restricted to LocalSystem and
   Administrators — it holds the device pairing token.
3. Deploys the NinjaTrader AddOn to `Documents\NinjaTrader 8\bin\Custom`
   when the package carries one.
4. Registers the `Vincere Auto Export` service as LocalSystem, delayed auto
   start, restarting three times on failure.
5. Starts the service and opens the pairing window.

`uninstall-agent.ps1` reverses it. The data folder is kept by default so a
re-install stays paired; `-RemoveData` forces a fresh pairing.

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

The published release contains an `AddOn` folder with four DLLs compiled on a
machine that has NinjaTrader 8. The installer copies them to `bin\Custom`; it
does not install an SDK or compile source on a client's machine. A package
without `AddOn` is a CI base artifact, not a production release.

## Before rolling out to every machine

Install on **one** VPS first and confirm:

- the service is running — `Get-Service 'Vincere Auto Export'`
- the machine appears under **Auto Collection** in the CRM after pairing
- the next scheduled capture lands as that client's daily close, and its four
  sections match what a manual upload produces for the same day
