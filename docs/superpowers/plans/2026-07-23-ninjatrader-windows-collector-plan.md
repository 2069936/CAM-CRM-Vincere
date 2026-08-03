# NinjaTrader Windows Collector and Installer Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver a signed, guided Windows package that installs the NinjaTrader AddOn and resilient background agent, pairs with a one-time CRM code, captures on schedule, queues offline, uploads exactly once, and can be upgraded or removed safely.

**Architecture:** A .NET Framework 4.8 AddOn runs in NinjaTrader's interactive process and exposes capture through a per-machine named pipe whose ACL permits LocalSystem and the interactive NinjaTrader user. A .NET 8 Windows Service runs as LocalSystem, stores its device credential with DPAPI LocalMachine scope, schedules in America/New_York through NodaTime, persists atomic JSON queue files under ProgramData, and uploads over HTTPS. A small WPF UI communicates with the service over an administrator-authorized control pipe for pairing and diagnostics. A WiX Burn bundle installs all Vincere-owned components and supports signed upgrades/rollback.

**Tech Stack:** C#/.NET Framework 4.8, .NET 8 Windows Service and WPF, Newtonsoft.Json, NodaTime, xUnit, named pipes, DPAPI, WiX Toolset, PowerShell/Pester, GitHub Actions Windows/self-hosted runners.

---

## Runtime Paths and Identities

```text
AddOn DLL:
  %USERPROFILE%\Documents\NinjaTrader 8\bin\Custom\Vincere.AutoExport.NinjaTrader.dll

Service/UI binaries:
  %ProgramFiles%\Vincere\AutoExport\

Machine configuration and queue:
  %ProgramData%\Vincere\AutoExport\config.json
  %ProgramData%\Vincere\AutoExport\secret.bin
  %ProgramData%\Vincere\AutoExport\queue\pending\
  %ProgramData%\Vincere\AutoExport\queue\uploading\
  %ProgramData%\Vincere\AutoExport\queue\sent\
  %ProgramData%\Vincere\AutoExport\logs\

Capture pipe: Vincere.AutoExport.v1
Control pipe: Vincere.AutoExport.Control.v1
Service name: VincereAutoExport
```

`secret.bin` uses `ProtectedData.Protect(..., LocalMachine)`. Its directory ACL grants Full Control only to SYSTEM and Administrators. The AddOn never reads the secret. Capture-pipe ACL grants connect/read/write only to SYSTEM, Administrators, and the SID of the current interactive user. Control-pipe mutation commands require an administrator client token; read-only status may be available to the installed Users group.

## Task 1: Scaffold the Windows solution and deterministic builds

**Files:**
- Create: `collector/Vincere.AutoExport.sln`
- Create: `collector/global.json`
- Create: `collector/Directory.Packages.props`
- Create: `collector/src/Vincere.AutoExport.NinjaTrader/Vincere.AutoExport.NinjaTrader.csproj`
- Create: `collector/src/Vincere.AutoExport.Agent/Vincere.AutoExport.Agent.csproj`
- Create: `collector/src/Vincere.AutoExport.Agent.UI/Vincere.AutoExport.Agent.UI.csproj`
- Create: `collector/tests/Vincere.AutoExport.Agent.Tests/Vincere.AutoExport.Agent.Tests.csproj`
- Create: `collector/README.md`

- [ ] Pin the .NET 8 SDK in `global.json` and centrally pin Newtonsoft.Json, NodaTime, Microsoft.Extensions.Hosting.WindowsServices, and xUnit packages.
- [ ] Reference the existing contracts project. Target AddOn `net48`; target agent/UI/tests `net8.0-windows` with `win-x64` publish settings.
- [ ] Resolve proprietary AddOn references only from `$(NINJATRADER_HOME)\bin`. Add a clear build error when the property is absent; never commit NinjaTrader DLLs.
- [ ] Add a smoke test that asserts contract assembly version and expected target framework.
- [ ] On Windows run:

```powershell
dotnet restore collector\Vincere.AutoExport.sln --locked-mode
dotnet test collector\Vincere.AutoExport.sln -c Release --no-restore
```

Expected: contracts/agent tests pass; AddOn builds only on a machine with `NINJATRADER_HOME`.
- [ ] Commit.

```bash
git add collector/Vincere.AutoExport.sln collector/global.json collector/Directory.Packages.props collector/src collector/tests collector/README.md
git commit -m "build: scaffold Windows auto-export solution"
```

## Task 2: Implement pure capture mapping

**Files:**
- Create: `collector/src/Vincere.AutoExport.NinjaTrader/Capture/INinjaTraderFacade.cs`
- Create: `collector/src/Vincere.AutoExport.NinjaTrader/Capture/SnapshotBuilder.cs`
- Create: `collector/src/Vincere.AutoExport.NinjaTrader/Capture/NinjaTraderFacade.cs`
- Create: `collector/src/Vincere.AutoExport.NinjaTrader/Capture/StrategyParameterReader.cs`
- Create: `collector/tests/Vincere.AutoExport.NinjaTrader.Tests/Vincere.AutoExport.NinjaTrader.Tests.csproj`
- Create: `collector/tests/Vincere.AutoExport.NinjaTrader.Tests/SnapshotBuilderTests.cs`

- [ ] Add failing tests against fake facades for all four sections, null optional fields, concurrent source mutation, secret-like strategy parameters, and partial section failure.
- [ ] Implement a facade so mapping logic is testable without booting NinjaTrader. Copy source collections to immutable lists before mapping.
- [ ] Map the exact frozen `AutoExportSnapshotV1`; do not add undocumented properties or coerce `null` to zero.
- [ ] Preserve separate `RealizedProfitLoss` and `GrossRealizedProfitLoss`. Never make the P&L preference decision inside the collector.
- [ ] Parameter reader accepts scalar strings, booleans, enums, integral/decimal values, dates, and time spans; everything else becomes a safe string or `null`. Redact secret-like names.
- [ ] A section exception returns stable diagnostic code and empty section only if the contract includes section diagnostics approved during probe. Otherwise fail the whole capture rather than produce an ambiguous payload.
- [ ] Run tests on the self-hosted NinjaTrader runner and commit.

```bash
git add collector/src/Vincere.AutoExport.NinjaTrader/Capture collector/tests/Vincere.AutoExport.NinjaTrader.Tests
git commit -m "feat: map NinjaTrader data to snapshot v1"
```

## Task 3: Implement the AddOn lifecycle and capture pipe

**Files:**
- Create: `collector/src/Vincere.AutoExport.NinjaTrader/VincereAutoExportAddOn.cs`
- Create: `collector/src/Vincere.AutoExport.NinjaTrader/Pipe/CapturePipeServer.cs`
- Create: `collector/src/Vincere.AutoExport.NinjaTrader/Pipe/CapturePipeSecurity.cs`
- Create: `collector/src/Vincere.AutoExport.NinjaTrader/Diagnostics/AddOnDiagnostics.cs`
- Create: `collector/tests/Vincere.AutoExport.NinjaTrader.Tests/CapturePipeServerTests.cs`

- [ ] Write failing integration tests for authorized capture, unauthorized pipe connection, malformed request, request ID echo, one capture at a time, timeout cancellation, NinjaTrader shutdown, and oversized response protection.
- [ ] Start one pipe accept loop when AddOn reaches active state and cancel/dispose it on termination. Prevent duplicate servers across NinjaScript reloads with process-local lifecycle ownership.
- [ ] Create pipe ACL from SYSTEM, Administrators, and current Windows identity SID. Do not grant Everyone/Authenticated Users.
- [ ] Parse one length-prefixed UTF-8 JSON request per connection with hard size/time limits. Serialize one length-prefixed response.
- [ ] Marshal the facade read to NinjaTrader's dispatcher. Do not block the UI while serializing or waiting for the agent.
- [ ] Add a Control Center `Vincere Auto Export Status` menu entry showing AddOn version, pipe state, and last capture result only. No CRM credentials or pairing controls live inside NinjaTrader.
- [ ] Run tests plus a live manual pipe capture from the agent test client. Restart NinjaTrader and prove exactly one server starts.
- [ ] Commit.

```bash
git add collector/src/Vincere.AutoExport.NinjaTrader collector/tests/Vincere.AutoExport.NinjaTrader.Tests
git commit -m "feat: expose NinjaTrader capture pipe"
```

## Task 4: Implement protected machine configuration

**Files:**
- Create: `collector/src/Vincere.AutoExport.Agent/Configuration/AgentOptions.cs`
- Create: `collector/src/Vincere.AutoExport.Agent/Configuration/ConfigurationStore.cs`
- Create: `collector/src/Vincere.AutoExport.Agent/Security/DpapiSecretStore.cs`
- Create: `collector/src/Vincere.AutoExport.Agent/Security/MachineIdentity.cs`
- Test: `collector/tests/Vincere.AutoExport.Agent.Tests/ConfigurationStoreTests.cs`
- Test: `collector/tests/Vincere.AutoExport.Agent.Tests/DpapiSecretStoreTests.cs`

- [ ] Write failing tests for default configuration, corrupt JSON, atomic config replacement, DPAPI round trip, missing secret, wrong machine context, MachineGuid normalization/hash, and log redaction.
- [ ] Keep nonsecret endpoint, schedule, device ID, and versions in `config.json`; keep only raw device token in `secret.bin`.
- [ ] Use DPAPI LocalMachine and fixed application entropy. Apply filesystem ACLs immediately after directory creation and before secret write.
- [ ] Write temp files with write-through/flush and atomic replace. Preserve last known-good backup for configuration only; never make plaintext secret backups.
- [ ] Expose a `RedactedAgentState`; serializers/loggers must never accept the secret-bearing model.
- [ ] Run focused tests elevated and non-elevated to verify access behavior; commit.

```bash
git add collector/src/Vincere.AutoExport.Agent/Configuration collector/src/Vincere.AutoExport.Agent/Security collector/tests/Vincere.AutoExport.Agent.Tests
git commit -m "feat: protect collector machine configuration"
```

## Task 5: Implement durable filesystem queue semantics

**Files:**
- Create: `collector/src/Vincere.AutoExport.Agent/Queue/SnapshotQueue.cs`
- Create: `collector/src/Vincere.AutoExport.Agent/Queue/QueueItem.cs`
- Test: `collector/tests/Vincere.AutoExport.Agent.Tests/SnapshotQueueTests.cs`

- [ ] Write failing tests for atomic enqueue, crash before rename, claim, upload success, upload retry, service restart while `uploading`, duplicate capture ID, corrupt payload quarantine, retention cleanup, and concurrent workers.
- [ ] Name items `<tradingDate>_<captureId>.json`; validate UUID/date against payload before enqueue.
- [ ] Enqueue to a same-volume `.tmp`, flush file and directory metadata where Windows allows, then rename into `pending`.
- [ ] Claim with atomic move `pending -> uploading`. On startup return stale `uploading` items to pending unless a sent receipt proves success.
- [ ] On success write a small receipt containing batch ID/hash, then move payload to `sent`. Never delete before durable receipt.
- [ ] Use bounded disk retention/size thresholds. When storage is near the configured limit, retain unsent data first and report `queue_capacity_warning`.
- [ ] Quarantine corrupt items with reason metadata; do not loop forever.
- [ ] Run focused tests including process-kill fault injection; commit.

```bash
git add collector/src/Vincere.AutoExport.Agent/Queue collector/tests/Vincere.AutoExport.Agent.Tests/SnapshotQueueTests.cs
git commit -m "feat: add crash-safe snapshot queue"
```

## Task 6: Implement New York scheduling and capture retries

**Files:**
- Create: `collector/src/Vincere.AutoExport.Agent/Scheduling/CaptureSchedule.cs`
- Create: `collector/src/Vincere.AutoExport.Agent/Scheduling/CaptureScheduler.cs`
- Create: `collector/src/Vincere.AutoExport.Agent/Capture/CapturePipeClient.cs`
- Test: `collector/tests/Vincere.AutoExport.Agent.Tests/CaptureScheduleTests.cs`
- Test: `collector/tests/Vincere.AutoExport.Agent.Tests/CapturePipeClientTests.cs`

- [ ] Write NodaTime tests for 4:45 p.m. America/New_York in EST/EDT, DST transition weekends, Windows host in a different zone, service restart before/after schedule, weekend configuration, duplicate trigger suppression, and manual capture.
- [ ] Persist `lastScheduledTradingDate` only after a snapshot is durably queued. A service restart after capture must not recapture unless an operator requests it.
- [ ] Default schedule is `16:45`, zone `America/New_York`, Monday-Friday. Allow configuration from CRM/UI within approved bounds; do not depend on the VPS local zone.
- [ ] Implement named-pipe client timeouts and stable error codes: `ninjatrader_not_running`, `addon_unavailable`, `capture_timeout`, `capture_failed`, `contract_mismatch`.
- [ ] Retry capture with bounded exponential delays until the cutoff configured before the daily reset. Never spin continuously or launch NinjaTrader automatically.
- [ ] Validate contract and trading date before queueing. Agent supplies machine/version source metadata; AddOn supplies NinjaTrader version and rows.
- [ ] Run focused tests and commit.

```bash
git add collector/src/Vincere.AutoExport.Agent/Scheduling collector/src/Vincere.AutoExport.Agent/Capture collector/tests/Vincere.AutoExport.Agent.Tests
git commit -m "feat: schedule resilient NinjaTrader capture"
```

## Task 7: Implement CRM pairing, heartbeat, and upload clients

**Files:**
- Create: `collector/src/Vincere.AutoExport.Agent/Crm/CrmClient.cs`
- Create: `collector/src/Vincere.AutoExport.Agent/Crm/CrmModels.cs`
- Create: `collector/src/Vincere.AutoExport.Agent/Crm/RetryPolicy.cs`
- Test: `collector/tests/Vincere.AutoExport.Agent.Tests/CrmClientTests.cs`

- [ ] Write HTTP-handler tests for successful pair, invalid/expired code, network interruption, TLS failure, timeout, 401 credential revocation, 409 duplicate capture, 413 size rejection, 429 Retry-After, 5xx backoff, and sanitized exceptions.
- [ ] Require HTTPS except an explicit development-only localhost setting. Use modern TLS defaults and normal certificate validation; no `DangerousAcceptAnyServerCertificateValidator` in any build.
- [ ] Pair with code and MachineGuid; write the returned token directly to DPAPI storage and zero/discard transient buffers where practical.
- [ ] Attach bearer token and MachineGuid only to the configured CRM origin. Disable automatic redirects that could forward Authorization to another host.
- [ ] Upload queued snapshots with `captureId` idempotency, optional gzip request body, bounded timeouts, and response validation.
- [ ] Classify retries: retry network/408/429/5xx; stop and surface action for 400/401/403/413/unsupported schema. Honor bounded `Retry-After`.
- [ ] Heartbeat at startup and periodically with queue depth, versions, last capture/error, and disk warning. Do not include account rows, product key, or device token.
- [ ] Run focused tests and commit.

```bash
git add collector/src/Vincere.AutoExport.Agent/Crm collector/tests/Vincere.AutoExport.Agent.Tests/CrmClientTests.cs
git commit -m "feat: connect collector agent to CRM"
```

## Task 8: Compose the Windows Service

**Files:**
- Create: `collector/src/Vincere.AutoExport.Agent/Program.cs`
- Create: `collector/src/Vincere.AutoExport.Agent/Worker.cs`
- Create: `collector/src/Vincere.AutoExport.Agent/Diagnostics/EventLogReporter.cs`
- Create: `collector/src/Vincere.AutoExport.Agent/Diagnostics/RedactingLogger.cs`
- Create: `collector/src/Vincere.AutoExport.Agent/Control/ControlPipeServer.cs`
- Test: `collector/tests/Vincere.AutoExport.Agent.Tests/WorkerTests.cs`
- Test: `collector/tests/Vincere.AutoExport.Agent.Tests/ControlPipeServerTests.cs`

- [ ] Write orchestration tests using fake clock, queue, pipe, and CRM: unpaired startup, paired startup, scheduled capture, offline upload recovery, capture error heartbeat, revoked token, graceful stop, and unexpected loop exception recovery.
- [ ] Compose through dependency injection and `AddWindowsService`. Set service recovery policy later in installer, not application code.
- [ ] Run scheduler, uploader, heartbeat, and control server as supervised background loops with cancellation. One loop failure must not terminate unrelated queue durability.
- [ ] Add structured rolling local logs with a bounded retention and central redaction. Mirror critical state transitions to Windows Event Log.
- [ ] Control-pipe commands: `status`, `pair`, `testCapture`, `captureNow`, `updateSchedule`, `collectDiagnostics`, `forgetDevice`. Authorize mutating commands with client impersonation/admin SID check.
- [ ] `forgetDevice` requires explicit UI confirmation, deletes local credential only after CRM revoke succeeds or writes a clear orphan warning.
- [ ] Publish self-contained service and install temporarily with `sc.exe`; prove start/stop/recovery under LocalSystem.
- [ ] Commit.

```bash
git add collector/src/Vincere.AutoExport.Agent collector/tests/Vincere.AutoExport.Agent.Tests
git commit -m "feat: compose auto-export Windows Service"
```

## Task 9: Build the guided WPF configuration UI

**Files:**
- Create: `collector/src/Vincere.AutoExport.Agent.UI/App.xaml`
- Create: `collector/src/Vincere.AutoExport.Agent.UI/MainWindow.xaml`
- Create: `collector/src/Vincere.AutoExport.Agent.UI/MainViewModel.cs`
- Create: `collector/src/Vincere.AutoExport.Agent.UI/ControlPipeClient.cs`
- Create: `collector/tests/Vincere.AutoExport.Agent.UI.Tests/Vincere.AutoExport.Agent.UI.Tests.csproj`
- Create: `collector/tests/Vincere.AutoExport.Agent.UI.Tests/MainViewModelTests.cs`

- [ ] Write view-model tests for service unavailable, pairing success/error, expired code, NinjaTrader restart required, AddOn absent, test capture, scheduled time validation, offline queue, update required, and diagnostics export.
- [ ] Create a four-step wizard in simple English: welcome/checks; enter one-time code; restart NinjaTrader if needed; test and finish. Keep an advanced status panel for support staff.
- [ ] Accept the code with case-insensitive Crockford normalization and readable grouping, but send canonical characters only.
- [ ] Never display/store the device token. Show client display name returned by server so the installer can confirm correct binding.
- [ ] Add schedule selector defaulted to 4:45 p.m. New York time and clearly label the time zone. Restrict values to server-approved bounds.
- [ ] Diagnostics ZIP includes versions, redacted config, bounded logs, service/AddOn status, and queue metadata—not snapshot payloads or secrets unless an explicit support workflow is later approved.
- [ ] Ensure keyboard navigation, screen-reader labels, scaling, and 1024x768 compatibility.
- [ ] Run view-model tests and a manual UI accessibility checklist; commit.

```bash
git add collector/src/Vincere.AutoExport.Agent.UI collector/tests/Vincere.AutoExport.Agent.UI.Tests
git commit -m "feat: add guided collector configuration UI"
```

## Task 10: Build safe AddOn deployment and WiX installer

**Files:**
- Create: `collector/src/Vincere.AutoExport.Installer/Vincere.AutoExport.Installer.wixproj`
- Create: `collector/src/Vincere.AutoExport.Installer/Package.wxs`
- Create: `collector/src/Vincere.AutoExport.Installer/Bundle.wxs`
- Create: `collector/src/Vincere.AutoExport.Installer/CustomActions/DetectNinjaTrader.ps1`
- Create: `collector/tests/installer/Installer.Tests.ps1`
- Create: `collector/scripts/build-installer.ps1`
- Create: `collector/scripts/sign-artifacts.ps1`

- [ ] Write Pester tests for NinjaTrader path detection, missing installation, running NinjaTrader warning, per-user Documents resolution, existing same/newer AddOn, downgrade block, file ownership manifest, service ACLs, rollback, and uninstall.
- [ ] Detect installed NinjaTrader and the actual profile Documents path. If multiple Windows user profiles exist, require explicit selection; never spray the AddOn into every profile.
- [ ] Require NinjaTrader to close before replacing the Vincere AddOn. Preserve no foreign files and overwrite only component GUID-owned Vincere paths.
- [ ] Install service binaries in Program Files, machine data directories with strict ACLs, LocalSystem automatic delayed-start service, recovery actions, UI shortcut, and AddOn DLL.
- [ ] Launch the configuration wizard after successful installation under the interactive administrator. Request NinjaTrader restart and verify AddOn availability through the service test.
- [ ] Use major-upgrade semantics, block downgrades, support repair, and remove only Vincere-owned binaries/config at uninstall. Offer an explicit checkbox to retain queued/sent data; default retains unsent queue for recovery.
- [ ] Force a custom-action failure in a test VM and prove rollback restores prior service/AddOn version.
- [ ] Sign EXE/MSI/DLL artifacts with Authenticode and timestamp. Secrets:

```text
WINDOWS_SIGNING_CERT_BASE64
WINDOWS_SIGNING_CERT_PASSWORD
WINDOWS_SIGNING_TIMESTAMP_URL
```

- [ ] Verify signatures with `Get-AuthenticodeSignature`; production packaging fails if any required artifact is unsigned/untrusted.
- [ ] Commit.

```bash
git add collector/src/Vincere.AutoExport.Installer collector/tests/installer collector/scripts
git commit -m "feat: package signed Windows collector installer"
```

## Task 11: Add Windows CI and release manifest

**Files:**
- Create: `.github/workflows/collector-windows.yml`
- Create: `collector/release/release-manifest.schema.json`
- Create: `collector/scripts/create-release-manifest.ps1`
- Modify: `.gitignore`

- [ ] Add pull-request jobs on `windows-2025` for contracts, agent, UI, tests, formatting, and unsigned dev installer.
- [ ] Add an AddOn job on runner labels `[self-hosted, Windows, ninjatrader8]`; validate that proprietary references are outside the checkout and never upload them.
- [ ] Add protected tag/release jobs that sign artifacts, generate SHA-256 hashes, create a manifest with version/minimum version/URLs/hashes/signing thumbprint, and publish to the approved private or public release location.
- [ ] Make release jobs fail if signing secrets are absent, tests fail, version is not monotonic, or manifest/schema/hash verification fails.
- [ ] Retain build artifacts for a bounded period; do not retain fixtures containing client data.
- [ ] Add build outputs, local NT reference paths, logs, queue files, certificates, and secrets to `.gitignore`.
- [ ] Validate the workflow with one pull request build and one prerelease tag; commit sanitized run links in rollout evidence, not secrets.
- [ ] Commit.

```bash
git add .github/workflows/collector-windows.yml collector/release collector/scripts/create-release-manifest.ps1 .gitignore
git commit -m "ci: build and sign Windows collector"
```

## Task 12: Windows system verification

**Files:**
- Create: `docs/verification/windows-collector.md`
- Create: `collector/tests/system/Collector.System.Tests.ps1`
- Modify: `collector/README.md`

- [ ] Provision a clean Windows VPS/VM snapshot with NinjaTrader 8 and a test connection. Record OS/NT versions and restore point ID, not credentials.
- [ ] Automate/test: clean install, pair, NinjaTrader restart, test capture, scheduled capture, network outage, service restart mid-upload, NinjaTrader closed at schedule, delayed NinjaTrader start, duplicate upload, credential revoke, upgrade, forced rollback, repair, and uninstall.
- [ ] Verify service runs without an interactive desktop while capture correctly reports unavailable if NinjaTrader is closed. The agent must never synthesize or screen-scrape data.
- [ ] Inspect filesystem/service/pipe ACLs as standard user and unauthorized local user.
- [ ] Search logs/diagnostics/registry/Event Log for the raw enrollment code and device token; expected zero matches.
- [ ] Restore the clean VM and repeat signed install from the CRM download link.
- [ ] Run final Windows gate:

```powershell
dotnet test collector\Vincere.AutoExport.sln -c Release
Invoke-Pester collector\tests\installer,collector\tests\system -CI
Get-AuthenticodeSignature .\artifacts\* | Format-Table Path,Status
```

Expected: all tests pass and every production artifact status is `Valid`.
- [ ] Document results, known optional-field gaps, operational error codes, upgrade/uninstall procedure, and support-diagnostics procedure.
- [ ] Commit.

```bash
git add docs/verification/windows-collector.md collector/tests/system collector/README.md
git commit -m "docs: verify Windows collector package"
```

## Completion Gate

- [ ] AddOn captures frozen v1 without pixel/OCR automation.
- [ ] Named-pipe ACL works between interactive NinjaTrader and LocalSystem service and rejects unauthorized users.
- [ ] Schedule is correct across New York DST regardless of VPS zone.
- [ ] Queue survives crash/reboot and retries idempotently.
- [ ] Token exists only in DPAPI-protected machine storage and is redacted everywhere.
- [ ] WPF setup requires only the one-time code and a NinjaTrader restart.
- [ ] Signed installer passes install, repair, upgrade, rollback, and uninstall.
- [ ] Production AddOn compiles on a controlled runner with legitimate NinjaTrader references.
- [ ] Full Windows system suite passes on a clean VPS image.
