# Shadcn UI wiring handoff (for Sam)

Our backend/domain work is now merged on top of your shadcn `main` (re-sync done —
merge commit brings your UI + our logic together). **All logic is built and tested
(305 tests, build clean).** What's left is wiring it into the shadcn UI, which you
can test with Supabase. Below is each piece with the exact functions to call.

App.jsx took the shadcn version in the merge, so our UI touch-points need
re-applying on your components. The domain modules and helper components
(`src/components/ChangePassword.jsx`, `src/components/ProfilePanel.jsx`) are in the
tree for reference — restyle or reuse the logic.

---

## 1. Decouple — a Manager can also have a CAM profile
The API is already decoupled (`api/admin/users.js`: `wantsCamProfile` no longer
requires `role === 'CAM'`). The shadcn create/edit-user form still gates the
"CAM profile" toggle behind `role === CAM` (disabled for Managers). **Enable the
toggle for every role** so a Manager can also own clients (the admin-who-has-clients
case). Four combos must all work: Manager+clients, Manager-only, CAM+clients, CAM-only.

## 2. Profile panel + self-service password
- `import { changeOwnPassword } from 'src/lib/supabaseClient'`
  → `await changeOwnPassword(newPassword)` — uses the caller's own Supabase session
  (not the admin API), min 8 chars, no old password required.
- Add a **"Profile"** nav item (like Users & Access) → panel showing the signed-in
  user's **name, username, email** (`supabase.auth.getUser()` → `.email`), **role**,
  plus a **change-password** form.
- Reference: `src/components/ProfilePanel.jsx` + `ChangePassword.jsx`.

## 3. Sticky client-view sidebar
The client-view sidebar scrolls away with the page (the manager sidebar is already
fine). Make the client sidebar sticky with its own scroll:
`position: sticky; top: 0; height: 100vh; overflow-y: auto`.

## 4. Remove the "Open Peter's Workspace" button
Leftover demo button that always opened the first CAM (hardcoded `am-pedro` /
"Pedro" fallback). Remove it, or turn it into a CAM picker.

## 5. Client subscription price field
- Data layer done. Run `supabase/step_21_client_subscription_price.sql` on the DB.
- Value: `client.profile.subscriptionPrice` (read/written by supabaseStore, default
  'Undetermined').
- `import { SUBSCRIPTION_PRICES } from 'src/domain/subscriptionPrice'`
  → `['$500', '$250', 'Free', 'Undetermined']`.
- Add a dropdown in the client form bound to `profile.subscriptionPrice`.

## 6. NinjaTrader log/trace import → client history  ⭐ (the big new one)
**Goal:** upload a NinjaTrader daily log to backfill history. Those files persist on
disk with the date in the filename (`log.20260710.00000.txt`), unlike the CSV grid
exports which can only be pulled the same day.

Functions (`src/domain/ninjaTraderLog.js`, all tested):
- `dateFromLogFilename(filename)` → `'2026-07-10'` from `'log.20260710.00000.txt'`.
- `parseNinjaTraderLogFile(filename, text)` → `{ date, filename, orders, executions, strategyEvents }`.
- `summarizeLogByAccount(parsedFile)` → per-account daily activity:
  `[{ accountName, date, fills, contracts, long, short }]`.

UI: a **file upload** (reuse the UploadArea pattern) that accepts log/trace files,
reads the text, calls `parseNinjaTraderLogFile(file.name, text)`, and shows/stores
the per-account activity keyed by the filename date.

**Caveats (important):**
- The log has trade **activity** (fills, long/short) but **NOT account balances** —
  so it backfills *activity* history, not balance/PnL snapshots (those still come
  from the `accounts` CSV export).
- The log's strategy account id (`388413837`) differs from the order account
  (`LTD…`) and the log never links them — attribute to a strategy via the account
  registry, not the log alone.
- Persistence: store the per-day / per-account activity in Supabase (new table, or
  extend `daily_imports`) so it shows as history over time.

Validated on a real 877-line log: dated `2026-07-10`, 385 orders / 37 executions,
2 accounts summarized (LTD…002: 15 fills 9L/6S; LTD…001: 22 fills 14L/8S).

## 7. Manager dashboard (approved direction)
Grouped, click-to-expand dashboard replacing the long-list manager view — panels for
weekly PnL by segment, **bullet-bot over time** (`buildBulletBotStats(clients)`),
strategy analyzer (0–10), lifecycle, action queue, CAM leaderboard, subscription MRR.

---

## Domain functions ready to wire (all tested)
| Function | File | Returns |
|---|---|---|
| `changeOwnPassword(pw)` | `lib/supabaseClient.js` | updates the user's own password |
| `SUBSCRIPTION_PRICES` | `domain/subscriptionPrice.js` | the 4 options |
| `parseNinjaTraderLogFile(name, text)` | `domain/ninjaTraderLog.js` | dated parsed log |
| `summarizeLogByAccount(parsed)` | `domain/ninjaTraderLog.js` | per-account activity |
| `buildBulletBotStats(clients)` | `domain/bulletBotStats.js` | BB performance over time |
| eval-target flag | `domain/reconcile.js` | already active (fires on Evaluation accounts at target) |
