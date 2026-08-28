# Complete Auto-Collector Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a Windows collector package that answers Setup status requests reliably, reports valid heartbeat chronology, and contains the already-designed NinjaTrader AddOn runtime payload.

**Architecture:** Keep the current Windows service, named-pipe protocol, PowerShell installer, and GitHub Release distribution. Fix the pipe ordering at its source, preserve CRM-compatible timestamps in the agent, compile the proprietary-host-dependent AddOn once on a NinjaTrader VPS, and inject its four runtime DLLs into the portable CI package before generating the pinned manifest.

**Tech Stack:** .NET 8, .NET Framework 4.8 AddOn target, xUnit, named pipes, PowerShell, Bash, GitHub Actions, GitHub Releases, Vercel.

**Spec:** `docs/publish-collector-release.md`

## Global Constraints

- Do not require CRM administrator access or new Vercel environment variables.
- Do not add a self-hosted GitHub Actions runner, Authenticode signing, or install-time AddOn compilation.
- The release ZIP must contain `Agent/`, `Setup/`, `AddOn/`, `install-agent.ps1`, `uninstall-agent.ps1`, and `installing.md`.
- `AddOn/` must contain exactly the required runtime inputs: `Vincere.AutoExport.NinjaTrader.dll`, `Vincere.AutoExport.NinjaTrader.Core.dll`, `Vincere.AutoExport.Contracts.dll`, and `Newtonsoft.Json.dll`.
- NinjaTrader must be closed while the AddOn is compiled or installed.
- The public manifest and package remain SHA-256 pinned by the existing application code.

---

### Task 1: Make the control pipe wait for the request before impersonating

**Files:**
- Modify: `collector/src/Vincere.AutoExport.Agent/Control/ControlPipeServer.cs`
- Test: `collector/tests/Vincere.AutoExport.Agent.Tests/ControlPipeServerTests.cs`

**Interfaces:**
- Consumes: the existing length-prefixed `ControlCommandRequest` frame.
- Produces: the same `ControlCommandResponse`; authorization continues through `IsAdministrator(NamedPipeServerStream)`.

- [ ] Add a Windows integration test that connects a real `NamedPipeClientStream`, deliberately waits before writing, sends `status`, and receives `status_ok` without terminating the control loop.
- [ ] Run the test on the unmodified implementation and record the expected failure caused by `RunAsClient` occurring before the first client write.
- [ ] In `RunOnceAsync`, move `ReadFrameAsync<ControlCommandRequest>` before `IsAdministrator`; keep the 64 KiB frame bound and existing pipe ACL.
- [ ] Re-run the focused test and the full collector solution.

### Task 2: Keep heartbeat success time compatible with capture time

**Files:**
- Modify: `collector/src/Vincere.AutoExport.Agent/Service/CollectorLoops.cs`
- Test: `collector/tests/Vincere.AutoExport.Agent.Tests/CollectorLoopTests.cs`

**Interfaces:**
- Consumes: `CollectorState.RecordCapture(...)` followed by `RecordUploadSuccess(DateTimeOffset acknowledgedAt)`.
- Produces: a `CollectorStatusSnapshot` where `LastSuccessAt` identifies the successfully delivered capture and never exceeds `LastCaptureAt` when the latter is known.

- [ ] Add a test with capture time `20:45` and acknowledgement time `20:45:03` asserting both heartbeat timestamps are `20:45`.
- [ ] Run the focused test and verify it fails because the current code stores `20:45:03`.
- [ ] Change `RecordUploadSuccess` to retain `LastCaptureAt` as the success timestamp when present, falling back to the acknowledgement time only when the process has no capture timestamp.
- [ ] Re-run focused and full collector tests.

### Task 3: Compose a complete portable package from the verified AddOn payload

**Files:**
- Create: `scripts/compose-collector-package.sh`
- Create: `scripts/compose-collector-package.test.js`
- Modify: `scripts/prepare-release.sh`

**Interfaces:**
- Consumes: a CI-produced `Vincere-AutoExport-Agent.zip`, a directory containing the four required DLLs, and an output ZIP path.
- Produces: a complete `Vincere-AutoExport-Agent.zip` with an `AddOn/` directory; exits non-zero before writing output when any DLL is absent or empty.

- [ ] Add Vitest cases that create a synthetic base package and AddOn payload, execute the composer, and inspect the ZIP listing and bytes.
- [ ] Add a negative case proving a missing DLL blocks package creation.
- [ ] Run the focused tests and verify failure because the composer does not yet exist.
- [ ] Implement the portable Bash composer with `mktemp`, `unzip`, `zip`, literal paths, and exact required-file validation.
- [ ] Update `prepare-release.sh` to require the AddOn directory and invoke the composer before generating the manifest.
- [ ] Re-run focused tests and the full Node suite.

### Task 4: Point local AddOn bootstrap at the canonical current source

**Files:**
- Modify: `collector/scripts/bootstrap-local-test.ps1`
- Modify: `collector/docs/local-capture-test.md`

**Interfaces:**
- Consumes: public source ZIP from `2069936/CAM-CRM-Vincere`, default branch `main`.
- Produces: the existing four DLLs in `collector/src/Vincere.AutoExport.NinjaTrader/bin/Release/net48` and installs them in `Documents/NinjaTrader 8/bin/Custom`.

- [ ] Change the bootstrap repository and default branch from the stale fork branch to the canonical repository `main`.
- [ ] Preserve the current NinjaTrader and .NET SDK preflight behavior.
- [ ] Update the local-capture command and explain where the reusable release DLLs remain after compilation.

### Task 5: Document the unsigned complete-release procedure

**Files:**
- Modify: `docs/publish-collector-release.md`
- Modify: `collector/docs/installing.md`
- Modify: `.github/workflows/collector-windows.yml`

**Interfaces:**
- Consumes: green portable workflow artifact plus the four DLLs built on a NinjaTrader VPS.
- Produces: a documented `agent-v1.0.1` GitHub Release and a pinned manifest ready for the application default.

- [ ] Remove statements claiming the AddOn is intentionally absent from the distributed package.
- [ ] Make the CI artifact explicitly a base package awaiting AddOn composition, so an incomplete artifact cannot be mistaken for a production release.
- [ ] Document the exact VPS build command, DLL transfer, package composition, manifest generation, GitHub Release upload, and NinjaTrader-closed requirement.
- [ ] Document that the normal `main` deployment updates the committed release URL/hash without CRM-console access.

### Task 6: Build, publish, and prove the release

**Files:**
- Modify after artifact creation: `server/apiLib/collectorRelease.js`
- Test: `server/tests/apiLib/collectorReleaseRedirect.test.js`

**Interfaces:**
- Consumes: published `agent-v1.0.1/release-manifest.json` and its exact SHA-256.
- Produces: the Auto Collection download command resolving to the complete ZIP.

- [ ] Run .NET tests, Vitest, lint, formatting verification, and production builds.
- [ ] Run the Windows workflow and download the new base agent artifact.
- [ ] On the current NinjaTrader VPS, run the canonical bootstrap/build with NinjaTrader closed and collect the four DLLs.
- [ ] Compose the complete ZIP and verify its full listing, hashes, and non-empty AddOn payload.
- [ ] Generate and upload `Vincere-AutoExport-Agent.zip` and `release-manifest.json` to GitHub Release `agent-v1.0.1`.
- [ ] Update the committed default manifest URL/hash, run its focused tests, and deploy through the normal `main` path.
- [ ] On the VPS, verify Setup passes step 1, pairing succeeds, the AddOn loads in NinjaTrader, manual capture queues/uploads, and the subsequent heartbeat remains accepted.
