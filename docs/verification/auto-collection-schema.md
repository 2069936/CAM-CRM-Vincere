# Auto-collection schema verification

## Verification status

The repository has local static contract coverage for
`supabase/step_28_auto_collection.sql`. No Supabase database credentials are
available in this task, so the migration has **not** been applied to staging and
this document does not claim live SQL execution evidence.

Local verification checks the migration text for the required additive columns,
constraints, indexes, private bucket, RLS boundary, atomic enrollment
administration, durable rate limiting, pairing/batch locking/idempotency,
heartbeat health/throttling/audit behavior, and service-role-only execution
grants. It cannot prove catalog state or runtime behavior in PostgreSQL.

## Local static verification

Run from the repository root:

```bash
npx vitest run supabase/step_28_auto_collection.test.js
npx eslint supabase/step_28_auto_collection.test.js
git diff --check
```

The full repository test command is:

```bash
npm test
```

Evidence recorded on 2026-07-23:

- Focused contract: 1 file passed, 22 tests passed.
- Targeted ESLint: exited 0 with no findings.
- Full Vitest suite: 46 files passed, 632 tests passed.
- `git diff --check`: exited 0 with no findings.
- PostgreSQL 18.3 disposable local cluster: baseline schema plus Step 22 applied,
  revised Step 28 applied twice successfully. `record_ingest_heartbeat` was
  confirmed `SECURITY DEFINER` with fixed `search_path`, executable by
  `service_role`, and not executable by `anon`. This is local syntax/rerun
  evidence only; live Supabase catalog and concurrency evidence remain pending.
- Local sequential RPC cases confirmed empty-name generation/pairing rollback,
  existing global-machine denial, credential unique-constraint classification,
  exact-retry audit idempotence, first-online, unchanged-heartbeat throttling,
  version/error/recovery bypass, exactly-once recovery audit, safe audit keys,
  strict-version rejection, and revoked-device rejection. These do not
  constitute concurrency-race evidence.

## Pending disposable/staging verification

Use a disposable or staging Supabase project whose baseline migrations through
`step_22_ingest_devices.sql` are already applied. Do not paste the connection
string, service-role key, enrollment codes, credentials, or raw hashes into this
file.

1. Apply `supabase/step_28_auto_collection.sql` once.
2. Apply the same file a second time. The second run must complete without schema
   drift. `CREATE OR REPLACE FUNCTION` replaces the RPC bodies and the migration
   reapplies their explicit revokes/grants; a future signature or return-type
   change requires a reviewed drop migration.
3. Exercise two concurrent `pair_ingest_device_v2` calls with identical hashes. Confirm both
   return the same device ID. Repeat with a different machine or credential hash
   and confirm the consumed enrollment is rejected.
4. Exercise two concurrent batch claims with identical metadata. Confirm both
   return the same batch ID. Repeat with changed immutable metadata and confirm
   the retry is rejected.
5. Attempt to update an existing batch's `storage_path` and confirm the immutable
   path trigger rejects it.
6. Using anon and authenticated clients, confirm direct reads and writes to the
   four ingest tables fail and that no raw Storage object can be listed or read.
7. Exercise `create_ingest_enrollment` concurrently for one client and confirm
   only one open enrollment remains. Confirm normal generation rejects an active
   device and explicit rebind revokes its credential before issuing a new code.
8. Exercise `check_ingest_pair_rate_limit` through its threshold, block, and
   window reset using only HMAC keys; confirm no raw IP or code is persisted.
9. Exercise `record_ingest_heartbeat` for first contact, an unchanged throttled
   retry, a version/status change inside the interval, an error, and recovery.
   Confirm `last_seen_at` changes only for accepted writes, first-online and
   recovery audit exactly once, and no audit for repeated healthy heartbeats.
10. Run the catalog queries below and save sanitized result rows under a dated
   staging-evidence section in this document.

The `ninjatrader-imports deny browser direct access` policy is restrictive.
PostgreSQL ANDs restrictive policies with the result of applicable permissive
policies, so its `bucket_id <> 'ninjatrader-imports'` condition denies this bucket
even if another anon/authenticated policy permissively covers every object. The
condition remains true for other buckets, and the policy does not target the
service role; Supabase's service role retains its RLS bypass.

## Catalog queries for staging evidence

```sql
-- Required columns and nullable legacy raw identifiers.
select table_name, column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name in ('ingest_enrollments', 'ingest_devices', 'ingest_batches', 'ingest_pair_rate_limits')
order by table_name, ordinal_position;

-- Checks, foreign keys, uniqueness, and the immutable-path trigger.
select c.conrelid::regclass as relation, c.conname,
       pg_get_constraintdef(c.oid) as definition
from pg_catalog.pg_constraint c
where c.conrelid in (
  'public.ingest_enrollments'::regclass,
  'public.ingest_devices'::regclass,
  'public.ingest_batches'::regclass
)
order by relation::text, c.conname;

select event_object_schema, event_object_table, trigger_name,
       action_timing, event_manipulation
from information_schema.triggers
where event_object_schema = 'public'
  and event_object_table = 'ingest_batches';

-- Required indexes.
select schemaname, tablename, indexname, indexdef
from pg_catalog.pg_indexes
where schemaname = 'public'
  and tablename in ('ingest_enrollments', 'ingest_devices', 'ingest_batches', 'ingest_pair_rate_limits')
order by tablename, indexname;

-- RLS and explicit browser-deny policies.
select n.nspname as schema_name, c.relname as table_name,
       c.relrowsecurity, c.relforcerowsecurity
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('ingest_enrollments', 'ingest_devices', 'ingest_batches', 'ingest_pair_rate_limits');

select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_catalog.pg_policies
where schemaname = 'public'
  and tablename in ('ingest_enrollments', 'ingest_devices', 'ingest_batches', 'ingest_pair_rate_limits')
order by tablename, policyname;

-- Private bucket and every Storage object policy. Review all broad policies and
-- confirm the restrictive ninjatrader-imports exclusion applies to browser roles.
select id, name, public
from storage.buckets
where id = 'ninjatrader-imports';

select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_catalog.pg_policies
where schemaname = 'storage'
  and tablename = 'objects'
order by policyname;

-- SECURITY DEFINER, fixed search_path, and RPC privileges.
select n.nspname as schema_name, p.proname, p.prosecdef, p.proconfig,
       pg_get_function_identity_arguments(p.oid) as identity_arguments,
       p.proacl
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('create_ingest_enrollment', 'revoke_ingest_access',
                    'check_ingest_pair_rate_limit', 'pair_ingest_device',
                    'pair_ingest_device_v2', 'record_ingest_heartbeat',
                    'claim_ingest_batch')
order by p.proname;

select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where specific_schema = 'public'
  and routine_name in ('create_ingest_enrollment', 'revoke_ingest_access',
                       'check_ingest_pair_rate_limit', 'pair_ingest_device',
                       'pair_ingest_device_v2', 'record_ingest_heartbeat',
                       'claim_ingest_batch')
order by routine_name, grantee;
```
