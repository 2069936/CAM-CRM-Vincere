# Work summary — `dev/natanel` (2026-07-10)

Handoff of everything done on this branch: what changed, where it lives, and
what's pending. Audience: whoever merges/implements (Natanel / Sam).

Base: branch is `dev/natanel` on top of `main` (`3a7bd34`). All work goes to
Natanel via **PR #2** (`pedro-cmyks:dev/natanel` → `2069936:dev/natanel`).

---

## 1. Changes in this branch

| Commit | What | Files | Status |
|---|---|---|---|
| `e7451e4` | `.env.example` could never be committed (a trailing `.env*` in `.gitignore` overrode `!.env.example`) | `.gitignore`, `.env.example` | ✅ done |
| `0d9f518` | SPA rewrite — `/database` and refresh 404'd on Vercel with no fallback | `vercel.json` | ✅ done |
| `aa041d4` | User-admin API integrity: roll back orphaned Auth user on create failure; pre-check duplicate email/username on update before mutating Auth/CAM | `api/admin/users.js` | ✅ done |
| `fb18114` | Decouple CAM profile (client ownership) from role — a **Manager can now also have clients** (admin+clients case) | `api/admin/users.js`, `src/App.jsx` | ⚠️ API ✅; **UI part must be re-applied on the shadcn UI** (see §4) |
| `e801f0f` | Client **CAM subscription price** field — data layer | `supabase/step_21_client_subscription_price.sql`, `src/domain/subscriptionPrice.js`, `src/domain/supabaseStore.js`, `supabase/DATABASE_TRACKER.md` | ✅ backbone; needs SQL run + UI (see §3) |

**Conflict status with the `dev/sam` shadcn rewrite:** `dev/sam` only rewrote UI
(`App.jsx`, `components/`, css). It did **not** touch `api/admin/users.js`,
`supabaseStore.js`, or any SQL. So every change above is conflict-free **except
the `App.jsx` UI half of the decouple** (`fb18114`), which must be re-applied on
the new shadcn form after `dev/sam → main`.

---

## 2. Steps to make it live

1. **Push:** `git push` → updates PR #2 with all commits.
2. **Run SQL:** open `supabase/step_21_client_subscription_price.sql` in the
   Supabase Dashboard → SQL Editor and run it (adds `clients.subscription_price`).
   Without this the column doesn't exist and the field won't save.
3. **Merge PR #2** into `dev/natanel` (then to `main` per your flow).
4. **Wire two UI bits** on the shadcn UI (see §3 and §4).

---

## 3. Subscription-price field — UI wiring (Sam / post-merge)

Data layer is done. Only the form input is missing.

- Options: `import { SUBSCRIPTION_PRICES } from 'src/domain/subscriptionPrice'`
  → `['$500', '$250', 'Free', 'Undetermined']`
- Value lives at `client.profile.subscriptionPrice` (read + written by
  `supabaseStore`, defaults to `'Undetermined'`).
- Add a dropdown (shadcn `Select`) in the client form bound to it, and include
  `subscriptionPrice` in the `profile` patch on save, exactly like the other
  profile fields (`stage`, `email`, …).

---

## 4. Decouple (Manager + clients) — re-apply on shadcn

The **API** is already decoupled (`aa041d4` / `fb18114`). The `dev/sam` UI still
gates the CAM-profile toggle behind `role === CAM`:
- `App.jsx` ~`1809` (create submit), ~`1856` (edit), ~`2202` (role onChange),
  and the **disabled checkbox** ~`2211-2212`.

After the merge, remove that role gate in the shadcn user form so the
CAM-profile toggle is enabled for **every** role (a Manager can turn it on).
Four valid combinations must all work: Manager+clients, Manager-only,
CAM+clients, CAM-only.

---

## 5. NinjaTrader `log` / `trace` analysis (V1)

Files reviewed (NOT committed — contain real account IDs / firm names):
`log.*.txt` + `log.*.en.txt` (event log, ~700–900 lines), `trace.*.txt`
(internal debug, ~28k lines).

**Question:** can `trace`/`log` **replace or complement** the 4 CSV exports
(`accounts`, `strategies`, `orders`, `executions`)?

**Verdict: COMPLEMENT, not replace.**

| Current export | Key fields (`csvImport.js`) | In log/trace? |
|---|---|---|
| `accounts` | `displayName`, `cashValue`, `grossRealizedPnl` (balances, PnL, drawdown) | ❌ **NO** — no balance/equity/PnL values anywhere. Irreplaceable. |
| `strategies` | `strategy`, `accountDisplayName`, `parameters` | ⚠️ partial — has strategy↔account map + enable/disable + config, but not the full `parameters` blob |
| `orders` | `state`, `orderType`, `filled`, `remaining` | ✅ full order lifecycle — `Order='id/account' New state='Filled' … Quantity=6 Fill price=2986.3` |
| `executions` | `entryExit`, `orderId`, `price` | ✅ full fills — `Execution='…' Account='…' Price=2986.3 Quantity=6 Market position=Short` |

**What the log gives that the exports don't:** the complete order + execution
stream for **all** accounts in one file, including order **rejections** (e.g.
"You need an active Prop Firm subscription to trade this contract."), exact
state-transition timestamps, and per-fill long/short.

**What it can't give:** account balances / equity / drawdown / realized-PnL
snapshots — logs are events, not state. That is exactly the `accounts` export.

**Bonus — this is the right source for F6 (bullet bot analytics):** the log
contains `BulletBot/388413837` order + execution events with
`Market position=Long/Short` and timestamps → directly supports long-vs-short
pass rate and pass frequency, which the CSV exports don't carry at per-trade
granularity.

**Recommendation:**
- Keep the `accounts` export (balances) — required, not replaceable.
- Optionally add a **log parser** (regex over `log.en` `Order=` / `Execution=`
  lines) to (a) replace/enrich `orders` + `executions` with a single richer
  source and (b) power F6. New parser needed — this is line-based text, not CSV.
  Use the `log`, not the `trace` (trace is too low-level/noisy for trade data).

---

## 6. Backlog status

| # | Item | Status |
|---|---|---|
| F1/F2 | Client subscription price | ✅ data layer; UI pending (§3) |
| F3 | Manager view: Cash vs Funded separated | not started |
| F4 | Movements differentiated by account type | not started (needs spec) |
| F5 | Evals: pass/fail + % to pass | not started (needs pass formula) |
| F6 | Bullet bot: long/short + frequency | not started — **data source found: the log** (§5) |
| V1 | NT log/trace vs exports | ✅ done (§5) |

**Pre-existing issues (not introduced by us; ride into `main` via `dev/sam`):**
- "Split-brain": a deactivated CAM's clients read as unassigned in the roster
  but still-owned in the historical drill-down and payouts views (those two use
  raw `camProfiles`; everything else uses `activeCamProfiles`). Med.
- Clicking a truly-unassigned client defaults to opening the `am-pedro`
  workspace (`openCamWorkspace(camId = "am-pedro")`). Low.

Both are fixable when we re-sync onto the shadcn UI; they need a product call on
whether "deactivate a CAM" should unassign clients or be reversible.

---

## 7. Update — end of day (2026-07-10)

Three more commits landed on top of the summary above (branch now at `5009890`):

| Commit | What | Files |
|---|---|---|
| `d36d066` | Flag an **evaluation account that reaches its target** (bullet-bot + standard) → "deactivate and confirm consistency to activate". Mirrors the funded `Payout eligible` flag; Cash excluded (no target). | `src/domain/reconcile.js` |
| `a6681f4` | **NinjaTrader log parser** (`parseNinjaTraderLog`) — the dated daily logs persist on disk (unlike the same-day CSV exports), so they backfill historical order/execution/strategy events. Validated on a real 877-line log: 385 orders, 37 executions, 47 strategy events. | `src/domain/ninjaTraderLog.js` |
| `5009890` | **Bullet-bot performance over time** (`buildBulletBotStats`) — per BB eval account: direction, fired, passed (balance ≥ target) + days-to-pass; aggregated pass rate / fired / avg-days-to-pass, split Long vs Short. | `src/domain/bulletBotStats.js` |

All three are pure `src/domain/` modules → **conflict-free with the `dev/sam` UI rewrite**. 302 tests pass.

**Log attribution caveat:** the raw log cannot attribute bullet-bot fills on its own — strategy events key the account as `388413837` while orders/executions key it as `LTD…`, and the log never links the two. So BB analytics run on the app's stored strategy history (already linked by the `strategies` export); the log parser is a general backfill path.

**Manager dashboard direction (approved):** replace the current long-list manager view with a grouped, click-to-expand dashboard — panels for weekly PnL by segment, bullet-bot over time, strategy analyzer (0–10), lifecycle, action queue, CAM leaderboard, subscription MRR — mapped from the existing master-spreadsheet logic. Data functions get built in `domain/` (conflict-free); panels get wired on the shadcn UI.

**Creating new CAMs:** works today via the create-user toggle (already in main). A Manager who *also* has clients requires the decouple (§4) — coded, pending merge + runtime test + re-apply on the shadcn form. Runtime user creation needs Supabase access (Manager panel or a seed script).

**Backlog delta:** F6 analytics ✅ (`buildBulletBotStats`), UI panel pending. New: "evaluation target reached" alert ✅. Still open: consistency validation (% of profit in one day vs total, per-firm thresholds), Cash-vs-IRA split (Rick), F3/F4/F5 UI panels.
