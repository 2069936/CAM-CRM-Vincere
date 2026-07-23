# CAM CRM Supabase Database Tracker

Last updated: 2026-07-23

## Connection Status

- Supabase project URL: `https://rmokyixyhgdwcjbqilsd.supabase.co`
- Local database check page: `http://127.0.0.1:5173/database`
- App runtime for admin API: use `vercel dev` / `npm run dev:vercel` so `/api/admin/users` is available.
- Intake route hook: `/api/admin/intake-sheet`, backed by optional `GOOGLE_SHEET_CSV_URL`.
- Frontend env keys expected:
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_PUBLISHABLE_KEY`
- Server-only env key expected for user management:
  - `SUPABASE_SERVICE_ROLE_KEY`
- Server-only env keys expected for collector enrollment:
  - `INGEST_TOKEN_PEPPER`
  - `INGEST_PAIR_RATE_LIMIT_MAX_ATTEMPTS`
  - `INGEST_PAIR_RATE_LIMIT_WINDOW_SECONDS`
  - `INGEST_PAIR_RATE_LIMIT_BLOCK_SECONDS`
  - `AUTO_COLLECTION_MIN_AGENT_VERSION`
  - `AUTO_COLLECTION_HEARTBEAT_MIN_INTERVAL_SECONDS`
- App integration status: Supabase is required for authentication and operational data.
- RLS status: not production-hardened yet. Manager/CAM restrictions exist in app flow and server API checks, but final hard enforcement should be completed with Supabase RLS policies before production use.

Do not expose these in frontend env:

- `DATABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- raw database password

## SQL Files

Recommended run order for a fresh database:

1. `supabase/cam_crm_schema.sql`
2. `supabase/step_1_auth_setup.sql`
3. `supabase/step_6_daily_sop.sql`
4. `supabase/step_7_user_management.sql`
5. `supabase/step_8_client_management.sql`
6. `supabase/step_11_report_history.sql`
7. `supabase/step_12_audit_logs.sql`
8. `supabase/step_14_shared_client_profile_fields.sql`
9. `supabase/step_15_client_profile_intake_fields.sql`
10. `supabase/step_16_prop_firms_platform_access.sql`
11. `supabase/step_17_real_daily_sop.sql`
12. `supabase/step_20_cam_client_permissions.sql`
13. `supabase/step_21_client_subscription_price.sql`
14. `supabase/step_22_ingest_devices.sql`
15. `supabase/step_28_auto_collection.sql`
16. `supabase/cam_crm_verification_queries.sql`

No SQL required:

- `supabase/step_13_data_tools.md` documents Manager Data Tools for DB-safe export/import.
- `supabase/step_19_intake_import.md` documents Manager intake CSV import from Google Sheet exports.

Cleanup:

- `supabase/step_10_remove_starter_data.sql` removes the old starter rows from public tables. Run it only after confirming those legacy keys are not being used for real clients.
- Supabase Auth users are separate from public tables. Remove or disable old starter Auth users in Supabase Dashboard -> Authentication -> Users if they should no longer exist.

## Tables

| Table | Purpose | App Status |
| --- | --- | --- |
| `cam_profiles` | CAM workspace/person profile | Read/write |
| `app_users` | App-level user profile linked to Supabase Auth | Read/write through Manager Users & Access |
| `clients` | Client master records | Read/write |
| `client_assignments` | CAM/client ownership and transfer | Read/write |
| `trading_accounts` | Persistent account registry | Read/write |
| `daily_imports` | One close/import per client per trading date | Read/write |
| `account_snapshots` | Frozen daily account metrics | Written by import persistence |
| `strategy_snapshots` | Strategy state per account/day | Written by import persistence |
| `orders` | NinjaTrader orders | Table ready; imported when order CSV is provided |
| `executions` | NinjaTrader executions | Written by import persistence |
| `operational_flags` | Auto-generated review queue | Read/write from recalculate/resolve |
| `tasks` | Client/account tasks | Read/write |
| `activity_logs` | Call/note/alert/message timeline | Read/write |
| `client_credentials` | VPS/NT/firm credential fields | Read/write; server-side encryption still pending |
| `client_prop_firms` | Multiple client prop firm logins/connections | Read/write; server-side encryption still pending |
| `price_checks` | Manual price/algo status checks | Read/write |
| `payout_events` | Payout history | Read/write |
| `reports` | Generated report history | Read/write from Build Daily Report |
| `audit_logs` | Change audit trail | Read/write; Manager Audit Logs panel shows recent entries |
| `sop_templates` | Daily SOP template master | Read/write through Manager SOP Builder |
| `sop_sections` | Daily SOP sections | Read/write through Manager SOP Builder |
| `sop_items` | Daily SOP checklist items | Read/write through Manager SOP Builder |
| `daily_sop_checklists` | Per-CAM daily checklist progress, including per-item checked state JSON | Read/write |
| `ingest_enrollments` | One-time, expiring device-pairing enrollments | Server API/service role only |
| `ingest_devices` | Legacy watcher bindings plus hashed collector credentials and health | Server API/service role only |
| `ingest_batches` | Immutable raw auto-collection batch claims and processing state | Server API/service role only |
| `ingest_pair_rate_limits` | Durable HMAC-keyed pairing attempt windows and blocks | Server API/service role only |

## Frontend Read Model

`src/domain/supabaseStore.js` reconstructs this shape for the React app:

```text
state
  accountManager
  camProfiles[]
    clientIds[]
  clients[]
    profile
    credentials
    accountRegistry
    dailyImports[]
      accounts
      snapshots[]
        strategies[]
      strategies[]
      executions[]
      flags[]
    tasks[]
    activityLog[]
    priceChecks[]
```

## Integration Checklist

- [x] Create Supabase schema.
- [x] Add verification queries.
- [x] Install `@supabase/supabase-js`.
- [x] Add Supabase client.
- [x] Add `/database` connection check page.
- [x] Replace local login with Supabase Auth login.
- [x] Scope CAM sidebar/search/analytics to assigned clients.
- [x] Wire account registry updates to Supabase.
- [x] Wire tasks/activity updates to Supabase.
- [x] Wire flags and close-day updates to Supabase.
- [x] Add Daily SOP template and checklist persistence to Supabase.
- [x] Add Manager SOP Builder CRUD for sections/items.
- [x] Wire Manager Users & Access to Supabase Auth + `app_users` via server API.
- [x] Add Manager Client Management for create/delete/transfer assignment.
- [x] Move CSV import/reconcile writes to Supabase.
- [x] Remove old starter data and browser business persistence.
- [x] Persist generated report history into `reports`.
- [ ] Add production RLS policies.
- [ ] Move credential encryption/decryption to server-side code.
- [x] Add basic audit logging into `audit_logs`.
- [x] Add DB-safe Manager Data Tools export/import.
- [x] Ensure existing client profile fields are shared between CAM and Manager views.
- [x] Add client profile intake fields for product key and additional emails.
- [x] Add multiple prop firm records and NinjaTrader password field.
- [x] Replace Daily SOP content with the real CAM checklist.
- [x] Add Manager intake CSV import path for unassigned onboarding clients.
- [x] Add per-CAM create/delete client permission flag.
- [x] Add name/email duplicate protection and preview for client intake imports.
- [x] Add Google Sheet intake fetch/import audit logging.
- [ ] Expand audit coverage to every low-level data mutation.
- [ ] Apply and verify `step_28_auto_collection.sql` twice on disposable/staging Supabase; local static contract coverage is documented in `docs/verification/auto-collection-schema.md`.
- [x] Add atomic enrollment generation/rebind/revoke RPCs and durable pairing rate-limit state to `step_28_auto_collection.sql`.

## Permission Direction

- `Manager`: intended full operational permissions for users, clients, CAM assignments, SOP templates, account data, flags, tasks, reports, and imports.
- `CAM`: intended scoped access to assigned clients and own Daily SOP progress.
- `CAM can_manage_clients`: optional Manager-controlled permission that allows a CAM to create and deactivate clients from the CAM workspace.
- Final hard database enforcement is still pending RLS. Until RLS is enabled, restrictions are primarily enforced by app flow and server API checks.

## Verification Queries

Use `supabase/cam_crm_verification_queries.sql`.
