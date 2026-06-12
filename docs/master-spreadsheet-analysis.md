# Template Master Spreadsheet Analysis

Source reviewed: `/Users/pedro/Downloads/Template Master Spreadsheet.xlsx`

## Workbook Structure

- `Funded Accounts`: operational tracker for funded accounts.
- `Evaluations`: operational tracker for standard evaluations and Bullet Bot evaluation flow.
- `Averages`: summary analytics for weekly averages, account counts, strategy analyzer scores, and action recommendations.
- `Performance`: strategy comparison surface with selectable status, strategy, compare strategy, and daily/weekly performance charts.
- `Accounts History`: lifecycle analysis for evaluations/funded accounts: days to fail, days to funded, days to payout.
- `Historical Data`: time-series source table for strategy daily and weekly PnL.
- `Price Confirmations`: manual hourly-ish checklist for instrument price, connection, and algo status.
- `Client Credentials`: credential/notes reference sheet.

## Key Analytical Logic To Bring Into CRM

- Account counts by type and status:
  - funded account count
  - evaluation count
  - running Bullet Bot count
  - active/failed/reserve/payout states
- Average weekly PnL segmented by:
  - funded non-Bullet Bot
  - evaluation non-Bullet Bot
  - Bullet Bot evaluations
  - account balance bands
- Strategy analyzer:
  - group by strategy name
  - count active instances
  - average weekly PnL
  - average daily PnL
  - score strategies on a 0-10 scale using relative performance
- Performance comparison:
  - filter historical data by account status/type
  - select one strategy and compare against another
  - show daily and weekly time-series charts
- Lifecycle metrics:
  - average days from evaluation creation to failure
  - average days from evaluation creation to funded
  - average days from funded to payout
- Operational recommendations:
  - account count thresholds trigger buy/replenish recommendations
  - payout and activation states need explicit review queues

## CRM Translation

- The new `Manager Overview` maps the Excel `Averages`, `Performance`, and `Accounts History` sheets into a higher-level dashboard above individual CAM workspaces.
- The current `CAM Overview` maps algorithm rollups, cross-client strategy comparison, XML config matching, and per-strategy movement.
- Future backend model should persist:
  - daily account snapshots
  - strategy performance snapshots
  - account lifecycle events
  - CAM ownership
  - manager/CAM/client role permissions
  - generated report history

## Immediate Demo Layer Added

- Dummy login.
- Manager-level overview.
- CAM cards with Pedro live data plus mock CAMs.
- Team daily/weekly PnL, total accounts, total clients, flags.
- Strategy analyzer mock based on the Excel scoring concept.
- Lifecycle metrics mock based on the Excel account-history concept.
- Button into Pedro's existing CAM workspace.
