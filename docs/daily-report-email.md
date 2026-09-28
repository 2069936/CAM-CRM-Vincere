# The daily report email

Every afternoon each CAM gets one email with their whole close: the numbers in
the body, one HTML report per client in a zip, and the day's raw figures beside
them.

It runs inside Supabase. Nothing here needs Vercel, DNS access, or a manager.

## What arrives

```
Subject   Daily reports · 2026-09-28 · 11 clients
Body      one block per client, the same text the CAM pastes into Discord
Attached  reports-2026-09-28.zip   one .html per client, ~8 KB each
          raw-2026-09-28.json      the day's figures, no licence key, no tuning
```

The reports are standalone HTML: inline stylesheet, no fetch, no font. They open
on a double click, reflow on a phone where a PDF does not, and carry a **Save as
PDF** button that produces the same paper from wherever they were opened.

### Why HTML and not PDF

The PDF path launches a headless Chromium per client inside a 60 second
function, which is why `buildDailyReportPackage` renders them one at a time.
Measured over the real book: eleven reports as HTML total **75 KB**, the largest
8 KB. Plain JavaScript over the desk record, so it runs where the data already
is.

### Why the zip

Not size; 75 KB needs no compression. Google Workspace administrators commonly
block `.htm` and `.html` attachments, because an HTML attachment is a standard
phishing vehicle. The rule matches on the extension, so a `.zip` carrying them
is not matched.

### What the raw file does not contain

An **allowlist**, not a redaction: each field is named, and nothing else
travels. Measured on production on 2026-09-28, of 16,435 `strategy_snapshots`
rows, 16,273 carry a `LicenseKey` and 12,239 carry a live licence value, with
`StopLossTicks` on 16,170 and the URGO inputs, day filters and trade windows
beside them. The full record stays behind Deep Export, asked for by a person.

## Setting it up

### 1. The sender

Create a free account at [brevo.com](https://www.brevo.com) (300 emails a day;
this desk sends 8). Add a sender and verify it with the six digit code Brevo
emails to that address.

**No DNS record is required for this.** Without domain authentication a message
is likelier to land in spam the first time; the recipients are
`@vinceretrading.com` mailboxes, so marking it as not-spam once is enough.
Authenticating the domain later is an improvement, not a prerequisite.

Copy the API key from **SMTP & API → API Keys**.

### 2. Deploy the function

```bash
node scripts/build_daily_email_bundle.mjs
supabase functions deploy daily-report-email
```

### 3. The secrets

```bash
supabase secrets set BREVO_API_KEY=...
supabase secrets set DAILY_EMAIL_FROM=reports@vinceretrading.com
supabase secrets set DAILY_EMAIL_FROM_NAME="Vincere CRM"
supabase secrets set DAILY_EMAIL_CRON_SECRET="$(openssl rand -hex 32)"
```

`DAILY_EMAIL_CRON_SECRET` is generated here and never written down anywhere
else. The function refuses every request without it: it is reachable over the
internet whatever the schedule does, and a job that silently accepts anyone is
worse than one that does not run.

### 4. The schedule

In the SQL editor. **Neither extension is installed on this project** — checked
on 2026-09-28, `pg_cron` and `pg_net` both absent. Enable them first, in
**Database → Extensions**, or:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
```

```sql
-- The key the schedule sends, kept out of the job definition, which is
-- readable by anyone who can read cron.job.
select vault.create_secret('<the DAILY_EMAIL_CRON_SECRET from step 3>', 'daily_email_cron_secret');

select cron.schedule(
  'daily-report-email',
  -- 21:30 UTC is 17:30 in New York during daylight saving. pg_cron has no
  -- time zone, so this moves by an hour in November and is meant to: the
  -- agents close at 16:30 local and the email follows an hour later.
  '30 21 * * 1-5',
  $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/daily-report-email',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets
                        where name = 'daily_email_cron_secret')
    ),
    timeout_milliseconds := 120000
  );
  $$
);
```

Weekdays only: there is no close on a Saturday, and a daily "nothing happened"
is how a daily email gets muted.

### 5. Check it

```sql
-- What the schedule did, newest first.
select job_run_details.*
from cron.job_run_details
join cron.job using (jobid)
where cron.job.jobname = 'daily-report-email'
order by start_time desc
limit 10;
```

Or run one day by hand without waiting for the schedule:

```bash
curl -H "x-cron-secret: $SECRET" \
  "https://<project-ref>.supabase.co/functions/v1/daily-report-email?date=2026-09-28"
```

The response is the run's own report:

```json
{
  "date": "2026-09-28",
  "sent": [{ "camName": "Peter", "to": ["pedro@..."], "clients": 11 }],
  "refused": [],
  "unreachable": [],
  "notBuilt": [],
  "ok": true
}
```

`ok` is false, and the status 500, when anything was refused or could not be
built, so the schedule's log shows a failure instead of a 200 with the problems
inside it.

## Who gets what

The split follows `cam_profiles.client_ids`, which is what the sidebar shows, so
the email and the screen cannot disagree about whose client is whose.

Addresses come from **`app_users`**, not from `cam_profiles`. The `email` column
on `cam_profiles` exists and is empty on all 8 production rows; `app_users` is
what **Users & Access** shows and all 10 accounts have it filled in.

`app_users.cam_profile_id` holds the row's UUID while the rest of the app names
a CAM by its `legacy_key`. The join is translated in `usersFromRows`. Matched on
either identity alone it joins nothing, every CAM comes out unreachable, and the
run reports a clean success having sent no mail.

A CAM with no reachable address is reported in `unreachable` rather than
skipped: a CAM who silently stops receiving their close is worse than a job that
fails.

## What this does NOT cover

**The schedule lives inside Postgres.** If the database is down, the job does
not fire — and there is nothing to send anyway, because the reports are built
from the desk record. The outage of 2026-09-26 was exactly this.

The agent's local report is the answer to that case and it is a separate path
on purpose: it is built on the trading machine, from that machine's own
captured close, with no CRM. Routing it through here would make it depend on
the thing it exists to survive.

## Changing provider

`src/domain/emailDelivery.js` is one request body. Everything above it is
tested without a network, so a different provider is a change to that file and
its tests and to nothing else.
