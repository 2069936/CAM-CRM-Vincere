import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import process from 'node:process';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('./step_28_auto_collection.sql', import.meta.url);
const trackerUrl = new URL('./DATABASE_TRACKER.md', import.meta.url);
const migrationExists = existsSync(migrationUrl);
const sql = migrationExists ? readFileSync(migrationUrl, 'utf8') : '';
const normalizedSql = sql.toLowerCase().replace(/\s+/g, ' ');
const tracker = readFileSync(trackerUrl, 'utf8');
const execFileAsync = promisify(execFile);
const pgTestUrl = process.env.AUTO_COLLECTION_TEST_DATABASE_URL;

async function psql(statement) {
  const { stdout } = await execFileAsync('psql', [pgTestUrl, '-v', 'ON_ERROR_STOP=1', '-Atc', statement], {
    timeout: 10_000,
  });
  return stdout.trim();
}

function functionDefinition(name) {
  const match = sql.match(new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\([\\s\\S]*?\\$function\\$\\s*;`,
    'i',
  ));
  return match?.[0].toLowerCase().replace(/\s+/g, ' ') ?? '';
}

function auditStatements() {
  return (sql.match(/insert\s+into\s+public\.audit_logs\s*\([\s\S]*?\)\s*values\s*\([\s\S]*?\)\s*;/gi) || [])
    .join(' ')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

describe('step 28 auto-collection migration contract', () => {
  it('exists and is tracked after the legacy ingest-device migration', () => {
    expect(migrationExists).toBe(true);
    expect(tracker).toContain('supabase/step_28_auto_collection.sql');
    expect(tracker.indexOf('supabase/step_28_auto_collection.sql'))
      .toBeGreaterThan(tracker.indexOf('supabase/step_22_ingest_devices.sql'));
  });

  it('creates enrollment and batch records with the required lifecycle fields', () => {
    expect(normalizedSql).toContain('create table if not exists public.ingest_enrollments');
    for (const column of [
      'id', 'client_id', 'code_hash', 'created_by', 'expires_at', 'consumed_at',
      'consumed_by_device_id', 'revoked_at', 'created_at',
    ]) {
      expect(normalizedSql).toMatch(new RegExp(`\\b${column}\\b`));
    }
    expect(normalizedSql).toMatch(/code_hash text not null unique/);
    expect(normalizedSql).toMatch(/expires_at\s*>\s*created_at/);

    expect(normalizedSql).toContain('create table if not exists public.ingest_batches');
    for (const column of [
      'id', 'capture_id', 'device_id', 'client_id', 'trading_date', 'captured_at',
      'received_at', 'status', 'schema_version', 'storage_path', 'content_sha256',
      'byte_count', 'row_counts', 'completeness', 'daily_import_id',
      'replaces_batch_id', 'error_code', 'error_detail', 'processed_at',
    ]) {
      expect(normalizedSql).toMatch(new RegExp(`\\b${column}\\b`));
    }
  });

  it('adds hashed device identity and collector-health fields without requiring legacy raw identifiers', () => {
    for (const column of [
      'machine_id_hash', 'credential_hash', 'credential_prefix', 'status', 'health_status',
      'schedule_time', 'schedule_timezone', 'agent_version', 'addon_version',
      'ninjatrader_version', 'last_seen_at', 'last_capture_at', 'last_success_at',
      'last_error_code', 'last_error_at', 'revoked_at', 'metadata',
    ]) {
      expect(normalizedSql).toMatch(new RegExp(`add column if not exists ${column}\\b`));
    }
    expect(normalizedSql).toMatch(/alter table public\.ingest_devices alter column product_key drop not null/);
    expect(normalizedSql).toMatch(/alter table public\.ingest_devices alter column machine_id drop not null/);
    expect(normalizedSql).not.toMatch(/\b(?:digest|hmac|crypt)\s*\(/);
    expect(normalizedSql).toMatch(/create unique index if not exists idx_ingest_devices_machine_id_hash_unique/);
    expect(normalizedSql).toMatch(/create unique index if not exists idx_ingest_devices_credential_hash_unique/);

    const pairing = functionDefinition('pair_ingest_device');
    expect(pairing).not.toMatch(/insert into public\.ingest_devices\s*\([^)]*\b(?:product_key|machine_id)\b/);
  });

  it('keeps credential lifecycle separate from constrained heartbeat health', () => {
    expect(normalizedSql).toMatch(/add column if not exists health_status text not null default 'pending'/);
    expect(normalizedSql).toMatch(/health_status in\s*\([^)]*'pending'[^)]*'online'[^)]*'error'[^)]*'update_required'/);
    expect(normalizedSql).toMatch(/status in\s*\([^)]*'active'[^)]*'revoked'/);
  });

  it('enforces uniqueness, immutable storage paths, valid states, timezone, and nonnegative counts', () => {
    expect(normalizedSql).toMatch(/unique\s*\(device_id, capture_id\)/);
    expect(normalizedSql).toMatch(/storage_path text not null unique/);
    expect(normalizedSql).toContain('prevent_ingest_batch_storage_path_change');
    expect(normalizedSql).toMatch(/create index if not exists idx_ingest_batches_client_trading_date/);
    expect(normalizedSql).toMatch(/create index if not exists idx_ingest_batches_device_received_at/);
    expect(normalizedSql).toMatch(/create index if not exists idx_ingest_batches_status_received_at/);
    expect(normalizedSql).toMatch(/status in\s*\([^)]*'active'[^)]*'revoked'/);
    expect(normalizedSql).toMatch(/status in\s*\([^)]*'received'[^)]*'processing'[^)]*'processed'[^)]*'incomplete'[^)]*'late_closed_day'[^)]*'failed'[^)]*'replaced'/);
    expect(normalizedSql).toMatch(/drop constraint if exists ingest_batches_status_check/);
    expect(normalizedSql).toMatch(/schedule_timezone\s*=\s*'america\/new_york'/);
    expect(normalizedSql).toMatch(/schema_version\s*>\s*0/);
    expect(normalizedSql).toContain('ingest_row_counts_are_nonnegative(row_counts)');
  });

  it('returns an explicit atomic claim winner for concurrent duplicate retries', () => {
    const claiming = functionDefinition('claim_ingest_batch_v3');
    expect(claiming).toContain('security definer');
    expect(claiming).toContain('for update');
    expect(claiming).toMatch(/pg_advisory_xact_lock/);
    expect(claiming).toContain("'outcome', 'owned'");
    expect(claiming).toContain("'outcome', 'busy'");
    expect(claiming).toContain("'outcome', 'terminal'");
    expect(claiming).toContain("'outcome', 'failed'");
    expect(claiming).toMatch(/processing_lease_expires_at[^;]+v_now/);
    expect(claiming).toMatch(/processing_token = p_processing_token/);
    expect(claiming.indexOf('select client.*')).toBeLessThan(claiming.indexOf('select device.*'));
    expect(claiming.indexOf('select device.*')).toBeLessThan(claiming.indexOf('select batch.*'));
    expect(claiming).toMatch(/v_device\.client_id is distinct from v_client_id/);
    expect(normalizedSql).toMatch(/add column if not exists processing_token uuid/);
    expect(normalizedSql).toContain('ingest_batches_processing_lease_check');
    expect(normalizedSql).toMatch(/status = 'processing'[^;]+processing_token is not null[^;]+processing_lease_expires_at is not null/);
    expect(normalizedSql).toMatch(/grant execute on function public\.claim_ingest_batch_v3\([^;]+to service_role/);
    expect(normalizedSql).toMatch(/revoke execute on function public\.claim_ingest_batch_v2\([^;]+from service_role/);
    expect(normalizedSql).toMatch(/revoke execute on function public\.claim_ingest_batch\([^;]+from service_role/);
  });

  it('persists normalized automatic imports atomically and refuses closed-day replacement', () => {
    const persistence = functionDefinition('persist_auto_daily_import_v2');
    const internalPersistence = functionDefinition('persist_auto_daily_import');
    expect(normalizedSql).toMatch(/add column if not exists source_type text/);
    expect(normalizedSql).toMatch(/add column if not exists source_batch_id uuid/);
    expect(persistence).toContain('security definer');
    expect(persistence).toContain('for update');
    expect(persistence).toMatch(/status is not distinct from 'closed'/);
    expect(persistence).toContain('daily_import_closed');
    expect(persistence).toMatch(/v_device\.status is distinct from 'active'/);
    expect(persistence).toMatch(/processing_token is distinct from p_processing_token/);
    expect(persistence).toMatch(/processing_lease_expires_at <= clock_timestamp\(\)/);
    expect(persistence).toMatch(/v_batch\.captured_at <= v_prior_batch\.captured_at/);
    expect(persistence).toContain("'disposition', 'superseded'");
    expect(persistence).not.toMatch(/set replaces_batch_id = v_prior_batch\.id/);
    expect(persistence).toContain('public.persist_auto_daily_import');
    expect(internalPersistence).toMatch(/status = 'replaced'/);
    expect(internalPersistence).toMatch(/status in \('processed', 'incomplete', 'processing'\)/);
    expect(internalPersistence).toMatch(/replaces_batch_id = v_daily\.source_batch_id/);
    expect(internalPersistence).toContain('ingest_batch_superseded');
    expect(internalPersistence).toContain("'replacementbatchid', p_source_batch_id");
    expect(internalPersistence).toMatch(/v_prior_batch\.status = 'processing'/);
    expect(internalPersistence).toMatch(/jsonb_array_length[^;]+> 0/);
    for (const table of ['trading_accounts', 'daily_imports', 'account_snapshots', 'strategy_snapshots', 'orders', 'executions', 'operational_flags']) {
      expect(`${persistence} ${internalPersistence}`).toContain(`public.${table}`);
    }
    expect(normalizedSql).toMatch(/grant execute on function public\.persist_auto_daily_import_v2\([^;]+to service_role/);
    expect(normalizedSql).toMatch(/revoke execute on function public\.persist_auto_daily_import\([^;]+from service_role/);
  });

  it('atomically finalizes the batch, device health, one audit and the closed-day alert', () => {
    const finalize = functionDefinition('finalize_ingest_batch_v2');
    const internalFinalize = functionDefinition('finalize_ingest_batch');
    expect(finalize).toContain('security definer');
    expect(finalize.match(/for update/g).length).toBeGreaterThanOrEqual(2);
    expect(finalize).toContain('public.ingest_batches');
    expect(finalize).toContain('public.ingest_devices');
    expect(finalize).toContain('public.finalize_ingest_batch');
    expect(internalFinalize).toContain('public.audit_logs');
    expect(internalFinalize).toContain('public.operational_flags');
    expect(finalize).toMatch(/p_status = 'late_closed_day'/);
    expect(finalize).toMatch(/processing_token is distinct from p_processing_token/);
    expect(finalize).toMatch(/processing_lease_expires_at <= clock_timestamp\(\)/);
    expect(finalize).toMatch(/captured_at is distinct from p_captured_at/);
    expect(finalize).toMatch(/row_counts is distinct from p_row_counts/);
    expect(finalize).toMatch(/client_id is distinct from p_client_id/);
    expect(finalize).toMatch(/v_device\.status is distinct from 'active'/);
    expect(finalize).toMatch(/p_status = 'replaced'/);
    expect(normalizedSql).toMatch(/grant execute on function public\.finalize_ingest_batch_v2\([^;]+to service_role/);
    expect(normalizedSql).toMatch(/revoke execute on function public\.finalize_ingest_batch\([^;]+from service_role/);
  });

  it('provides a service-only token-checked lease release for transient pre-storage failures', () => {
    const release = functionDefinition('release_ingest_batch_lease');
    expect(release).toContain('security definer');
    expect(release).toContain('for update');
    expect(release).toMatch(/processing_token is distinct from p_processing_token/);
    expect(release).toMatch(/status = 'received'/);
    expect(release).toContain('invalid_ingest_device');
    expect(release).toContain('processing_lease_lost');
    expect(release.indexOf('select client.*')).toBeLessThan(release.indexOf('select device.*'));
    expect(release.indexOf('select device.*')).toBeLessThan(release.indexOf('select batch.*'));
    expect(normalizedSql).toMatch(/grant execute on function public\.release_ingest_batch_lease\([^;]+to service_role/);
  });

  it('creates a private bucket and composes a restrictive browser denial with Storage policies', () => {
    expect(normalizedSql).toMatch(/insert into storage\.buckets\s*\(id, name, public\)[\s\S]*'ninjatrader-imports'[\s\S]*false/);
    expect(normalizedSql).toMatch(/on conflict\s*\(id\)\s*do update[\s\S]*public\s*=\s*false/);
    expect(normalizedSql).toMatch(/from pg_catalog\.pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'ninjatrader-imports deny browser direct access'/);
    expect(normalizedSql).toMatch(/create policy "ninjatrader-imports deny browser direct access" on storage\.objects as restrictive for all to anon, authenticated using \(bucket_id <> 'ninjatrader-imports'\) with check \(bucket_id <> 'ninjatrader-imports'\)/);

    for (const table of ['ingest_enrollments', 'ingest_devices', 'ingest_batches']) {
      expect(normalizedSql).toContain(`alter table public.${table} enable row level security`);
      expect(normalizedSql).toMatch(new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`));
      expect(normalizedSql).toMatch(new RegExp(`create policy [^;]+ on public\\.${table} as restrictive for all to anon, authenticated using \\(false\\) with check \\(false\\)`));
    }
  });

  it('defines locked, idempotent SECURITY DEFINER RPCs executable only by service_role', () => {
    const pairing = functionDefinition('pair_ingest_device_v2');
    const claiming = functionDefinition('claim_ingest_batch');

    for (const definition of [pairing, claiming]) {
      expect(definition).toContain('security definer');
      expect(definition).toMatch(/set search_path\s*=\s*pg_catalog, public/);
      expect(definition).toContain('for update');
    }
    expect(pairing).toMatch(/consumed_by_device_id is not null/);
    expect(pairing).toMatch(/revoked_at is not null/);
    expect(pairing).toMatch(/expires_at\s*<=\s*clock_timestamp\(\)/);
    expect(pairing).toMatch(/machine_id_hash is distinct from p_machine_hash/);
    expect(pairing).toMatch(/credential_hash is distinct from p_credential_hash/);
    expect(claiming.match(/for update/g)).toHaveLength(2);
    expect(claiming).toMatch(/where device_id = p_device_id and capture_id = p_capture_id[\s\S]*for update/);
    expect(claiming).toMatch(/storage_path is distinct from p_storage_path/);

    expect(normalizedSql).toMatch(/revoke all on function public\.pair_ingest_device_v2\([^;]+from public, anon, authenticated/);
    expect(normalizedSql).toMatch(/grant execute on function public\.pair_ingest_device_v2\([^;]+to service_role/);
    expect(normalizedSql).toMatch(/revoke all on function public\.claim_ingest_batch\([^;]+from public, anon, authenticated/);
    expect(normalizedSql).toMatch(/grant execute on function public\.claim_ingest_batch\([^;]+to service_role/);
  });

  it('defines a locked service-only heartbeat RPC with bounded unchanged-only throttling', () => {
    const heartbeat = functionDefinition('record_ingest_heartbeat');
    expect(heartbeat).toContain('security definer');
    expect(heartbeat).toMatch(/set search_path\s*=\s*pg_catalog, public/);
    expect(heartbeat).toContain('for update');
    expect(heartbeat).toMatch(/v_device\.status is distinct from 'active'/);
    expect(heartbeat).toMatch(/v_device\.revoked_at is not null/);
    expect(heartbeat).toMatch(/p_min_interval_seconds[^;]+between 1 and 3600/);
    expect(heartbeat).toMatch(/v_unchanged/);
    expect(heartbeat).toMatch(/v_device\.last_seen_at[^;]+make_interval\(secs => p_min_interval_seconds\)/);
    expect(heartbeat).toMatch(/if v_unchanged[^;]+then[\s\S]*return query[\s\S]*true/);
    expect(heartbeat).toMatch(/update public\.ingest_devices[\s\S]*last_seen_at = v_now/);
    expect(heartbeat).toMatch(/metadata = [^;]+lasterrormessage[^;]+queuedepth[^;]+queuebytes[^;]+addonavailable/);
    expect(normalizedSql).toMatch(/revoke all on function public\.record_ingest_heartbeat\([^;]+from public, anon, authenticated/);
    expect(normalizedSql).toMatch(/grant execute on function public\.record_ingest_heartbeat\([^;]+to service_role/);
  });

  it('validates direct heartbeat inputs to the same stable protocol boundary', () => {
    const heartbeat = functionDefinition('record_ingest_heartbeat');
    expect(heartbeat).toMatch(/p_agent_version[^;]+\^\[0-9\]/);
    expect(heartbeat).toMatch(/p_addon_version[^;]+\^\[0-9\]/);
    expect(heartbeat).toMatch(/p_ninjatrader_version is null/);
    for (const code of [
      'ninjatrader_not_running', 'addon_unavailable', 'capture_timeout', 'capture_failed',
      'contract_mismatch', 'queue_capacity_warning', 'upload_failed', 'configuration_error',
    ]) {
      expect(heartbeat).toContain(`'${code}'`);
    }
    expect(heartbeat).toMatch(/p_queue_depth[^;]+>= 0/);
    expect(heartbeat).toMatch(/p_queue_bytes[^;]+>= 0/);
    expect(heartbeat).toContain('9007199254740991');
    expect(heartbeat).toMatch(/char_length\(p_last_error_message\)[^;]+256/);
    expect(heartbeat).toMatch(/p_health_status[^;]+'online'[^;]+'error'[^;]+'update_required'/);
  });

  it('enforces future/order policy and persists monotonic effective timestamps under lock', () => {
    const heartbeat = functionDefinition('record_ingest_heartbeat');
    expect(heartbeat).toMatch(/p_last_capture_at[^;]+v_now \+ interval '5 minutes'/);
    expect(heartbeat).toMatch(/p_last_success_at[^;]+v_now \+ interval '5 minutes'/);
    expect(heartbeat).toMatch(/p_last_success_at[^;]+p_last_capture_at[^;]+p_last_success_at > p_last_capture_at/);
    expect(heartbeat).toMatch(/v_effective_capture_at/);
    expect(heartbeat).toMatch(/v_effective_success_at/);
    expect(heartbeat).toMatch(/greatest\(v_device\.last_capture_at, p_last_capture_at\)/);
    expect(heartbeat).toMatch(/greatest\(v_device\.last_success_at, p_last_success_at\)/);
    expect(heartbeat).toMatch(/v_effective_success_at[^;]+v_effective_capture_at/);
    expect(heartbeat).toMatch(/v_device\.last_capture_at is not distinct from v_effective_capture_at/);
    expect(heartbeat).toMatch(/v_device\.last_success_at is not distinct from v_effective_success_at/);
    expect(heartbeat).toMatch(/last_capture_at = v_effective_capture_at/);
    expect(heartbeat).toMatch(/last_success_at = v_effective_success_at/);
  });

  it('writes first-online and recovery audits atomically without noisy healthy-heartbeat audit', () => {
    const heartbeat = functionDefinition('record_ingest_heartbeat');
    expect(heartbeat).toMatch(/v_device\.health_status = 'pending'[\s\S]*ingest_device\.first_online/);
    expect(heartbeat).toMatch(/v_device\.last_error_code is not null[\s\S]*p_last_error_code is null[\s\S]*ingest_device\.recovered/);
    expect(heartbeat.match(/insert into public\.audit_logs/g)).toHaveLength(2);
    const auditSection = heartbeat.slice(heartbeat.indexOf('if v_first_online'));
    const auditPayloads = (auditSection.match(/jsonb_build_object\([\s\S]*?\)\s*\)/g) || []).join(' ');
    expect(auditPayloads).toMatch(/clientid/);
    expect(auditPayloads).toMatch(/deviceid/);
    expect(auditPayloads).toMatch(/healthstatus/);
    expect(auditPayloads).toMatch(/agentversion/);
    expect(auditPayloads).toMatch(/addonversion/);
    expect(auditPayloads).toMatch(/ninjatraderversion/);
    expect(auditPayloads).toMatch(/lasterrorcode/);
    expect(auditPayloads).not.toMatch(/lasterrormessage|machine|credential|token|ip|request/);
  });

  it('corrects the new-device schedule default to 16:45 without rewriting existing rows', () => {
    expect(normalizedSql).toMatch(/add column if not exists schedule_time time without time zone not null default '16:45:00'/);
    expect(normalizedSql).toMatch(/alter table public\.ingest_devices alter column schedule_time set default '16:45:00'/);
    expect(normalizedSql).not.toMatch(/update public\.ingest_devices set schedule_time/);
  });

  it('enforces one active unconsumed enrollment per client as a database backstop', () => {
    expect(normalizedSql).toMatch(/create unique index if not exists idx_ingest_enrollments_one_open_per_client on public\.ingest_enrollments\(client_id\) where consumed_at is null and revoked_at is null/);
  });

  it('atomically generates, rebinds, and revokes client-scoped ingest access', () => {
    const generating = functionDefinition('create_ingest_enrollment');
    const revoking = functionDefinition('revoke_ingest_access');
    for (const definition of [generating, revoking]) {
      expect(definition).toContain('security definer');
      expect(definition).toMatch(/set search_path\s*=\s*pg_catalog, public/);
      expect(definition).toContain('for update');
    }
    expect(generating).toMatch(/from public\.clients[\s\S]*for update/);
    expect(generating).toMatch(/status[^;]+active/);
    expect(generating).toMatch(/deleted_at is not null/);
    expect(generating).toMatch(/product_key/);
    expect(generating).toMatch(/active_device_exists/);
    expect(generating).toMatch(/update public\.ingest_devices[\s\S]*credential_hash = null[\s\S]*credential_prefix = null/);
    expect(generating).toMatch(/update public\.ingest_enrollments[\s\S]*revoked_at = clock_timestamp\(\)/);
    expect(generating).toMatch(/insert into public\.ingest_enrollments/);
    expect(generating).toMatch(/insert into public\.audit_logs/);
    expect(generating).toMatch(/p_action_code/);
    expect(generating).toMatch(/p_reason_code/);
    expect(revoking).toMatch(/p_client_id/);
    expect(revoking).toMatch(/update public\.ingest_(?:devices|enrollments)/);
    expect(revoking).toMatch(/insert into public\.audit_logs/);
    expect(revoking).toMatch(/p_actor_id/);
    for (const name of ['create_ingest_enrollment', 'revoke_ingest_access']) {
      expect(normalizedSql).toMatch(new RegExp(`revoke all on function public\\.${name}\\([^;]+from public, anon, authenticated`));
      expect(normalizedSql).toMatch(new RegExp(`grant execute on function public\\.${name}\\([^;]+to service_role`));
    }
  });

  it('uses a durable HMAC-keyed pairing limiter with an atomic service-only RPC', () => {
    expect(normalizedSql).toContain('create table if not exists public.ingest_pair_rate_limits');
    expect(normalizedSql).toMatch(/key_hash text primary key/);
    for (const column of ['window_started_at', 'attempt_count', 'blocked_until', 'updated_at']) {
      expect(normalizedSql).toMatch(new RegExp(`\\b${column}\\b`));
    }
    expect(normalizedSql).toMatch(/alter table public\.ingest_pair_rate_limits enable row level security/);
    expect(normalizedSql).toMatch(/revoke all on table public\.ingest_pair_rate_limits from public, anon, authenticated/);
    expect(normalizedSql).toMatch(/grant select, insert, update, delete on table public\.ingest_pair_rate_limits to service_role/);
    expect(normalizedSql).not.toMatch(/\bip_address\b|\braw_ip\b|\benrollment_code\b/);

    const limiting = functionDefinition('check_ingest_pair_rate_limit');
    expect(limiting).toContain('security definer');
    expect(limiting).toContain('for update');
    expect(limiting).toMatch(/p_max_attempts/);
    expect(limiting).toMatch(/p_window_seconds/);
    expect(limiting).toMatch(/p_block_seconds/);
    expect(limiting).toMatch(/window_started_at/);
    expect(limiting).toMatch(/blocked_until/);
    expect(normalizedSql).toMatch(/revoke all on function public\.check_ingest_pair_rate_limit\([^;]+from public, anon, authenticated/);
    expect(normalizedSql).toMatch(/grant execute on function public\.check_ingest_pair_rate_limit\([^;]+to service_role/);
  });

  it('allows a rebind to the same machine only after the former active binding is revoked', () => {
    expect(normalizedSql).toMatch(/create unique index if not exists idx_ingest_devices_machine_id_hash_unique on public\.ingest_devices\(machine_id_hash\) where machine_id_hash is not null and status = 'active' and revoked_at is null/);
  });

  it('uses one deterministic deadlock-safe lock order: client, enrollment IDs, then device IDs', () => {
    const generating = functionDefinition('create_ingest_enrollment');
    const revoking = functionDefinition('revoke_ingest_access');
    const pairing = functionDefinition('pair_ingest_device_v2');

    const generationClient = generating.indexOf('from public.clients');
    const generationEnrollments = generating.indexOf('from public.ingest_enrollments');
    const generationDevices = generating.indexOf('from public.ingest_devices');
    expect(generationClient).toBeGreaterThan(-1);
    expect(generationClient).toBeLessThan(generationEnrollments);
    expect(generationEnrollments).toBeLessThan(generationDevices);
    expect(generating).toMatch(/from public\.ingest_enrollments as enrollment[\s\S]*order by enrollment\.id[\s\S]*for update/);
    expect(generating).toMatch(/from public\.ingest_devices as device[\s\S]*order by device\.id[\s\S]*for update/);

    expect(revoking.indexOf('from public.clients')).toBeLessThan(revoking.indexOf('from public.ingest_enrollments'));
    expect(revoking.indexOf('from public.ingest_enrollments')).toBeLessThan(revoking.indexOf('from public.ingest_devices'));
    expect(revoking).toMatch(/order by enrollment\.id[\s\S]*for update/);

    const unlockedRead = pairing.indexOf('select enrollment.client_id');
    const pairClientLock = pairing.indexOf('from public.clients');
    const pairEnrollmentLock = pairing.indexOf('select enrollment.*');
    const pairDeviceLock = pairing.indexOf('from public.ingest_devices');
    expect(unlockedRead).toBeGreaterThan(-1);
    expect(unlockedRead).toBeLessThan(pairClientLock);
    expect(pairClientLock).toBeLessThan(pairEnrollmentLock);
    expect(pairEnrollmentLock).toBeLessThan(pairDeviceLock);
    expect(pairing).toMatch(/order by device\.id[\s\S]*for update/);
  });

  it('pairs and writes success audit atomically in v2 without a post-RPC client query', () => {
    const pairing = functionDefinition('pair_ingest_device_v2');
    expect(pairing).toContain('client_name');
    expect(pairing).toMatch(/insert into public\.audit_logs/);
    expect(pairing).toMatch(/ingest_pair\.succeeded/);
    expect(pairing).toMatch(/code_not_found/);
    expect(pairing).toMatch(/code_expired/);
    expect(pairing).toMatch(/machine_conflict/);
    expect(pairing).toMatch(/nonce_or_credential_conflict/);
    expect(normalizedSql).toMatch(/revoke all on function public\.pair_ingest_device\([^;]+from public, anon, authenticated, service_role/);
    expect(normalizedSql).not.toMatch(/grant execute on function public\.pair_ingest_device\([^;]+to service_role/);
  });

  it('keeps atomic audit payloads to IDs, allowlisted codes, and validated numeric versions', () => {
    const definitions = [
      functionDefinition('create_ingest_enrollment'),
      functionDefinition('revoke_ingest_access'),
      functionDefinition('pair_ingest_device_v2'),
    ].join(' ');
    const audits = auditStatements();
    expect(audits).toMatch(/jsonb_build_object/);
    expect(audits).not.toMatch(/code_hash|machine_id_hash|credential_hash|credential_prefix|product_key/);
    expect(audits).not.toMatch(/request_body|pairing_nonce|ip_hash/);
    expect(definitions).toMatch(/p_agent_version[^;]+\^\[0-9\]/);
    expect(definitions).toMatch(/p_agent_version is null/);
    expect(definitions).toMatch(/p_addon_version is null/);
    expect(definitions).toMatch(/vps_rebuilt/);
    expect(definitions).toMatch(/security_revoke/);
  });

  it('rejects blank client names in both generation eligibility and pairing revalidation', () => {
    const generating = functionDefinition('create_ingest_enrollment');
    const pairing = functionDefinition('pair_ingest_device_v2');
    expect(generating).toMatch(/nullif\(btrim\(v_client\.name\), ''\) is null/);
    expect(pairing).toMatch(/nullif\(btrim\(v_client\.name\), ''\) is null/);
    expect(pairing).toMatch(/client_ineligible/);
  });

  it('locks and prechecks a globally active machine before insert at the device lock stage', () => {
    const pairing = functionDefinition('pair_ingest_device_v2');
    expect(pairing).toMatch(/machine_id_hash = p_machine_hash/);
    expect(pairing).toMatch(/from public\.ingest_devices as device[\s\S]*machine_id_hash = p_machine_hash[\s\S]*order by device\.id[\s\S]*for update/);
    const globalCheck = pairing.lastIndexOf('machine_id_hash = p_machine_hash');
    const deviceInsert = pairing.indexOf('insert into public.ingest_devices');
    expect(globalCheck).toBeGreaterThan(-1);
    expect(globalCheck).toBeLessThan(deviceInsert);
    expect(pairing).toMatch(/raise exception 'machine_conflict'/);
  });

  it('maps only known insert unique constraints and rethrows unknown unique violations', () => {
    const pairing = functionDefinition('pair_ingest_device_v2');
    expect(pairing).toMatch(/exception when unique_violation/);
    expect(pairing).toMatch(/get stacked diagnostics[^;]+constraint_name/);
    expect(pairing).toContain('idx_ingest_devices_machine_id_hash_unique');
    expect(pairing).toContain('idx_ingest_devices_credential_hash_unique');
    expect(pairing).toMatch(/raise exception 'credential_conflict'/);
    expect(pairing).toMatch(/else raise; end if/);
  });

  it('writes pair success audit only for a newly created device, not an exact retry', () => {
    const pairing = functionDefinition('pair_ingest_device_v2');
    expect(pairing.match(/insert into public\.audit_logs/g)).toHaveLength(1);
    expect(pairing).toMatch(/v_device_created boolean := false/);
    expect(pairing).toMatch(/v_device_created := true/);
    expect(pairing).toMatch(/if v_device_created then[\s\S]*insert into public\.audit_logs/);
  });
});

describe('step 28 PostgreSQL concurrency regression', () => {
  const databaseIt = pgTestUrl ? it : it.skip;

  databaseIt('serializes claim against device revocation without deadlock', async () => {
    const clientId = '17171717-1717-4717-8717-171717171717';
    const deviceId = '27272727-2727-4727-8727-272727272727';
    const actorId = '37373737-3737-4737-8737-373737373737';
    const captureId = '47474747-4747-4747-8747-474747474747';
    const token = '57575757-5757-4757-8757-575757575757';
    await psql(`
      insert into public.app_users(id, username, display_name, role)
      values ('${actorId}', 'task7-concurrency', 'Task 7 Concurrency', 'Manager')
      on conflict (id) do nothing;
      insert into public.clients(id, name) values ('${clientId}', 'Task 7 Concurrency')
      on conflict (id) do nothing;
      delete from public.ingest_batches where device_id = '${deviceId}';
      delete from public.ingest_devices where id = '${deviceId}';
      insert into public.ingest_devices(
        id, client_id, machine_id_hash, credential_hash, credential_prefix, status
      ) values ('${deviceId}', '${clientId}', repeat('7', 64), repeat('8', 64), 'task7con', 'active');
    `);

    const claim = psql(`
      begin;
      set local deadlock_timeout = '100ms';
      set local statement_timeout = '5s';
      select id from public.clients where id = '${clientId}' for update;
      select pg_sleep(1);
      select public.claim_ingest_batch_v3(
        '${deviceId}', '${captureId}', '2026-07-23', '2026-07-23T16:45:00-04:00', 1,
        '${clientId}/2026-07-23/${captureId}.json.gz', repeat('a', 64), 10,
        '{"accounts":0,"strategies":0,"orders":0,"executions":0}'::jsonb,
        '${token}', 120
      )->>'outcome';
      commit;
    `);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const revoke = psql(`
      begin;
      set local deadlock_timeout = '100ms';
      set local statement_timeout = '5s';
      select revoked_kind from public.revoke_ingest_access(
        '${clientId}', null, '${deviceId}', 'support_reset', '${actorId}'
      );
      commit;
    `);
    const [claimOutput, revokeOutput] = await Promise.all([claim, revoke]);
    expect(claimOutput).toContain('owned');
    expect(revokeOutput).toContain('device');
    await expect(psql(`select status from public.ingest_devices where id = '${deviceId}'`))
      .resolves.toBe('revoked');
    await expect(psql(`select count(*) from public.ingest_batches where capture_id = '${captureId}'`))
      .resolves.toBe('1');
  }, 15_000);

  databaseIt('keeps replacement history directed and audits crash recovery exactly once', async () => {
    const clientId = '18181818-1818-4818-8818-181818181818';
    const deviceId = '28282828-2828-4828-8828-282828282828';
    const oldCapture = '48484848-4848-4848-8848-484848484848';
    const newerCapture = '49494949-4949-4949-8949-494949494949';
    const lateOlderCapture = '50505050-5050-4050-8050-505050505050';
    const oldToken = '58585858-5858-4858-8858-585858585858';
    const newerToken = '59595959-5959-4959-8959-595959595959';
    const lateOlderToken = '60606060-6060-4060-8060-606060606060';
    const counts = '{"accounts":0,"strategies":0,"orders":0,"executions":0}';
    const importResult = '{"id":"task7-history","date":"2026-07-25","accounts":{},"snapshots":[],"strategies":[],"orders":[],"executions":[],"flags":[]}';
    await psql(`
      insert into public.clients(id, name) values ('${clientId}', 'Task 7 History')
      on conflict (id) do nothing;
      delete from public.ingest_batches where device_id = '${deviceId}';
      delete from public.ingest_devices where id = '${deviceId}';
      insert into public.ingest_devices(
        id, client_id, machine_id_hash, credential_hash, credential_prefix, status
      ) values ('${deviceId}', '${clientId}', repeat('9', 64), repeat('a', 64), 'task7his', 'active');
    `);
    const claim = (captureId, capturedAt, token, hash) => psql(`
      select public.claim_ingest_batch_v3(
        '${deviceId}', '${captureId}', '2026-07-25', '${capturedAt}', 1,
        '${clientId}/2026-07-25/${captureId}.json.gz', repeat('${hash}', 64), 10,
        '${counts}'::jsonb, '${token}', 120
      )->'batch'->>'id'
    `);
    const persist = (batchId, token) => psql(`
      select public.persist_auto_daily_import_v2(
        '${clientId}', '${batchId}', '${token}', '${importResult}'::jsonb
      )->>'disposition'
    `);

    const oldBatch = await claim(oldCapture, '2026-07-25T16:40:00-04:00', oldToken, 'b');
    await expect(persist(oldBatch, oldToken)).resolves.toBe('persisted');
    const newerBatch = await claim(newerCapture, '2026-07-25T16:45:00-04:00', newerToken, 'c');
    await expect(persist(newerBatch, newerToken)).resolves.toBe('persisted');
    await expect(psql(`
      select status || '|' || (replaces_batch_id is null)::text || '|' || (daily_import_id is not null)::text
      from public.ingest_batches where id = '${oldBatch}'
    `)).resolves.toBe('replaced|true|true');
    await expect(psql(`
      select count(*) || '|' || min(after_data->>'replacementBatchId')
      from public.audit_logs
      where entity_id = '${oldBatch}' and action = 'ingest_batch_superseded'
    `)).resolves.toBe(`1|${newerBatch}`);
    await expect(persist(newerBatch, newerToken)).resolves.toBe('persisted');
    await expect(psql(`
      select count(*) from public.audit_logs
      where entity_id = '${oldBatch}' and action = 'ingest_batch_superseded'
    `)).resolves.toBe('1');

    const lateOlderBatch = await claim(lateOlderCapture, '2026-07-25T16:35:00-04:00', lateOlderToken, 'd');
    await expect(persist(lateOlderBatch, lateOlderToken)).resolves.toBe('superseded');
    const dailyId = await psql(`
      select id from public.daily_imports
      where client_id = '${clientId}' and trading_date = '2026-07-25'
    `);
    await psql(`
      select status from public.finalize_ingest_batch_v2(
        '${lateOlderBatch}', '${deviceId}', '${clientId}', '${lateOlderToken}',
        'replaced', '${dailyId}', '2026-07-25T16:35:00-04:00', true, null,
        '{}'::jsonb, '${counts}'::jsonb, 'ingest_batch_superseded'
      )
    `);
    await expect(psql(`
      select status || '|' || (replaces_batch_id is null)::text || '|' || (daily_import_id = '${dailyId}')::text
      from public.ingest_batches where id = '${lateOlderBatch}'
    `)).resolves.toBe('replaced|true|true');
  }, 15_000);

  databaseIt('distinguishes revoked release credentials from token lease loss', async () => {
    const clientId = '19191919-1919-4919-8919-191919191919';
    const deviceId = '29292929-2929-4929-8929-292929292929';
    const captureId = '51515151-5151-4151-8151-515151515151';
    const token = '61616161-6161-4161-8161-616161616161';
    await psql(`
      insert into public.clients(id, name) values ('${clientId}', 'Task 7 Release')
      on conflict (id) do nothing;
      delete from public.ingest_batches where device_id = '${deviceId}';
      delete from public.ingest_devices where id = '${deviceId}';
      insert into public.ingest_devices(
        id, client_id, machine_id_hash, credential_hash, credential_prefix, status
      ) values ('${deviceId}', '${clientId}', repeat('e', 64), repeat('f', 64), 'task7rel', 'active');
    `);
    const batchId = await psql(`
      select public.claim_ingest_batch_v3(
        '${deviceId}', '${captureId}', '2026-07-26', '2026-07-26T16:45:00-04:00', 1,
        '${clientId}/2026-07-26/${captureId}.json.gz', repeat('e', 64), 10,
        '{"accounts":0,"strategies":0,"orders":0,"executions":0}'::jsonb,
        '${token}', 120
      )->'batch'->>'id'
    `);
    await expect(psql(`
      select public.release_ingest_batch_lease(
        '${batchId}', '${deviceId}', '62626262-6262-4262-8262-626262626262'
      )
    `)).rejects.toMatchObject({ stderr: expect.stringContaining('processing_lease_lost') });
    await psql(`update public.ingest_devices set status = 'revoked', revoked_at = clock_timestamp() where id = '${deviceId}'`);
    await expect(psql(`
      select public.release_ingest_batch_lease('${batchId}', '${deviceId}', '${token}')
    `)).rejects.toMatchObject({ stderr: expect.stringContaining('invalid_ingest_device') });
  }, 15_000);
});
