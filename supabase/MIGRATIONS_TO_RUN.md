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
| 35 | `step_35_prop_firm_plan.sql` | `prop_firm_plan` on `trading_accounts` | Drawdown limits that follow the plan an account was bought under |
| 36 | `step_36_simulation_accounts.sql` | the CAM's simulation/live override on `trading_accounts` | Simulated accounts kept out of desk capital without being discarded |
| 37 | `step_37_derived_strategy_pnl.sql` | `derived_realized` on `strategy_snapshots`; `derivation` on `account_snapshots` | Per-algo P&L derived from the fills |
| 38 | `step_38_flag_acknowledged_to_resolved.sql` | `acknowledged_before_step_38` on `operational_flags`, and the 460 `Acknowledged` rows set to `Resolved` | Retiring the Acknowledge action on flags |
| 39 | `step_39_client_churn_reason.sql` | `churn_reason`, `churn_note`, `churned_at` on `clients` | The churn drill-down, and the reason captured when a CAM marks a client Inactive |
| 41 | `step_41_heartbeat_ordering.sql` | replaces `record_ingest_heartbeat` without the invalid capture/success ordering rule | Collector heartbeats remain valid after a successful upload |

## These three groups behave differently

**28–30 are required before the auto-collector works at all.** They create tables
and RPCs the ingest endpoints call directly, so without them every upload fails
with `snapshot_ingest_unavailable` and every pairing attempt fails with
`pairing_unavailable`. They do **not** degrade gracefully. The rest of the CRM is
unaffected either way — nothing else touches those tables.

`INGEST_TOKEN_PEPPER` is required alongside them for the same reason: device
authentication has nothing to hash without it.

**31–38 degrade gracefully.** Each feature reads its column as an empty default
when the column is missing, so the code can deploy before they run and the
feature simply stays dormant:

- No 31 → the report designer shows the default layout and can't save changes.
- No 32 → the sidebar keeps its pinned + urgency sort; drag order won't persist.
- No 33 → the Tradovate ID field shows but has nowhere to save.
- No 34 → time off and coverage are unavailable; everyone sees only their own
  clients, exactly as before.
- No 35 → an account runs on the tightest drawdown its firm sells at that size,
  because no plan can be recorded to say otherwise.
- No 36 → the simulation/live classification runs on its heuristic alone and a
  CAM's override has nowhere to save.
- No 37 → **the per-algo split does not survive a reload.** The derivation still
  runs at import and a CAM sees the split on the freshly imported close; after a
  refresh the columns it was read back from do not exist, so the panel shows the
  combination history and no per-algo figures. Nothing wrong is displayed —
  absent stays absent — but the feature is invisible to anyone who did not do the
  import themselves. This is the one of the four whose absence a user notices.
- No 38 → nothing on any screen changes, and that is the point. The Acknowledge
  button is gone from the code either way; the 460 flags already stored as
  `Acknowledged` keep reading as closed because `isFlagOpen` and every filter
  beside it still exclude that status by name. Running 38 moves those rows to
  `Resolved` in the database and records that it did; not running it leaves the
  data as it is with the product behaving identically. It is the one step here
  that is purely about the stored rows rather than about a feature.

**39 reads gracefully and writes loudly, which is not the same thing.** Its
*reads* behave like 31–38: on a database without the three columns, and on every
export taken before it ran, `buildCrmStateFromTables` reads them as absent, the
churn drill-down shows "Not recorded" against every departure, and no count
anywhere moves.

Its *write* does not degrade, on purpose. The columns are mapped only by the one
save that marks a client Inactive, and that save carries the new stage and the
reason in the **same** UPDATE — so on an un-migrated database that single action
fails with the usual "Could not save client" alert instead of quietly recording a
churn with no reason. Creating unexplained rows is the thing step 39 exists to
stop, so it refuses to create them rather than degrading into doing exactly that.
Nothing else about a client save is affected: names, emails, stages other than
Inactive, notes and everything else on the profile keep working untouched.

- No 39, and nobody marks anyone Inactive → indistinguishable from having run it.
- No 39, and a CAM marks a client Inactive → one alert, nothing saved, and the
  fix is this one file.

Step 37 adds **two** columns, one per table. It was drafted with two more on
`strategy_snapshots` — `derived_realized_status` and `derived_realized_join` —
and both were cut before the step was ever run, because each repeated the
account-day's own verdict on every roster row of that account while
`account_snapshots.derivation` already stored it once. Measured through the
shipped write mapper on a real export they were 72.5 of the 96.4 bytes a strategy
row was about to grow by, or ~73 KiB on the busiest CAM's 1,033-row export pull —
against the 4 MiB ceiling `server/export/clientExport.js` enforces as a 413 and
that pull is already over. Every per-row question they answered is answerable
from `derived_realized` plus `derivation`; the SQL file carries the mapping. If
you ran an earlier draft of this file, the two columns are inert and may be
dropped whenever convenient.

## Order

28 → 29 → 30 → 31 → 32 → 33 → 34 → 35 → 36 → 37 → 38 → 39 → 41. Steps 29 and 30 build
on 28, 34 references `cam_profiles` and `clients`, and 35–37 alter
`trading_accounts`, `strategy_snapshots` and `account_snapshots` — all of which
already exist. 35, 36, 37, 38 and 39 are independent of each other and of
everything above them; 38 touches only `operational_flags` and 39 only
`clients`.

Step 41 replaces only `record_ingest_heartbeat`. It removes both forms of the
invalid ordering rule between `last_success_at` and `last_capture_at`; either
timestamp may honestly be newer. The independent five-minute future-skew
checks remain in place. It does not rewrite stored device rows.

Step 39 adds columns and rewrites nothing. Every client already marked Inactive
keeps a null reason and a null date, which the app reports as "Not recorded"
rather than back-filling to `other` — `other` is an option a CAM can choose, and
a back-fill would make silence indistinguishable from an answer in the one column
that exists to be counted.

Step 38 is the only one that rewrites existing rows. It is idempotent (a second
run finds no `Acknowledged` rows) and reversible in one statement, which
`step_38_flag_acknowledged_to_resolved.sql` spells out at the top.
