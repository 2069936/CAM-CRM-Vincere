# Migrations to run for PR #10

Run these in Supabase (SQL editor or CLI) in order. All are additive and
idempotent, so re-running is safe. None drops or rewrites existing data.

| Step | File | What it adds | Feature it powers |
|---|---|---|---|
| 28 | `step_28_auto_collection.sql` | auto-collection tables, RPCs and the storage bucket | NinjaTrader auto-collector |
| 29 | `step_29_auto_collection_reprocess.sql` | reprocess / replay support | auto-collector |
| 30 | `step_30_auto_collection_pnl_audit.sql` | PnL source audit | auto-collector |
| 31 | `step_31_report_config.sql` | `report_config` on `cam_profiles` + `clients` | Report designer |
| 32 | `step_32_client_order.sql` | `client_order` on `cam_profiles` | Drag-and-drop sidebar order |
| 33 | `step_33_tradovate_account_id.sql` | `tradovate_account_id` on `trading_accounts` | Tradovate / NinjaTrader-web import |
| 34 | `step_34_cam_time_off_and_coverage.sql` | `cam_time_off`, `client_coverage`, CAM record fields | Time off and temporary client coverage |

## These two groups behave differently

**28–30 are required before the auto-collector works at all.** They create tables
and RPCs the ingest endpoints call directly, so without them every upload fails
with `snapshot_ingest_unavailable` and every pairing attempt fails with
`pairing_unavailable`. They do **not** degrade gracefully. The rest of the CRM is
unaffected either way — nothing else touches those tables.

`INGEST_TOKEN_PEPPER` is required alongside them for the same reason: device
authentication has nothing to hash without it.

**31–34 degrade gracefully.** Each feature reads its column as an empty default
when the column is missing, so the code can deploy before they run and the
feature simply stays dormant:

- No 31 → the report designer shows the default layout and can't save changes.
- No 32 → the sidebar keeps its pinned + urgency sort; drag order won't persist.
- No 33 → the Tradovate ID field shows but has nowhere to save.
- No 34 → time off and coverage are unavailable; everyone sees only their own
  clients, exactly as before.

## Order

28 → 29 → 30 → 31 → 32 → 33 → 34. Steps 29 and 30 build on 28, and 34 references
`cam_profiles` and `clients`, which already exist.
