# Vincere Auto Export collector

This folder contains the versioned contract, NinjaTrader AddOn, Windows Service,
guided WPF setup application, installer, and their tests. The production design
does not use pixels, mouse automation, OCR, filenames, IP addresses, or shared
CRM credentials to identify a client.

## Build boundaries

- `Vincere.AutoExport.Contracts` targets `netstandard2.0` so NinjaTrader and the
  service share one wire contract.
- `Vincere.AutoExport.NinjaTrader.Core` targets `netstandard2.0` and owns the
  testable four-section mapper, safe strategy-parameter reader, capture request
  concurrency/timeout rules, and bounded wire framing. It has no NinjaTrader UI
  or proprietary assembly dependency.
- Pure agent tests target `net8.0` and run on every developer/CI platform.
- The service and UI target self-contained `net8.0-windows` / `win-x64`.
- The AddOn targets `net48`. Set `NINJATRADER_HOME` to a legitimate local
  NinjaTrader 8 installation; proprietary assemblies are never committed.

The SDK and package versions are pinned. Restore once to generate/update the
reviewed `packages.lock.json` files, then CI uses locked mode.

```powershell
dotnet restore collector\Vincere.AutoExport.sln --locked-mode
dotnet test collector\tests\Vincere.AutoExport.Contracts.Tests -c Release --no-restore
dotnet test collector\tests\Vincere.AutoExport.NinjaTrader.Core.Tests -c Release --no-restore
dotnet test collector\tests\Vincere.AutoExport.Agent.Tests -c Release --no-restore
```

The supported-API parity gate and its manual VPS instructions live in
[`probe/README.md`](probe/README.md). Do not treat the production AddOn as ready
until that comparison has been reviewed.

Production AddOn work is activated in CI only when the supported-API facade,
capture-pipe server, and NinjaTrader AddOn entry point all exist. A partial
source file cannot produce a verified/packageable AddOn. The portable test
assembly compiles the exact facade source against narrow API substitutes so its
four-section mapping is exercised on normal CI; the controlled `ninjatrader8`
runner remains authoritative for compilation against legitimate NinjaTrader
assemblies and live parity.

## Machine configuration boundary

All machine-owned state derives from `%ProgramData%\Vincere\AutoExport`. The
nonsecret `config.json` is written with flush-and-rename semantics and retains
one validated last-known-good backup. The device credential is stored only in
`secret.bin`, protected with DPAPI `LocalMachine` scope and fixed application
entropy; it has no plaintext backup and is never accepted by diagnostic state
serializers. The root ACL is replaced with explicit Full Control entries for
SYSTEM and the local Administrators group before either file is accessed.

Cross-platform tests verify atomic recovery, secret-store sequencing, machine
ID normalization/hash behavior, and redaction. Real DPAPI, registry, owner/ACL,
and elevated/non-elevated access checks remain required on the Windows system
runner before release.

## Quarantine review

A capture the CRM refuses leaves the queue for `queue\quarantine` with a
`.reason` file beside it. Since 1.0.7 that folder is reviewed once a trading
day (the days in `enabledTradingDays`), at `quarantineReviewTime` in
`config.json` (New York, default `12:00`), and on demand from the Setup
window's Retry quarantine now button. A capture refused with a 422
(`snapshot_processing_failed`, `unsupported_schema_version`) is sent back to
pending, up to three times, because a fix on the CRM side makes the same bytes
acceptable. The CRM of today keeps the refused snapshot as a failed close and
answers the resend 409 `capture_requires_replay` until the desk replays that
close from Auto Collection; a capture holding that code is sent again at every
review, without a cap, because the resend after the replay is what clears it
from the folder (the CRM answers duplicate and the queue completes it). Every
other code is final and waits for the desk. The reason file carries the
attempt count and history and stays behind when the payload leaves, so a
capture that bounces keeps its count. After each review the service offers
the inventory to `POST /api/ingest/quarantine`; a CRM without that endpoint
answers 404, which is logged once at INFO and tried again the next day.
Nothing about the quarantine ever rides on the heartbeat.

## Strategy attribution

NinjaTrader names no strategy on an order or an execution, so until 1.0.8 every
order and every fill the automatic path sent carried an empty `strategyId` and
`strategyName`. Measured from 2026-09-01 that was 5,824 of 5,943 executions
(98%), against 18% on the manual CSV path, which reads the grid export where
the column is populated. An account day that arrives with neither a strategy
grid nor a name on its fills cannot be attributed by anything the CRM does
later, which is why 45.9% of the funded account days in the Stack Playbook's
window were unattributable.

The link is read in the direction the platform exposes it. Each account's
strategy list is copied once per capture under the lock the strategies section
already takes, and the orders and fills each one lists become a lookup from
order id and execution id to that strategy (`StrategyAttributionMap` in
`Vincere.AutoExport.NinjaTrader.Core`, covered by the Core tests). The orders
and executions sections then consult it, and a fill the strategy does not list
resolves through the order it filled.

It adds attribution and never invents it. An id nobody claims, an id two
strategies disagree about, and a blank id all stay null, exactly as they were
before, because a wrong strategy name moves a day's losses onto an algorithm
that never traded them and nothing downstream could tell that it had happened.

## Windows packaging boundary

The operator receives one setup executable, but it chains two ownership
domains: a per-machine MSI for the LocalSystem service and guided setup UI, and
a per-machine MSI that owns the AddOn under one selected user's NinjaTrader
Documents tree. Runtime data under `%ProgramData%\Vincere\AutoExport` is
retained by default during uninstall so unsent captures are not destroyed.

Burn resolves `PersonalFolder` in the interactive Windows session before UAC
elevation, verifies that the selected Documents folder contains
`NinjaTrader 8`, persists that single path for repair/upgrade, and passes it
explicitly into the AddOn MSI. It never writes the AddOn into every Windows
profile. If setup is launched from the wrong profile, it stops before either
MSI runs and asks the operator to sign in to the Windows profile that runs
NinjaTrader. An administrator may override the persisted
`NinjaTraderDocuments` Burn variable only for controlled multi-profile
recovery; the same directory-existence gate still applies.

Production packaging fails unless the AddOn DLL and its three runtime
dependencies (`NinjaTrader.Core`, `Contracts`, and `Newtonsoft.Json`) have a
matching verification receipt proving all four `SnapshotV1` sections passed
the supported-API parity gate. The installer validates and ships that exact
four-file payload into NinjaTrader's supported compiled-assembly discovery
folder, `Documents\NinjaTrader 8\bin\Custom`. The source-only probe remains in
`bin\Custom\AddOns`; probe and UI-automation experiments are never accepted as
installer inputs. For signed releases, the ownership manifest is generated
after Authenticode signing so its SHA-256 values describe the exact bytes placed
inside the MSIs.

On a controlled Windows runner:

```powershell
collector\scripts\build-installer.ps1 `
  -Version 1.0.0 `
  -AddOnSource C:\verified\Vincere.AutoExport.NinjaTrader.dll `
  -AddOnVerificationPath C:\verified\addon-verification.json `
  -ProductionSign
```

The release workflow verifies every Authenticode signature, creates SHA-256
release metadata, and emits a detached CMS signature for the manifest. WiX and
the WPF application still require the Windows system gate before any release is
offered in the CRM.
