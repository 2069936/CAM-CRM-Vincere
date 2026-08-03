# Tradovate API connection — plan (for a cash-only book)

NinjaTrader's web platform runs on Tradovate (NinjaTrader acquired Tradovate in
2022). Tradovate exposes a documented REST + WebSocket API. This is the path to
**auto-pull** trading data instead of exporting CSVs by hand — and it becomes
realistic the moment the company moves to **cash / personal Tradovate accounts**,
because the one hard blocker below only applies to prop-firm accounts.

## The one blocker: prop-firm accounts can't use the API

A personal Tradovate API key **cannot reach prop-firm / evaluation / funded
accounts** (Apex, and by extension the firms our clients trade through —
BlueSky, Legends, Tradeify). This is confirmed on Tradovate's own forum and has
no supported workaround. So:

- **Prop-firm book → API is out.** Keep the NinjaTrader desktop AddOn auto-
  collection we're already building. It runs inside the desktop where the data
  (including the strategy/algo name) lives and needs no API.
- **Cash / personal Tradovate accounts → API works.** This is the migration
  target, so the API plan is worth having ready.

## What the API gives us

- Per-account fills, orders, positions, and cash balances — the same content as
  the Performance / Position History exports, but live and automatic.
- Realized P/L per trade directly (no reconstruction, no point-value table).
- Real-time via WebSocket if we ever want intraday, not just the daily close.

What it does **not** give: the NinjaTrader strategy/algo name. Tradovate only
knows the fills, not which NinjaTrader strategy placed them. So API data is
account-level, same limitation as the CSV export.

## Auth model

`POST https://live.tradovateapi.com/v1/auth/accesstokenrequest` with:

```json
{
  "name": "<tradovate username>",
  "password": "<password>",
  "appId": "<our registered app name>",
  "appVersion": "1.0",
  "cid": "<API key id>",
  "sec": "<API secret>",
  "deviceId": "<stable per-machine id, for MFA>"
}
```

Returns a short-lived bearer `accessToken` (+ an md-token for market data). All
subsequent calls send `Authorization: Bearer <token>`. Tokens expire (~80 min);
renew before expiry, don't re-auth on every call (Tradovate rate-limits and can
lock an app that hammers the auth endpoint).

Requirements to switch this on:
1. An **API access subscription** on each Tradovate account (~$25/mo, personal
   accounts only).
2. A registered **appId** (one per integrating app).
3. The account holder's credentials + generated API key (cid/sec).

## Key endpoints we'd use

| Need | Endpoint |
|---|---|
| List accounts we can see | `GET /account/list` |
| Cash balance / snapshot | `GET /cashBalance/getcashbalancesnapshot` |
| Fills for a day | `GET /fill/list` (or `/fill/deps` by order) |
| Filled orders | `GET /order/list` |
| Positions | `GET /position/list` |
| Contract / product metadata | `GET /contract/item`, `/product/item` |

## How it maps into the CRM

The importer we just built (`src/domain/tradovateImport.js`) already normalizes
Tradovate's shape into per-trade → per-day realized P/L. The API path reuses all
of it:

```
Tradovate API (fills/positions)  ─┐
Tradovate CSV export             ─┼─►  normalize to { date, instrument, pnl, ... }
                                  │        │
                                  │        ├─► summarizeTradovateByDay  → equity curve / history
                                  │        └─► summarizeTradovateByInstrument → per-instrument stats
```

So building the CSV importer first is not throwaway work: the API integration is
"fetch instead of read a file", then the same normalization and summaries.

## Account mapping (the real integration work)

Tradovate identifies an account by a numeric id (e.g. `1977234`), not by the
NinjaTrader display name the CRM keys accounts on. Whichever path we take (CSV or
API) we need a stored mapping:

- Add `tradovate_account_id` to `trading_accounts`.
- On first import, show the unmatched Tradovate id and let the CAM link it to a
  CRM account once; after that it resolves automatically.

## Rollout order (recommended)

1. **Now** — CSV importer (done): read Performance / Position History, preview
   per-day P/L, feed history. Works today for any web/Tradovate account.
2. **On cash migration** — add the account-id mapping field + linking UI.
3. **Then** — swap the CSV read for an authenticated API fetch behind the same
   normalization. Store credentials/keys server-side (never in the browser),
   likely in the same collector/service layer the desktop auto-collection uses.

## Security notes

- API credentials and keys are account-holder secrets — store them server-side
  (the collector/service tier), never in the client bundle or in Supabase plain
  text. The browser should only ever see normalized results.
- One appId, renewed tokens, backoff on the auth endpoint.
