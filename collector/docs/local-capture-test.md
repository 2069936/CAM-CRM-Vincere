# Testing the capture on a VPS, without the CRM

Verifies that the AddOn reads NinjaTrader correctly, before any pairing, service
or CRM connection exists. It writes the snapshot to a file and sends nothing.

## What you need

A machine with **NinjaTrader 8 installed** and the **.NET SDK 8**
(free: https://dotnet.microsoft.com/download), plus a checkout of this
repository. No agent, no service, no pairing code, no CRM.

The AddOn compiles against NinjaTrader's own assemblies, so it can only be built
where NinjaTrader is installed. That is why CI cannot produce it and why the
agent package ships without it.

## The short way — one command

On the VPS, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/pedro-cmyks/CAM-CRM-Vincere/dev/natanel/collector/scripts/bootstrap-local-test.ps1 | iex
```

That installs the .NET SDK if the machine lacks it, downloads this repository,
builds the AddOn against the local NinjaTrader install, and installs it. Close
NinjaTrader before running it.

It fetches from the public repository, so anyone can read exactly what it runs at
the URL above before running it.

Then continue from step 3 below.

## The long way — step by step

1. **Close NinjaTrader.**

2. **Build and install the AddOn** from PowerShell, in a checkout of this repo:

   ```powershell
   cd <repo>\collector\scripts
   .\build-addon-local.ps1
   ```

   If NinjaTrader is not in the default location, pass `-NinjaTraderHome "<path>"`
   — the folder holding `bin\NinjaTrader.Core.dll`.

3. **Open NinjaTrader** and wait for the accounts to connect and populate — the
   capture reads what NinjaTrader has loaded at that moment.

4. In the Control Center: **New → "Vincere: Export Snapshot to File (local test)"**.

5. A box reports where it saved and how many rows it found per section:

   ```
   Saved to: C:\Users\<user>\Documents\VincereAutoExport\snapshot-2026-07-27-163045.json

   Accounts: 19
   Strategies: 7
   Orders: 42
   Executions: 15

   Nothing was sent to the CRM.
   ```

6. **Send that JSON file back** for review.

## What to check in the file

- **Every account appears**, with its real balance in `cashValue`.
- **`accountValues`** on each account — every metric NinjaTrader reports for it,
  by name. This is where anything not named explicitly ends up.
- **`extraValues`** on each strategy, order and execution — same idea: every
  other readable property, captured by name.
- **`parameterCaptureStatus`** on each strategy: `captured` means every parameter
  was read; `partial` means at least one could not be (a strategy backed by a
  proprietary indicator can refuse to hand over a property). `partial` is not a
  failure — the strategy is still captured, with the unreadable parameters null.

## Two values that will be null, by design

`trailingMaxDrawdown` and `weeklyPnl` are **not exposed by NinjaTrader's public
API**. Its documented `AccountItem` enum has 25 values and neither is among them;
they exist only as columns in the Accounts grid. Any export that reads them is
reading the screen, not the API.

This is a real difference from a manual CSV upload, which does carry both, and
the CRM uses `trailingMaxDrawdown` for its drawdown flags. Worth deciding on
before rollout — it is a product question, not something more code solves.

## What this does NOT test

Uploading, pairing, scheduling, retries, or anything the CRM does with the data.
It only answers whether the AddOn reads NinjaTrader correctly — which is the part
that has never run against a real installation.
