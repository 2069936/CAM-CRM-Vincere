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
| `buildAlgoComboPerformance(allClients)` | `components/StackPlaybook.jsx` | team-wide algo-combo pool (already exists) |
| `buildClientSegments(client, dailyImport)` | `domain/clientSegments.js` | balance + PnL split by account type (never a total) |
| `buildClientPropFirms(client, dailyImport)` | `domain/clientSegments.js` | the client's prop firms (connections), grouped |

---

## 8. CAM view sync: Team overview + Stack Playbook only see the CAM's own data

Both the **Team overview** (bottom of CAM Overview) and the **Stack Playbook**
"Team Algo Performance" / "vs Team avg" are built from `allClients`, which in the
**CAM view is scoped to the signed-in CAM's own clients**. Effect:
- Team overview shows every *other* CAM as `0 clients · 0 accounts · $0 weekly`
  (only the current CAM's row is real).
- Stack Playbook's "team" pool is really just the CAM's own clients — so it
  compares the CAM against themselves, not the team.

The Manager view is correct because it loads all clients. The logic is fine; the
CAM view just isn't given team-level data.

**Fix:** feed the CAM view a lightweight **team aggregate** (privacy-scoped — no
other CAMs' client records or flags):
- Per-CAM summary — clients, accounts, **weekly PnL** — for the Team overview
  leaderboard. (A CAM does NOT need other CAMs' flags; weekly PnL is the compare
  metric they want.)
- Team-wide **algo-combo pool** (`buildAlgoComboPerformance` over all clients) for
  the Stack Playbook, passed in as `allClients` or a dedicated pooled dataset.

Requested by Pedro: as a CAM he wants to benchmark his weekly PnL and his per-algo
performance against the team. Aggregates only — this is a sync/data-loading fix,
not new UI or a redesign.

---

## 9. Per-account balance in the UI + balance/PnL split by account type in the report

Three related asks from Pedro. **The data already exists** on every snapshot
(`accountBalance` from cash value, `grossRealizedPnl`, `trailingMaxDrawdown`) and
in the account registry (`accountType`, `connection`). This is display + grouping,
no new data. Two tested helpers do the grouping for you — see the table above.

### 9a. Show the balance per account (all accounts) in the client view
Today the per-account balance is captured and used internally (payout eligibility,
funded tracking) but never shown next to each account. In the client's account
list, show for **every** account: **balance** (`snapshot.accountBalance`) and, when
present, the **trailing buffer** (`snapshot.trailingMaxDrawdown`). Caveat Pedro
hit live: his NinjaTrader grid export was missing the *Trailing max drawdown*
column, so trailing came in as 0 — show a dash, not `$0`, when the column is absent.

### 9b. Report: balance AND PnL split by account type — NOT a combined total
In the report the balance and PnL must be shown **separated by account type**, not
summed into one number. Pedro cares about three pools specifically:
- **Evaluations running normal algorithms** (`Evaluation - Standard`)
- **Funded accounts** (`Funded`)
- **Cash accounts** (`Cash`)

Already computed for you: **`report.segments`** on the object returned by
`buildDailyReportSummary` (the same `report` the daily view already uses). Shape:
`{ funded, cash, evalStandard, bulletBot, other }`, each `{ balance, dailyPnl,
count, accounts[] }`. No new call needed — just read `report.segments`. Render one
balance figure and one PnL figure **per segment** (Eval-standard / Funded / Cash).
Do not add them together — a Funded $52k, a Cash $10k and an Eval $51k are three
separate pools, not $113k. (Bullet-bot evals are tracked by pass/fail, not balance
— you can omit their balance from the report; `buildBulletBotStats` covers them.)

**Cash PnL is net of fees — do not label it "Gross".** Pedro confirmed his
NinjaTrader "Realized PnL" column already has commissions subtracted, so the
`dailyPnl` we carry for a Cash account is the net figure. For the Cash segment
label the PnL as "Realized (net)" — not "Gross". No compute change: the number is
already correct; the fix is purely the label. (The combined report headline was
renamed from "Daily / Gross PnL" to "Daily Realized PnL" for the same reason.)

### 9c. Client overview: click "accounts tracked" → reveal the client's prop firms
In a client's overview the CAM sees a count of accounts tracked but not *what* they
are. Make that count expandable: on click, list the **prop firms** the client runs
on (grouped, with the account count per firm) so the CAM can see at a glance which
firms to turn on. Use `buildClientPropFirms(client, dailyImport)` → sorted array of
`{ firm, count, accounts[] }` (firm = the account `connection`).

Requested by Pedro verbatim: balance visible for all accounts in the UI; in the
report balance + PnL "separados" by eval / funded / cash, "no es un balance total";
and clicking accounts-tracked should "dejar saber qué prop firms tiene, para
prenderlas más fácil".
