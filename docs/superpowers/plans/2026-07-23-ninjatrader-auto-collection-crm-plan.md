# NinjaTrader Auto-Collection CRM Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add secure device enrollment, immutable snapshot ingestion, canonical reconciliation/persistence, setup and fleet-health UI, audit history, and JSON/four-CSV downloads to the existing CRM without breaking manual imports.

**Architecture:** Vercel Node endpoints authenticate browser users or hashed device credentials. Device uploads first become immutable `ingest_batches` plus compressed private Storage objects; accepted snapshots then pass through a pure normalizer, the existing `reconcileDailyImport`, and one shared transactional persistence service. React profile and Manager components call server endpoints for enrollment and operations. Closed days reject silent replacement and retain late raw batches for review.

**Tech Stack:** React 19, Vite 8, Vitest 4, Vercel Node functions, Supabase/Postgres/Storage, PapaParse, fflate, Node `crypto` and `zlib`.

---

## Security and State Model

- Enrollment codes are 10 Crockford Base32 characters, valid for 60 minutes, one-time, and rate-limited. Only a SHA-256 HMAC digest is stored.
- Device tokens are 32 random bytes encoded base64url. CRM returns a token exactly once and stores only its HMAC digest plus an 8-character display prefix.
- `INGEST_TOKEN_PEPPER` is a server-only environment secret. It must differ across staging and production.
- Pairing binds one active credential to a normalized Windows MachineGuid. A rebind or replacement requires an authorized CAM/Manager action and produces an audit event.
- Browser authorization: Manager can operate all clients; CAM can operate only clients assigned to that user. Client-facing accounts cannot generate/revoke enrollment credentials unless separately approved later.
- Device states: `pending`, `online`, `late`, `incomplete`, `offline`, `update_required`, `revoked`.
- Batch states: `received`, `duplicate`, `processing`, `processed`, `incomplete`, `late_closed_day`, `failed`.

## Task 1: Add server HTTP/auth/token primitives

**Files:**
- Create: `api/_lib/http.js`
- Create: `api/_lib/apiAuth.js`
- Create: `api/_lib/ingestTokens.js`
- Test: `api/_lib/http.test.js`
- Test: `api/_lib/apiAuth.test.js`
- Test: `api/_lib/ingestTokens.test.js`
- Modify: `api/admin/users.js`
- Modify: `api/admin/intake-sheet.js`
- Modify: `api/admin/data-export.js`

- [ ] Write failing tests for method rejection, JSON size limits, bearer extraction, role enforcement, CAM-client assignment enforcement, code expiration, constant-time digest matching, and token redaction.

```js
it('never stores or logs the raw device token', () => {
  const issued = issueDeviceToken({ pepper: 'test-pepper' });
  expect(issued.token).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(issued.record.credentialHash).not.toContain(issued.token);
  expect(JSON.stringify(issued.record)).not.toContain(issued.token);
});
```

- [ ] Implement `sendJson`, `readJsonBody`, `requireMethod`, `ApiError`, and one top-level `handleApiError` that hides stack traces in production.
- [ ] Implement `createServiceClient()` and `requireAppUser(req, { roles, clientUuid })` by extracting the existing Supabase bearer-auth pattern. Validate the caller with Supabase Auth, then load role/assignment from database state; never trust a role sent by the browser.
- [ ] Implement `issueEnrollmentCode`, `digestEnrollmentCode`, `issueDeviceToken`, `digestDeviceToken`, and `safeEqualHex` with `crypto.randomBytes`, `createHmac('sha256', pepper)`, and `timingSafeEqual`.
- [ ] Make the three existing admin endpoints use the helpers with no behavior change. Add regression tests for their existing authorization decisions.
- [ ] Run:

```bash
npm test -- api/_lib/http.test.js api/_lib/apiAuth.test.js api/_lib/ingestTokens.test.js
npm run lint
```

- [ ] Commit.

```bash
git add api/_lib api/admin/users.js api/admin/intake-sheet.js api/admin/data-export.js
git commit -m "refactor: share secure API authentication"
```

## Task 2: Add the additive Supabase schema and private bucket

**Files:**
- Create: `supabase/step_28_auto_collection.sql`
- Modify: `supabase/DATABASE_TRACKER.md`
- Create: `docs/verification/auto-collection-schema.md`

- [ ] Write the migration inside a transaction where supported. Create:
  - `ingest_enrollments(id, client_id, code_hash, created_by, expires_at, consumed_at, consumed_by_device_id, revoked_at, created_at)`;
  - additive `ingest_devices` fields: `machine_id_hash`, `credential_hash`, `credential_prefix`, `status`, `schedule_time`, `schedule_timezone`, `agent_version`, `addon_version`, `ninjatrader_version`, `last_seen_at`, `last_capture_at`, `last_success_at`, `last_error_code`, `last_error_at`, `revoked_at`, `metadata`;
  - `ingest_batches(id, capture_id, device_id, client_id, trading_date, captured_at, received_at, status, schema_version, storage_path, content_sha256, byte_count, row_counts, completeness, daily_import_id, replaces_batch_id, error_code, error_detail, processed_at)`.
- [ ] Add uniqueness for `(device_id, capture_id)` and immutable storage path; indexes for client/date, device/received, and status/received.
- [ ] Add check constraints for allowed states, `America/New_York`, positive schema version, and nonnegative row counts.
- [ ] Create private Storage bucket `ninjatrader-imports`. Restrict object operations to service role; browser downloads must go through an authorized API.
- [ ] Enable RLS and define explicit no-direct-browser policies for enrollment, device-secret fields, and raw batches. Existing application role reads must go through server endpoints.
- [ ] Add SQL functions/RPCs for atomic pairing and atomic batch claim if a plain transaction cannot be guaranteed across Vercel calls:

```sql
pair_ingest_device(
  p_code_hash text,
  p_machine_hash text,
  p_credential_hash text,
  p_credential_prefix text,
  p_agent_version text,
  p_addon_version text
)
claim_ingest_batch(
  p_device_id uuid,
  p_capture_id uuid,
  p_trading_date date,
  p_captured_at timestamptz,
  p_schema_version integer,
  p_storage_path text,
  p_content_sha256 text,
  p_byte_count bigint,
  p_row_counts jsonb
)
```

Each function must lock the enrollment/batch row, validate expiration/revocation, and return the winning row for concurrent retries.
- [ ] Apply to a disposable/staging Supabase project, run the migration twice, and confirm the second run is either safely idempotent or clearly rejected before mutation.
- [ ] Query constraints, indexes, RLS, and bucket privacy into `docs/verification/auto-collection-schema.md`; exclude connection strings and secrets.
- [ ] Commit.

```bash
git add supabase/step_28_auto_collection.sql supabase/DATABASE_TRACKER.md docs/verification/auto-collection-schema.md
git commit -m "feat: add auto-collection database schema"
```

## Task 3: Normalize automatic snapshots into canonical CRM input

**Files:**
- Create: `src/domain/autoImport.js`
- Test: `src/domain/autoImport.test.js`
- Modify: `src/domain/autoExportContract.js`
- Use fixture: `test/fixtures/auto-export/snapshot-v1.json`

- [ ] Write failing tests for valid normalization, all four missing/empty section combinations, malformed numeric values, trading-date/time-zone mismatch, duplicate identifiers, and P&L preference.

```js
it('prefers realized unless it reset to zero while gross is non-zero', () => {
  expect(selectDailyPnl({ realizedPnl: 125, grossRealizedPnl: 140 }))
    .toEqual({ value: 125, source: 'realized' });
  expect(selectDailyPnl({ realizedPnl: 0, grossRealizedPnl: 140 }))
    .toEqual({ value: 140, source: 'gross_fallback' });
  expect(selectDailyPnl({ realizedPnl: 0, grossRealizedPnl: 0 }))
    .toEqual({ value: 0, source: 'realized' });
});
```

- [ ] Implement `normalizeAutoImportSnapshot(snapshot)` returning `{ date, parsed, metadata }` in precisely the shape consumed by `reconcileDailyImport`.
- [ ] Map both gross and realized into account snapshot source metadata; keep selected P&L and `pnlSource` explicit.
- [ ] A structurally valid empty section is `incomplete`, not an HTTP failure. A missing/invalid required property is a validation failure before storage processing.
- [ ] Reject unsupported `schemaVersion` with stable code `unsupported_schema_version`.
- [ ] Run focused tests and existing CSV/reconcile tests.

```bash
npm test -- src/domain/autoExportContract.test.js src/domain/autoImport.test.js src/domain/csvImport.test.js src/domain/reconcile.test.js
```

- [ ] Commit.

```bash
git add src/domain/autoExportContract.js src/domain/autoImport.js src/domain/autoImport.test.js
git commit -m "feat: normalize automatic NinjaTrader snapshots"
```

## Task 4: Extract shared daily-import persistence

**Files:**
- Create: `src/domain/dailyImportPersistence.js`
- Test: `src/domain/dailyImportPersistence.test.js`
- Modify: `src/domain/supabaseStore.js`
- Modify: `src/App.jsx`

- [ ] Characterize current `upsertSupabaseDailyImport` behavior with adapter spies: daily import upsert, child-row replacement, operational flags, and error rollback/cleanup behavior.
- [ ] Write failing tests for `persistDailyImportWithClient({ db, clientUuid, importResult, sourceBatchId })`, including open-day replacement and closed-day refusal.
- [ ] Implement a database adapter interface with the smallest methods needed. Keep all domain transformations independent of the Supabase SDK.
- [ ] Move persistence sequencing out of `supabaseStore.js`; leave `upsertSupabaseDailyImport` as a compatibility wrapper used by manual uploads.
- [ ] Include `source_type`/`source_batch_id` when schema columns exist. Do not delete the prior closed-day normalized result.
- [ ] Update the manual-import call in `App.jsx` only enough to keep using the wrapper; no UI change in this task.
- [ ] Run existing reconciliation, batch import, and new persistence tests.
- [ ] Commit.

```bash
git add src/domain/dailyImportPersistence.js src/domain/dailyImportPersistence.test.js src/domain/supabaseStore.js src/App.jsx
git commit -m "refactor: share daily import persistence"
```

## Task 5: Implement enrollment administration and pairing

**Files:**
- Create: `api/admin/ingest-enrollment.js`
- Create: `api/ingest/pair.js`
- Test: `api/admin/ingest-enrollment.test.js`
- Test: `api/ingest/pair.test.js`
- Modify: `.env.example`

- [ ] Write route tests with injected fake database/auth dependencies for:
  - Manager generation;
  - assigned-CAM generation;
  - unassigned CAM denial;
  - only one unconsumed code per client;
  - expired/used/revoked code denial;
  - same-machine idempotent pairing;
  - different-machine conflict;
  - rate limiting without leaking whether a code exists;
  - raw token returned once and absent from database/logs.
- [ ] Implement admin `POST` generate, `DELETE` revoke device/enrollment, and `POST` rebind-intent actions. Return the raw enrollment code only in the generation response.
- [ ] Implement device `POST /api/ingest/pair`; normalize then HMAC the MachineGuid, call the atomic RPC, issue/store the token digest, and return client display name plus schedule.
- [ ] Use generic public errors (`invalid_or_expired_code`) and detailed server audit codes. Never log request bodies for pair endpoints.
- [ ] Add `INGEST_TOKEN_PEPPER`, `INGEST_PAIR_RATE_LIMIT_*`, and `AUTO_COLLECTION_MIN_AGENT_VERSION` documentation to `.env.example` with blank values.
- [ ] Insert audit events for generation, expiration-on-use, pairing, denial, revoke, and rebind.
- [ ] Run route tests and lint.
- [ ] Commit.

```bash
git add api/admin/ingest-enrollment.js api/ingest/pair.js api/**/*.test.js .env.example
git commit -m "feat: add secure collector enrollment"
```

## Task 6: Implement device authentication and heartbeat

**Files:**
- Create: `api/_lib/deviceAuth.js`
- Create: `api/ingest/heartbeat.js`
- Test: `api/_lib/deviceAuth.test.js`
- Test: `api/ingest/heartbeat.test.js`

- [ ] Write failing tests for valid credential, wrong token, revoked token, machine mismatch, missing headers, old agent version, throttled heartbeat, and last-seen update.
- [ ] Implement `requireIngestDevice(req)` using bearer token digest lookup and constant-time final comparison. Bind the request to the hashed `X-Machine-Id`.
- [ ] Accept heartbeat metadata only from an allowlist. Clamp free-form error text length and store stable `last_error_code` separately.
- [ ] Calculate `update_required` server-side from the configured minimum version; do not trust agent-provided status.
- [ ] Emit heartbeat-recovery and first-online audit entries, but avoid a noisy audit row for every healthy heartbeat.
- [ ] Run focused tests and commit.

```bash
git add api/_lib/deviceAuth.js api/_lib/deviceAuth.test.js api/ingest/heartbeat.js api/ingest/heartbeat.test.js
git commit -m "feat: authenticate collector heartbeats"
```

## Task 7: Store and process immutable daily batches

**Files:**
- Create: `api/_lib/autoImportStore.js`
- Create: `api/ingest/daily.js`
- Test: `api/_lib/autoImportStore.test.js`
- Test: `api/ingest/daily.test.js`
- Modify: `src/domain/dailyImportPersistence.js`

- [ ] Write failing tests for valid ingest, byte-limit rejection, content hash, gzip round trip, duplicate capture ID, same-date newer open-day capture, incomplete sections, storage failure, reconciliation failure after storage, closed-day late batch, and concurrent duplicate claim.
- [ ] Enforce compressed and uncompressed request limits before parsing. Calculate SHA-256 over the canonical UTF-8 payload.
- [ ] Claim `captureId` atomically before processing. A retry returns the original batch/daily import IDs with `duplicate: true` and does not write a second object.
- [ ] Store gzip JSON at `<clientUuid>/<tradingDate>/<captureId>.json.gz` in the private bucket. Never overwrite an existing object.
- [ ] Normalize, load the client's registry, call `reconcileDailyImport`, then `persistDailyImportWithClient` for an open day.
- [ ] If processing fails after raw storage, mark the batch `failed` with a stable code and retain the object for replay. Do not return stack traces.
- [ ] For an incomplete snapshot, persist/flag only according to existing reconcile semantics and mark `incomplete`; the CRM closes nothing automatically.
- [ ] For a closed day, mark `late_closed_day`, retain raw data, link the existing daily import, create an operational/audit alert, and require explicit Manager replacement later.
- [ ] Update device success/error timestamps. Emit one audit event with row counts and batch link.
- [ ] Run:

```bash
npm test -- api/_lib/autoImportStore.test.js api/ingest/daily.test.js src/domain/autoImport.test.js src/domain/dailyImportPersistence.test.js
```

- [ ] Commit.

```bash
git add api/_lib/autoImportStore.js api/_lib/autoImportStore.test.js api/ingest/daily.js api/ingest/daily.test.js src/domain/dailyImportPersistence.js
git commit -m "feat: ingest immutable NinjaTrader snapshots"
```

## Task 8: Add batch history and safe downloads

**Files:**
- Create: `api/admin/ingest-batches.js`
- Create: `api/admin/ingest-download.js`
- Create: `api/_lib/autoExportDownload.js`
- Test: `api/admin/ingest-batches.test.js`
- Test: `api/admin/ingest-download.test.js`
- Test: `api/_lib/autoExportDownload.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] Install `fflate` with `npm install fflate` and commit the lockfile change in this task.
- [ ] Write authorization/pagination/filter tests for batch list and JSON/ZIP downloads.
- [ ] Implement filters by client, device, trading-date range, status, and capture ID with bounded page size and stable `(received_at, id)` cursor pagination.
- [ ] Download raw JSON only after authorization using bounded in-memory buffering with shared compressed/uncompressed hard limits. Add `Cache-Control: private, no-store` and safe `Content-Disposition`. Verify deployed Vercel response limits before raising the production caps.
- [ ] Reconstruct a ZIP with `Accounts.csv`, `Strategies.csv`, `Orders.csv`, and `Executions.csv`. Use stable contract column order, RFC-4180 escaping, UTF-8 BOM only if needed for Excel compatibility, and filenames independent of client-entered text.
- [ ] Include `manifest.json` with schema version, capture metadata, row counts, hashes, P&L-source notes, and batch status.
- [ ] Audit each download without recording signed URLs or payload content.
- [ ] Run focused tests and commit.

```bash
git add package.json package-lock.json api/admin/ingest-batches.js api/admin/ingest-batches.test.js api/admin/ingest-download.js api/admin/ingest-download.test.js api/_lib/autoExportDownload.js api/_lib/autoExportDownload.test.js
git commit -m "feat: browse and download collector batches"
```

## Task 9: Add the profile installation card

**Files:**
- Create: `src/domain/autoCollectionApi.js`
- Test: `src/domain/autoCollectionApi.test.js`
- Create: `src/components/AutoCollectionCard.jsx`
- Test: `src/components/AutoCollectionCard.test.jsx`
- Modify: `src/App.jsx`
- Modify: `src/index.css`

- [ ] Write API wrapper tests for auth headers, enrollment, revoke/rebind, status loading, retry, and sanitized errors.
- [ ] Write component tests for: not installed, code generated with expiry countdown, copy button, download agent button, paired/online, offline, failed, revoked, and permission denied.
- [ ] Build a focused card with four guided steps: download installer, run as administrator, enter one-time code, confirm green connection test. Use plain-language copy for nontechnical employees.
- [ ] Show client binding, last heartbeat, last successful capture, installed versions, schedule, and a clear next action. Never render product key or device-token material.
- [ ] Add Manager/assigned-CAM actions for generate, revoke, and intentional rebind, each with confirmation appropriate to impact.
- [ ] Obtain installer URL/version from a server-controlled release manifest endpoint or environment setting, not a hard-coded GitHub asset.
- [ ] Wire the card into `CredentialsTab` near the existing product-key information. Do not expose it to unauthorized roles.
- [ ] Run component/domain tests, lint, and build.
- [ ] Commit.

```bash
git add src/domain/autoCollectionApi.js src/domain/autoCollectionApi.test.js src/components/AutoCollectionCard.jsx src/components/AutoCollectionCard.test.jsx src/App.jsx src/index.css
git commit -m "feat: add guided collector setup to profiles"
```

## Task 10: Add Manager fleet health, history, and Audit links

**Files:**
- Create: `src/components/AutoCollectionManager.jsx`
- Test: `src/components/AutoCollectionManager.test.jsx`
- Modify: `src/App.jsx`
- Modify: `src/domain/supabaseStore.js`
- Modify: `src/index.css`

- [ ] Write pure status tests based on New York trading date and scheduled time. Cover DST, pre-schedule pending state, late grace period, weekend behavior, offline threshold, incomplete, revoked, and update required.
- [ ] Create a Manager menu entry `Auto Collection` adjacent to Audit Logs. Add summary counts and a searchable table with client, VPS/device, schedule, last seen, today's batch, row counts, version, and status.
- [ ] Add a client/date drawer showing immutable batch history, processing errors, replacement chain, JSON download, and four-CSV ZIP download.
- [ ] Link batch-related Audit Log rows to the same drawer. Keep the existing generic Audit Logs screen intact.
- [ ] Use server pagination; do not subscribe to or load the whole fleet. Poll summary/list only while the view is visible, with an interval of at least 60 seconds.
- [ ] Add accessible status text/icons; color cannot be the only signal.
- [ ] Run focused tests, full test suite, lint, and build.
- [ ] Commit.

```bash
git add src/components/AutoCollectionManager.jsx src/components/AutoCollectionManager.test.jsx src/App.jsx src/domain/supabaseStore.js src/index.css
git commit -m "feat: add collector fleet monitoring"
```

## Task 11: Add explicit replay and closed-day replacement controls

**Files:**
- Create: `api/admin/ingest-reprocess.js`
- Test: `api/admin/ingest-reprocess.test.js`
- Modify: `src/components/AutoCollectionManager.jsx`
- Modify: `src/components/AutoCollectionManager.test.jsx`

- [ ] Write tests proving Manager-only access, idempotent replay, failed-batch replay, incomplete replay, and explicit closed-day replacement with reason.
- [ ] Implement `reprocess` from immutable Storage content. It must create a new processing attempt/audit entry without changing the raw object.
- [ ] For closed-day replacement require `{ confirmClosedDay: true, reason }`, retain links to prior daily import/batch, and create high-signal audit and operational flag records.
- [ ] Disable the UI action unless the user types/provides a reason and confirms the trading date/client.
- [ ] Run focused tests and commit.

```bash
git add api/admin/ingest-reprocess.js api/admin/ingest-reprocess.test.js src/components/AutoCollectionManager.jsx src/components/AutoCollectionManager.test.jsx
git commit -m "feat: add controlled batch reprocessing"
```

## Task 12: CRM verification and documentation

**Files:**
- Create: `docs/verification/auto-collection-crm.md`
- Modify: `README.md`
- Modify: `supabase/DATABASE_TRACKER.md`

- [ ] Against staging, use the frozen snapshot to prove: pair, heartbeat, first ingest, duplicate retry, newer open-day ingest, incomplete ingest, closed-day late ingest, reprocess, JSON download, and ZIP download.
- [ ] Record sanitized request IDs, status codes, resulting batch state, normalized row counts, and audit events. Never record tokens or enrollment codes.
- [ ] Confirm the four reconstructed CSVs can be re-uploaded through the existing manual path and produce equivalent reconciliation results.
- [ ] Run the full gate:

```bash
npm test
npm run lint
npm run build
git diff --check
```

Expected: all tests pass, lint has zero errors, Vite production build succeeds, and `git diff --check` is silent.
- [ ] Perform a secret scan of changed files and inspect every hit:

```bash
git diff --name-only HEAD~12..HEAD | xargs rg -n -i "service_role|product.?key|device.?token|authorization: bearer|password" || true
```

- [ ] Document staging environment variables, migration order, rollback behavior, rate limits, retention choice, and on-call replay procedure in README/verification docs.
- [ ] Commit.

```bash
git add docs/verification/auto-collection-crm.md README.md supabase/DATABASE_TRACKER.md
git commit -m "docs: verify CRM auto-collection pipeline"
```

## Completion Gate

- [ ] Raw secrets are never stored, rendered, exported, or logged.
- [ ] Device identity is server-bound to client and MachineGuid.
- [ ] Duplicate uploads are idempotent under concurrency.
- [ ] Raw gzip JSON is immutable in a private bucket.
- [ ] Automatic and manual imports share reconciliation and persistence.
- [ ] Closed-day arrival requires explicit replacement.
- [ ] Manager can inspect history and download JSON/four-CSV ZIP.
- [ ] Assigned CAM can enroll only their clients.
- [ ] Audit covers every privileged or state-changing action.
- [ ] Manual upload regression suite and full CRM quality gates pass.
