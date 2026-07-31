# Prop firm rules catalog — design note

Not built. Recorded so the reasoning is not lost, and so whoever picks it up
knows what it has to solve and what it would replace.

## The problem

A prop firm today is whatever string NinjaTrader put in the connection column.
There is no list of recognised firms and no record of their rules, so:

**The same firm counts as several.** The Operations insight feed shows both
`Blusky - 4077` and `BlueSky - 0193`. The client lifecycle groups funded accounts
by that raw string (`clientLifecycle.js`, `propFirms` keyed by
`meta.connection`), so one firm is reported as two.

**Account rules live in people's heads.** Start balance, profit target, drawdown
limit and payout rules are typed in per account. `accountTargets.js` hardcodes
one set of assumptions (50k→54,100, 100k→107,300, 150k→159,000, Bullet Bot
50k→53,000) that happens to match some firms and silently does not match others.

**Trailing drawdown cannot be computed exactly.** `derivedAccountMetrics.js`
reconstructs it from stored closes, but only as a lower bound, because it does
not know whether a firm trails from the intraday high or from the daily close. It
compensates by widening the alert thresholds — correct, but a workaround for a
missing fact rather than an answer.

## What the catalog would hold

Per firm: the names it appears under, and per account type, the rules.

```
BlueSky
  aliases: BlueSky, Blusky, BSKELAUNCH*
  account types:
    Evaluation 50k
      startBalance: 50,000
      target: 54,100
      trailing: from peak, 2,000
      trailingBasis: intraday | end-of-day        <- the unknown
      trailingStopsAtBreakeven: yes | no
      dailyLossLimit: ...
    Funded 50k
      ...
```

`trailingBasis` is the field that matters most. With it, the drawdown becomes an
exact figure instead of a lower bound, or the catalog states plainly that this
firm cannot be reconstructed from daily closes — which is also a real answer,
better than a number nobody should trust.

## What it would replace

- `accountTargets.js` — its hardcoded bands become one firm's entry.
- The manual start-balance and target entry per account, once the firm and size
  are known.
- The widened thresholds in `derivedAccountMetrics.js`, wherever a firm's basis
  is known to be end-of-day.

## Why it is worth waiting for the local capture test

`collector/docs/local-capture-test.md` produces a snapshot with the trailing
figure the Accounts grid reports. Comparing that against
`deriveTrailingDrawdown` for the same account and day answers the
`trailingBasis` question by measurement:

- The two agree → that firm trails on the daily close, and the derivation is
  exact for it.
- The reported figure is consistently larger → it trails intraday, and daily
  closes can only ever under-report it.

That is the first catalog entry established from evidence rather than assumption.
Writing the catalog first would mean guessing at the field that the whole thing
exists to answer.

## Note on where the firm name comes from

The connection name is the trading connection, not necessarily the firm's own
name, and a client can reach one firm through different connections. Alias
matching therefore belongs in the catalog rather than being imposed on the
imported data — the raw connection string should keep arriving unchanged so a
mis-mapping is always recoverable.
