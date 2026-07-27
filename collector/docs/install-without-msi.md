# Installing the collector with a script instead of the MSI

The agent can be installed two ways. Both end in the same place: the
`Vincere Auto Export` Windows service running, the NinjaTrader AddOn deployed,
and the machine paired to a client.

| | Signed MSI | PowerShell script |
|---|---|---|
| Needs a code-signing certificate | Yes (~$200-400/yr) | No |
| Windows SmartScreen warning | None once signed | Bypassed by running the script in an already-open admin PowerShell |
| Distribution | Host the .msi, register the URL in the CRM | Host the agent .zip, paste one command |
| Familiar to the team | New | Matches how the company already deploys |

The script route removes the certificate from the critical path, so machines can
be onboarded before any signing is bought.

## What the script does

`collector/scripts/install-agent.ps1` performs exactly the MSI's actions:

1. Copies the self-contained agent to `C:\Program Files\Vincere\Auto Export`.
   The publish is `win-x64` self-contained, so the machine needs no .NET runtime.
2. Creates `C:\ProgramData\Vincere\AutoExport` and restricts it to LocalSystem
   and Administrators (it holds the device pairing token).
3. Deploys the NinjaTrader AddOn to `Documents\NinjaTrader 8\bin\Custom\AddOns`.
4. Registers the `Vincere Auto Export` service as LocalSystem, delayed auto
   start, restarting three times on failure — the same policy as the MSI.
5. Starts the service and opens the setup window to paste the pairing code.

`collector/scripts/uninstall-agent.ps1` reverses it. The data folder is kept by
default so a re-install stays paired; `-RemoveData` forces a fresh pairing.

## Running it

From an **elevated** PowerShell, with **NinjaTrader closed**:

```powershell
# From a package already on the machine
.\install-agent.ps1 -PackagePath C:\Users\me\Downloads\vincere-agent

# Or download it in the same step
.\install-agent.ps1 -PackageUrl https://<host>/vincere-agent-1.0.0.zip
```

Then paste the pairing code from the CRM (**Auto Collection → the client →
generate code**) into the setup window that opens.

Updating the agent later, leaving NinjaTrader alone:

```powershell
.\install-agent.ps1 -PackagePath <new package> -SkipAddOn
```

## Execution policy

A downloaded `.ps1` may be blocked. Either unblock the file:

```powershell
Unblock-File .\install-agent.ps1
```

or run it for that one process only:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-agent.ps1 -PackagePath <path>
```

## What still has to be hosted

The script needs the agent **package** (a .zip containing `Agent\`, `Setup\` and
`AddOn\`), produced by `collector/scripts/build-installer.ps1` / CI. That zip has
to live somewhere the machines can reach. That is the only remaining hosting
step — no certificate, no MSI.

## Before rolling out to every machine

Install on **one** VPS first and confirm:

- the service shows as Running (`Get-Service 'Vincere Auto Export'`),
- the machine appears under **Auto Collection** in the CRM after pairing,
- the next scheduled capture lands as that client's daily close, and its four
  sections match what a manual upload produces for the same day.
