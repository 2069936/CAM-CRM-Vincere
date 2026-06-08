# CAM Portal (Client Account Manager)

## Purpose
The CAM Portal is a centralized dashboard designed to process and visualize daily trading performance data from NinjaTrader grid exports (`acc.csv`, `str.csv`, `ord.csv`). It allows Account Managers to track specific algorithms running across multiple Prop Firm accounts, categorized logically into Evaluations and Funded stages.

## Core Logic & Terminology
- **Client**: A trader or entity managed by the CAM. Each client has a segregated historical record of uploads.
- **Prop Firm (Connection)**: The underlying firm providing the account (e.g., Legends Trading, BlueSky, My Funded Futures, Lucid).
- **Buckets**: Accounts are classified into two primary buckets:
  - `Evaluation`: Accounts in the testing phase to reach a specific profit target.
  - `Funded`: Live accounts that have passed evaluation.
- **Account Status**: Manually set to `Active`, `Inactive`, or `Parked`.
- **Gross Realized PnL**: The primary metric serving as the true "Net Profit" indicator.
- **Algorithm (Strategy)**: Automated trading bots (e.g., B2X-2.5, Bullet Bot-1.1) deployed on accounts.
- **Distance to Target**: The required monetary gap between the `Gross Realized PnL` and the user-defined `Profit Target`.

## Native Shape of the Product
The product is structured as a **Hierarchical Tree Dashboard**. 
Data flows downwards: `Client -> Upload (Timestamp) -> Account -> Algorithms`.
The dashboard reflects this native shape by establishing the **Account** as the dominant entity, displaying its base stats, and nesting the **Algorithms** trading on it directly beneath it.

## Critical Files
- `src/utils/csvParser.js`: The parsing pipeline utilizing `papaparse` to map NinjaTrader headers (`Display name`, `Trailing max drawdown`, `Gross realized PnL`) to local state.
- `src/App.jsx`: State manager and Sidebar navigation. Manages Client CRUD and Historical Upload persistence via `localStorage`.
- `src/components/Dashboard.jsx`: The Recharts visualization layer and the Account Tree view.
- `src/index.css`: The root design system and token definitions.
