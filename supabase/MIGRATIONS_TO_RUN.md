# Migrations to run before merging / after deploying PR #10

Run these in Supabase (SQL editor or CLI) in order. All are additive and
idempotent (`add column if not exists`), so re-running is safe. None drops or
rewrites existing data.

| Step | File | What it adds | Feature it powers |
|---|---|---|---|
| 28 | `step_28_auto_collection.sql` | auto-collection tables | NinjaTrader desktop auto-exporter |
| 29 | `step_29_auto_collection_reprocess.sql` | reprocess support | auto-collection |
| 30 | `step_30_auto_collection_pnl_audit.sql` | PnL source audit | auto-collection |
| 31 | `step_31_report_config.sql` | `report_config` jsonb on `cam_profiles` + `clients` | Report designer (per-CAM + per-client layout) |
| 32 | `step_32_client_order.sql` | `client_order` jsonb on `cam_profiles` | Drag-and-drop sidebar order |
| 33 | `step_33_tradovate_account_id.sql` | `tradovate_account_id` on `trading_accounts` | Tradovate / NinjaTrader-web import linking |

Steps 28–30 are the auto-collection work; 31–33 are the CRM features in this PR.

Until each runs, the matching feature no-ops safely:
- No 31 → report designer resolves to the default layout and can't save changes.
- No 32 → sidebar keeps its pinned + urgency sort; drag order won't persist.
- No 33 → the Tradovate ID field is present but has nowhere to save.

The app tolerates the columns being absent (loads treat missing values as empty
defaults), so deploying the code before the migrations run won't break anything —
the features just stay dormant.
