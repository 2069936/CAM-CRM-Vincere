import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('./step_28_auto_collection.sql', import.meta.url);
const trackerUrl = new URL('./DATABASE_TRACKER.md', import.meta.url);
const migrationExists = existsSync(migrationUrl);
const sql = migrationExists ? readFileSync(migrationUrl, 'utf8') : '';
const normalizedSql = sql.toLowerCase().replace(/\s+/g, ' ');
const tracker = readFileSync(trackerUrl, 'utf8');

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
      'machine_id_hash', 'credential_hash', 'credential_prefix', 'status',
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

  it('enforces uniqueness, immutable storage paths, valid states, timezone, and nonnegative counts', () => {
    expect(normalizedSql).toMatch(/unique\s*\(device_id, capture_id\)/);
    expect(normalizedSql).toMatch(/storage_path text not null unique/);
    expect(normalizedSql).toContain('prevent_ingest_batch_storage_path_change');
    expect(normalizedSql).toMatch(/create index if not exists idx_ingest_batches_client_trading_date/);
    expect(normalizedSql).toMatch(/create index if not exists idx_ingest_batches_device_received_at/);
    expect(normalizedSql).toMatch(/create index if not exists idx_ingest_batches_status_received_at/);
    expect(normalizedSql).toMatch(/status in\s*\([^)]*'active'[^)]*'revoked'/);
    expect(normalizedSql).toMatch(/status in\s*\([^)]*'received'[^)]*'processing'[^)]*'processed'[^)]*'failed'[^)]*'replaced'/);
    expect(normalizedSql).toMatch(/schedule_timezone\s*=\s*'america\/new_york'/);
    expect(normalizedSql).toMatch(/schema_version\s*>\s*0/);
    expect(normalizedSql).toContain('ingest_row_counts_are_nonnegative(row_counts)');
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
});
