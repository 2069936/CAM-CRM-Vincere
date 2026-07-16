# CAM CRM

Web CRM for managing trading client accounts from NinjaTrader end-of-day exports with Supabase-backed persistence.

The goal is to replace a manual Excel workflow with a safer daily close process: upload the client's NinjaTrader CSV files, persist account classifications, review action flags, inspect account/strategy performance, and build a clean daily report.

## What It Does

- Tracks one account manager workspace with multiple clients.
- Imports NinjaTrader CSV exports by column headers, not fixed column positions.
- Supports Accounts, Strategies, Orders, and Executions exports.
- Ignores simulator accounts whose names start with `SIM`.
- Persists manual account classification across days.
- Separates Review, Evaluations, Funded, Cash, Credentials, Notes, and Price Checks.
- Shows account-level and strategy-level drill-downs.
- Joins executions to strategies through `order.id -> execution.orderId`.
- Shows CAM Overview across clients: algorithms running, accounts, deviations, daily PnL, account weekly context, and per-client breakdown.
- Optionally matches running strategies against local NinjaTrader XML set files to display risk, version, period, pass type, direction, and strategy movement.
- Builds a printable daily report that can be saved as PDF.

## AI Agent Quickstart

If you are an AI coding agent opening this repository, run these commands from the repository root:

```bash
npm install
npm run dev:open
```

Expected behavior:

1. Vite starts on `http://127.0.0.1:5173/`.
2. The default browser opens the local app automatically.
3. The app shows the CAM CRM sidebar and workspace.
4. If no client data is loaded, create a client and upload that client's NinjaTrader CSV files.

For verification, run:

```bash
npm test
npm run build
npm run lint
```

## Daily Workflow

1. Run `npm run dev:open`.
2. Add a client from the sidebar.
3. Select the client.
4. Choose the close date.
5. Upload the four NinjaTrader exports for that client:
   - Accounts
   - Strategies
   - Orders
   - Executions
6. Classify new accounts once in the Account Registry.
7. Click `Recalculate` in Action Required after classification changes.
8. Review Evaluations, Funded, Cash, and Review tabs.
9. Expand an account to inspect strategies, attributed executions, and movement.
10. Open CAM Overview to compare algorithms across clients.
11. Click `Build Daily Report`, then print or save as PDF.

## Important Data Rules

- Upload only one client's NinjaTrader files at a time.
- CSV file type is detected by headers, so file names and column order can vary.
- Positions are not required for the daily close because positions can disappear by end of day.
- Executions and Orders are used for trade reconstruction.
- Cash accounts only focus on daily/gross PnL, weekly PnL, and account balance.
- Bullet Bot is treated as an Evaluation subtype.
- Account classification is manual the first time and persisted afterward.

## Sensitive Files

These are ignored by git and should stay local:

- Excel workbooks
- NinjaTrader CSV exports
- Local `.env` / `.env.local` files

## Scripts

```bash
npm run dev        # Start Vite locally
npm run dev:open   # Start Vite and open localhost automatically
npm test           # Run Vitest suite
npm run build      # Production build check
npm run lint       # ESLint check
```

## Project Status

The active application uses Supabase for authentication and operational persistence. Browser storage is limited to non-critical UI/session state; client, CAM, account, import, task, flag, user, and SOP data should be stored in Supabase.
