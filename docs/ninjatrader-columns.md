# NinjaTrader columns the CRM reads (which to enable before exporting)

The daily upload needs the four NinjaTrader grid exports: **Accounts, Strategies,
Orders, Executions**. The CRM auto-detects each file by its headers (column order
doesn't matter, and header text is matched loosely — spaces, dots and case are
ignored). If a column isn't enabled in the grid it isn't exported, so the CRM
can't read it. Enable at least the columns below.

A file is only **recognized** if it has all of its *required* columns. If a
required column is missing, that file uploads as "unrecognized" and its data is
dropped — the upload warns you.

---

## 1. Accounts grid
**Required (for the file to be recognized):** Display name · Cash value · Realized PnL
*(the CRM accepts either "Realized PnL" or "Gross realized PnL")*

| Column | Used for |
|---|---|
| **Display name** | account name (required) |
| **Cash value** | account balance (required) |
| **Realized PnL** *(or Gross realized PnL)* | daily realized PnL (required) |
| Trailing max drawdown | trailing / drawdown room — **often missing; enable it** |
| Weekly PnL | weekly PnL |
| Unrealized PnL | open PnL |
| Connection | prop firm |
| ConnectionStatus | connected/disconnected |

## 2. Strategies grid
**Required:** Strategy · Account display name · Parameters

| Column | Used for |
|---|---|
| **Strategy** | algo family + version (required) |
| **Account display name** | which account (required) |
| **Parameters** | the entry/exit parameters — drives direction + version classification (required) |
| Instrument | contract (NQ, M2K, NG…) |
| Data series | timeframe |
| Realized | per-strategy realized |
| Unrealized | per-strategy open |
| Connection | prop firm |
| Enabled | is the strategy running |

## 3. Orders grid
**Required:** State · Type · Filled · Remaining

| Column | Used for |
|---|---|
| **State** | order state (required) |
| **Type** | order type (required) |
| **Filled** | filled qty (required) |
| **Remaining** | remaining qty (required) |
| Account display name | which account |
| Strategy | which algo |
| Instrument | contract |
| Action | Buy / Sell |
| Quantity | size |
| Limit | limit price |
| Stop | stop price |
| Avg. price | fill price |
| Name | order name |
| ID | order id |
| Time | timestamp |

## 4. Executions grid
**Required:** E/X · Order ID · Price

| Column | Used for |
|---|---|
| **E/X** | entry / exit (required) |
| **Order ID** | links to the order (required) |
| **Price** | fill price — drives realized PnL (required) |
| Account display name | which account |
| Instrument | contract |
| Action | Buy / Sell |
| Quantity | size |
| Market position | Long / Short / Flat |
| Time | timestamp |
| ID | execution id |
| Name | execution name |
| Commission | fees |
| Rate | fx rate |
| Connection | prop firm |

---

**Tip:** the most commonly forgotten column is **Trailing max drawdown** on the
Accounts grid — without it the trailing / drawdown room shows blank.
