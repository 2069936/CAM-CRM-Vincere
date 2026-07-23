# NinjaTrader Auto-Collection End-to-End Rollout Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Verify the complete collector-to-CRM path with real operational evidence, pilot it safely beside manual exports, deploy it in controlled waves, and leave the team with measurable fleet operations and rollback procedures.

**Architecture:** Staging contract/system tests precede a two-to-three-client shadow pilot. Automatic snapshots and manual files run in parallel and are compared at raw and reconciled levels without auto-closing days. Acceptance gates control production waves of 10–20 VPSs. Manager health, audit data, signed release manifests, and documented rollback make the fleet supportable at roughly 200 daily clients.

**Tech Stack:** Existing CRM/Vercel/Supabase environments, signed Windows installer, PowerShell system tests, Vitest, SQL verification queries, operational runbooks.

---

## Rollout Invariants

- Manual export remains available until final acceptance.
- Pilot automatic imports cannot silently replace/close reviewed production days.
- Every pilot comparison uses the same capture minute and New York trading date.
- No committed evidence contains client names, account IDs, P&L, product keys, enrollment codes, device tokens, service-role keys, or raw snapshot bodies.
- Rollout is paused on routing errors, missing required fields, duplicate normalized rows, secret exposure, data loss, or unsigned artifacts.
- A client/VPS can be revoked independently without affecting the fleet.

## Task 1: Define staging and production readiness checks

**Files:**
- Create: `docs/operations/auto-collection-environments.md`
- Create: `docs/operations/auto-collection-release-checklist.md`
- Create: `scripts/verify-auto-collection-env.mjs`
- Test: `scripts/verify-auto-collection-env.test.js`

- [ ] Write failing tests for missing/placeholder environment variables, identical staging/production peppers, non-HTTPS release URL, absent minimum version, and malformed release manifest.
- [ ] Implement a value-presence/shape checker that prints variable names/status only, never values. Required server configuration includes Supabase URL/service credentials, `INGEST_TOKEN_PEPPER`, pair rate limits, bucket name, installer manifest URL, and minimum agent/schema versions.
- [ ] Document separate staging/production Supabase projects, Vercel protection, private Storage, signing identity, self-hosted runner ownership, and migration ordering.
- [ ] Define go/no-go checks for schema, APIs, CRM UI, signed artifact/hash, clean-VM system test, alert visibility, and rollback owner.
- [ ] Run against staging and production metadata without changing either environment.
- [ ] Commit.

```bash
git add docs/operations/auto-collection-environments.md docs/operations/auto-collection-release-checklist.md scripts/verify-auto-collection-env.mjs scripts/verify-auto-collection-env.test.js
git commit -m "docs: define collector release readiness"
```

## Task 2: Add end-to-end contract and load verification

**Files:**
- Create: `tests/e2e/auto-collection-ingest.test.js`
- Create: `scripts/load-test-auto-collection.mjs`
- Create: `docs/verification/auto-collection-load.md`

- [ ] Build an integration fixture factory that generates unique clients/devices/capture IDs while keeping frozen row shape. Use only a disposable staging project.
- [ ] Test full path: authorized enrollment generation, pair, heartbeat, ingest, normalized rows/flags, duplicate retry, history list, JSON download, CSV ZIP reconstruction, and revoke.
- [ ] Test 20 concurrent devices and 200 daily devices with randomized upload times/retries. Verify unique batch counts, no cross-client routing, bounded endpoint latency/error rate, and expected Storage objects.
- [ ] Test two devices attempting the same enrollment and one device attempting another client's capture metadata; both must fail safely.
- [ ] Clean only records tagged with the test run ID after resolving exact IDs. Never issue broad table/bucket deletes.
- [ ] Record environment, sample size, latency percentiles, errors, and database/storage counts in sanitized evidence.
- [ ] Commit.

```bash
git add tests/e2e/auto-collection-ingest.test.js scripts/load-test-auto-collection.mjs docs/verification/auto-collection-load.md
git commit -m "test: verify collector ingest at fleet scale"
```

## Task 3: Prepare pilot selection and consent

**Files:**
- Create: `docs/operations/auto-collection-pilot.md`
- Create: `docs/operations/auto-collection-pilot-checklist.md`

- [ ] Select two or three representative VPSs: at least two connection providers/prop firms, active strategies, all four tabs populated, and one employee comfortable with rollback.
- [ ] Record pilot contacts, VPS alias, NinjaTrader/Windows version, normal operating window, rollback owner, and maintenance authorization in the private operational system—not this public repository.
- [ ] Define shadow mode: collector uploads to staging or production `pilot` batches, CRM processes/computes comparisons but does not auto-close or replace reviewed days.
- [ ] Train the pilot employee on the four-step install, green status, manual fallback, and whom to contact. They must not need product/database credentials.
- [ ] Back up Vincere-owned prior files/config if present and create a recoverable VM snapshot before install.
- [ ] Get an explicit go/no-go sign-off from engineering, CRM owner, and operations.
- [ ] Commit only the blank/redacted checklist template.

```bash
git add docs/operations/auto-collection-pilot.md docs/operations/auto-collection-pilot-checklist.md
git commit -m "docs: prepare collector shadow pilot"
```

## Task 4: Run multi-day shadow comparisons

**Files:**
- Create: `scripts/compare-auto-and-manual-imports.mjs`
- Test: `scripts/compare-auto-and-manual-imports.test.js`
- Create: `docs/verification/auto-collection-pilot-summary.md`

- [ ] Write failing tests for equivalent reordered rows, normalized numeric/timestamp values, realized-to-gross fallback, missing optional fields, missing required rows, and cross-client mismatch.
- [ ] Implement comparison at three levels: contract fields; four section row sets; reconciled daily totals/flags. Mask identifiers and values in output while retaining mismatch categories/counts.
- [ ] For at least three consecutive trading days, keep automatic capture at configured time and perform same-minute manual exports on each pilot VPS.
- [ ] Verify Accounts, Strategies, Orders, and current-session Executions separately. Investigate mismatches the same day before session data changes.
- [ ] Exercise one controlled offline period and one service/NinjaTrader restart. Confirm queued recovery creates no duplicate batch or normalized rows.
- [ ] Exercise a post-reset capture on a noncritical test account and confirm CRM chooses gross only when realized is zero and gross non-zero, with `pnlSource=gross_fallback` visible in batch metadata/audit.
- [ ] Record aggregate counts, mismatch causes, fixes/retests, upload delay, queue recovery, and support events in a redacted summary.
- [ ] Pilot acceptance thresholds:
  - 100% client/device routing accuracy;
  - 100% required-field availability;
  - zero lost/duplicate captures after acknowledged receipt;
  - reconciled P&L/totals equivalent under documented normalization;
  - 100% recovery of deliberately queued offline snapshots;
  - no high-severity secret/security finding;
  - at least 95% scheduled captures received within 15 minutes, with every miss explained.
- [ ] If thresholds fail, keep manual export and return to the owning subplan; do not waive required/security criteria.
- [ ] Commit.

```bash
git add scripts/compare-auto-and-manual-imports.mjs scripts/compare-auto-and-manual-imports.test.js docs/verification/auto-collection-pilot-summary.md
git commit -m "test: validate auto-export shadow pilot"
```

## Task 5: Add operational monitoring and daily reconciliation

**Files:**
- Create: `docs/operations/auto-collection-runbook.md`
- Create: `docs/operations/auto-collection-status-codes.md`
- Create: `scripts/audit-auto-collection-day.mjs`
- Test: `scripts/audit-auto-collection-day.test.js`

- [ ] Write tests for expected-versus-received classification at pre-schedule, grace window, late, weekend, revoked, paused, incomplete, and update-required states using America/New_York.
- [ ] Implement a read-only daily audit script/API consumer that reports aggregate counts and redacted device/client references. It must never fetch raw snapshots or secrets.
- [ ] Define daily owner actions for: pending before schedule; AddOn unavailable; NinjaTrader closed; offline queue; incomplete section; invalid schema; revoked token; late closed-day arrival; update required; storage/processing failure.
- [ ] Define severity/SLA and escalation owner. Routing/security/data-loss is immediate stop; single-device offline is local remediation; optional-field gaps follow documented probe decision.
- [ ] Document safe replay, explicit closed-day replacement, revoke/rebind, diagnostics collection, installer repair, rollback, and manual-export fallback.
- [ ] Run the audit against the pilot daily and reconcile counts with Manager UI.
- [ ] Commit.

```bash
git add docs/operations/auto-collection-runbook.md docs/operations/auto-collection-status-codes.md scripts/audit-auto-collection-day.mjs scripts/audit-auto-collection-day.test.js
git commit -m "docs: add collector fleet operations runbook"
```

## Task 6: Deploy controlled production waves

**Files:**
- Create: `docs/operations/auto-collection-wave-checklist.md`
- Create: `docs/verification/auto-collection-rollout.md`

- [ ] Freeze one signed installer/release manifest for each wave. Do not change version mid-wave.
- [ ] Wave 0: pilot devices. Wave 1+: 10–20 VPSs chosen across staff/client types, with no more devices than the support owner can revert the same day.
- [ ] Before each device: confirm profile/client, generate a fresh one-time code, download installer from profile, record expected VPS alias privately, and keep manual fallback available.
- [ ] After each install: confirm returned client name, green AddOn capture test, heartbeat, signed version, configured New York schedule, and one visible audit enrollment event.
- [ ] After each trading day: compare expected/received/incomplete/late/duplicate counts; resolve every unexplained miss before the next wave.
- [ ] Hold each wave for at least two successful trading days. Expand only when acceptance thresholds continue to pass.
- [ ] Stop the wave and revoke affected devices on any cross-client routing, token exposure, systematic P&L mismatch, unsigned/update tampering, or data-loss condition.
- [ ] Rollback order: pause new enrollments; revoke affected credentials; retain raw/queue evidence; uninstall/restore prior package; use manual export; investigate and release a new version—never republish bits under the same version/hash.
- [ ] Record redacted wave sizes, versions, dates, status counts, incidents, and go/no-go approvals.
- [ ] Commit after rollout evidence is complete.

```bash
git add docs/operations/auto-collection-wave-checklist.md docs/verification/auto-collection-rollout.md
git commit -m "docs: record collector production rollout"
```

## Task 7: Final acceptance and handoff

**Files:**
- Create: `docs/operations/auto-collection-support-handoff.md`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-07-23-ninjatrader-auto-collection-implementation.md`

- [ ] Run all CRM and Windows gates on the exact production version/hash.

```bash
npm test
npm run lint
npm run build
git diff --check
```

```powershell
dotnet test collector\Vincere.AutoExport.sln -c Release
Invoke-Pester collector\tests\installer,collector\tests\system -CI
Get-AuthenticodeSignature .\artifacts\* | Where-Object Status -ne Valid
```

Expected: JavaScript gates pass; PowerShell returns no invalid production artifact.
- [ ] Verify raw object count equals non-rejected unique batch count for sampled days; verify normalized rows trace to batch IDs; verify no unassigned/revoked device uploads.
- [ ] Perform a repository/artifact/log secret scan and dependency vulnerability review. Resolve high/critical findings before acceptance.
- [ ] Hand off release, enrollment, daily monitoring, incident, replay, rollback, update, and uninstall responsibilities with named operational owners outside the public repo.
- [ ] Keep manual upload enabled for an agreed observation period. Removing it requires a separate approved change.
- [ ] Mark every master completion-audit box only when linked evidence exists. Do not treat “installed” as proof of data parity or reliability.
- [ ] Commit final handoff and plan status.

```bash
git add docs/operations/auto-collection-support-handoff.md README.md docs/superpowers/plans/2026-07-23-ninjatrader-auto-collection-implementation.md
git commit -m "docs: complete auto-collection handoff"
```

## Completion Gate

- [ ] Staging E2E and 200-device load checks pass without cross-client routing or duplication.
- [ ] Shadow pilot passes required-field, P&L, reliability, and security thresholds.
- [ ] Signed installer version/hash is fixed and traceable for every rollout wave.
- [ ] Each wave has at least two accepted trading days before expansion.
- [ ] Manager expected-versus-received monitoring and the daily owner routine are active.
- [ ] Replay, closed-day replacement, revoke/rebind, rollback, and manual fallback are rehearsed.
- [ ] Support staff have a redacted diagnostics path and do not need developer/database credentials.
- [ ] Full CRM/Windows gates pass on the production artifact.
- [ ] Master completion audit links to actual verification evidence.
