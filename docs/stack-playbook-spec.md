# Stack Playbook: what it says, what it measures, what to change

Repo `/Users/pedro/Developer/CAM-CRM-Vincere`. Book `public/local-snapshot.json` (export dated 2026-08-20; last close inside it 2026-07-30). Every number below was produced by `scratchpad/playbook/spec_numbers.py` (raw tables, app rules replicated line by line; output `spec_numbers.json`) or `spec_contracts.py`, and cross-checked against `audit.md` / `recompute.md` (the real `buildAlgoComboPerformance` run through `buildCrmStateFromTables`, `app_vs_recompute_all_match: true`). Amounts to the cent. Code anchors are `src/components/StackPlaybook.jsx` unless another file is named.

Population the whole tab stands on (spec_numbers.py `population`): 96 visible clients (40 hidden by `supabaseStore.js:384-386`), 2,934 account-days, of which **865 are Funded and not Failed/Inactive by the account's current row** (`StackPlaybook.jsx:101-102`), total P&L **-$127,292.95**, **-$147.16 per account-day**, 14 closes 2026-07-13..2026-07-30, one calendar month (2026-07).

---

## 1. What the screen says today and what it actually measures

Panel "Team Algo Performance" (`:628-711`), table columns `:671-678`, aggregator `:86-159`. Panel "Client Config vs Team Avg" (`:713-767`), builder `:162-214`. Income Projection `:222-256`, `:873-880`.

| Screen label | What the code computes | Population | Time window | What the number really is |
|---|---|---|---|---|
| Badge `96 clients · 104 account-runs` (`:632`, `:339`) | `teamClients.length` and `Σ row.accounts` over combo rows | 96 = every visible client, incl. 63 with no row in the table (32 rows draw on 33 clients); 104 = sum of per-combo account sets, so 91 distinct accounts are counted 104 times | none | Not "clients in the table" and not "accounts" |
| Select `Last 7d / 30d / 60d / 90d / 180d`, default 30 (`:278`, `:633-640`), tooltip "Trend / recent-average window" | `windowDays` gates only `isRecent`/`isPrior` (`:95-97`, `:129-130`) | | Only the Trend and Last Nd avg columns | A trend window, not a filter. The book has 18 calendar days, so at 30d the window is a no-op on all 32 rows |
| Caption "Aggregated from every client running each algo combination" (`:648`) | | Funded, not Failed/Inactive by CURRENT status, visible clients, and only days with at least one strategy `enabled` at CSV export time (`:28-41`, `:105`) | | 311 of the 865 funded account-days (36.0%); the other 554 (64.0%, -$81,792.12) are dropped as `Unknown` |
| Bars (top 8 by avgPnl, `:654`) | `abs(avgPnl)/max` | same as table | all history | 4 of the 8 bars are single-account-day rows |
| **Combo** (`:671`) | `comboFromStrategies`: enabled rows only; family upper-cased; `includes('URGO')` → URGO, `includes('IFSP')` → IFSP (folds IFSP_PF), `includes('BULLET')` → Bullet, else `slice(0,8)`; sorted, de-duplicated, joined ` + ` (`:28-41`) | | | The set of families still switched on when the CSV was taken. Version dropped. IFSP_PF shown as IFSP; OGX_PF / RBO_PF / ARPD_PF kept apart. Not "what traded" |
| **Best** badge (`:686`) | row 0 after `sort((a,b) => b.avgPnl - a.avgPnl)` (`:158`) | | all history | Highest unweighted mean with no minimum days / accounts / clients. Today: 1 account, 1 day, +$265.00 |
| **Avg P&L / day** (`:672`) | `totalPnl / days`, `totalPnl = Σ snap.grossRealizedPnl` (`:122-125`, `:137`) | Funded + not Failed/Inactive + combo known | **all history**, window ignored | Mean of the ACCOUNT's day result (not the combo's) over account-days where the combo was enabled at export; `grossRealizedPnl` is the grid's net-of-commission "Realized PnL" whenever non-zero, gross only as fallback (`csvImport.js:244`, `autoImport.js:70-78`); one account-day = one vote regardless of size or contracts |
| **Win rate** (`:673`) | `round(winDays/days*100)`, `winDays` = days with `pnl > 0` (`:126`, `:148`) | same | all history | Zero days count as losses: 119 of 311 kept days are exactly $0 |
| **Trend (Nd)** (`:674`) | up if `recentAvg > priorAvg*1.1`, down if `< priorAvg*0.9`, else stable; `recent` = age in [0,N), `prior` = age in [N,2N), age = anchor − di.date, anchor = latest close of ANY client (`:76-84`, `:140-144`) | same | N and the N days before it | At 30d `priorDays = 0` for all 32 rows → "stable" everywhere. With negative averages `×1.1` lowers the bar, so "up" means "less negative" |
| **Last Nd avg** (`:675`) | `recentPnl / recentDays`, null → "-" (`:138`) | same | last N calendar days | At 30d identical to Avg P&L / day on all 32 rows |
| **Accounts** (`:676`) | `|{clientId::accountName}|` ever seen on the combo (`:127`, `:150`) | same | all history | An account that ran the combo one day counts the same as one that ran it 12 days |
| **Clients** (`:677`) | `|{clientId}|` (`:128`, `:151`) | same | all history | Clients with at least one such account-day |
| **Total days** (`:678`) | `days` = number of account-days (`:125`, `:149`) | same | all history | Account-days, not calendar days: URGO "66" spans 12 calendar dates |
| Insight panel **Current combo** (`:727`, `:180`) | `comboFromStrategies` of the selected close's snapshot | selected client's Funded/not Failed/Inactive accounts | the one close | "Unknown" on 91 of 120 rows (each client at its latest close) |
| **This acct Nd avg** (`:728`, `:187-193`) | `Σ grossRealizedPnl / daysWithData` over every close of THIS account with age in [0,N) from the viewed close, whatever combo ran that day | | N days before the viewed close | Account average over all its days, not over its days on the shown combo (136 of 231 days = 59% are on the shown combo) |
| **Team avg (same combo)** (`:729`, `:194`) | `teamData.recentAvg ?? teamData.avgPnl` | table population | last N days when the combo has a day there, otherwise all history, one label | Enabled-at-export days only; silently switches basis |
| **vs Team** (`:730`, `:195`) | `accountAvg − teamAvg` | | mixed | Difference of two different day sets |
| **Insight** (`:731`, `:196-198`) | suggestion when `best.combo !== currentCombo && best.avgPnl > (teamData?.avgPnl ‖ 0) * 1.15` | | | Fires for 31 of 32 combos (the only exception is the best combo itself); Unknown → threshold 0. 120 of 120 rows get "Consider ARPD_PF + IFSP + OGX + RBO_PF - team avg $265/day" |
| Badge "Consider updating" / "On best combos" (`:718-720`) | `clientInsights.some(i => i.suggestion)` | | | Always "Consider updating" on this book |
| Income Projection "Avg monthly P&L per funded account" (`:223`, `:232-233`) | `useState(800)`, input `min={100}` | | | A typed constant, never derived. Book: -$147.16 per account-day, × 21 closes = **-$3,090.35** per funded account per month; the input cannot express a negative number |
| Income "Current funded" (`:242`, `:262-266`, `:879`) | registry rows Funded and not Failed/Inactive | includes Reserve (2) and accounts with no snapshot (4 of 178) | | Registry count, not trading accounts |
| Heatmap "Combo × Prop firm" "Avg PnL/day by combo under each firm's rules" (`:547`, `stackAnalytics.js:122-154`) | `Σ pnl / days` per (combo, `snapshot.connection`) | **no account-type or status filter**: all 3,100 account-days incl. evaluations and Bullet Bot | all history | Different population from the table two panels up; `connection` is free text (11 spellings of BluSky in the book) |

---

## 2. Where it differs from reality

All figures: `spec_numbers.py` unless noted. "App" = the table as rendered today.

### 2.1 Blocker: 64.0% of funded account-days are dropped because the combo key is the export-time `enabled` flag

`enabled` is `parseBool(row.enabled)` of the NinjaTrader Strategies-grid checkbox at export (`csvImport.js:283`), stored per `strategy_snapshots` row and read back as `Boolean(row.enabled)` (`supabaseStore.js:76`). `comboFromStrategies` keeps only enabled rows (`:30`) and `:105` skips `Unknown`.

| | account-days | P&L |
|---|---:|---:|
| Funded, not Failed/Inactive (population) | 865 | -$127,292.95 |
| Kept in the table (combo known) | 311 | -$45,500.83 |
| Dropped: strategy rows present, all `enabled = false` | 456 | -$80,953.62 |
| Dropped: no strategy rows at all | 98 | -$838.50 |

455 of the 456 all-disabled days have every strategy `realized = 0` while the account moved on 271 of the 554 dropped days; 270 of those 271 have execution rows that day and **245 name the algo in `executions.strategy_name`, carrying -$73,277.42**. Per close: 2026-07-22 has 85 funded account-days and 0 in the table (-$11,250.42 vanish); 2026-07-28: 24 kept vs 81 dropped (-$24,727.00); 2026-07-30: 28 vs 65 (-$16,805.80). Kept/dropped tracks `daily_imports.imported_at` hour (UTC): 19h 25/1, 20h 215/159, 21h 44/204, 22h 11/93, 00-03h 0/50. Whether a day counts depends on when the CAM exported.

Re-keyed on "enabled at export OR named in that account-day's fills" (family via `strategyFamilyOf`, `strategyFamily.js:29`, `-PF` normalised to `_PF` as `csvImport.js:220-221` does), 573 of 865 days attribute and the 292 still unknown carry only -$8,514.70:

| Combo | App avg / days / win | Traded avg / days / win |
|---|---:|---:|
| URGO | -$64.78 / 66 / 23% | -$124.72 / 107 / 20% |
| B2X | -$63.40 / 33 / 9% | -$176.49 / 57 / 12% |
| G4M | -$144.41 / 41 / 7% | -$184.78 / 48 / 6% |
| IFSP + URGO | -$151.79 / 33 / 18% | -$226.78 / 40 / 12% |
| IFSP | -$119.68 / 16 / 0% | -$209.63 / 31 / 0% |
| RBO | -$240.75 / 4 / 25% | -$247.22 / 29 / 41% |
| ARPD + URGO | **+$55.88** / 10 / 70% | **-$90.62** / 23 / 43% |
| OGX | absent | -$84.74 / 26 / 38% |
| OGX_PF | -$369.00 / 1 / 0% | +$8.63 / 7 / 43% |
| B2X + URGO | -$61.18 / 5 / 0% | -$331.16 / 17 / 12% |

Per family, account-days credited by the app vs days it actually traded: URGO 136 → 219, IFSP 116 → 171, B2X 64 → 104, RBO 41 → 96, **OGX 22 → 85**, G4M 60 → 72, ARPD 15 → 43.

### 2.2 Blocker: "Best" and 100% of suggestions rest on one account-day

Row 0 = `ARPD_PF + IFSP + OGX + RBO_PF`: client Oakley Larch, account `CGH59752528298726`, 2026-07-13, `gross_realized_pnl` 264.999999999999 (+$265.00), 1 account, 1 day; enabled rows OGX 2.4 (-302), ARPD_PF 1.1 (+430), RBO_PF 1.8 (+147), IFSP_PF 1.1 (-10). Sort `:158` has no gate. Of 32 rows: 7 have 1 day, 11 have ≤ 2 days, 14 have a single account, 28 have a negative average, 4 of the top 8 bars are 1-day rows. Rule `:196`: for the 28 negative rows `avg × 1.15 < avg`, so the "15% margin" is a 15% tolerance; for Unknown the threshold is `(undefined ‖ 0) × 1.15 = 0`. It fires for 31 of 32 combos. Insight panel over every visible client at its latest close: **120 rows, 120 suggestions, 91 with Current combo Unknown**, 41 clients, single suggestion text.

### 2.3 Major: version stripped from the key; `includes('IFSP')` folds IFSP_PF into IFSP

`strategyVersion` is mapped (`supabaseStore.js:70`) and never read by `comboFromStrategies`. `algoContribution.js:93` keys `family + ' ' + version` on the same tab. Enabled rows on kept days by family+version: URGO 4.5 136, IFSP 1.1 97, B2X 2.5 64, G4M 3.4 60, RBO 1.8 42, OGX 2.4 22, IFSP_PF 1.1 19, ARPD 1.1 15, OGX_PF 2.4 14, SYFY 1.4 13, RBO_PF 1.8 4, ARPD_PF 1.1 1, DJDR 1.1 1. **No family has two versions inside the population**, so version-stripping is latent today; the older URGO 2.0 and B2X 1.3 (7 enabled rows each, 2026-06-25..07-01) sit on one hidden client and would fold into URGO / B2X with no trace the moment that client became visible.

What bites now is the IFSP fold. Rows whose "IFSP" is IFSP_PF:

| App row | Versioned key | days | total |
|---|---|---:|---:|
| B2X + IFSP (12 d, -$4,478.20, avg -$373.18) | B2X 2.5 + IFSP 1.1 | 11 | -$4,144.20 (avg -$376.75) |
| | B2X 2.5 + IFSP_PF 1.1 | 1 | -$334.00 |
| IFSP + OGX_PF (12 d, -$596.50) | IFSP_PF 1.1 + OGX_PF 2.4 | 12 | -$596.50 |
| B2X + IFSP + URGO (2 d) | B2X 2.5 + IFSP_PF 1.1 + URGO 4.5 | 2 | -$861.00 |
| IFSP + OGX + RBO_PF (2 d) | IFSP_PF 1.1 + OGX 2.4 + RBO_PF 1.8 | 2 | -$331.00 |
| IFSP + OGX_PF + RBO_PF (1 d) | IFSP_PF 1.1 + OGX_PF 2.4 + RBO_PF 1.8 | 1 | +$22.50 |
| ARPD_PF + IFSP + OGX + RBO_PF ("Best") | ARPD_PF 1.1 + IFSP_PF 1.1 + OGX 2.4 + RBO_PF 1.8 | 1 | +$265.00 |

Instrument matters more than version on this export: IFSP 1.1 on NG AUG26 75 account-days -$16,350.10 (-$218.00/day) vs NG SEP26 22 account-days -$5,949.60 (-$270.44/day), first seen 2026-07-27.

### 2.4 Major: the window only moves Trend and Last Nd avg; at the default 30d it moves nothing

`totalPnl / days / winDays / accountSet / clientSet` accumulate on every close (`:124-128`); `windowDays` is read only at `:95-97` and `:129-130`. Anchor 2026-07-30, first close 2026-07-13. At 30d: `recentAvg === avgPnl` on 32/32, `priorAvg = null` on 32/32, trend "stable" on 32/32. What a real window would show (same rule applied to every metric, avg / days):

| Combo | 7d | 30d | 90d | all |
|---|---:|---:|---:|---:|
| URGO | -$41.49 / 45 | -$64.78 / 66 | -$64.78 / 66 | -$64.78 / 66 |
| B2X | -$138.30 / 18 | -$63.40 / 33 | same | same |
| G4M | -$209.02 / 17 | -$144.41 / 41 | same | same |
| IFSP + URGO | -$137.51 / 15 | -$151.79 / 33 | same | same |
| ARPD + URGO | +$80.80 / 4 | +$55.88 / 10 | same | same |
| RBO | -$1,038.00 / 1 | -$240.75 / 4 | same | same |
| ARPD_PF + IFSP + OGX + RBO_PF | no days | +$265.00 / 1 | same | same |

At 7d the "Best" row disappears entirely (its only day is 17 days before the anchor). 16 of the 79 clients with account-days have no close inside the last 7 days, so at 7d they contribute nothing to `recentAvg` but everything to `avgPnl`.

### 2.5 Major: population judged by CURRENT account status (survivorship) and by current client visibility

`meta` is the account's single current `trading_accounts` row (`supabaseStore.js:25-54`, `:503-507`, same object as `di.accounts` `:538` and `client.accountRegistry` `:612`); `dateFailed` (`:49`) is mapped and never read by the Playbook. 6 Funded accounts on visible clients are `Failed`; **`date_failed` is null on all 6**, `date_funded` null on all 184 visible Funded accounts.

Their own days with data (the "alive" range the fix will use): Devon Onyx `CDG81177005400329` 07-13..07-28 (6 days, 2 known, -$682.00); Devon Onyx `GEFJBDEFG485378909077` 07-13..07-28 (6, 2, -$783.00); Indigo Glen `GECCFDEGA590295455` 07-13 (1, 0, $0.00); Jordan Birch `BCGBEDCFDFBBGCKEF01028` 07-13..07-28 (6, 2, -$839.20); Oakley Glen `DHECCGHGADCEDEEG97297` 07-22..07-30 (6, 2, -$1,679.20); Parker Pine `CGGEBGBJ411844790362` 07-13..07-28 (6, 4, -$1,230.20). Total excluded: 31 account-days, -$5,213.60; 12 known-combo days, -$2,016.30 (-$168.02/day).

| Combo | App (current status) | Incl. Failed accounts' own days | Δ avg |
|---|---:|---:|---:|
| URGO | -$64.78 / 66 d / -$4,275.38 | -$73.98 / 70 d / -$5,178.78 | -$9.20 (app 14.2% too kind) |
| RBO | -$240.75 / 4 / -$963.00 | -$287.10 / 6 / -$1,722.60 | -$46.35 |
| IFSP + URGO | -$151.79 / 33 / -$5,009.20 | -$149.25 / 35 / -$5,223.60 | +$2.55 |
| IFSP + OGX + RBO | -$258.44 / 8 / -$2,067.50 | -$252.40 / 10 / -$2,524.00 | +$6.04 |
| ARPD + URGO | +$55.88 / 10 / +$558.80 | +$73.03 / 12 / +$876.40 | +$17.15 |
| Table | -$146.30 / 311 / -$45,500.83 | -$147.11 / 323 / -$47,517.13 | -$0.81 |

Hidden clients (40 with `deleted_at` + Inactive, dropped in the loader at `supabaseStore.js:384-386`): 51 Funded account-days, 7 clients, 9 accounts, -$273.00, 2026-06-25..07-16. They hold **all 28 `RBO_PF` days** (avg -$27.54, win 61%; the combo is absent from the app) and 14 of the 15 `OGX_PF` days (all clients: +$58.20 on 15 days vs app -$369.00 on 1 day). Month by month with hidden clients included: OGX_PF 2026-06 +$85.17 (12 d, 75% win) → 2026-07 -$49.67 (3 d); RBO_PF 06 -$27.54 (24 d) → 07 -$27.50 (4 d); URGO 06 -$62.33 (6 d) → 07 -$73.93 (71 d). Under the app filter every combo has exactly one month (2026-07), so a month split cannot explain any average on this export.

### 2.6 Major: "Avg P&L / day" is the account's blended net-or-gross, not the combo's P&L, and the label says neither

`snap.grossRealizedPnl` (`supabaseStore.js:105`) ← `account_snapshots.gross_realized_pnl` ← `realizedPnl !== 0 ? realizedPnl : grossRealizedPnl` (`csvImport.js:244`; comment `:245-251`: Realized PnL is NET of commissions and differed from gross on 19 of 21 traded accounts). The header is "Avg P&L / day" (`:672`); no "gross", "net" or "commission" appears in the panel. The export cannot size the gap: `account_snapshots` has no `derivation` or `gross_realized_pnl_reported` column; `executions.commission` is the string "0" on 7,893 of 7,919 rows and null on 26.

Strategy-level `realized` explains 62.3% of the kept days' P&L: 311 known days gross -$45,500.83 vs enabled-strategy realized -$28,358.25. On the 166 solo days (exactly one enabled strategy) account gross equals the strategy's realized on only 108. URGO row: 66 days gross -$4,275.38 vs URGO's own realized -$2,019.00; G4M: -$5,921.00 vs -$4,770.00. 7 known-combo days carry fills from a family that was not enabled at export.

### 2.7 Major: one account-day is one vote; zero days are losses

`entry.days += 1` per snapshot (`:125`); no weight by size, contracts or drawdown. Registry population 178: `start_balance` 50000 on 48, 150000 on 7, unset on 123; `max_drawdown_limit` unset on all 178. Contract sizes exist in `params_parsed.posSizes` and are not 1 contract: URGO `[1,1,0]` on 128 rows / `[2,1,1]` 7 / `[3,2,1]` 1; B2X `[3,3,2]` 61 / `[5,5,3]` 3; RBO `[2,2,2]` 42; G4M `[2,1,1]` 53 / `[3,3,2]` 5 / `[2,3,1]` 2; SYFY `[2,1,1]` 7 / `[1,1,1]` 5 / `[3,3,3]` 1 (spec_contracts.py). Where size is known URGO reads +$14.88/day on 50K accounts (8 days, +$119.00) vs -$75.77/day on unsized accounts (58 days, -$4,394.38). URGO "Accounts 25": 6 accounts have one URGO day, the largest has 12.

Win rate with `pnl > 0` over all days vs over traded (non-zero) days: URGO 23% (15/66) vs 43% (15/35, 31 zero days); B2X 9% vs 30% (23 zero); G4M 7% vs 18% (24 zero); IFSP + URGO 18% vs 25% (9 zero). 119 of 311 kept days are exactly $0.

### 2.8 Major: "This acct Nd avg" and "Team avg (same combo)" count different day sets

Account side (`:187-193`) sums every close the account has in the window, whatever combo ran; team side only enabled-combo days. Over the 29 non-Unknown insight rows: 231 account-days counted, 136 (59%) on the displayed combo. Examples (window 30d at each client's latest close): Wren Larch `GJF81519317785934` shows -$37.40 on URGO over 5 days, but +$40.33 on its 3 URGO days; Wren Larch `JDECDDBEB886959181470` -$81.13 shown vs +$39.73 on its 3 URGO days; Indigo Glen `GCKJBFKGD497202012` -$46.15 shown vs +$119.20 on its 1 URGO day. Against team URGO -$64.78 the sign of "vs Team" flips on all three.

### 2.9 Major: Income Projection default is opposite in sign to the book

Default +$800/month per funded account (`:223`), `min={100}` (`:233`). Book: 865 funded-active account-days, -$147.16 per account-day, × 21 closes = **-$3,090.35** per account per month; 174 funded accounts with a snapshot: 7 positive, 30 zero, 137 negative, median -$600.00; accounts average 4.97 closes each in the book (-$731.57 per account over its own closes, -$1,097.35 scaled to 21 closes), so every extrapolation is negative. "Current funded" = 178 registry rows (176 Active + 2 Reserve), 4 with no snapshot.

### 2.10 Minor: labels that overstate

"Total days" is account-days (URGO 66 over 12 calendar dates). "Accounts" counts an account once per combo, never per day. Badge counts all visible clients. Heatmap has no population filter; `connection` is free text with 49 distinct strings over the 3,100 `account_snapshots` rows, 11 of them spellings of BluSky. `fmt` rounds to whole dollars (`:17-19`) while sort and the 1.15 rule use unrounded values.

---

## 3. What My Futures Book measures instead (labelling requirement)

My Futures Book publishes, per algorithm, the algorithm's own track record: one algorithm, on its own, one contract, one continuous series. Nothing in this repository or in the export carries My Futures Book data (grep over `src`, `server`, `docs` for "futures book", "myfuturesbook", "MFB": zero hits), so the CRM cannot validate an MFB figure and MFB cannot validate a Playbook figure. The two are different measurements of different things:

| | Stack Playbook (this tab) | My Futures Book |
|---|---|---|
| Unit | A client's funded account-day | The algorithm |
| Population | Live client accounts of this desk's visible clients, funded, current status | The algorithm's own run |
| Attribution | Whatever the account did on a day the combo was switched on (multi-algo days, fills from non-enabled algos, days with every algo disabled dropped) | The algorithm alone |
| Size | posSizes as configured per account (URGO 1/1/0, B2X 3/3/2, RBO 2/2/2, G4M 2/1/1...) and unknown start balance on 123 of 178 accounts | One contract |
| P&L basis | Realized net of commission where the grid reported it, gross otherwise (csvImport.js:244) | Whatever MFB states |
| Time | 14 closes 2026-07-13..07-30 in this book | MFB's own history |

The nearest thing the CRM can produce to an MFB-style figure is the strategy row's own `realized` on solo days (exactly one strategy enabled): 166 such days, and even there account gross equals the strategy's realized on only 108. It still is not one contract.

Requirements:

1. The Team Algo Performance panel MUST carry the sentence, verbatim, under its heading: **"Client account results while the combo was running. Not the algorithm's own track record. Not comparable to My Futures Book."**
2. Wherever an MFB number is shown in the CRM (none today; if added later) it MUST be labelled **"My Futures Book, one contract, algorithm alone"** and MUST NOT be placed in the same table or bar chart as Playbook rows.
3. The desk MUST NOT quote a Playbook combo average as the algorithm's performance, and MUST NOT quote an MFB figure as what client accounts made. The labels in section 4.8 enforce this on screen.
4. No reconciliation claim ("validated against My Futures Book") may appear until an MFB series is imported with its basis (gross or net, contracts, instrument, dates) stored beside it.

---

## 4. The fix

All aggregation moves out of the component into a pure domain module so it can be tested against the book. `StackPlaybook.jsx` keeps rendering only.

### 4.1 New module `src/domain/comboPerformance.js` (replaces `:28-41`, `:68-159`, `:162-214`)

```
export function comboKeyFromDay(snapshot, executionsForAccount, { basis, level })
export function buildComboPerformance(clients, options)
export function buildClientComboInsights(client, dailyImport, perf, options)
export const DEFAULT_OPTIONS = { basis: 'traded', level: 'version', window: { preset: 30, from: null, to: null }, minDays: 10, minAccounts: 3, includeFailed: true }
```

`comboKeyFromDay`:
- Family = `strategy.strategyFamily` exactly as stored (`IFSP_PF` stays `IFSP_PF`; no `includes()`, no `slice(0,8)`; `Bullet Bot` stays `Bullet Bot`). Remove the URGO/IFSP/BULLET folds at `:33-35`.
- `level: 'version'` → element = `${strategyFamily} ${strategyVersion}` (same `dayKey` as `algoContribution.js:93`); `level: 'family'` → element = `strategyFamily`. Elements de-duplicated, sorted, joined with ` + `.
- `basis: 'enabled'` → strategies with `enabled === true` (today's rule). `basis: 'traded'` → strategies with `enabled === true` OR `realized` non-zero OR whose family is named in `executionsForAccount[].strategyName` (family via `strategyFamilyOf` from `src/domain/strategyFamily.js`, then `-PF` → `_PF` as `normalizeStrategyFamily` does at `csvImport.js:220-221`; version from `parseStrategyVersion`, `csvImport.js:232`). Executions for the account = `di.executions.filter(e => e.accountName.toLowerCase() === snap.accountName.toLowerCase())` (mapped at `supabaseStore.js:121-125`, live split at `:542`).
- Returns `{ key, elements, reason }` with `reason` one of `enabled`, `fills`, `realized`, `none`; `key = 'Unknown'` only when `elements` is empty.

`buildComboPerformance(clients, options)` returns `{ rows, basis, window, population }`:
- Anchor = latest `di.date` across clients (keep `:76-84`). Window: `preset` 7 | 30 | 90 | 'all', or explicit `from`/`to` (YYYY-MM-DD inclusive); a day is in scope when `from <= di.date <= to`; preset N means `from = anchor − (N−1) days`, `to = anchor`. **Every accumulator (totalPnl, days, winDays, flatDays, accountSet, clientSet, firstDate, lastDate) runs only over in-scope days.**
- Population: snapshot's registry row `accountType === 'Funded'`; `status` is NOT consulted when `includeFailed` is true (default). A day is counted when it falls inside the account's alive range: `[first snapshot date, max(last snapshot date, dateFailed || '')]`. No day is excluded because of what the account's status is today. `includeFailed: false` reproduces today's `:102` rule for the comparison label only.
- Per row: `{ key, level, elements[], totalPnl, days, tradedDays (pnl !== 0), winDays (pnl > 0), lossDays (pnl < 0), flatDays (pnl === 0), avgPnl = totalPnl/days, avgTradedPnl = totalPnl/tradedDays ‖ null, winRate = winDays/tradedDays ‖ null, accounts, clients, firstDate, lastDate, failedAccounts (accounts in the row whose current status is Failed), lowSample = days < minDays || accounts < minAccounts, trend, recentAvg, priorAvg, recentDays, priorDays }`.
- Trend inside the window: split the window in halves at `to − floor(span/2)`; `trend = 'n/a'` if either half has < 5 days; else `up` when `recentAvg − priorAvg > 0.1 × |priorAvg|`, `down` when `< −0.1 × |priorAvg|`, else `stable` (fixes the negative-prior inversion at `:142-143`).
- Sort: rows with `lowSample === false` first by `avgPnl` desc, then low-sample rows by `avgPnl` desc. `best` = first row with `lowSample === false && avgPnl > 0`, else null.
- Family roll-up: when `level === 'family'` rows are keyed by family; when `level === 'version'` each row also carries `familyKey` so the UI can group by it. Roll-up is computed by the same function, not by summing version rows in the component.
- `population` = `{ fundedDays, includedDays, unknownDays, unknownPnl, failedAccountDays, hiddenClients }` for the caption.

`buildClientComboInsights(client, dailyImport, perf, options)`:
- Current key = `comboKeyFromDay` of the viewed close with the same `basis`/`level`.
- Account side: sum over this account's in-window closes **whose key equals the current key**; expose `accountDaysOnCombo` and `accountDaysTotal` separately.
- Team side: the perf row for that key from the same call (same window, same basis); never fall back between `recentAvg` and `avgPnl`.
- Suggestion: only when `perf.best` is non-null, `currentKey !== 'Unknown'`, `best.key !== currentKey`, and `best.avgPnl − (teamRow?.avgPnl ?? 0) >= Math.max(25, 0.15 × Math.abs(teamRow?.avgPnl ?? 0))`. When `currentKey === 'Unknown'`: `suggestion = null`, `note = 'No algo recorded on this close'`.

### 4.2 `src/domain/supabaseStore.js`
- `buildCrmStateFromTables` returns `hiddenClientCount` = `clientRows.length − visibleClientRows.length` (after `:386`) so the Playbook caption can state it. No change to the visibility rule.
- Nothing else; `strategyVersion`, `realized`, `executions` are already mapped.

### 4.3 `src/domain/stackAnalytics.js`
- `buildComboByFirm(clients, comboFn, { populationFilter, normalizeFirm })`: apply the same Funded population and the same `comboKeyFromDay`; normalise `connection` with `trim().toLowerCase().replace(/[^a-z0-9]/g,'')` mapped through a small table (`blusky|bluesky|blsky` → `BluSky`, etc.). Caption becomes "Avg P&L per account day by combo and prop firm, same population as the table above".

### 4.4 `src/components/StackPlaybook.jsx`
- Delete `comboFromStrategies` (`:28-41`), `daysBefore`/`latestImportDate` (`:68-84`), `buildAlgoComboPerformance` (`:86-159`), `buildClientComboInsights` (`:162-214`); import from `src/domain/comboPerformance.js`. Keep `buildAlgoComboPerformance` exported as a thin alias for `src/components/StackPlaybook.test.js` until that file is moved.
- State: replace `windowDays` (`:278`) with `windowPreset` (`7 | 30 | 90 | 'all' | 'custom'`), `windowFrom`, `windowTo`; `level` (`'version' | 'family'`, default `'version'`); `basis` (`'traded' | 'enabled'`, default `'traded'`).
- Selector (`:633-640`): options "Last 7 days", "Last 30 days", "Last 90 days", "All history", "Custom range" (two `<input type="date">` bounded by first and last close in the book, prefilled with the current preset's range). Tooltip: "Applies to every column in this panel".
- Toggles beside it: "Group by version" / "Group by family"; "Attribution: traded" / "Attribution: enabled at export".
- Caption (`:646-649`) becomes, with live numbers: **"Client account results while the combo was running. {includedDays} of {fundedDays} funded account days in range; {unknownDays} days with no algo attributable ({fmt(unknownPnl)}); {failedAccountDays} days from accounts now marked Failed are included; {hiddenClientCount} inactive clients are not loaded. P&L is realized net of commission where the grid reported it, gross otherwise. One account day is one observation, unweighted. Not the algorithm's own track record. Not comparable to My Futures Book."**
- Badge (`:632`) becomes "{rows.length} combos · {distinct accounts} accounts · {distinct clients} clients".
- Bars (`:654`): only rows with `lowSample === false`; up to 8.
- "Best" badge (`:686`): only on `perf.best`; when null show a muted line "No combo passes the sample gate ({minDays} account days and {minAccounts} accounts)".
- Rows with `lowSample` get class `row-muted` and a badge "Low sample".
- `comboChangesFor` (`:46-62`), `mult` at `:359`, `liveCombo` at `:791`: use `comboKeyFromDay` with the same `basis`/`level`.
- Income Projection (`:222-256`): `avgPerAccount` initial value = `Math.round(perf.population.avgPnlPerAccountDay × 21)` from the same window (book: -$3,090); remove `min={100}`; label "Assumed monthly P&L per funded account (book: {fmt(bookMonthly)} per account over the selected window)"; "Current funded" counts only accounts with a snapshot in the window and is labelled "Funded accounts with data in range".

### 4.5 Sample gate constants
`MIN_DAYS = 10`, `MIN_ACCOUNTS = 3` in `comboPerformance.js`, exported, shown in the caption. On this book at "All history", traded basis, version level, the rows passing the gate are the ones with ≥ 10 account-days and ≥ 3 accounts; the 1-day rows never carry "Best".

### 4.6 `date_failed`
`src/domain/accountOutcomeStamp.js` already stamps `dateFailed` when a status is set to Failed from now on. No backfill for the 6 existing Failed accounts (their alive range comes from their own snapshot dates, section 2.5).

### 4.7 Out of scope, stated on screen
The loader's hidden-client rule (`supabaseStore.js:384-386`) is unchanged; the caption states the count.

### 4.8 Exact new labels (English, no dashes)

Team Algo Performance table, in this order:

| Column | Label | Tooltip |
|---|---|---|
| 1 | **Combo** | "Algorithm families and versions attributed to the account day" |
| 2 | **Range** | "First and last close with this combo inside the selected window" (renders `firstDate` to `lastDate`) |
| 3 | **Account days** | "Number of account days, one per funded account per close" |
| 4 | **Traded days** | "Account days with nonzero P&L" |
| 5 | **Accounts** | "Distinct funded accounts with at least one day on this combo in range" |
| 6 | **Clients** | "Distinct clients with at least one such account" |
| 7 | **Avg P&L per account day** | "Total P&L divided by account days. Realized net of commission where reported, gross otherwise. Unweighted." |
| 8 | **Avg P&L per traded day** | "Total P&L divided by traded days" |
| 9 | **Win rate on traded days** | "Share of traded days with positive P&L; flat days excluded" |
| 10 | **Flat days** | "Account days with zero P&L" |
| 11 | **Trend in window** | "First half of the window vs second half, at least 5 account days each; otherwise n/a" |
| 12 | **Sample** | "OK, or Low sample when under {MIN_DAYS} account days or {MIN_ACCOUNTS} accounts" |

Client Config vs Team Avg:

| Column | Label |
|---|---|
| 1 | **Account** |
| 2 | **Combo on this close** |
| 3 | **This account on this combo, avg per account day** (sub text: "{accountDaysOnCombo} of {accountDaysTotal} days in range") |
| 4 | **Team on this combo, avg per account day** (sub text: "{teamRow.days} account days, {teamRow.accounts} accounts") |
| 5 | **Difference** |
| 6 | **Suggestion** (text "Consider {best.key}: team avg {fmt(best.avgPnl)} per account day over {best.days} days on {best.accounts} accounts", or "No combo passes the sample gate", or "No algo recorded on this close") |

Panel badge: "Suggestions available" / "No suggestion passes the gate". Footer sentence: "Team figures are client account results, not the algorithm's own track record."

Window selector labels: "Last 7 days", "Last 30 days", "Last 90 days", "All history", "Custom range". Grouping: "By version", "By family". Attribution: "Traded (enabled or filled)", "Enabled at export".

---

## 5. Tests to add

`src/domain/comboPerformance.test.js` (synthetic, ungated):

1. `comboKeyFromDay` with `[IFSP_PF 1.1 enabled]` at level `version` returns key `'IFSP_PF 1.1'`, not `'IFSP'`.
2. `comboKeyFromDay` with `[URGO 4.5 enabled, URGO 2.0 enabled]` at level `version` returns `'URGO 2.0 + URGO 4.5'` and at level `family` returns `'URGO'`.
3. `comboKeyFromDay` basis `traded` with `[OGX 2.4 enabled=false, realized=0]` and one execution named `'0 - OGX-2.4'` returns `'OGX 2.4'` with reason `fills`; basis `enabled` returns `'Unknown'`.
4. `comboKeyFromDay` basis `traded` with an execution named `'0 - OGX-PF-2.4'` returns `'OGX_PF 2.4'`.
5. `buildComboPerformance` with 6 closes 2026-06-01..06 and `window.preset = 3` reports `days = 3`, `avgPnl` over the last three closes only, `accounts` and `clients` from those closes only, `firstDate = '2026-06-04'`, `lastDate = '2026-06-06'`.
6. `buildComboPerformance` with `window.from = '2026-06-02', window.to = '2026-06-03'` counts exactly the two closes and nothing else.
7. A Funded account whose registry status is `Failed` with days 06-01..06-03 contributes 3 days when `includeFailed` is true and 0 when false; the row's `failedAccounts` is 1.
8. A day with `pnl === 0` increments `flatDays` and `days` but not `tradedDays`; `winRate` uses `tradedDays` as denominator; a row with only flat days has `winRate === null`.
9. A row with 1 day and 1 account has `lowSample === true` and is never `best`, even with the highest `avgPnl`.
10. `best` is null when no row passes the gate, and `buildClientComboInsights` returns `suggestion === null` for every row in that case.
11. Trend is `'n/a'` when either half has fewer than 5 days; with prior avg -100 over 5 days and recent avg -100 over 5 days the trend is `'stable'`, not `'up'`.
12. `buildClientComboInsights` account side sums only closes whose key equals the current key: account with closes `[URGO +100, Unknown -500, URGO +100]` reports `accountAvg = 100`, `accountDaysOnCombo = 2`, `accountDaysTotal = 3`.
13. `buildClientComboInsights` with current key `'Unknown'` returns `suggestion === null` and `note === 'No algo recorded on this close'`.
14. Suggestion does not fire when `best.avgPnl − teamAvg < Math.max(25, 0.15 × |teamAvg|)`: best +30, team +10 → no suggestion; best +60, team +10 → suggestion.
15. `buildComboByFirm` maps `'Blusky '`, `'BLUSKY'`, `'BlueSky'` to one column `'BluSky'` and applies the Funded population filter.

`src/domain/comboPerformance.book.test.js` (reads the book, add to `localSnapshotTests` in `vite.config.js`):

16. At basis `enabled`, level `family`, `includeFailed: false`, window all: `Σ rows.days === 311` and `Σ rows.totalPnl` within $0.01 of -$45,500.83 (same day set as today's table; the row count is no longer 32 because IFSP_PF rows separate from IFSP), and the `URGO` row is 66 days / -$4,275.38 / 25 accounts / 18 clients / 2026-07-13 to 2026-07-30.
17. At basis `enabled`, `includeFailed: false`, window all, the key `'ARPD_PF 1.1 + IFSP_PF 1.1 + OGX 2.4 + RBO_PF 1.8'` has `days === 1`, `lowSample === true`, and `perf.best` is not that row.
18. At basis `traded`, level `family`, `includeFailed: false`, window all: `URGO` row has `days === 107` and `avgPnl` within $0.01 of -$124.72; `B2X` has `days === 57` and `avgPnl` within $0.01 of -$176.49; `OGX` row exists with `days === 26` and `avgPnl` within $0.01 of -$84.74; `ARPD + URGO` has `avgPnl` within $0.01 of -$90.62 over 23 days.
19. At basis `traded`, window all, `population.unknownDays === 292` and `population.unknownPnl` within $0.01 of -$8,514.70.
20. `includeFailed: true` vs `false` at basis `enabled`, level `family`, window all: `URGO` moves from 66 days / -$64.78 to 70 days / -$73.98; `RBO` from 4 / -$240.75 to 6 / -$287.10; every other family-level combo is unchanged.
21. Window preset 7 at basis `enabled`, level `family`, `includeFailed: false`: `URGO` has `days === 45` and `avgPnl` within $0.01 of -$41.49; the key containing `ARPD_PF` is absent.
22. `population.fundedDays === 865` and `Σ rows.totalPnl + population.unknownPnl` equals -$127,292.95 within $0.01 at basis `traded`, `includeFailed: false`, window all.
23. `hiddenClientCount === 40` from `buildCrmStateFromTables(snapshot.tables)`.
24. No row key contains the substring `'IFSP'` without a version token at level `version`, and no row key is `'IFSP'` when the underlying rows are `IFSP_PF` (the 12 `IFSP_PF 1.1 + OGX_PF 2.4` days never appear under an `IFSP` key).
25. Income projection default from the book at window all equals `Math.round(-147.16 × 21) = -3090`.

`src/components/StackPlaybook.test.js` (existing, keep passing):

26. The rendered panel contains the sentence "Not comparable to My Futures Book" and the column header "Avg P&L per account day".
27. Changing the window select from "Last 30 days" to "Last 7 days" changes the "Account days" cell of the URGO row (book test, gated) or of a synthetic 10-close client (ungated).
