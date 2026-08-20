# Running the CRM locally against real data

Everything built recently — lifecycle, coverage, the report designer, the
overview charts — has only been seen against fixtures. Fixtures answer "does it
render". They do not answer "does this say something true about our book", and
the two diverge exactly where it matters: the client with nineteen accounts, the
account nobody classified, the strategy name that repeats across accounts.

This runs the whole app on a saved export, with no Supabase and no deploy.

## 1. Export

Operations page, as a **Manager**. The endpoint is `/api/admin/data-export` and
it is Manager-only and audit-logged — a CAM account cannot call it. If your
account is not a Manager, ask someone who is; do not work around the check.

Save the file outside the repository, or as `something.export.json`, which is
already ignored by git.

## 2. Redact

**Do this before anything else touches the file.** The raw export is the entire
book: client names, prop-firm account numbers, balances, and the `app_users`
table.

```bash
node scripts/redact-export.mjs ~/Downloads/export.json public/local-snapshot.json
```

What it does:

- Drops `app_users`, `audit_logs`, and `client_credentials` whole.
- Replaces names with stable pseudonyms — the same client reads as the same
  person across every table, so relationships stay legible.
- Rewrites the digits in account numbers while keeping the prefix and the
  length, because a CAM recognises an account by its shape and a shorter string
  would change how the tables lay out.
- Replaces notes with `[redacted N chars]`, keeping the length so text that
  wrapped in production still wraps locally.
- Rewrites every identifier — including `external_order_id` and
  `external_execution_id` — as a stable 1:1 token, and **refuses to write** if
  any of them came out merged. See "Joins" below.

**Balances, dates, P&L, drawdown, and account types are untouched.** The charts,
the flags, and the totals read exactly as they do in production. That is the
point: the numbers are the thing being tested, and the names never were.

It is not reversible. No key, no mapping file.

### Joins — read this before measuring anything against a redacted book

A redacted book is only useful if it still joins to itself, and for one whole
book it did not. `external_order_id` was missing from the redactor's identifier
list, so it fell through to the generic `[redacted N]` marker, which keeps a
string's length and nothing else: **30,955 distinct order ids became four
values.** The book looked perfect — every table, every row, every price, every
timestamp.

`deriveStrategyPnl` resolves each fill's owning strategy through exactly that
join, so it returned one arbitrary strategy for every leg of an account-day.
Replaying it produced 185 per-strategy figures that disagreed with the Strategies
grid, $77,876.25, 54 of them on accounts the module certifies publishable. Three
separate investigations reported that as a defect in the derivation. It was not:
rebuilt from `executions.strategy_name`, the same module over the same fills
scores 1,052 agreements and 11 disagreements, none publishable.

Two rules follow.

- **Adding an id column means adding it to `ID_FIELDS` in the same commit.** An
  id joins something; a length bucket joins everything to everything.
- **A replay of a stored book must not resolve a leg's strategy through the
  order ids.** Use `executions.strategy_name` / `executions.name`, which
  `reconcile` writes from the order before persistence and which is the same
  value a sound join returns. If you must use the ids, count them first:
  `new Set(orders.map(o => o.external_order_id)).size` against `orders.length`.

`scripts/lib/redactionJoins.mjs` now enforces the first of those at write time —
the script exits non-zero and writes nothing if a join key was merged. Books
written before that fix still exist, and it cannot fix them.

**One thing a redacted book still cannot answer.** NinjaTrader execution ids are
`"<seq>_<n>"` or a bare monotonic integer, and the derivation prefers to order
fills by them. The redactor's tokens match neither shape, so ordering falls back
to the timestamp on essentially every account. Any ordering result taken from a
redacted book is about the time basis plus the Position-column repair, never
about the execution-id basis. Say which one you measured.

## 3. Run

```bash
VITE_LOCAL_SNAPSHOT=1 npm run dev
```

The header reads **Local snapshot (read-only)**, and names any table the export
did not contain.

Local snapshot mode takes precedence over Supabase deliberately. A developer
with production credentials in `.env` should not be able to point a testing
session at the live book by forgetting a flag.

## What you cannot do

Writes are not persisted. Uploading a CSV, closing a flag, or editing a report
config will change the screen and vanish on reload. This is on purpose: a local
copy that accepted edits would invite someone to fix a real problem in a file
that goes nowhere.

To test the write paths you need a real Supabase project. A free one with the
migrations in `supabase/` applied is enough, and it is the honest way to test
persistence — see `docs/verification/auto-collection-crm.md` for the gap this
leaves.

## Do not

- Commit `public/local-snapshot.json`. It is in `.gitignore`; leave it there.
- Paste an export, redacted or not, into a chat window or an issue.
- Keep the un-redacted export around after step 2. Delete it.
