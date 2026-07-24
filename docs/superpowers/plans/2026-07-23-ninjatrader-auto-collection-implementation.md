# NinjaTrader Auto-Collection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver an end-to-end, scalable daily auto-collection system that captures Accounts, Strategies, Orders, and Executions from each client's NinjaTrader VPS, uploads them securely, and feeds the existing CRM review and close workflow.

**Architecture:** A NinjaTrader .NET Framework 4.8 AddOn captures a versioned four-section snapshot through supported in-process APIs and exposes it over a local named pipe. A self-contained .NET 8 Windows Service schedules capture, persists a durable queue, enrolls with a one-time CRM code, and uploads idempotently. The Vercel/Supabase CRM authenticates device credentials, stores immutable compressed source payloads, normalizes them through the existing reconcile pipeline, and exposes setup, health, history, audit, and download surfaces.

**Tech Stack:** React 19, Vite 8, Vitest 4, Vercel Node functions, Supabase/Postgres/Storage, NinjaScript/C# on .NET Framework 4.8, .NET 8 Windows Service and WPF configuration UI, named pipes, WiX Toolset, GitHub Actions Windows runners.

## Global Constraints

- Source design: `docs/superpowers/specs/2026-07-23-ninjatrader-auto-collection-design.md`.
- Capture schedule uses IANA zone `America/New_York`; initial default is 4:45 p.m.
- One VPS belongs to one CRM client; the server resolves identity through the client's product key during one-time enrollment and then issues a revocable device credential.
- The employee never enters CAM, NinjaTrader, Supabase, or database credentials into the installer.
- The collector performs structural validation only; reconciliation, flags, close, and reporting remain CRM responsibilities.
- A snapshot is one JSON document with four independent arrays: `accounts`, `strategies`, `orders`, and `executions`.
- Raw snapshots are immutable and retained separately from normalized daily-import rows.
- Capture IDs are UUIDs and make retries idempotent.
- A late snapshot never silently overwrites a CRM day already marked closed.
- The agent stores its credential with Windows DPAPI and writes every snapshot atomically before upload.
- The AddOn installer copies only Vincere-owned files under `Documents\NinjaTrader 8\bin\Custom`, never overwrites NinjaTrader files, supports rollback/uninstall, and requires a controlled NinjaTrader restart.
- AddOn code targets .NET Framework 4.8. Agent, UI, and tooling target self-contained `net8.0-windows` `win-x64` builds.
- Current-session NinjaTrader APIs are authoritative. Undocumented grid reflection is allowed only as an explicitly isolated fallback after the collector probe proves a required field is unavailable through supported APIs.
- Every production change follows red-green-refactor and ends with a focused commit.
- Existing manual CSV upload must remain functional throughout rollout.

---

## Decomposition

The approved design spans independent runtime and deployment boundaries, so it
is executed through four coordinated sub-plans. Each sub-plan produces a
reviewable, independently testable deliverable.

1. **Collector contract and NinjaTrader probe**
   `docs/superpowers/plans/2026-07-23-ninjatrader-collector-probe-plan.md`
2. **CRM ingest, storage, profile setup, health, and downloads**
   `docs/superpowers/plans/2026-07-23-ninjatrader-auto-collection-crm-plan.md`
3. **Production AddOn, Windows agent, UI, and guided installer**
   `docs/superpowers/plans/2026-07-23-ninjatrader-windows-collector-plan.md`
4. **End-to-end verification, fleet rollout, and operations**
   `docs/superpowers/plans/2026-07-23-ninjatrader-auto-collection-rollout-plan.md`

## Locked Interface Map

### Snapshot envelope

```text
AutoExportSnapshotV1
  schemaVersion: 1
  captureId: UUID
  capturedAt: ISO-8601 timestamp with offset
  tradingDate: YYYY-MM-DD in America/New_York
  timeZone: "America/New_York"
  source: { machineId, agentVersion, addonVersion, ninjaTraderVersion }
  accounts: AccountRowV1[]
  strategies: StrategyRowV1[]
  orders: OrderRowV1[]
  executions: ExecutionRowV1[]
```

The JSON property names and nullability are defined once in the collector probe
plan, mirrored in C# contracts, and enforced by CRM fixture tests.

### Local AddOn protocol

```text
Named pipe: Vincere.AutoExport.v1
Request:  { "command": "capture", "requestId": "<uuid>" }
Success:  { "ok": true, "requestId": "<uuid>", "snapshot": { ... } }
Failure:  { "ok": false, "requestId": "<uuid>", "errorCode": "...", "message": "..." }
```

### Remote enrollment and ingest protocol

```text
POST /api/ingest/pair
  body: { enrollmentCode, machineId, agentVersion, addonVersion }
  response: { deviceToken, clientName, deviceId, schedule }

POST /api/ingest/heartbeat
  Authorization: Bearer <deviceToken>
  X-Machine-Id: <MachineGuid>

POST /api/ingest/daily
  Authorization: Bearer <deviceToken>
  X-Machine-Id: <MachineGuid>
  body: AutoExportSnapshotV1
  response: { ok, batchId, dailyImportId, duplicate, status }
```

### CRM canonical boundary

```js
normalizeAutoImportSnapshot(snapshot) -> {
  date,
  parsed: { accounts, strategies, orders, executions },
  metadata
}

reconcileDailyImport({ clientId, date, registry, parsed }) -> importResult

persistDailyImportWithClient({ db, clientUuid, importResult }) -> savedImport
```

## Execution Order and Gates

### Phase 1: Prove data access and freeze the contract

- [ ] Execute the collector probe plan on a Windows development machine with NinjaTrader installed.
- [ ] Compare probe output with same-minute manual grid exports for all four sections.
- [ ] Record supported-API coverage for every required and preferred field.
- [ ] Freeze `AutoExportSnapshotV1`; changes after this gate require schema version 2.

**Gate:** Do not build the production AddOn until the probe fixture and comparison report are committed. CRM contract work may proceed against the frozen fixture once available.

### Phase 2: Build the CRM receiving path

- [ ] Execute the CRM plan through migration, normalization, shared persistence, enrollment, ingest, storage, downloads, profile card, and Manager health UI.
- [ ] Deploy the migration and endpoints to a non-production Supabase/Vercel environment.
- [ ] Verify pair, heartbeat, duplicate ingest, incomplete ingest, closed-day late arrival, and download behavior using the frozen fixture.

**Gate:** No real VPS device token may target production until the staging endpoint passes the integration suite.

### Phase 3: Build and package the Windows collector

- [ ] Execute the Windows collector plan using the frozen contract and staging endpoint.
- [ ] Verify named-pipe capture, atomic queue writes, DPAPI credential storage, schedule/DST behavior, retries, and service recovery.
- [ ] Build and sign the installer; verify install, upgrade, rollback, and uninstall on a clean Windows VPS image.

**Gate:** The installer must not modify unrelated files and must recover from a forced mid-install failure.

### Phase 4: Pilot and roll out

- [ ] Execute the rollout plan on two or three clients in parallel with manual exports.
- [ ] Approve field parity and operational reliability for several trading days.
- [ ] Deploy in waves of 10–20 VPSs while monitoring expected versus received captures.
- [ ] Retire manual export only after fleet acceptance criteria pass.

## Repository File Map

### Existing web files modified

- `src/domain/csvImport.js` — remains the manual CSV parser and shares canonical row semantics.
- `src/domain/reconcile.js` — remains the sole reconciliation and flag engine.
- `src/domain/supabaseStore.js` — delegates daily persistence and adds collection-health loaders.
- `src/App.jsx` — wires focused auto-collection components into client/CAM/Manager surfaces.
- `api/admin/data-export.js` — includes new metadata tables but never exports device token hashes.
- `supabase/DATABASE_TRACKER.md` — records the new migration and storage bucket.

### New web files

- `src/domain/autoImport.js` and `.test.js` — validates and normalizes snapshot v1.
- `src/domain/dailyImportPersistence.js` and `.test.js` — shared adapter-based persistence.
- `src/domain/autoCollectionApi.js` and `.test.js` — authenticated browser API wrapper.
- `src/components/AutoCollectionCard.jsx` and `.test.jsx` — client setup/status card.
- `src/components/AutoCollectionManager.jsx` and `.test.jsx` — fleet health/history UI.
- `api/_lib/apiAuth.js`, `api/_lib/http.js`, `api/_lib/ingestTokens.js`, and tests — server primitives.
- `api/_lib/autoImportStore.js` and tests — batch/storage orchestration.
- `api/admin/ingest-enrollment.js`, `api/admin/ingest-batches.js`, `api/admin/ingest-download.js` — authenticated CRM actions.
- `api/ingest/pair.js`, `api/ingest/heartbeat.js`, `api/ingest/daily.js` — device APIs.
- `supabase/step_28_auto_collection.sql` — additive schema, indexes, bucket, and policies.

### New Windows solution

- `collector/Vincere.AutoExport.sln`
- `collector/src/Vincere.AutoExport.Contracts/` — frozen snapshot and pipe contracts.
- `collector/src/Vincere.AutoExport.NinjaTrader/` — .NET Framework 4.8 AddOn.
- `collector/src/Vincere.AutoExport.Agent/` — .NET 8 Windows Service.
- `collector/src/Vincere.AutoExport.Agent.UI/` — WPF pairing/configuration app.
- `collector/src/Vincere.AutoExport.Installer/` — WiX bundle.
- `collector/tests/` — contracts, queue, schedule, API, pipe, and installer tests.
- `.github/workflows/collector-windows.yml` — Windows build/test/package pipeline.

## Whole-System Completion Audit

The objective is complete only when authoritative evidence proves all items:

- [ ] A clean VPS can install and pair from the CRM without command-line work.
- [ ] The AddOn captures all required fields and reports unsupported optional fields explicitly.
- [ ] The service schedules and uploads without mouse/desktop automation; capture succeeds whenever the interactive NinjaTrader process and AddOn are running.
- [ ] Offline capture survives restart and later uploads once, without duplication.
- [ ] CRM routing uses the enrolled device/client identity, never filenames or IP.
- [ ] Automatic and manual input reach the same reconcile and persistence logic.
- [ ] Raw JSON is immutable and Manager can download JSON or a four-CSV ZIP.
- [ ] Open-day replacement is versioned; closed-day late data cannot silently overwrite.
- [ ] Manager can see expected, received, incomplete, late, offline, and update-required states.
- [ ] Audit events cover enrollment, heartbeat, ingest, duplicate, failure, rebind, and download.
- [ ] A signed installer passes clean install, upgrade, rollback, and uninstall tests.
- [ ] Pilot comparison and rollout acceptance records are committed.
- [ ] Existing manual upload, full web tests, lint, and production build remain green.
