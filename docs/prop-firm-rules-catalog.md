# Prop firm rules catalog

The limits that decide whether an account lives or dies — trailing drawdown,
profit target — are firm rules. NinjaTrader reports how far down an account is;
it has no idea how far down it is allowed to go. The auto-export will not fill
these in, however many columns it brings.

On the book as of 2026-07-31, `max_drawdown_limit` was set on **7 of 764**
accounts. Everything that reads it — the drawdown flags, the trailing chart —
was running on nothing.

## Why this is a short list, not a research project

Firm and account size are both derivable from data already stored:

- **Firm** from `connection`, folded across spellings. The book held Legends
  under four spellings and Bluesky under five.
- **Size** from the earliest balance on record, snapped to a standard size.
  This resolves 667 of 721 accounts, against 211 that have `start_balance` set.

That leaves 563 prop accounts resolved to a firm and a size, across these pairs:

| Rule key | Accounts | Cumulative | Trailing drawdown | Profit target | Basis |
|---|---:|---:|---|---|---|
| `Legends\|50000` | 226 | 40% | | | |
| `Bluesky\|50000` | 122 | 62% | | | |
| `Lucid\|50000` | 71 | 74% | | | |
| `Lucid\|150000` | 34 | 80% | | | |
| `MFF\|50000` | 24 | 85% | | | |
| `Apex\|50000` | 17 | 88% | | | |
| `Tradeify\|50000` | 15 | 90% | | | |
| `Tradeify\|100000` | 11 | 92% | | | |
| `Bulenox\|50000` | 7 | 94% | | | |
| `Tradeify\|150000` | 6 | 95% | | | |
| `TOF\|100000` | 6 | 96% | | | |

**The first six rows cover 88% of the book.**

## Filling it

Add to `PROP_FIRM_RULES` in `src/domain/propFirmRules.js`:

```js
export const PROP_FIRM_RULES = {
  'Legends|50000': { trailingDrawdown: 2500, profitTarget: 3000, basis: 'end-of-day' },
};
```

Record the source — the firm's published rules page, dated — beside each row
here. A limit nobody can trace is a limit nobody should trade against.

### basis

`intraday` or `end-of-day`. The two give different answers on the same account:
an intraday trail follows the peak equity touched during the session, an
end-of-day trail only moves on the close.

We do not yet know which each firm uses. The NinjaTrader capture was set up to
answer this — compare a firm-reported trailing figure against the peak we
derive from stored closes — but it needs a capture taken during market hours
with the Trailing column enabled in the Accounts grid.

Leave `basis` unset until it is confirmed. It is recorded per rule rather than
per firm because firms have been known to differ by account size.

## What stays unresolved

- **11 accounts** whose connection names no firm pattern recognises. They pass
  through under their raw name rather than being dropped, so they appear in the
  coverage summary and can be added to `FIRM_PATTERNS`.
- **53 accounts** whose earliest balance is not within 15% of any standard size.
  These need `start_balance` set by hand; guessing would put an account under
  rules that were never its own.

## Never derive silently

`resolveAccountLimits` labels every number with where it came from —
`stored`, `firm-rule`, or `inferred`. A stored value always wins, because
someone typed it deliberately. A derived one must stay visibly derived, the same
way a derived trailing figure is kept distinct from a reported one: the CRM
should never present a lookup as though a human confirmed it.
