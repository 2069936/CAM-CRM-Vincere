# CAM CRM Case Study

## Context

Manual Excel tracking for trading client accounts made it easy to lose account status, mix active/reserve accounts, and overwrite historical daily values. The workflow needed a web-first CRM that could ingest NinjaTrader end-of-day exports and preserve account history.

## Problem

- Manual classification was repeated and error-prone.
- Excel snapshots lost daily history for PnL, drawdown, balance, and weekly PnL.
- NinjaTrader exports changed column order, so fixed-column parsing was unsafe.
- Executions did not include strategy names, requiring reconciliation through orders.
- Strategy risk/period/version lived in XML set files, not in the running strategy CSV name.

## Solution Built

- React/Vite local CRM with client sidebar, per-client daily close uploads, persistent account registry, and report preview.
- Header-based CSV parser for Accounts, Strategies, Orders, and Executions.
- Daily reconciliation that ignores simulator accounts, persists classifications, and recalculates action flags.
- Evaluation/Funded/Cash/Review tabs scoped by account type.
- Account drill-down with strategy rows, attributed executions, and execution price timelines.
- CAM Overview across clients showing algorithms, accounts running, average daily PnL, weekly account context, deviation alerts, and per-client breakdown.
- XML set-file matcher that generates a local strategy index and labels running strategies with risk, period, version, pass type, and direction when signatures match uniquely.

## Technical Highlights

- Defensive CSV ingestion by header names, not column positions.
- Orders-to-executions join via `order.id -> execution.orderId`.
- XML matching scoped by strategy family to avoid broad false matches.
- Private XML configs stay local: `npm run xml:index` generates `public/strategy-set-index.json`, which is gitignored.
- TDD coverage for parsers, reconciliation, CAM rollups, deviation flags, and XML matching.
- Playwright installed for reproducible UI screenshots and before/after evidence.

## Demo Evidence

- Before XML matching: `/tmp/cam-crm-qa/before-xml-overview.png`
- After XML matching: `/tmp/cam-crm-qa/after-xml-overview.png`

## Resume Framing

Built a local web CRM that replaced a manual Excel-based trading account workflow with automated NinjaTrader CSV ingestion, persistent account classification, algorithm-level performance analytics, and XML-based strategy configuration matching. Improved operational accuracy by making active accounts, missing classifications, payout holds, algorithm deviations, and per-strategy executions visible in one dashboard.
