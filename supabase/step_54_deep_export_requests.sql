-- Step 54: asking a VPS for a deep export from the CRM, and the machine's
-- answer.
--
-- WHAT THIS IS. Today the only way a deep export comes into existence is a
-- person sitting at a client's trading VPS clicking a button in the Setup
-- window. The commit before this one put the export code in a net8.0 library the
-- Windows service can see. This file is the other half of the question: where a
-- request lives between the moment a manager makes it and the moment the machine
-- picks it up, and what the machine is allowed to say back.
--
-- NOTHING IN THIS FILE RUNS AN EXPORT. It is two tables and two functions. The
-- admin route, the heartbeat field, the signed upload URL, the agent loop and
-- the download all come after it and all depend on this being right. It is
-- deliberately the first thing to land, because it is the only part that can be
-- proved entirely in SQL with no agent and no endpoint.
--
-- THE AGENT PULLS. NOTHING IS PUSHED. There is no inbound channel to a client's
-- VPS and this file adds none. A request sits in `ingest_deep_export_requests`
-- until that machine's own heartbeat loop - already a one minute poll - calls
-- `claim_deep_export_request` and is offered it. A machine that is off,
-- firewalled, revoked or simply not beating never learns a request exists, and
-- after `request_ttl_hours` the row expires and the CRM can say "the VPS never
-- came" instead of leaving a manager watching a spinner.
--
-- WHY THIS IS A NEW FUNCTION AND NOT A WIDER HEARTBEAT. `record_ingest_heartbeat`
-- is `returns table (...)` (step_41_heartbeat_ordering.sql:36), so `create or
-- replace` cannot widen its result: adding a column means dropping and
-- recreating the one function every machine in the fleet calls once a minute.
-- That function's deployed version is already in doubt - step_41:62-63 still
-- raises INVALID_HEARTBEAT_REQUEST when `p_ninjatrader_version is null`, which
-- is exactly what server/autoCollection/ingest/heartbeat.js deliberately sends,
-- and no later migration redefines it. A bug inside a fatter heartbeat RPC is
-- fleet silence. So the claim is its own function, called after the beat has
-- already succeeded and inside a try/catch that omits the field on any failure.
-- step_46_ingest_quarantine_reports.sql:14-18 wrote this lesson down for the
-- request direction; this is the same lesson for the response direction.
--
-- WHAT IT COSTS WHEN THERE IS NOTHING TO DO. One probe of a partial index per
-- machine per minute, returning zero rows, before any settings read, any lock
-- and any row work. On the wire it is zero bytes: the heartbeat response carries
-- the field only when a request was actually offered.
--
-- EVERY TUNABLE IS A COLUMN, NOT AN ENVIRONMENT VARIABLE. Vercel environment
-- variables are not available to the person who operates this desk; SQL is.
-- Every one of the five decisions taken on this feature is therefore a column in
-- `ingest_deep_export_settings` with a default that encodes the decision, so
-- changing one is an UPDATE in the SQL editor and never a deploy. The same
-- reason step 45 put its admission cap in a table rather than a function body.

begin;

-- ---------------------------------------------------------------------------
-- THE SETTINGS, WHICH ARE THE DECISIONS.
-- ---------------------------------------------------------------------------
--
-- Singleton on step 45's model (step_45_ingest_admission_control.sql:58): one
-- row addressed without knowing its id. Each default below is a decision that
-- was made, not a placeholder, and the comment on each says what the decision
-- was.
create table if not exists public.ingest_deep_export_settings (
  id boolean primary key default true,

  -- DECISION 5, THE QUIET WINDOW: 17:15 to 18:00 New York on trading days, any
  -- time at weekends. Minutes past local midnight, so the arithmetic in the
  -- claim is integer comparison and not timestamp construction.
  --
  -- The numbers are read off this desk's own configuration rather than chosen:
  -- the agent captures at 16:30 (AgentOptions.ScheduleTime), stops accepting a
  -- capture for upload at 17:00 (CaptureCutoffTime), and
  -- collector/src/Vincere.AutoExport.Agent/Program.cs notes that NinjaTrader
  -- disables strategies around 16:30. So 17:15 is after the day's capture, after
  -- its upload cutoff, after the strategies are down, and inside the daily
  -- settlement break. A request that arrives mid session SITS: the claim returns
  -- 'none' without offering, so waiting costs the request nothing.
  window_start_minute integer not null default 1035,
  window_end_minute integer not null default 1080,
  weekend_any_time boolean not null default true,

  -- DECISION 5, SECOND HALF: `run now` exists, as a deliberate second choice.
  -- There will be an afternoon when the desk needs the package now and the
  -- machine is trading. That is a judgement a manager may make and a CAM may
  -- not, so the gate is a column rather than a constant: `run_mode = 'now'`
  -- skips the window entirely.
  run_now_requires_manager boolean not null default true,

  -- DECISION 4, A MACHINE OFFLINE: the request expires after 72 hours and says
  -- so. The alternative - an open request that waits forever - means a VPS back
  -- from a fortnight's downtime immediately builds a package nobody remembers
  -- asking for, which is exactly the unattended action the desk's standing rule
  -- is about. 72 hours covers a long weekend. A machine that IS beating but
  -- never gets a window gets `max_offers` offers and then fails visibly with the
  -- last blocking reason recorded, rather than retrying in silence.
  request_ttl_hours integer not null default 72,

  -- DECISIONS 2 AND 3, WHICH ARE ONE COLUMN EACH BECAUSE THEY ARE TWO
  -- PERMISSIONS AND NOT ONE.
  --
  -- Asking a machine to build a package is an operational act: it has a visible
  -- audit trail, a named reason and a revoke button. Reading the package is
  -- access to a client's complete order history. They are not the same right,
  -- and the design that conflates them has to pick the stricter one for both.
  --
  -- So: only a manager may DOWNLOAD, always. A CAM may REQUEST for a client it
  -- covers - and stage 1 ships with that OFF, which is the conservative start
  -- decision 2 asked for. Turning it on is one UPDATE and no deploy, which is
  -- the whole reason it is a column and not an `if` in a route.
  cam_may_request boolean not null default false,
  download_requires_manager boolean not null default true,

  -- DECISION 1, RETENTION: keep the newest 3 per device and nothing past 30
  -- days, pruned by the admin route on every create and every list.
  --
  -- NOT pg_cron. docs/daily-report-email.md:97 records that as of 2026-09-28
  -- both pg_cron and pg_net were absent on this project. Nor would plain SQL
  -- help: deleting from storage.objects leaves the blob. Pruning on a request a
  -- human already made needs no extension and no scheduler, and it is
  -- self-limiting in the right way - the bucket can only grow when somebody asks
  -- for an export, and every ask prunes first.
  --
  -- There is no retention story anywhere else in this project: every daily
  -- capture ever uploaded is still in `ninjatrader-imports`. At 3 KB that never
  -- mattered. At 4 to 250 MB it does.
  retain_per_device integer not null default 3,
  retain_days integer not null default 30,

  -- A LEASE AND NOT A BOOLEAN, for the reason step 45 has one
  -- (step_45:337-341): a VPS that dies mid export releases the request when the
  -- lease expires instead of wedging it forever. 90 minutes, deliberately under
  -- the 2 hours a Supabase signed upload token is valid for - that TTL is fixed
  -- by the SDK (`createSignedUploadUrl` takes only a path and `upsert`) and
  -- cannot be tuned, so the lease has to be the shorter of the two or a machine
  -- would hold a claim on a URL that has already died.
  lease_seconds integer not null default 5400,

  -- HOW MANY TIMES A REQUEST MAY BE OFFERED BEFORE IT GIVES UP. An offer is
  -- renewable on purpose: a machine that was off for an afternoon gets a fresh
  -- token at the same storage path rather than a dead URL and a request that
  -- silently never runs. What is one-shot is the COMPLETION, not the offer. Five
  -- bounds the loop so it terminates visibly as 'failed' with the last blocking
  -- reason instead of going round forever.
  max_offers integer not null default 5,

  -- THE TWO NUMBERS THE AGENT IS TOLD AND OBEYS. Nothing in the export code
  -- bounds the package: DeepExportRunner's WarnAboveBytes is 500 MB and
  -- exceeding it only appends a warning string. 256 MB is the first real bound,
  -- and the agent checks the finished ZIP against it BEFORE uploading, so a
  -- quarter gigabyte is never pushed through a client's link.
  --
  -- Peak transient DISK is the real cost of a run and not CPU: the manifest of a
  -- real 110 MB export reports durationMs 6547 over 988 files, while the run
  -- makes a full working copy of the live sqlite, a filtered copy beside it, a
  -- SHA256 pass over every staged file and then the ZIP. Six seconds of
  -- BelowNormal CPU inside the settlement break is not a trading incident; 150 MB
  -- of transient disk on a full VPS volume is. Hence a free-space floor the agent
  -- refuses to start below.
  max_bytes bigint not null default 268435456,
  min_free_disk_bytes bigint not null default 1073741824,

  updated_at timestamptz not null default now(),

  constraint ingest_deep_export_settings_singleton check (id),
  constraint ingest_deep_export_settings_window_check
    check (window_start_minute between 0 and 1439
      and window_end_minute between 1 and 1440
      and window_end_minute > window_start_minute),
  constraint ingest_deep_export_settings_ttl_check
    check (request_ttl_hours between 1 and 720),
  -- The floor is five minutes because an export that cannot finish inside the
  -- lease releases a request it is still working on; the ceiling is two hours
  -- because that is the signed upload token's own life.
  constraint ingest_deep_export_settings_lease_check
    check (lease_seconds between 300 and 7200),
  constraint ingest_deep_export_settings_offers_check
    check (max_offers between 1 and 50),
  constraint ingest_deep_export_settings_retention_check
    check (retain_per_device between 1 and 50 and retain_days between 1 and 3650),
  constraint ingest_deep_export_settings_size_check
    check (max_bytes between 1048576 and 536870912
      and min_free_disk_bytes >= 0)
);

insert into public.ingest_deep_export_settings (id) values (true)
on conflict (id) do nothing;

-- NO `alter table ... add column if not exists` BLOCK REPEATING THE COLUMNS
-- ABOVE, and that is a decision rather than an omission. Step 45 needs one
-- because it alters a table step 28 created; this table is new in this file, so
-- `create table if not exists` is the single statement of its shape and a second
-- list of thirteen columns beside it would be the one that stops agreeing. A
-- draft of this file has never been run anywhere, so there is no earlier shape to
-- converge from; if that ever changes, the converging ALTER goes in the step that
-- changes it.

-- ---------------------------------------------------------------------------
-- THE REQUEST, AND ITS WHOLE LIFE ON ONE ROW.
-- ---------------------------------------------------------------------------
--
-- One row per ask, from "a manager wanted this" to "the package is in the
-- bucket" or "the VPS never came". Six months from now the question will be who
-- asked, when, why, and what the machine said - and all four have to be
-- answerable from the row, not reconstructed from logs.
create table if not exists public.ingest_deep_export_requests (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.ingest_devices(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,

  -- WHO ASKED, TWICE, AND THE SECOND ONE IS NOT REDUNDANT. `created_by` is
  -- `on delete set null`, because an offboarded user must not take a client's
  -- rows with them. The audit answer "who asked for this client's complete order
  -- history" must survive that, so the address is denormalised beside the
  -- reference. It is NOT in `ingest_devices.metadata`: `record_ingest_heartbeat`
  -- rewrites four keys there on every beat (step_41:163-175) and the throttle's
  -- own predicate reads those same keys, so whether a request survived would
  -- depend on whether an unrelated queue counter happened to move.
  created_by uuid references public.app_users(id) on delete set null,
  created_by_email text not null check (created_by_email <> ''),

  -- WHY, AND IT IS REQUIRED. 3 to 200 characters, shown in the list and carried
  -- into audit_logs. The row that says who and when is far more useful with a
  -- sentence saying why, and it costs the requester five seconds.
  reason text not null check (char_length(reason) between 3 and 200),

  run_mode text not null default 'window'
    check (run_mode in ('window', 'now')),

  status text not null default 'open'
    check (status in ('open', 'offered', 'uploaded', 'failed', 'expired', 'revoked')),

  expires_at timestamptz not null,
  offered_at timestamptz,

  -- OFFERS AND DEFERRALS ARE COUNTED SEPARATELY, and that distinction is the
  -- difference between a feature that works on a busy machine and one that gives
  -- up on it. An OFFER is the CRM handing this machine the job. A DEFERRAL is the
  -- machine handing it back because the window closed, the day's own capture
  -- upload is still queued, or the disk is too full - none of which is a failure
  -- and none of which should burn an attempt. So a machine can defer all week
  -- without exhausting `max_offers`, and `last_deferral_code` is what the CAM's
  -- card shows while it does.
  offer_count integer not null default 0 check (offer_count >= 0),
  deferral_count integer not null default 0 check (deferral_count >= 0),
  last_deferral_code text,

  -- THE LEASE. Held by whichever beat was offered the request, expiring on its
  -- own so a dead VPS releases rather than wedges.
  lease_token uuid,
  lease_expires_at timestamptz,

  -- WHERE THE PACKAGE GOES, SET ONCE ON THE FIRST OFFER AND NEVER CHANGED. A
  -- re-offer of the same request reuses the same path, so `upsert: false` on the
  -- signed upload URL keeps the completion one-shot at the storage layer too,
  -- independently of anything the CRM or the agent believes. Request-scoped as
  -- well as client-scoped, so a new request cannot land on an old object.
  storage_path text,
  uploaded_at timestamptz,
  content_sha256 text check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
  byte_count bigint check (byte_count is null or byte_count >= 0),
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  warning_count integer check (warning_count is null or warning_count >= 0),
  failure_code text,

  revoked_at timestamptz,
  revoked_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),

  constraint ingest_deep_export_requests_expiry_check check (expires_at > created_at)
);

-- ONE OPEN REQUEST PER DEVICE, GUARANTEED BY POSTGRES AND NOT BY A ROUTE.
-- Lifted from `ingest_enrollments` (step_28_auto_collection.sql:131-133), which
-- uses the same partial unique index for the same reason: two managers clicking
-- at the same second is a race, and a unique index is the only place to settle
-- it. The admin route turns the resulting 23505 into 409
-- deep_export_already_open.
--
-- It is also the index the claim's cheap probe reads, which is why the probe
-- costs nothing on the thousands of beats a day that have nothing to collect.
create unique index if not exists idx_deep_export_one_open_per_device
  on public.ingest_deep_export_requests(device_id)
  where status in ('open', 'offered');

create index if not exists idx_deep_export_client_created
  on public.ingest_deep_export_requests(client_id, created_at desc);

-- The prune reads this one: newest N per device, and anything past the day
-- ceiling, among the rows that actually hold an object.
create index if not exists idx_deep_export_device_uploaded
  on public.ingest_deep_export_requests(device_id, uploaded_at desc)
  where status = 'uploaded';

-- ---------------------------------------------------------------------------
-- WHERE THE PACKAGE LANDS.
-- ---------------------------------------------------------------------------
--
-- ITS OWN BUCKET, NOT A PREFIX INSIDE `ninjatrader-imports`. Two reasons, both
-- measured in step 28's own text. The restrictive policy at step_28:332-351
-- names its bucket id LITERALLY (`using (bucket_id <> 'ninjatrader-imports')`),
-- so a new bucket inherits no protection whatever and must carry its own copy -
-- and a copy written out is better than one hidden inside a prefix. And
-- `ninjatrader-imports` was created with only `id, name, public`
-- (step_28:325-330), so it has NO `file_size_limit` and inherits a project-wide
-- ceiling that appears nowhere in this repository. For a 3 KB JSON that did not
-- matter. For a package between 4 MB and a quarter of a gigabyte the ceiling is
-- the whole question, so this one states its own.
--
-- 512 MB here against the agent's 256 MB refusal: the bucket is the backstop and
-- the agent is the gate, and a backstop set equal to the gate turns an
-- off-by-one into an opaque storage error instead of a readable failure code.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ninjatrader-deep-exports', 'ninjatrader-deep-exports', false, 536870912, array['application/zip'])
on conflict (id) do update
set name = excluded.name,
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

do $deep_export_storage_policy$
begin
  if not exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'ninjatrader-deep-exports deny browser direct access'
  ) then
    -- RESTRICTIVE, so it is ANDed with every permissive Storage policy that
    -- applies to anon or authenticated: a broad policy somebody adds later
    -- cannot authorise this bucket. It stays true of every other bucket, and it
    -- does not apply to service_role, which keeps its normal RLS bypass. The
    -- agent's upload does not go through these policies at all - a signed upload
    -- token authorises the insert on its own and carries no Authorization
    -- header - which is the one thing in this file that is argued from the
    -- storage SDK rather than from this repository, and is therefore the first
    -- thing to prove against the live project before any C# is written.
    create policy "ninjatrader-deep-exports deny browser direct access"
      on storage.objects
      as restrictive
      for all
      to anon, authenticated
      using (bucket_id <> 'ninjatrader-deep-exports')
      with check (bucket_id <> 'ninjatrader-deep-exports');
  end if;
end
$deep_export_storage_policy$;

-- ---------------------------------------------------------------------------
-- claim_deep_export_request: what a heartbeat is told, if anything.
-- ---------------------------------------------------------------------------
--
-- Called by the ingest heartbeat route AFTER `record_ingest_heartbeat` has
-- already returned, inside a try/catch that logs and omits the field on any
-- failure. The heartbeat's own contract is untouched, so nothing in here can
-- stop a beat.
--
-- The order of the steps is the point of the function: probe, lock, ownership,
-- expiry, lease, window, offer. A beat on an ordinary day stops at the probe and
-- writes nothing; nothing writes before the lock, which is what keeps this from
-- deadlocking against the ack.
create or replace function public.claim_deep_export_request(
  p_device_id uuid,
  p_lease_token uuid,
  p_lease_seconds integer default null,
  p_now timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := coalesce(p_now, clock_timestamp());
  v_settings public.ingest_deep_export_settings;
  v_client public.clients;
  v_device public.ingest_devices;
  v_request public.ingest_deep_export_requests;
  v_client_id uuid;
  v_lease_seconds integer;
  v_local timestamp;
  v_minute integer;
  v_is_weekend boolean;
  v_in_window boolean;
  v_retry_after integer;
  v_storage_path text;
begin
  if p_device_id is null or p_lease_token is null then
    raise exception 'invalid_deep_export_claim' using errcode = '22023';
  end if;

  -- STEP 1: THE CHEAP PROBE, AND IT COMES FIRST ON PURPOSE. One index-only look
  -- at idx_deep_export_one_open_per_device. On every beat of every ordinary day
  -- this returns nothing and the function is done: no settings read, no
  -- advisory lock, no row lock, no writes. That is what makes one extra RPC per
  -- machine per minute an acceptable price.
  if not exists (
    select 1
    from public.ingest_deep_export_requests as request
    where request.device_id = p_device_id
      and request.status in ('open', 'offered')
  ) then
    return jsonb_build_object('outcome', 'none');
  end if;

  select settings.* into v_settings
  from public.ingest_deep_export_settings as settings
  where settings.id
  limit 1;
  if not found then
    raise exception 'deep_export_settings_missing' using errcode = 'P0001';
  end if;

  v_lease_seconds := coalesce(p_lease_seconds, v_settings.lease_seconds);
  if v_lease_seconds not between 300 and 7200 then
    raise exception 'invalid_deep_export_claim' using errcode = '22023';
  end if;

  -- STEP 2: SERIALISE TWO BEATS FROM THE SAME MACHINE. step_45:294's trick. Two
  -- heartbeats racing is not hypothetical on a VPS whose clock has just been
  -- corrected.
  --
  -- NOTHING IN THIS FUNCTION WRITES ANYTHING ABOVE THIS LINE, AND THAT IS A LOCK
  -- ORDER RATHER THAN A PREFERENCE. An earlier draft swept the timed-out rows
  -- here, above the lock, and a sweep is an UPDATE: it takes a tuple lock on the
  -- request row and only then waits for the advisory lock, while
  -- `finalize_deep_export_request` takes the advisory lock first and the request
  -- row second. That is a cycle, and Postgres breaks a cycle by killing one side
  -- of it: 33 of 40 synchronised rounds aborted with 40P01, and in 15 of them a
  -- finished, uploaded export was never recorded as uploaded, because the victim
  -- was the ack rather than the beat. Both functions now take the same four locks
  -- in the same order - advisory, client, device, request - and the expiry moved
  -- below to STEP 4. `scripts/race-deep-export-lock-order.sh` is the harness that
  -- proved it and the thing to re-run if this order is ever touched.
  perform pg_advisory_xact_lock(hashtextextended(p_device_id::text || ':deep-export', 0));

  -- STEP 3: THE OWNERSHIP CHAIN, client -> device -> request, in that order and
  -- with the same locks step_45:274-299 takes. The order is what keeps this from
  -- deadlocking against the enrollment and revocation paths, which walk it the
  -- same way.
  select device.client_id into v_client_id
  from public.ingest_devices as device
  where device.id = p_device_id;
  if not found then
    raise exception 'invalid_ingest_device' using errcode = 'P0001';
  end if;

  select client.* into v_client
  from public.clients as client
  where client.id = v_client_id
  for update;
  if not found then
    raise exception 'invalid_ingest_device' using errcode = 'P0001';
  end if;

  select device.* into v_device
  from public.ingest_devices as device
  where device.id = p_device_id
  for update;
  if not found
    or v_device.client_id is distinct from v_client_id
    or v_device.status is distinct from 'active'
    or v_device.revoked_at is not null then
    raise exception 'invalid_ingest_device' using errcode = 'P0001';
  end if;

  select request.* into v_request
  from public.ingest_deep_export_requests as request
  where request.device_id = p_device_id
    and request.status in ('open', 'offered')
  order by request.created_at asc
  limit 1
  for update;
  if not found then
    -- Another beat finished it, or the admin route revoked it, between the probe
    -- and the lock. Both are 'none' and neither is an error.
    return jsonb_build_object('outcome', 'none');
  end if;
  if v_request.client_id is distinct from v_device.client_id then
    raise exception 'invalid_ingest_device' using errcode = 'P0001';
  end if;

  -- STEP 4: WHAT HAS RUN OUT OF TIME, WHICH IS TWO CLOCKS AND NOT ONE.
  --
  -- `expires_at` answers one question: did any machine ever come for this? It
  -- exists so a request nobody answered does not wait forever, and so the CRM
  -- can tell a manager "the VPS never came" rather than leaving him watching a
  -- spinner. `lease_expires_at` answers a different question entirely: is a
  -- machine working on it right now?
  --
  -- A REQUEST UNDER A LIVE LEASE HAS ALREADY BEEN ANSWERED, so the TTL has
  -- nothing left to decide about it and expiry must not touch it. An earlier
  -- draft had one clock here and expired anything open or offered whose TTL had
  -- passed, which threw away work that had succeeded: a machine that spent
  -- twenty minutes building a 7.2 MB package and uploaded it was told its
  -- request had expired, with the ZIP already sitting at `storage_path` and
  -- `upsert: false` making that path unusable again, so the desk was told the
  -- VPS never came about an export that was in the bucket. It needed no
  -- concurrency: any run that spanned the TTL instant lost. And it is ordinary,
  -- because the offer below stamps a full lease without clamping it to the TTL -
  -- deliberately, since a machine offered the job two minutes before expiry
  -- needs ninety minutes to finish it and not two.
  --
  -- A LEASE THAT HAS ITSELF EXPIRED IS THE OTHER CASE, and that one IS expiry's
  -- business: a lease runs out only when the VPS died mid-export, and then the
  -- TTL's question is unanswered again. So the longest a request can live is its
  -- TTL plus one lease - 72 hours to be picked up, then one lease to finish - and
  -- both halves of that are a column in the settings table.
  --
  -- Reached only when the probe already matched, which is what keeps the
  -- ordinary beat free of writes, and taken on the row this transaction has
  -- already locked, so no second session can move the lease under the
  -- comparison. The partial unique index means that row is the only open or
  -- offered one this device has, so there is nothing else here to sweep.
  if v_request.expires_at <= v_now
    and (v_request.status <> 'offered'
      or v_request.lease_expires_at is null
      or v_request.lease_expires_at <= v_now) then
    update public.ingest_deep_export_requests
    set status = 'expired',
        lease_token = null,
        lease_expires_at = null
    where id = v_request.id;
    return jsonb_build_object('outcome', 'none');
  end if;

  -- STEP 5: A LIVE LEASE. WHOSE IT IS DECIDES THE ANSWER, and there are two
  -- answers here and not one.
  if v_request.status = 'offered'
    and v_request.lease_expires_at is not null
    and v_request.lease_expires_at > v_now then

    if v_request.lease_token is distinct from p_lease_token then
      -- SOMEBODY ELSE IS RUNNING IT: busy, with the seconds left on their lease.
      -- step_45:317-321's rule, and the thing that stops two beats producing two
      -- exports on one machine.
      v_retry_after := greatest(1, ceil(extract(epoch from (v_request.lease_expires_at - v_now)))::integer);
      return jsonb_build_object('outcome', 'busy', 'retry_after_seconds', v_retry_after);
    end if;

    -- THIS WORKER IS THE ONE RUNNING IT, and that is not a new offer. The comment
    -- that used to stand here said such a beat "is answered below with its own
    -- offer, unchanged" and then let it fall through to the offer UPDATE, which
    -- is not unchanged: it burnt an offer and stamped a fresh lease. Measured
    -- against a database, six beats a minute apart carrying one token took
    -- offer_count to 1, 2, 3, 4, 5 and then wrote `failed / offer_limit` while
    -- the export was still running, after which the machine's honest ack was
    -- refused. With max_offers = 5 and a one minute heartbeat that is every
    -- export that runs longer than five minutes. The comment was right about what
    -- should happen and the code was doing something else; this is the code
    -- agreeing with it.
    --
    -- So the beat is idempotent. The worker gets back exactly what it was given -
    -- the same token, the same deadline, the same path, the same offer_count - and
    -- the row is not written at all. It has earned no new deadline and it owes no
    -- attempt. The lease is NOT renewed by checking in: if an export really
    -- outlives its lease the server has to be allowed to conclude the machine
    -- died, which is STEP 4's other half and the reason `lease_seconds` has a
    -- five minute floor.
    --
    -- 'held' AND NOT 'offered', because "you are already running this" and "here
    -- is a new job" are different messages and a route that cannot tell them
    -- apart spawns a second export on a trading machine. An outcome a caller does
    -- not recognise makes it do nothing, which is the right thing to do here;
    -- 'offered' would make it do the wrong one. It is answered whether or not the
    -- quiet window is still open, because the window decides whether to START a
    -- run and this run has started.
    return jsonb_build_object(
      'outcome', 'held',
      'request', jsonb_build_object(
        'id', v_request.id,
        'client_id', v_request.client_id,
        'storage_path', v_request.storage_path,
        'lease_token', v_request.lease_token,
        'lease_expires_at', v_request.lease_expires_at,
        'run_mode', v_request.run_mode,
        'offer_count', v_request.offer_count,
        'max_bytes', v_settings.max_bytes,
        'min_free_disk_bytes', v_settings.min_free_disk_bytes,
        'window', jsonb_build_object(
          'start_minute', v_settings.window_start_minute,
          'end_minute', v_settings.window_end_minute,
          'weekend_any_time', v_settings.weekend_any_time,
          'time_zone', coalesce(nullif(btrim(v_device.schedule_timezone), ''), 'America/New_York')
        )
      )
    );
  end if;

  -- STEP 6: THE WINDOW, DECIDED SERVER SIDE, AND IT DOES NOT BURN AN OFFER.
  --
  -- A request that arrives mid session gets no offer at all - the function
  -- returns 'none' and the row stays exactly as it was, so a machine can sit in
  -- 'open' all afternoon at a cost of one index probe a minute. That is why
  -- `max_offers` can be as low as five: offers are only ever spent on a machine
  -- that was actually asked to run.
  --
  -- The device's own timezone, not the server's. `ingest_devices.schedule_timezone`
  -- is constrained to 'America/New_York' (step_28:80-81), so today that is one
  -- value - but reading the column means the day this fleet has a machine
  -- somewhere else, the window follows the machine and not this function.
  if v_request.run_mode <> 'now' then
    v_local := v_now at time zone coalesce(nullif(btrim(v_device.schedule_timezone), ''), 'America/New_York');
    v_minute := extract(hour from v_local)::integer * 60 + extract(minute from v_local)::integer;
    v_is_weekend := extract(isodow from v_local)::integer >= 6;
    v_in_window := (v_is_weekend and v_settings.weekend_any_time)
      or (v_minute >= v_settings.window_start_minute and v_minute < v_settings.window_end_minute);
    if not v_in_window then
      return jsonb_build_object('outcome', 'none');
    end if;
  end if;

  -- STEP 7: OUT OF ATTEMPTS IS A VISIBLE FAILURE AND NOT A LOOP. The reason
  -- recorded is the last thing that actually blocked the machine, so the card
  -- says "the disk was too full five times" rather than "offer limit".
  if v_request.offer_count >= v_settings.max_offers then
    update public.ingest_deep_export_requests
    set status = 'failed',
        failure_code = coalesce(nullif(btrim(v_request.last_deferral_code), ''), 'offer_limit'),
        lease_token = null,
        lease_expires_at = null
    where id = v_request.id;
    return jsonb_build_object('outcome', 'none');
  end if;

  -- STEP 8: OFFER IT.
  --
  -- `storage_path` is coalesced, so it is written on the first offer and never
  -- again. A re-offer therefore reuses the path, which is what lets the signed
  -- upload URL be minted with `upsert: false` and still work on the second
  -- attempt - while a second SUCCESSFUL upload to that path fails in Storage no
  -- matter what the CRM thinks.
  v_storage_path := coalesce(
    v_request.storage_path,
    v_request.client_id::text || '/' || v_request.id::text || '.zip');

  update public.ingest_deep_export_requests
  set status = 'offered',
      lease_token = p_lease_token,
      lease_expires_at = v_now + make_interval(secs => v_lease_seconds),
      offer_count = offer_count + 1,
      offered_at = coalesce(offered_at, v_now),
      storage_path = v_storage_path
  where id = v_request.id
  returning * into v_request;

  return jsonb_build_object(
    'outcome', 'offered',
    'request', jsonb_build_object(
      'id', v_request.id,
      'client_id', v_request.client_id,
      'storage_path', v_request.storage_path,
      'lease_token', v_request.lease_token,
      'lease_expires_at', v_request.lease_expires_at,
      'run_mode', v_request.run_mode,
      'offer_count', v_request.offer_count,
      'max_bytes', v_settings.max_bytes,
      'min_free_disk_bytes', v_settings.min_free_disk_bytes,
      -- THE WINDOW TRAVELS WITH THE OFFER so the agent can re-check it locally
      -- before it spawns anything. The server's clock could be a minute stale
      -- and the machine is the one with the clock that matters to the trading
      -- session.
      'window', jsonb_build_object(
        'start_minute', v_settings.window_start_minute,
        'end_minute', v_settings.window_end_minute,
        'weekend_any_time', v_settings.weekend_any_time,
        'time_zone', coalesce(nullif(btrim(v_device.schedule_timezone), ''), 'America/New_York')
      )
    )
  );
end;
$function$;

revoke all on function public.claim_deep_export_request(uuid, uuid, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_deep_export_request(uuid, uuid, integer, timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------
-- finalize_deep_export_request: the machine's answer, once.
-- ---------------------------------------------------------------------------
--
-- Called by `POST /api/ingest/deep-export`, which authenticates the device the
-- same way every other ingest route does. Three answers, and the difference
-- between the middle one and the last one is the whole reason this is not a
-- boolean:
--
--   uploaded  the package is at storage_path. Terminal.
--   deferred  the machine declined for now - window closed, its own capture
--             upload still queued, not enough free disk. The request goes back to
--             'open', the lease is released, `deferral_count` rises and
--             `offer_count` does NOT. A busy machine can defer all week.
--   failed    the machine tried and cannot. Terminal, with the reason recorded.
--
-- ONE-SHOT IS ENFORCED HERE AND IN THREE OTHER PLACES. This function takes the
-- same advisory lock and the same `for update` chain as the claim, and rejects
-- unless the row is 'offered', belongs to this device, AND the lease token
-- matches. A replayed ack is therefore an error the route turns into 409, never a
-- second accept. Beside it: the partial unique index, the lease's own expiry, and
-- `upsert: false` at the storage layer.
create or replace function public.finalize_deep_export_request(
  p_device_id uuid,
  p_request_id uuid,
  p_lease_token uuid,
  p_outcome text,
  p_content_sha256 text default null,
  p_byte_count bigint default null,
  p_duration_ms integer default null,
  p_warning_count integer default null,
  p_code text default null,
  p_now timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := coalesce(p_now, clock_timestamp());
  v_settings public.ingest_deep_export_settings;
  v_client public.clients;
  v_device public.ingest_devices;
  v_request public.ingest_deep_export_requests;
  v_client_id uuid;
  v_code text := nullif(btrim(lower(coalesce(p_code, ''))), '');
begin
  if p_device_id is null or p_request_id is null or p_lease_token is null
    or p_outcome is null or p_outcome not in ('uploaded', 'deferred', 'failed') then
    raise exception 'invalid_deep_export_ack' using errcode = '22023';
  end if;

  -- A CODE IS CHECKED FOR SHAPE AND NOT AGAINST A LIST, and that is deliberate.
  -- The agent will learn reasons this file has not heard of, and an ack rejected
  -- because the CRM does not recognise a code is the worst failure mode
  -- available: the request stays 'offered', the lease expires, it is re-offered,
  -- and five rounds later it fails as 'offer_limit' with the real reason thrown
  -- away. So: lowercase snake_case, up to 60 characters, stored as given.
  if v_code is not null and v_code !~ '^[a-z][a-z0-9_]{0,59}$' then
    raise exception 'invalid_deep_export_ack' using errcode = '22023';
  end if;
  if p_outcome in ('deferred', 'failed') and v_code is null then
    raise exception 'invalid_deep_export_ack' using errcode = '22023';
  end if;
  if p_outcome = 'uploaded' then
    if p_content_sha256 is null or p_content_sha256 !~ '^[0-9a-f]{64}$'
      or p_byte_count is null or p_byte_count <= 0 then
      raise exception 'invalid_deep_export_ack' using errcode = '22023';
    end if;
  end if;

  select settings.* into v_settings
  from public.ingest_deep_export_settings as settings
  where settings.id
  limit 1;
  if not found then
    raise exception 'deep_export_settings_missing' using errcode = 'P0001';
  end if;

  if p_outcome = 'uploaded' and p_byte_count > v_settings.max_bytes then
    -- The agent is supposed to check this before it uploads. If it did not, the
    -- object is already in the bucket and the prune will take it; what must not
    -- happen is the row recording a package the desk's own limit says may not
    -- exist.
    raise exception 'deep_export_too_large' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_device_id::text || ':deep-export', 0));

  select device.client_id into v_client_id
  from public.ingest_devices as device
  where device.id = p_device_id;
  if not found then
    raise exception 'invalid_ingest_device' using errcode = 'P0001';
  end if;

  select client.* into v_client
  from public.clients as client
  where client.id = v_client_id
  for update;
  if not found then
    raise exception 'invalid_ingest_device' using errcode = 'P0001';
  end if;

  select device.* into v_device
  from public.ingest_devices as device
  where device.id = p_device_id
  for update;
  if not found
    or v_device.client_id is distinct from v_client_id
    or v_device.status is distinct from 'active'
    or v_device.revoked_at is not null then
    raise exception 'invalid_ingest_device' using errcode = 'P0001';
  end if;

  select request.* into v_request
  from public.ingest_deep_export_requests as request
  where request.id = p_request_id
  for update;
  -- THE FOUR THINGS THAT MAKE THIS THE ONLY ACCEPTABLE ACK: the row exists, it
  -- belongs to this device, it is still offered, and the lease token is the one
  -- this worker was given. A revoked request fails the third test, which is what
  -- makes the stop button work mid-flight.
  if not found
    or v_request.device_id is distinct from p_device_id
    or v_request.status is distinct from 'offered'
    or v_request.lease_token is null
    or v_request.lease_token is distinct from p_lease_token then
    raise exception 'deep_export_not_claimable' using errcode = 'P0001';
  end if;

  if p_outcome = 'uploaded' then
    update public.ingest_deep_export_requests
    set status = 'uploaded',
        uploaded_at = v_now,
        content_sha256 = p_content_sha256,
        byte_count = p_byte_count,
        duration_ms = p_duration_ms,
        warning_count = p_warning_count,
        failure_code = null,
        lease_token = null,
        lease_expires_at = null
    where id = v_request.id
    returning * into v_request;
  elsif p_outcome = 'deferred' then
    update public.ingest_deep_export_requests
    set status = 'open',
        deferral_count = deferral_count + 1,
        last_deferral_code = v_code,
        lease_token = null,
        lease_expires_at = null
    where id = v_request.id
    returning * into v_request;
  else
    update public.ingest_deep_export_requests
    set status = 'failed',
        failure_code = v_code,
        lease_token = null,
        lease_expires_at = null
    where id = v_request.id
    returning * into v_request;
  end if;

  return jsonb_build_object(
    'outcome', p_outcome,
    'request', jsonb_build_object(
      'id', v_request.id,
      'device_id', v_request.device_id,
      'client_id', v_request.client_id,
      'status', v_request.status,
      'storage_path', v_request.storage_path,
      'byte_count', v_request.byte_count,
      'content_sha256', v_request.content_sha256,
      'offer_count', v_request.offer_count,
      'deferral_count', v_request.deferral_count,
      'last_deferral_code', v_request.last_deferral_code,
      'failure_code', v_request.failure_code,
      'uploaded_at', v_request.uploaded_at
    )
  );
end;
$function$;

revoke all on function public.finalize_deep_export_request(
  uuid, uuid, uuid, text, text, bigint, integer, integer, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.finalize_deep_export_request(
  uuid, uuid, uuid, text, text, bigint, integer, integer, text, timestamptz
) to service_role;

-- ---------------------------------------------------------------------------
-- Row Level Security, in the shape step 28 gives every auto collection table and
-- step 46 repeats for a table created after step 43 ran.
-- ---------------------------------------------------------------------------
--
-- Nothing in the browser reaches either table. The admin route writes and reads
-- them, the ingest route acks through a function, and both run as the service
-- role, which RLS does not constrain. Step 43 cannot cover what did not exist
-- when it ran, so this file carries its own.
alter table public.ingest_deep_export_requests enable row level security;
alter table public.ingest_deep_export_settings enable row level security;

revoke all on table public.ingest_deep_export_requests from public, anon, authenticated;
revoke all on table public.ingest_deep_export_settings from public, anon, authenticated;

do $deep_export_policies$
begin
  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'ingest_deep_export_requests'
      and policyname = 'ingest_deep_export_requests deny browser direct access'
  ) then
    create policy "ingest_deep_export_requests deny browser direct access"
      on public.ingest_deep_export_requests
      as restrictive
      for all
      to anon, authenticated
      using (false)
      with check (false);
  end if;

  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'ingest_deep_export_settings'
      and policyname = 'ingest_deep_export_settings deny browser direct access'
  ) then
    create policy "ingest_deep_export_settings deny browser direct access"
      on public.ingest_deep_export_settings
      as restrictive
      for all
      to anon, authenticated
      using (false)
      with check (false);
  end if;
end
$deep_export_policies$;

commit;

-- What this leaves: two new tables, each with RLS and exactly one policy, one
-- new private bucket with its own size and mime limits and its own restrictive
-- policy, two functions granted to service_role alone, and no table in public
-- open. The same closing check steps 43, 44, 45 and 46 end with, for the same
-- reason.
do $$
declare
  n integer;
begin
  select count(*) into n from pg_tables where schemaname = 'public' and not rowsecurity;
  if n > 0 then
    raise exception 'step 54 left % table(s) without row level security', n;
  end if;
end $$;
