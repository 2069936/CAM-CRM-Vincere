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

  it('creates a private service-only storage bucket and denies direct browser table access', () => {
    expect(normalizedSql).toMatch(/insert into storage\.buckets\s*\(id, name, public\)[\s\S]*'ninjatrader-imports'[\s\S]*false/);
    expect(normalizedSql).toMatch(/on conflict\s*\(id\)\s*do update[\s\S]*public\s*=\s*false/);
    expect(normalizedSql).not.toMatch(/create policy[^;]*ninjatrader-imports/);

    for (const table of ['ingest_enrollments', 'ingest_devices', 'ingest_batches']) {
      expect(normalizedSql).toContain(`alter table public.${table} enable row level security`);
      expect(normalizedSql).toMatch(new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`));
      expect(normalizedSql).toMatch(new RegExp(`create policy [^;]+ on public\\.${table} as restrictive for all to anon, authenticated using \\(false\\) with check \\(false\\)`));
    }
  });

  it('defines locked, idempotent SECURITY DEFINER RPCs executable only by service_role', () => {
    const pairing = functionDefinition('pair_ingest_device');
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

    expect(normalizedSql).toMatch(/revoke all on function public\.pair_ingest_device\([^;]+from public, anon, authenticated/);
    expect(normalizedSql).toMatch(/grant execute on function public\.pair_ingest_device\([^;]+to service_role/);
    expect(normalizedSql).toMatch(/revoke all on function public\.claim_ingest_batch\([^;]+from public, anon, authenticated/);
    expect(normalizedSql).toMatch(/grant execute on function public\.claim_ingest_batch\([^;]+to service_role/);
  });
});
