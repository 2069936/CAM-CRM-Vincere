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

**Balances, dates, P&L, drawdown, and account types are untouched.** The charts,
the flags, and the totals read exactly as they do in production. That is the
point: the numbers are the thing being tested, and the names never were.

It is not reversible. No key, no mapping file.

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
