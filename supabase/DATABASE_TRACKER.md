# CAM CRM Supabase Database Tracker

Last updated: 2026-07-01

## Connection Status

- Supabase project URL: `https://rmokyixyhgdwcjbqilsd.supabase.co`
- Local database check page: `http://127.0.0.1:5173/database`
- Frontend env keys expected:
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_PUBLISHABLE_KEY`
- App integration status: connected at startup through `src/lib/supabaseClient.js`
- Data adapter status: `src/domain/supabaseStore.js` maps Supabase rows back into the existing local app state shape.
- RLS status for current migration phase: disabled / not enforced yet.

Do not store these in frontend env:

- `DATABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- raw database password

## SQL Files

Run order:

1. `supabase/cam_crm_schema.sql`
2. `supabase/cam_crm_seed_demo.sql`
3. `supabase/cam_crm_verification_queries.sql`

Auth migration:

4. Create users in Supabase Dashboard -> Authentication -> Users.
5. Run `supabase/step_1_auth_setup.sql`.

## Seed Coverage

The demo seed represents the current localStorage demo data:

- 5 CAM profiles
- 6 app users
- 6 clients
- 7 client assignments
- 17 trading accounts
- 42 daily imports
- 119 account snapshots
- 98 strategy snapshots
- current-day executions
- 10 operational flags
- activity logs
- tasks
- payout events
- empty client credentials rows

## Tables

| Table | Purpose | Seeded Data |
| --- | --- | --- |
| `cam_profiles` | CAM workspace/person profile | Pedro, Amanda, Juan Pablo, Ed, Sarah |
| `app_users` | App-level user profile linked later to Supabase Auth | Manager plus 5 CAM users |
| `clients` | Client master records | Rome, Todd, Amanda Capital, Blanco Family, Ed, Sarah Training Pool |
| `client_assignments` | Many-to-many CAM/client ownership | Pedro owns Rome/Todd/Blanco; Juan backs up Blanco; others own one client |
| `trading_accounts` | Persistent account registry | Account type, status, payout state, targets, drawdown limits |
| `daily_imports` | One close per client per trading date | 7 days per client using `current_date - 6..0` |
| `account_snapshots` | Frozen daily account metrics | PnL, weekly PnL, balance, drawdown |
| `strategy_snapshots` | Strategy state per account/day | Strategy family/version, realized PnL, parsed params |
| `orders` | NinjaTrader orders | Empty in seed; table ready for CSV imports |
| `executions` | NinjaTrader executions attributed to strategy | Current-day entry/exit demo executions |
| `operational_flags` | Review queue | Critical/warning flags on latest imports |
| `tasks` | Client/account tasks | Rome and Todd demo tasks |
| `activity_logs` | Call/note/alert/message timeline | Rome and Todd demo activity |
| `client_credentials` | VPS/NT/firm credential fields | Empty placeholder rows per client |
| `price_checks` | Manual price/algo status checks | Empty in seed; table ready |
| `payout_events` | Payout history | Rome, Todd, Amanda, Blanco, Sarah payout events |
| `reports` | Generated report history | Empty; table ready |
| `audit_logs` | Future change audit trail | Empty; table ready |

## Expected Row Counts

After running the seed, the verification query should report:

| Table | Expected Count |
| --- | ---: |
| `cam_profiles` | 5 |
| `app_users` | 6 |
| `clients` | 6 |
| `client_assignments` | 7 |
| `trading_accounts` | 17 |
| `daily_imports` | 42 |
| `account_snapshots` | 119 |
| `strategy_snapshots` | 98 |
| `executions` | 26 |
| `operational_flags` | 10 |
| `sop_templates` | 1 active default template from `step_6_daily_sop.sql` |
| `sop_sections` | 5 Daily CAM Checklist sections |
| `sop_items` | 27 checklist items |
| `tasks` | 7 |
| `activity_logs` | 8 |
| `daily_sop_checklists` | Created in `step_6_daily_sop.sql`; grows as CAMs use Daily SOP |
| `payout_events` | 11 |

## Frontend Read Model

`src/domain/supabaseStore.js` reconstructs this shape for the existing React app:

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

## Current Integration Notes

- The first integration phase is read-only for Supabase data.
- Existing UI actions still update React/local state only unless later wired to Supabase write APIs.
- Dummy login still uses the existing local demo users.
- Supabase Auth is not yet required for this phase.
- `orders` is intentionally empty in seed because demo executions already include `strategy_name`; real CSV import should populate `orders` and use `order.id -> execution.orderId`.

## Next Migration Checklist

- [x] Create Supabase schema.
- [x] Seed demo database.
- [x] Add verification queries.
- [x] Install `@supabase/supabase-js`.
- [x] Add Supabase client.
- [x] Add read adapter from Supabase tables to current app state.
- [x] Load Supabase data on app startup.
- [x] Add `/database` connection check page.
- [x] Create Supabase Auth users.
- [x] Run `step_1_auth_setup.sql`.
- [x] Replace dummy login with Supabase Auth login.
- [x] Scope CAM sidebar/search/analytics to assigned clients.
- [x] Wire account registry updates to Supabase.
- [x] Wire tasks/activity updates to Supabase.
- [x] Wire flags and close-day updates to Supabase.
- [x] Add Daily SOP template and checklist persistence to Supabase (`step_6_daily_sop.sql`).
- [x] Add manager SOP Builder CRUD for sections/items.
- [ ] Move CSV import/reconcile writes to Supabase.
- [ ] Add RLS policies.
- [ ] Move credential encryption/decryption to server-side code.

## Verification Queries

Use `supabase/cam_crm_verification_queries.sql`.

The final smoke assertion query should return zero rows. If it returns rows, the seed counts do not match expectations.
