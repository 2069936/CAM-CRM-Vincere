# Deploying this branch

Everything an operator (or an AI agent acting for one) needs to take this branch
live. Written to be followed start to finish with no other context.

Read this first, then act in order. Steps 1 and 2 are required. Step 3 is only
needed to switch on the automatic collector; the CRM is fully usable without it.

---

## What is in this branch

**CRM features**

- Client lifecycle and churn/retention, at three scopes: one client, a CAM's
  book, the whole team.
- Cash accounts split into IRA and Straight, reported separately. The pre-split
  `Cash` value keeps working and is reported as unclassified.
- A report designer: each CAM sets a default layout for their reports, and any
  client can override it.
- CAM time off and temporary client coverage: a CAM requests time off, a manager
  approves it and assigns cover in the same action. Cover adds access without
  removing it and expires on its own end date.
- An as-of date that re-scopes the whole Operations page to any past trading day.
- Undo a day's upload; drag-and-drop client ordering; a Tradovate /
  NinjaTrader-web CSV importer.

**Fixes**

- The Operations page rendered ~1,475 rows at once; heavy panels now collapse.
- The open-flags table scanned all history instead of the latest close, which is
  why it read 993 against a 777 header chip.
- The date defaulted to the next day in the evening (UTC vs local).
- Flags were counted but invisible from other tabs.
- Reports printed strategies NinjaTrader had already disabled after an algo
  switch.

**Automatic collector** — a Windows agent that runs on each client's VPS and
uploads the daily close by itself. Built and tested; publishing it is step 3.

---

## Step 1 — Run the database migrations (required)

In Supabase (SQL editor or CLI), run in order:

```
supabase/step_28_auto_collection.sql
supabase/step_29_auto_collection_reprocess.sql
supabase/step_30_auto_collection_pnl_audit.sql
supabase/step_31_report_config.sql
supabase/step_32_client_order.sql
supabase/step_33_tradovate_account_id.sql
supabase/step_34_cam_time_off_and_coverage.sql
```

All are additive and idempotent. None drops or rewrites existing data, so
re-running is safe.

**The two groups behave differently if skipped:**

- **28–30 do not degrade gracefully.** They create the tables and RPCs the
  collector's ingest endpoints call directly. Without them every collector
  upload fails with `snapshot_ingest_unavailable` and every pairing fails with
  `pairing_unavailable`. The rest of the CRM is unaffected — nothing else reads
  those tables.
- **31–34 degrade gracefully.** Each feature reads its column as an empty
  default when missing, so the code can deploy first and the feature simply
  stays dormant: no 31 → the report designer can't save; no 32 → the sidebar
  keeps its automatic sort; no 33 → the Tradovate ID field has nowhere to save;
  no 34 → time off and coverage are unavailable and everyone sees only their own
  clients, exactly as before.

Reference: [`supabase/MIGRATIONS_TO_RUN.md`](../supabase/MIGRATIONS_TO_RUN.md)

## Step 2 — Set environment variables (required)

In the CRM's Vercel project, Settings → Environment Variables.

Already set (the CRM runs today, so these exist):
`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`.

Add:

| Variable | Value |
|---|---|
| `INGEST_TOKEN_PEPPER` | A secret: `openssl rand -hex 32`. Generate it in Vercel and keep it there — it must not be committed or sent over chat. Device authentication has nothing to hash without it. |

The three below come out of step 3 and are only needed for the collector. Leave
them unset until then — the CRM does not need them.

| Variable | Set in step 3 |
|---|---|
| `AUTO_COLLECTION_MIN_AGENT_VERSION` | version of the published agent |
| `AUTO_COLLECTION_RELEASE_MANIFEST_URL` | URL of the published manifest |
| `AUTO_COLLECTION_RELEASE_MANIFEST_SHA256` | its SHA-256 |

Redeploy, then check:

```bash
node scripts/verify-auto-collection-env.mjs
```

It lists anything missing or still a placeholder.

## Step 3 — Publish the collector (only to switch on auto-collection)

Skip this and the CRM works normally; CAMs keep uploading the four NinjaTrader
CSVs by hand. Until it is done, the Auto Collection card shows **"Installer
unavailable"** — that is the expected state, not a bug.

1. **Build the agent.** Actions → "Collector Windows" → Run workflow (it has a
   manual trigger). Produces a `collector-agent-package-<n>` artifact. The
   package is ~100 MB, so it is a build artifact rather than a committed file.

2. **Stage the two files.** Decide where they will be served from first — any
   HTTPS folder works (a public Supabase Storage bucket, S3, a static host).
   That URL is baked into the manifest.

   ```bash
   ./scripts/prepare-release.sh https://<host>/<folder>
   ```

   It pulls the newest passing build from this repository's own Actions and
   writes `release-upload/` containing `Vincere-AutoExport-Agent.zip` and
   `release-manifest.json`, then prints the three values for step 2. Needs the
   GitHub CLI (`gh`) and Node.

3. **Upload both files** to that folder. They must sit in the same folder — the
   CRM rejects a manifest whose artifacts are served from another origin — and
   the folder must be publicly readable, because the VPS machines download from
   it directly.

4. **Set the three variables** from step 2 and redeploy.

Re-publishing a newer build later means repeating this and updating
`AUTO_COLLECTION_RELEASE_MANIFEST_SHA256` with it. The manifest is hash-pinned,
so a changed manifest with a stale hash is rejected by design.

Reference: [`docs/publish-collector-release.md`](publish-collector-release.md)

## Step 4 — Confirm

- Open the CRM. Client lifecycle, the report designer and the as-of date should
  be present.
- If step 3 was done: open **Auto Collection** for any client. The card should
  show a PowerShell command with a copy button instead of "Installer
  unavailable".
- To onboard one machine: on that client's VPS, open PowerShell **as
  administrator** with NinjaTrader closed, paste the command, then paste the
  pairing code the card generates. Details in
  [`collector/docs/installing.md`](../collector/docs/installing.md).

Install on **one** VPS and confirm a scheduled capture lands as that client's
daily close before rolling out further.

---

## Known gaps

Recorded rather than hidden. None of these blocks deploying.

**The persistence RPC is not executed by any test.** Automatic imports persist
through `persist_auto_daily_import`, a Postgres function no test runs — the
database tests exist but skip unless `AUTO_COLLECTION_TEST_DATABASE_URL` points
at a real database, and no CI job sets it. Its equivalence to the JavaScript
mappers the manual path uses is established by code inspection only. To close
it, point that variable at a staging database and run the suite; the tests are
already written. Expect one known difference: the RPC writes `NULL` where the JS
mappers write `0` for `orders` and `executions` numerics. The UI reads both as
`0`, but raw SQL or BI queries would see it. Details in
[`docs/verification/auto-collection-crm.md`](verification/auto-collection-crm.md).

**Trailing drawdown on automatic closes is an estimate.** NinjaTrader's API does
not expose it, so it is reconstructed from stored closes as a lower bound and
marked as derived, with widened alert thresholds. Making it exact needs each prop
firm's trailing rule recorded — see
[`docs/prop-firm-rules-catalog.md`](prop-firm-rules-catalog.md), which is a design
note, not built.

**The NinjaTrader AddOn is not in the published package.** CI only ever builds it
against a disposable payload, so the real one has to be deployed from a machine
with licensed NinjaTrader. `install-agent.ps1` warns and continues when it is
absent, so the service installs and pairs first; NinjaTrader capture begins once
the AddOn is in place.

**The agent package is unsigned.** Distribution deliberately does not depend on a
code-signing certificate. Integrity is still enforced — the manifest is pinned by
SHA-256 through the environment variable, and it carries the package's own
SHA-256, so a tampered download is rejected. What is absent is the Authenticode
signature, so Windows warns when a script downloaded from the internet is run;
`Unblock-File` handles it, and the install doc covers this.

---

## Verifying the branch locally

```bash
npm install
npm test        # 979 passing, 5 skipped
npm run build
npm run lint
```

The 5 skipped tests are the ones that need a real database: 3 in
`supabase/step_28_auto_collection.test.js` and 2 in
`tests/e2e/auto-collection-ingest.test.js`, all gated on
`AUTO_COLLECTION_TEST_DATABASE_URL`. See Known gaps.
