# NinjaTrader field-coverage decision table

**Status:** awaiting same-minute supported-API comparison on Windows.

`Documented API` below records only what can be established from NinjaTrader's
public documentation and the current probe source. `Result` and `Production
action` must be completed from real parity evidence rather than inference.

| Section / field | CRM need | Documented API | Manual grid observed | Result | Production action |
| --- | --- | --- | --- | --- | --- |
| Accounts / account name | Required | `Account.Name` | Yes | Pending | Pending parity |
| Accounts / cash value | Required | `Account.Get(CashValue, currency)` | Yes | Pending | Pending parity |
| Accounts / Realized PnL | Required | `AccountItem.RealizedProfitLoss` | Yes | Pending | Preserve separately |
| Accounts / Gross Realized PnL | Required fallback | `AccountItem.GrossRealizedProfitLoss` | Yes | Pending | Preserve separately |
| Accounts / Unrealized PnL | Preferred | `AccountItem.UnrealizedProfitLoss` | Yes | Pending | Pending parity |
| Accounts / Weekly PnL | Preferred | No documented `AccountItem` | Yes | Pending | Must remain `null`, derive in CRM, or receive an approved non-pixel decision |
| Accounts / trailing max drawdown | Preferred | No documented `AccountItem` | Not in available named export | Pending | Enable in parity export; then decide explicitly |
| Strategies / identity and account | Required | `Account.Strategies` plus public strategy/account properties | Yes | Pending | Pending parity |
| Strategies / parameters | Required | Browsable public property descriptors | Yes | Pending | Verify on two algorithms; redact secret-like names |
| Strategies / data series and sync | Preferred | Public descriptors to be measured | Yes | Pending | Pending parity |
| Orders / core row fields | Required | `Account.Orders` and public `Order` properties | Yes | Pending | Pending parity |
| Executions / core row fields | Required | `Account.Executions` and public `Execution` properties | Yes | Pending | Current session only |
| Executions / name, commission, rate | Preferred | Public `Execution.Name`, `Commission`, and `Rate` | Yes | Pending | Keep Rate as FX rate, never relabel as fee |
| Executions / E/X | Required by manual classifier | No documented direct execution property established | Yes | Pending | Determine safe derivation or CRM action |
| Executions / connection | Preferred | Owning account connection | Yes | Pending | Pending parity |

Official reference points:

- <https://ninjatrader.com/support/helpGuides/nt8/accountitem.htm>
- <https://ninjatrader.com/support/helpGuides/nt8/orders_account.htm>
- <https://ninjatrader.com/support/helpGuides/nt8/executions.htm>
- <https://ninjatrader.com/support/helpGuides/nt8/strategies_account.htm>
- <https://ninjatrader.com/support/helpGuides/nt8/order.htm>
- <https://ninjatrader.com/support/helpGuides/nt8/execution.htm>
