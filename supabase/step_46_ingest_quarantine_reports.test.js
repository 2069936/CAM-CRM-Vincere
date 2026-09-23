import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/* WHAT THIS MIGRATION HAS TO KEEP TRUE.
 *
 * The table is a mirror of a folder on a VPS, replaced whole on every report,
 * so the assertions below pin what makes that a mirror and not a log: one row
 * per capture per device, a re report that upserts rather than duplicates, a
 * delete of what the device no longer holds, and a malformed report that
 * leaves the table as it was. The fifth is that `final` is derived here from
 * the agent's own retry rule and never sent, so the fleet view cannot drift
 * from the policy on the machine.
 */
const migrationUrl = new URL('./step_46_ingest_quarantine_reports.sql', import.meta.url);
const runbookUrl = new URL('./MIGRATIONS_TO_RUN.md', import.meta.url);
const exists = existsSync(migrationUrl);
const raw = exists ? readFileSync(migrationUrl, 'utf8') : '';
const sql = raw
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join(' ')
  .toLowerCase()
  .replace(/\s+/g, ' ');
const runbook = readFileSync(runbookUrl, 'utf8');

function functionDefinition(name) {
  const match = raw.match(new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\([\\s\\S]*?\\$function\\$\\s*;`,
    'i',
  ));
  return match?.[0].toLowerCase().replace(/\s+/g, ' ') ?? '';
}

// The six codes the CRM answers with, per CrmClient.UploadFailure in the agent.
const CRM_CODES = [
  'snapshot_processing_failed',
  'unsupported_schema_version',
  'snapshot_rejected',
  'payload_too_large',
  'capture_requires_replay',
  'capture_conflict',
];

describe('step 46 records what each VPS holds in quarantine', () => {
  it('is documented in the runbook, after the migration before it', () => {
    expect(exists).toBe(true);
    expect(runbook).toMatch(/^\| 46 \| `step_46_ingest_quarantine_reports\.sql` \|.*\|$/m);
    expect(runbook.indexOf('| 46 | `step_46_ingest_quarantine_reports.sql`'))
      .toBeGreaterThan(runbook.indexOf('| 45 | `step_45_ingest_admission_control.sql`'));
    expect(runbook).toMatch(/→ 45 → 46(?: →|\.)/);
  });

  it('says in the runbook what the desk loses by not running it', () => {
    expect(runbook).toContain('46 degrades gracefully');
  });

  it('adds without dropping or rewriting anything', () => {
    expect(sql).toContain('create table if not exists public.ingest_quarantine_reports');
    expect(sql).toContain('create index if not exists idx_ingest_quarantine_reports_client_date');
    expect(sql).not.toMatch(/drop table/);
    expect(sql).not.toMatch(/truncate/);
    expect(sql).not.toMatch(/drop function/);
    expect(sql).not.toMatch(/alter table public\.ingest_(devices|batches)/);
  });

  it('keys one row per capture per device, so a re report replaces rather than duplicates', () => {
    expect(sql).toMatch(/constraint ingest_quarantine_reports_device_capture_unique unique \(device_id, capture_id\)/);
    const record = functionDefinition('record_ingest_quarantine_report');
    expect(record).toMatch(/on conflict \(device_id, capture_id\) do update set/);
    expect(record).toMatch(/set client_id = excluded\.client_id, trading_date = excluded\.trading_date, code = excluded\.code, attempts = excluded\.attempts, quarantined_at = excluded\.quarantined_at, last_attempt_at = excluded\.last_attempt_at, reported_at = excluded\.reported_at/);
  });

  it('derives final from the agent\'s own retry rule and never takes it from the wire', () => {
    // QuarantinePolicy in the agent: the two 422 codes go back under three
    // attempts, capture_requires_replay goes back at every review (the CRM
    // answers it at the door until the desk replays the failed close, and the
    // resend after that is what clears the VPS), nothing else ever does.
    // Stored, so the fleet view reads it as a column.
    expect(sql).toMatch(/final boolean generated always as \( case when code in \('snapshot_processing_failed', 'unsupported_schema_version'\) then attempts >= 3 else code <> 'capture_requires_replay' end \) stored/);
    const record = functionDefinition('record_ingest_quarantine_report');
    expect(record).not.toMatch(/'final'/);
    expect(record).not.toMatch(/\bfinal =/);
  });

  it('knows every code the CRM answers with, and one for a code it has not met', () => {
    for (const code of CRM_CODES) {
      expect(sql).toContain(`'${code}'`);
    }
    // The queue's own codes, for a file on disk that cannot be trusted.
    for (const code of ['queue_payload_corrupt', 'queue_payload_mismatch', 'capture_id_conflict', 'receipt_invalid', 'receipt_hash_mismatch', 'quarantine_reason_invalid']) {
      expect(sql).toContain(`'${code}'`);
    }
    expect(sql).toContain("'other'");
    // Both the CHECK on the table and the list in the function carry the
    // vocabulary, so a row cannot arrive by a path the function did not check.
    expect(sql).toMatch(/constraint ingest_quarantine_reports_code_check check \(code in \(/);
    expect(functionDefinition('record_ingest_quarantine_report')).toMatch(/or v_code not in \( 'snapshot_processing_failed'/);
  });

  it('bounds the report size to what the agent can send, and attempts only below', () => {
    // A close the desk has not replayed for a month has been sent again
    // thirty times, and that number is what the row is for: no upper bound.
    expect(sql).toMatch(/constraint ingest_quarantine_reports_attempts_check check \(attempts >= 0\)/);
    expect(sql).not.toMatch(/attempts between/);
    const record = functionDefinition('record_ingest_quarantine_report');
    expect(record).toMatch(/or jsonb_array_length\(p_items\) > 200 then raise exception 'invalid_quarantine_report' using errcode = '22023'/);
    expect(record).toMatch(/or v_attempts < 0/);
    expect(record).not.toMatch(/v_attempts not between/);
  });

  it('validates every item and answers a malformed report with one public code', () => {
    const record = functionDefinition('record_ingest_quarantine_report');
    expect(record).toMatch(/coalesce\(v_item ->> 'captureid', ''\) !~ '\^\[0-9a-f\]\{8\}-/);
    expect(record).toMatch(/coalesce\(v_item ->> 'tradingdate', ''\) !~ '\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$'/);
    // A missing key reads as SQL null and a null in an OR chain is not true,
    // so every typeof check is wrapped in coalesce.
    expect(record).toMatch(/coalesce\(jsonb_typeof\(v_item -> 'attempts'\), ''\) <> 'number'/);
    expect(record).toMatch(/coalesce\(jsonb_typeof\(v_item -> 'quarantinedat'\), ''\) <> 'string'/);
    // The casts raise on a date that does not exist; the handler turns any of
    // it into the code the endpoint maps to 400.
    expect(record).toMatch(/exception when others then raise exception 'invalid_quarantine_report' using errcode = '22023'/);
    // The same capture twice is not a folder.
    expect(record).toMatch(/or v_capture_id = any \(v_capture_ids\)/);
  });

  it('replaces the inventory whole: what the device no longer holds is deleted', () => {
    const record = functionDefinition('record_ingest_quarantine_report');
    expect(record).toMatch(/delete from public\.ingest_quarantine_reports as report where report\.device_id = p_device_id and not \(report\.capture_id = any \(v_capture_ids\)\)/);
    // After the upserts, never before: a raise in the loop rolls back
    // everything, so the delete cannot run on a report that was refused.
    expect(record.indexOf('delete from public.ingest_quarantine_reports'))
      .toBeGreaterThan(record.indexOf('on conflict (device_id, capture_id) do update'));
  });

  it('refuses a device that is not active with the code the heartbeat uses', () => {
    const record = functionDefinition('record_ingest_quarantine_report');
    expect(record).toMatch(/from public\.ingest_devices as device where device\.id = p_device_id for update/);
    expect(record).toMatch(/or v_device\.status is distinct from 'active' or v_device\.revoked_at is not null then raise exception 'invalid_ingest_device' using errcode = 'p0001'/);
  });

  it('closes the new table to the browser key, in the shape the other collector tables use', () => {
    expect(sql).toContain('alter table public.ingest_quarantine_reports enable row level security');
    expect(sql).toMatch(
      /create policy "ingest_quarantine_reports deny browser direct access" on public\.ingest_quarantine_reports as restrictive for all to anon, authenticated using \(false\) with check \(false\)/,
    );
    expect(sql).toMatch(/revoke all on function public\.record_ingest_quarantine_report\(uuid, jsonb\) from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function public\.record_ingest_quarantine_report\(uuid, jsonb\) to service_role/);
    expect(functionDefinition('record_ingest_quarantine_report')).toContain('security definer');
    expect(sql).toMatch(/raise exception 'step 46 left % table\(s\) without row level security'/);
  });

  it('leaves the heartbeat alone', () => {
    // The whole reason the report has its own endpoint: the heartbeat's
    // vocabulary is fixed on the server and every deployed agent depends on
    // it staying that way.
    expect(sql).not.toMatch(/record_ingest_heartbeat/);
    expect(sql).not.toMatch(/last_error_code/);
  });
});
