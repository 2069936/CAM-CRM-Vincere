# CAM CRM MVP Design

Date: 2026-06-08
Owner: Pedro
Target demo: Thursday, 2026-06-11 before the Friday team meeting

## Goal

Build a web-first CRM for one account manager that replaces the daily Excel workflow for client account tracking. The MVP must let Pedro manually close each client's trading day by uploading the four NinjaTrader exports for that client, reviewing account changes and flags, confirming a daily snapshot, and generating a polished client PDF report.

The current Excel workbook is a requirements reference and optional migration aid. It is not the daily source of truth.

## Source Files

Daily operational inputs:

- NinjaTrader accounts CSV
- NinjaTrader strategies CSV
- NinjaTrader orders CSV
- NinjaTrader positions/executions CSV

Reference inputs:

- `Client Account Manager (CAM) - Amanda Maradiaga.xlsx`
- `CAM Master Spreadsheet.xlsx`
- NinjaTrader set files XML under `Vincere Trading 6.0/3 - Set Files`

The CSV import belongs to exactly one client. The files are downloaded manually from that client's VPS at the end of the trading day.

## MVP Scope

In scope:

- One real account manager workspace for Pedro.
- Client sidebar with selectable clients.
- Manual daily close per client and date.
- Four-file CSV upload and type detection by headers.
- Persistent manual account classification.
- Daily account snapshots.
- Strategy snapshots linked to accounts.
- Operational flags.
- Evaluation, Funded, and conditional Cash views.
- Bullet Bot as a subcategory of Evaluations.
- Simple payout workflow.
- Credentials and notes area.
- Lightweight or mock Price Checks.
- Daily PDF report for the selected client and date.
- Mock Team Overview to show future scale.

Out of scope for the first demo:

- Real multi-user auth.
- Real team/manager permissions.
- Client portal/login.
- Automated VPS collection.
- Advanced prop firm-specific rule engine.
- Fully exhaustive XML preset matching if it threatens the Thursday demo.

## Product Shape

The app should feel like a workspace:

- Fixed left sidebar.
- Top of sidebar shows `Pedro`.
- Sidebar lists clients with small status indicators.
- Sidebar has a separate entry for `Team Overview` mock.
- Main panel changes based on selected client.

Client page header:

- Client name.
- Selected date, defaulting to today.
- Last close status.
- `Upload Daily Files`.
- `Build Daily Report`.

Client tabs:

- `Evaluations`
- `Funded`
- `Cash` only when the client has Cash accounts
- `Credentials & Notes`
- `Price Checks`

Within `Evaluations`:

- `Bullet Bot`
- `Standard Evaluations`

## Core Data Model

### AccountManager

Represents Pedro in the MVP. Add an `account_manager_id` concept from the start so the model can later support a team.

### Client

Fields:

- id
- account_manager_id
- name
- status
- notes
- credentials and VPS metadata

Credentials may include IP, username, password, and notes. Passwords should be hidden by default in the UI. For external demos, use mock or masked values.

### TradingAccount

Persistent account registry. Manual classification lives here and survives daily imports.

Fields:

- id
- client_id
- full account name
- safe display alias
- connection / prop firm
- account type: `Evaluation - Bullet Bot`, `Evaluation - Standard`, `Funded`, `Cash`, `Inactive / Ignore`
- status: `Active`, `Inactive`, `Reserve`, `Failed`, `Payout Hold`
- target profit
- payout state
- Bullet Bot pass type when applicable: `1-day pass`, `2-day pass`, `3-day pass`
- notes

Safe account aliases should use connection plus the final four account digits where possible, for example `Lucid - 0006` or `Live - 4812`.

### DailyImport

One manual close attempt for a client and date.

Fields:

- id
- client_id
- trading date
- upload timestamp
- source file metadata
- review status: `No data`, `Needs review`, `Ready to close`, `Closed`, `Reopened`
- summary counts

### AccountSnapshot

Frozen daily account metrics.

Fields:

- daily_import_id
- trading_account_id
- connection
- gross realized PnL / daily PnL
- trailing max drawdown
- account balance
- weekly PnL
- unrealized PnL

Use "aggregate balance" language in UI/reporting, not "total balance", because prop firm starting balances do not represent client-owned capital. Cash accounts are displayed separately because their financial meaning is different.

### StrategySnapshot

Daily strategy state from NinjaTrader.

Fields:

- daily_import_id
- trading_account_id
- strategy name
- normalized strategy family
- instrument
- data series
- raw parameters
- enabled
- realized
- unrealized
- inferred risk/config result

### OrderExecution

Audit detail from orders and positions/executions files.

Fields:

- daily_import_id
- trading_account_id
- instrument
- action
- quantity
- price
- time
- state
- strategy
- order/execution identifiers
- entry/exit indicator when available

### OperationalFlag

Actionable review item.

Fields:

- daily_import_id
- client_id
- trading_account_id optional
- severity: `Critical`, `Warning`, `Info`
- type
- message
- status: `Open`, `Resolved`, `Ignored`

### PriceCheck

Secondary manual checklist.

Fields:

- client_id
- date
- instrument
- time
- price
- connection status
- algo status
- notes

## Daily Close Workflow

1. Pedro selects a client.
2. Pedro chooses the date, defaulting to today.
3. If no snapshot exists, the app prompts for the daily upload.
4. Pedro uploads the four NinjaTrader CSV files.
5. The app detects each file type by headers.
6. The app creates a `DailyImport` in `Needs review`.
7. The app joins accounts and strategies by account display name.
8. Existing accounts keep their manual classification.
9. New accounts become `Needs review / Unassigned`.
10. Historical accounts missing from the import produce a flag.
11. Accounts that should be trading but have no active strategy produce a flag.
12. Payout hold accounts with active strategy produce a critical flag.
13. Pedro resolves required classifications and reviews flags.
14. The import moves to `Ready to close`.
15. Pedro confirms close.
16. The snapshot becomes `Closed` and is used for dashboards and reports.

Historical dates show frozen snapshots. Uploading to a historical date should be a secondary correction action, not the default path.

## Account Classification Rules

First load:

- Every account starts unassigned until Pedro manually classifies it.

Future loads:

- The app reuses the stored classification.
- It should not suggest automatic account type classifications unless later requested.
- It should only ask for action when a new or inconsistent state appears.

Account types:

- `Evaluation - Bullet Bot`
- `Evaluation - Standard`
- `Funded`
- `Cash`
- `Inactive / Ignore`

Cash accounts:

- Often appear through a `Live` connection or manual Cash classification.
- Use the same strategy and metric mechanics as funded accounts.
- Must be shown in their own tab/window when present.
- Must not be mixed with prop firm balances in summary language.

## Bullet Bot Rules

Bullet Bot is a specific kind of evaluation, not a separate account category outside Evaluations.

Fields:

- pass type: `1-day pass`, `2-day pass`, `3-day pass`
- direction: `LONG`, `SHORT`
- result: `PASSED`, `FAILED`, `NO TRADE`
- status: active, inactive, reserve, failed, payout hold

Concept:

- 1-day pass maps to a 100% consistency target.
- 2-day pass maps to a 50% consistency target.
- 3-day pass maps to a 33% consistency target.

The MVP should track the fields, but does not need to fully automate all consistency math for the first demo.

## Strategy Matching

The strategies CSV already identifies:

- strategy name
- account display name
- instrument
- parameters
- enabled state

Therefore matching must not compare every strategy against every XML file. It should:

1. Normalize the strategy family from the CSV strategy name.
2. Search only the XML folder for that family.
3. Use the XML title/file name and critical parameters to infer config.
4. Prioritize risk-related and output-related parameters:
   - position size / contracts
   - stop loss ticks
   - profit target ticks
   - trade direction
   - trade windows
   - relevant period/version if available
5. For normal algorithms, infer `LOW RISK`, `MEDIUM RISK`, or `HIGH RISK` when reliable.
6. For Bullet Bot, infer pass type, direction, and position size.
7. If not reliable, show `Unknown / custom config` and raise a review flag.

Technical note: the `Parameters` column cannot be parsed with a naive slash split because date values contain slashes. Implement parsing carefully or compare against normalized XML-derived parameter signatures.

## Flags

Daily import status:

- `No data`
- `Needs review`
- `Ready to close`
- `Closed`
- `Reopened`

Flag types:

- `New account`
- `Missing account`
- `Unassigned account`
- `Expected strategy missing`
- `Unexpected strategy active`
- `Strategy disabled`
- `Strategy config unknown`
- `Strategy config mismatch`
- `Payout hold violation`
- `Bullet Bot review`
- `Order anomaly`

Severity:

- `Critical`: potential operational mistake, such as payout account trading.
- `Warning`: needs review, such as new account or unknown config.
- `Info`: expected or low-risk state change.

The UI should expose an "Action required" area per client/date.

## Payout Workflow

Simple MVP state machine:

- `Not requested`
- `Request payout`
- `Payout requested`
- `Payout approved`
- `Clear to trade`

Rule:

- If a payout-hold account appears with active strategy, raise a critical flag.

## Client PDF Report

The report is generated from a closed daily snapshot.

It should include:

- client name
- report date
- account manager
- timestamp
- account summary
- evaluations summary
- funded summary
- cash summary only if applicable
- aggregate balance language
- daily/gross PnL
- weekly PnL
- trailing max drawdown
- target and remaining where relevant
- payout status where relevant
- client-safe alerts

It must not include:

- credentials
- internal notes
- sensitive strategy mismatch details unless explicitly approved
- other clients' data

## Demo Plan

Monday, 2026-06-08:

- Finalize design.
- Define data model.
- Implement reliable four-CSV parser.
- Build workspace layout.
- Make one-client local import functional.

Tuesday, 2026-06-09:

- Manual persistent classification.
- Daily snapshots.
- Evaluation, Funded, and conditional Cash views.
- Core flags.
- Load first real close if available.

Wednesday, 2026-06-10:

- Client dashboard.
- Account history.
- Daily PDF.
- Team Overview mock.
- UI polish.

Thursday, 2026-06-11:

- Load real data.
- Validate flags and report.
- Prepare boss demo narrative.

Narrative:

- This replaces manual Excel tracking.
- It reduces lost or crossed accounts.
- It creates daily history.
- It generates client-ready reports.
- With budget, it scales to the team.

## Open Implementation Choices

- Local storage format for the demo: browser localStorage, IndexedDB, or a small local database.
- PDF generation library.
- Exact XML signature strategy for matching without blocking the first demo.
- Whether to migrate any initial Excel state or start clean with manual classification in the app.
