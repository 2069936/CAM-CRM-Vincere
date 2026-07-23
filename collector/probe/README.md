# NinjaTrader supported-API probe

This disposable AddOn measures what NinjaTrader 8 exposes through supported
in-process APIs. It does **not** click grids, move the mouse, open `Export As`,
use OCR, or require `UIAutomationClient.dll` / `UIAutomationTypes.dll`.

The probe writes one version-1 JSON snapshot plus a warnings file to:

```text
%LOCALAPPDATA%\Vincere\AutoExport\probe\
```

The output is local-only. It does not contain a product key or CRM credential
and it never uploads anything. Snapshot rows can still contain client trading
data, so treat the folder as sensitive and do not commit raw output.

## Why this gate exists

NinjaTrader documents `Account.All`, `Account.Get(AccountItem, Currency)`, and
the per-account `Orders`, `Executions`, and `Strategies` collections. Executions
are current-session data. The documented `AccountItem` list includes separate
`RealizedProfitLoss` and `GrossRealizedProfitLoss`, but not the Accounts-grid
columns `Weekly PnL` or `Trailing max drawdown`. The supported strategy
collection also needs a real-VPS comparison against the Strategies grid.

Primary references:

- [Account class](https://ninjatrader.com/support/helpGuides/nt8/account_class.htm)
- [AccountItem values](https://ninjatrader.com/support/helpGuides/nt8/accountitem.htm)
- [Orders collection](https://ninjatrader.com/support/helpguides/nt8/orders_account.htm)
- [Executions collection](https://ninjatrader.com/support/helpguides/nt8/executions.htm)
- [Strategies collection](https://ninjatrader.com/support/helpGuides/nt8/strategies_account.htm)
- [Order properties](https://ninjatrader.com/support/helpGuides/nt8/order.htm)
- [Execution properties](https://ninjatrader.com/support/helpGuides/nt8/execution.htm)
- [Accounts grid columns](https://ninjatrader.com/support/helpGuides/nt8/accounts_tab.htm)

## Install and run

1. Close NinjaTrader.
2. In an ordinary PowerShell window from this repository, run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File collector\probe\install-probe.ps1
   ```

3. Open NinjaTrader, then open NinjaScript Editor and press `F5`.
4. Confirm zero compile errors and restart NinjaTrader completely.
5. Connect the approved test account and choose
   **New → Export Vincere Probe Snapshot** between 4:30 and 4:50 p.m. New York
   time.
6. Immediately export Accounts, Strategies, Orders, and Executions manually.
7. Copy the six artifacts to an encrypted temporary folder and run:

   ```powershell
   npm run probe:compare -- `
     --snapshot C:\secure-temp\probe.json `
     --accounts C:\secure-temp\Accounts.csv `
     --strategies C:\secure-temp\Strategies.csv `
     --orders C:\secure-temp\Orders.csv `
     --executions C:\secure-temp\Executions.csv `
     --out C:\secure-temp\comparison
   ```

8. Inspect every mismatch and missing field. Copy
   `parity-review.template.json` into the encrypted folder, record the controlled
   environment and checks, and add one explicit decision for every
   `missing-api` or `missing-grid` field. Then create sanitized, report-bound
   evidence:

   ```powershell
   npm run probe:evidence -- `
     --comparison C:\secure-temp\comparison\comparison.json `
     --review C:\secure-temp\parity-review.json `
     --out C:\secure-temp\parity-evidence.json
   ```

   The command refuses missing rows, value mismatches, incomplete checks,
   required fields preserved as null, and pixel/mouse/OCR actions. Its output
   contains no row keys or API/grid values and includes the SHA-256 of the exact
   comparison report. Raw probe, CSV, and comparison files remain sensitive.

The comparator detects each CSV by headers, not filename or column position. It
keeps realized and gross PnL separate. `Rate` in the Executions grid remains a
currency-conversion rate and is never relabeled as a fee.

## Remove

Close NinjaTrader and run:

```powershell
powershell -ExecutionPolicy Bypass -File collector\probe\uninstall-probe.ps1
```

The uninstall script removes only the Vincere probe source file. It does not
touch NinjaTrader-owned files or captured probe output.
