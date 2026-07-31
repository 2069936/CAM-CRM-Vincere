# NinjaTrader Collector Contract and Probe Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prove which NinjaTrader APIs expose every CRM field, compare an in-process capture with the four manual exports, and freeze the version-1 JSON contract before production collector work begins.

**Architecture:** A disposable NinjaTrader 8 AddOn runs inside Control Center, reads Accounts, Strategies, Orders, and Executions through supported APIs, serializes a typed snapshot, and writes it to a local probe folder. A repository comparison tool normalizes a same-minute set of manual CSVs and reports field coverage and value mismatches. Unsupported optional grid values remain explicit `null`; any proposed reflection fallback is isolated and cannot enter production without a written decision.

**Tech Stack:** NinjaScript/C# .NET Framework 4.8, Newtonsoft.Json, Node.js ESM, PapaParse, Vitest, NinjaTrader 8 on a Windows VPS.

---

## Contract Rules

All monetary and numeric fields are JSON numbers or `null`, never formatted strings. All timestamps are ISO-8601 strings with an offset or `null`. Enum-like values are stable strings. Original source identifiers remain strings. Unknown optional values are `null`, not zero.

```json
{
  "schemaVersion": 1,
  "captureId": "0f5fa8a0-2e84-43d8-8788-24055979f6fe",
  "capturedAt": "2026-07-23T16:45:00-04:00",
  "tradingDate": "2026-07-23",
  "timeZone": "America/New_York",
  "source": {
    "machineId": "probe-only",
    "agentVersion": "probe",
    "addonVersion": "0.1.0-probe",
    "ninjaTraderVersion": "8.x"
  },
  "accounts": [],
  "strategies": [],
  "orders": [],
  "executions": []
}
```

### Version 1 row fields

```text
AccountRowV1
  accountName*, connectionName, displayName
  netLiquidation, cashValue
  realizedPnl*, grossRealizedPnl*, unrealizedPnl, totalPnl
  weeklyPnl, buyingPower, excessIntradayMargin, initialMargin
  maintenanceMargin, currency, status

StrategyRowV1
  strategyId*, strategyName*, strategyDisplayName, accountName*
  instrument*, state*, quantity, position, averagePrice
  realizedPnl, unrealizedPnl, enabled, startedAt
  parameters (object of string -> scalar/null), parameterCaptureStatus*

OrderRowV1
  orderId*, accountName*, strategyId, strategyName, instrument*
  action*, orderType*, quantity*, filled, remaining
  limitPrice, stopPrice, averageFillPrice, state*, time, tif
  oco, name, nativeId

ExecutionRowV1
  executionId*, orderId, accountName*, strategyId, strategyName
  instrument*, action*, quantity*, price*, time*, marketPosition
  commission, fee, realizedPnl, nativeId
```

An asterisk marks a structurally required property. It may still be an empty string only when NinjaTrader itself provides no identifier; the probe report must call that out. `realizedPnl` and `grossRealizedPnl` are both retained. CRM daily-P&L selection stays: prefer a non-zero realized value; when realized is zero and gross is non-zero, use gross and record the fallback.

## Task 1: Add the frozen JSON fixture and validator tests

**Files:**
- Create: `test/fixtures/auto-export/snapshot-v1.json`
- Create: `src/domain/autoExportContract.js`
- Test: `src/domain/autoExportContract.test.js`

- [ ] Write a failing test that loads the fixture and asserts the envelope, all four arrays, required row keys, numeric/null values, and valid ISO timestamps.

```js
import snapshot from '../../test/fixtures/auto-export/snapshot-v1.json';
import { validateAutoExportSnapshot } from './autoExportContract.js';

it('accepts the canonical v1 fixture', () => {
  expect(validateAutoExportSnapshot(snapshot)).toEqual({ ok: true, errors: [] });
});

it('rejects formatted money and missing row identifiers', () => {
  const invalid = structuredClone(snapshot);
  invalid.accounts[0].realizedPnl = '$12.00';
  delete invalid.orders[0].orderId;
  expect(validateAutoExportSnapshot(invalid).errors).toEqual(
    expect.arrayContaining([
      'accounts[0].realizedPnl must be a number or null',
      'orders[0].orderId is required',
    ]),
  );
});
```

- [ ] Run `npm test -- src/domain/autoExportContract.test.js` and confirm failure because the module/fixture does not exist.
- [ ] Add a realistic fixture with at least one row per section, both realized/gross values, a strategy parameter map, partial order, and execution fees.
- [ ] Implement a dependency-free validator that returns every path-specific error rather than stopping on the first one.
- [ ] Run the focused test and confirm it passes.
- [ ] Commit.

```bash
git add test/fixtures/auto-export src/domain/autoExportContract.js src/domain/autoExportContract.test.js
git commit -m "test: freeze auto-export snapshot v1"
```

## Task 2: Create shared C# contract types

**Files:**
- Create: `collector/Directory.Build.props`
- Create: `collector/src/Vincere.AutoExport.Contracts/Vincere.AutoExport.Contracts.csproj`
- Create: `collector/src/Vincere.AutoExport.Contracts/SnapshotV1.cs`
- Create: `collector/src/Vincere.AutoExport.Contracts/PipeProtocol.cs`
- Create: `collector/tests/Vincere.AutoExport.Contracts.Tests/Vincere.AutoExport.Contracts.Tests.csproj`
- Create: `collector/tests/Vincere.AutoExport.Contracts.Tests/SnapshotSerializationTests.cs`

- [ ] Create a `netstandard2.0` contracts project with nullable disabled for NinjaTrader compatibility and Newtonsoft.Json pinned to one reviewed version.
- [ ] Write a failing xUnit test that deserializes `snapshot-v1.json`, reserializes it with camel-case property names, and compares its JSON shape to the fixture.
- [ ] Define typed `AutoExportSnapshotV1`, source metadata, four row classes, `CaptureRequest`, and `CaptureResponse`. Use nullable value types for optional numbers and timestamps.
- [ ] Copy the fixture into the test output through a linked `Content` item; do not duplicate its source.
- [ ] On a Windows developer machine run:

```powershell
dotnet test collector\tests\Vincere.AutoExport.Contracts.Tests -c Release
```

Expected: all contract serialization tests pass and no fixture property is dropped.
- [ ] Commit.

```bash
git add collector/Directory.Build.props collector/src/Vincere.AutoExport.Contracts collector/tests/Vincere.AutoExport.Contracts.Tests
git commit -m "feat: add collector snapshot contracts"
```

## Task 3: Build a supported-API NinjaTrader probe

**Files:**
- Create: `collector/probe/Vincere.AutoExport.Probe.cs`
- Create: `collector/probe/README.md`
- Create: `collector/probe/install-probe.ps1`
- Create: `collector/probe/uninstall-probe.ps1`

- [ ] Add a compile-only skeleton derived from `NinjaTrader.NinjaScript.AddOnBase`; record required references in the README rather than committing proprietary NinjaTrader assemblies.
- [ ] Install the probe by copying only `Vincere.AutoExport.Probe.cs` into `%USERPROFILE%\Documents\NinjaTrader 8\bin\Custom\AddOns`, then compile it through NinjaScript Editor.
- [ ] Add an `Export Vincere Probe Snapshot` Control Center menu item. Dispatch collection on NinjaTrader's UI thread, but serialize/write the result off the UI thread.
- [ ] Capture accounts from `Account.All`; query documented `Account.Get(AccountItem, Currency)` values individually. Map `RealizedProfitLoss` and `GrossRealizedProfitLoss` separately.
- [ ] Enumerate `Account.Strategies`, `Account.Orders`, and `Account.Executions`. Copy collections before enumeration so a live event cannot mutate them mid-capture.
- [ ] Capture public strategy properties with `TypeDescriptor.GetProperties(strategy)` only for properties marked browsable/serializable. Convert scalars to JSON-safe values; redact any property whose name matches `password|secret|token|key` case-insensitively.
- [ ] Set `weeklyPnl`, trailing drawdown, or any grid-only field to `null` and add a probe warning when no documented API supplies it.
- [ ] Write atomically to `%LOCALAPPDATA%\Vincere\AutoExport\probe\<captureId>.json`: serialize to `.tmp`, flush, then rename.
- [ ] Catch each section independently. A failure creates an empty section plus `probe-warnings.json`; it must not invent values.
- [ ] Verify the probe compiles with zero errors and appears once in Control Center.
- [ ] Commit.

```bash
git add collector/probe
git commit -m "feat: add NinjaTrader data-access probe"
```

## Task 4: Normalize the four manual exports for comparison

**Files:**
- Create: `scripts/compare-ninjatrader-probe.mjs`
- Create: `scripts/lib/manualGridNormalization.mjs`
- Test: `scripts/lib/manualGridNormalization.test.js`
- Modify: `package.json`

- [ ] Write failing tests using minimal CSV strings for Accounts, Strategies, Orders, and Executions. Include alternate headers already accepted by `src/domain/csvImport.js`, formatted currency, reordered columns, and the post-5 p.m. realized-zero/gross-nonzero case.
- [ ] Implement header-driven normalization. Never classify files by filename alone: score recognized headers and reject ambiguous files.
- [ ] Reuse exported parsing helpers from `src/domain/csvImport.js` where possible; extract a pure helper only if importing that module has browser side effects.
- [ ] Implement row match keys:
  - accounts: normalized account name;
  - strategies: account + strategy name/display name + instrument;
  - orders: order ID, falling back to account + native ID;
  - executions: execution ID, falling back to account + order ID + time + quantity + price.
- [ ] Add `npm run probe:compare -- --snapshot <json> --accounts <csv> --strategies <csv> --orders <csv> --executions <csv> --out <dir>`.
- [ ] Emit `comparison.json` and `comparison.md` with per-field status: `exact`, `normalized-match`, `missing-api`, `missing-grid`, or `value-mismatch`.
- [ ] Run focused tests and confirm pass.
- [ ] Commit.

```bash
git add package.json scripts/compare-ninjatrader-probe.mjs scripts/lib
git commit -m "feat: compare probe capture with NinjaTrader grids"
```

## Task 5: Run the real-VPS parity experiment

**Files:**
- Create: `docs/verification/ninjatrader-probe/README.md`
- Create: `docs/verification/ninjatrader-probe/field-coverage.md`
- Create: `docs/verification/ninjatrader-probe/redacted-comparison.json`
- Update: `test/fixtures/auto-export/snapshot-v1.json`

- [ ] Select a non-production or approved client VPS with active rows in all four tabs. Record NinjaTrader version, connection provider, Windows version, and local time zone.
- [ ] Between 4:30 and 4:50 p.m. New York time, trigger the probe and immediately export the four grids manually. Do not wait across a session reset.
- [ ] Copy artifacts to a temporary encrypted working directory. Redact client name, account IDs, machine IDs, order IDs, execution IDs, prices, P&L, and product keys before committing any evidence.
- [ ] Run the comparison command and manually inspect every `value-mismatch`.
- [ ] Repeat once after the NinjaTrader realized-P&L reset to prove that the snapshot preserves distinct realized and gross values and that zero is not treated as missing by the collector.
- [ ] Complete this decision table:

```text
Field | CRM required? | Supported API | Manual grid | Result | Production action
```

- [ ] For required fields unavailable through supported APIs, write a short architecture decision in `field-coverage.md`. Allowed outcomes are: derive deterministically in CRM; approve an isolated reflection fallback with a version guard; or declare the feature blocked. Pixel/OCR collection is not an allowed production fallback.
- [ ] Replace synthetic fixture values with a fully redacted real-shape fixture while preserving test edge cases.
- [ ] Run:

```bash
npm test -- src/domain/autoExportContract.test.js scripts/lib/manualGridNormalization.test.js
npm run lint
```

Expected: all focused tests pass; lint returns zero errors.
- [ ] Commit.

```bash
git add docs/verification/ninjatrader-probe test/fixtures/auto-export/snapshot-v1.json
git commit -m "docs: verify NinjaTrader collector field parity"
```

## Task 6: Freeze schema version 1

**Files:**
- Modify: `docs/superpowers/specs/2026-07-23-ninjatrader-auto-collection-design.md`
- Modify: `docs/superpowers/plans/2026-07-23-ninjatrader-auto-collection-implementation.md`
- Create: `collector/CONTRACT.md`

- [ ] Copy the final field/nullability table and unsupported-field decisions into `collector/CONTRACT.md`.
- [ ] Add fixture SHA-256, probe date, tested NinjaTrader versions, and approval names/date.
- [ ] Mark the Phase 1 gate complete only if every required field has a production action and no unredacted client data is tracked.
- [ ] Run `git grep -n -Ei 'product.?key|bearer|device.?token|password' docs/verification test/fixtures/auto-export` and inspect every match for accidental secrets.
- [ ] Commit.

```bash
git add collector/CONTRACT.md docs/superpowers/specs docs/superpowers/plans
git commit -m "docs: freeze auto-export contract v1"
```

## Completion Gate

- [ ] Same-minute manual exports and probe output have a reviewed comparison report.
- [ ] Required fields are available or have an approved deterministic production action.
- [ ] Weekly P&L and drawdown behavior is explicit; unsupported values are `null`.
- [ ] Strategy parameter capture is verified on at least two algorithms with different parameter types.
- [ ] Executions are documented as current-session data.
- [ ] The redacted real-shape fixture passes both JavaScript and C# contract tests.
- [ ] Contract v1 is frozen before CRM/agent integration proceeds.
