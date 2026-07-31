# NinjaTrader supported-API parity gate

**Status:** prepared; real NinjaTrader probe capture still required.

This gate compares one in-process supported-API snapshot with the four native
grid exports captured immediately afterward. It is deliberately separate from
the production AddOn. Passing this gate is required before the production
AddOn DLL can be accepted by the installer build.

The repository probe does not use UI Automation, pixels, mouse movement, OCR,
context menus, or the `Export As` dialog. The coworker's native-export
experiment is useful diagnostic evidence, but it is not part of this gate or a
production fallback.

## Header baseline already verified

The four named CSVs supplied on 2026-07-22 were classified from their headers,
not their filenames or column positions. All four classified without parser
errors:

| Section | Rows | Headers observed |
| --- | ---: | --- |
| Accounts | 5 | ConnectionStatus, Connection, Display name, Gross realized PnL, Cash value, Weekly PnL, Unrealized PnL, Realized PnL, Total PnL |
| Strategies | 11 | Strategy, Account display name, Instrument, Data series, Parameters, Sync, Unrealized, Realized, Enabled |
| Orders | 75 | Instrument, Action, Type, Quantity, Limit, Stop, State, Filled, Avg. price, Remaining, Name, Strategy, OCO, TIF, Account display name, ID, Time, Cancel |
| Executions | 43 | Instrument, Action, Quantity, Price, Time, ID, E/X, Position, Order ID, Name, Commission, Rate, Account display name, Connection |

This proves the expected native-grid shape only. It does **not** prove that the
supported API returns matching rows or values because no same-minute probe JSON
was supplied with those exports.

The Accounts file did not contain `Trailing max drawdown`. The comparator and
snapshot contract support that field, but the parity run must use an Accounts
grid with the column enabled so the production decision is explicit.

## Run on the approved Windows VPS

1. Install `collector/probe/Vincere.AutoExport.Probe.cs` using the documented
   `install-probe.ps1` script and compile it in NinjaScript Editor.
2. Between 4:30 and 4:50 p.m. New York time, choose
   **New -> Export Vincere Probe Snapshot**.
3. Immediately export Accounts, Strategies, Orders, and Executions manually.
4. Copy the probe JSON, warnings JSON, and four CSVs into an encrypted temporary
   directory.
5. Run `npm run probe:compare` as shown in `collector/probe/README.md`.
6. Review every `missing-api`, `missing-grid`, and `value-mismatch` result.
7. Repeat after the daily reset to confirm that Realized PnL and Gross Realized
   PnL remain distinct and that a zero Realized value is not treated as absent.
8. Complete `collector/probe/parity-review.template.json` and run
   `npm run probe:evidence`. The resulting evidence must be bound to the exact
   comparison SHA-256; a manually authored `allFourSectionsPassed` boolean is
   not accepted by the installer release gate.

Do not commit raw client data. Commit only a redacted comparison, a redacted
real-shape fixture, and the field decision table.

## Evidence required to pass

- NinjaTrader and Windows versions and the connection provider, without
  credentials.
- Same-minute row and field comparison for all four sections.
- Two different strategy algorithms with different parameter types.
- Explicit decision for Weekly PnL and trailing max drawdown.
- Confirmation that executions represent the current NinjaTrader session.
- Zero unredacted account, machine, order, execution, price, PnL, product-key,
  enrollment-code, or device-token values in committed evidence.

Until those items exist, schema v1 remains pre-release and the production AddOn
and signed installer remain gated.
