import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/* WHAT THIS MIGRATION HAS TO KEEP TRUE.
 *
 * The door only helps if it is a door and not a wall, so the assertions below
 * pin the four things that decide that: it turns away new work only, it leaves
 * the turned away capture claimable, it sends two machines back at different
 * seconds, and it never asks for a wait longer than the two minutes the
 * deployed agent honours. The fifth is that 'at_capacity' stays a different
 * word from 'busy' everywhere, because a duplicate and a shed upload are
 * different facts and the desk counts them separately.
 */
const migrationUrl = new URL('./step_45_ingest_admission_control.sql', import.meta.url);
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

describe('step 45 puts a door on the ingest endpoint', () => {
  it('is documented in the runbook, after the migration before it', () => {
    expect(exists).toBe(true);
    expect(runbook).toMatch(/^\| 45 \| `step_45_ingest_admission_control\.sql` \|.*\|$/m);
    expect(runbook.indexOf('| 45 | `step_45_ingest_admission_control.sql`'))
      .toBeGreaterThan(runbook.indexOf('| 44 | `step_44_algorithm_benchmarks.sql`'));
    expect(runbook).toMatch(/→ 44 → 45(?: →|\.)/);
  });

  it('says in the runbook what the desk loses by not running it', () => {
    expect(runbook).toContain('45 degrades gracefully');
  });

  it('adds without dropping or rewriting anything', () => {
    expect(sql).toContain('create table if not exists public.ingest_admission_settings');
    expect(sql).toMatch(/alter table public\.ingest_batches add column if not exists admission_deferrals/);
    expect(sql).toContain('add column if not exists stage_durations_ms jsonb');
    expect(sql).toContain('add column if not exists ingest_duration_ms integer');
    expect(sql).not.toMatch(/drop table/);
    expect(sql).not.toMatch(/delete from/);
    expect(sql).not.toMatch(/truncate/);
    expect(sql).not.toMatch(/drop function/);
  });

  it('keeps the cap tunable without a deploy, and defensible for the instance it runs on', () => {
    expect(sql).toContain('max_concurrent_ingests integer not null default 4');
    expect(sql).toContain('retry_after_floor_seconds integer not null default 20');
    expect(sql).toContain('retry_after_spread_seconds integer not null default 90');
    expect(sql).toMatch(/insert into public\.ingest_admission_settings \(id\) values \(true\) on conflict \(id\) do nothing/);
    // A single row, addressed without knowing its id.
    expect(sql).toMatch(/check \(id\)/);
    expect(raw).toMatch(/HOW THE DEFAULT OF 4 WAS CHOSEN/);
  });

  it('can never ask for a wait the deployed agent would not honour', () => {
    // RetryPolicy.MaximumDelay in 1.0.3, 1.0.4 and 1.0.5 caps the honoured
    // Retry-After at two minutes. A longer one is silently shortened, so the
    // server would be measuring a spread it is not getting.
    expect(sql).toMatch(
      /check \(retry_after_floor_seconds >= 1 and retry_after_spread_seconds >= 1 and retry_after_floor_seconds \+ retry_after_spread_seconds <= 120\)/,
    );
  });

  it('serialises the count with the grant it guards, so a burst cannot walk through the door', () => {
    // Measured before this line existed: sixty simultaneous claims against a
    // cap of four admitted fifteen, then four, then seven, and with a slow
    // claim transaction ten of ten. With the lock, four of sixty three runs
    // out of three, and four of ten under the slow transaction. The lock
    // must come before the count and be the transaction level kind, so it
    // is held to commit and released on rollback without anyone remembering.
    const decision = sql.slice(sql.indexOf('function public.ingest_admission_decision'));
    const lock = decision.indexOf("pg_advisory_xact_lock(hashtextextended('ingest_admission_door', 0))");
    const count = decision.indexOf("select count(*) into v_in_flight");
    expect(lock).toBeGreaterThan(-1);
    expect(count).toBeGreaterThan(lock);
    expect(decision).not.toMatch(/pg_advisory_lock\(/);
  });

  it('rotates the wait by day, so the same machines are not served last every day', () => {
    expect(sql).toMatch(/hashtextextended\(p_device_id::text \|\| ':' \|\| \(p_now at time zone 'america\/new_york'\)::date::text, 0\)/);
  });

  it('spreads the callers it turns away instead of sending them back together', () => {
    const decision = functionDefinition('ingest_admission_decision');
    expect(decision).toContain('security definer');
    // Derived from the device id and the New York day: two machines turned
    // away in the same second come back at different seconds, one machine
    // comes back the same way all day so the behaviour can be reproduced
    // while it is diagnosed, and no machine is last every day of the year.
    expect(decision).toMatch(/hashtextextended\(p_device_id::text \|\| ':' \|\| \(p_now at time zone 'america\/new_york'\)::date::text, 0\) % v_modulus/);
    expect(decision).toMatch(/v_settings\.retry_after_floor_seconds \+/);
    expect(decision).toMatch(/where batch\.status = 'processing' and batch\.processing_lease_expires_at is not null and batch\.processing_lease_expires_at > p_now/);
    // A missing settings row leaves the door open. A tuning table that was
    // never filled must not be able to stop the desk collecting.
    expect(decision).toMatch(/if not found then .*return jsonb_build_object\('full', false, 'retry_after_seconds', 0, 'in_flight', 0\)/);
  });

  it('counts live work with an index rather than a scan of every batch ever received', () => {
    expect(sql).toMatch(
      /create index if not exists idx_ingest_batches_in_flight on public\.ingest_batches \(processing_lease_expires_at\) where status = 'processing'/,
    );
  });

  it('turns away new work only, and never a duplicate, a lease in flight or a failure', () => {
    const claim = functionDefinition('claim_ingest_batch_v4');
    expect(claim).toContain("'outcome', 'terminal'");
    expect(claim).toContain("'outcome', 'busy'");
    expect(claim).toContain("'outcome', 'failed'");
    expect(claim).toContain("'outcome', 'owned'");
    expect(claim).toContain("'outcome', 'at_capacity'");
    // The three answers about a capture that already exists come before the
    // door is consulted at all.
    const door = claim.indexOf('ingest_admission_decision');
    expect(claim.indexOf("'outcome', 'terminal'")).toBeLessThan(door);
    expect(claim.indexOf("'outcome', 'busy'")).toBeLessThan(door);
    expect(claim.indexOf("'outcome', 'failed'")).toBeLessThan(door);
    // 'busy' keeps its own retry, measured from the live lease, and is not the
    // door's spread wearing the same name.
    expect(claim).toMatch(/v_retry_after := greatest\(1, ceil\(extract\(epoch from \(v_batch\.processing_lease_expires_at - v_now\)\)\)::integer\)/);
  });

  it('leaves a capture it turned away claimable, and counts the shed on the batch', () => {
    const claim = functionDefinition('claim_ingest_batch_v4');
    // A new capture that is turned away still gets its row, in 'received' with
    // no lease. That row is what the agent's retry claims a minute later.
    expect(claim).toMatch(/values \( p_capture_id, p_device_id, v_device\.client_id, p_trading_date, p_captured_at, 'received', p_schema_version, p_storage_path, p_content_sha256, p_byte_count, p_row_counts, null, null, 0, 1 \)/);
    expect(claim).toMatch(/set admission_deferrals = admission_deferrals \+ 1/);
    // Nothing is finalized. A shed upload is not a failed one, and the whole
    // point of the door is that the capture comes back.
    expect(claim).not.toMatch(/finalize_ingest_batch/);
    expect(claim).not.toMatch(/'failed', 'retry_after_seconds', \(v_admission/);
  });

  it('keeps the function the running server calls, so either order of deploy and migration works', () => {
    expect(sql).not.toMatch(/revoke execute on function public\.claim_ingest_batch_v3/);
    expect(sql).not.toMatch(/revoke execute on function public\.finalize_ingest_batch_v2/);
    expect(sql).toMatch(/grant execute on function public\.claim_ingest_batch_v4\([^;]+to service_role/);
    expect(sql).toMatch(/grant execute on function public\.finalize_ingest_batch_v3\([^;]+to service_role/);
  });

  it('writes the stopwatch from the finalize path and never at the cost of the close', () => {
    const finalize = functionDefinition('finalize_ingest_batch_v3');
    // v2 owns the lease and ownership checks. This calls it and only then
    // writes the timings, so a finalize that should fail still fails there.
    expect(finalize.indexOf('finalize_ingest_batch_v2'))
      .toBeLessThan(finalize.indexOf('set stage_durations_ms'));
    expect(finalize).toMatch(/when jsonb_typeof\(p_stage_durations_ms\) = 'object' then p_stage_durations_ms else null/);
    expect(finalize).toMatch(/set stage_durations_ms = v_stages, ingest_duration_ms = coalesce\(v_total, ingest_duration_ms\)/);
    // The endpoint cannot time the call that writes the timing, so the sixth
    // stage is measured here, with clock_timestamp rather than now(), which is
    // the transaction's start and would read zero every time.
    expect(finalize).toMatch(/v_started timestamptz := clock_timestamp\(\)/);
    expect(finalize).toMatch(/jsonb_build_object\('finalize', v_finalize_ms\)/);
    expect(finalize).toMatch(/p_ingest_duration_ms \+ v_finalize_ms/);
    expect(sql).toMatch(/check \(stage_durations_ms is null or jsonb_typeof\(stage_durations_ms\) = 'object'\)/);
    expect(sql).toMatch(/check \(ingest_duration_ms is null or ingest_duration_ms >= 0\)/);
  });

  it('closes the new table to the browser key, in the shape the other collector tables use', () => {
    expect(sql).toContain('alter table public.ingest_admission_settings enable row level security');
    expect(sql).toMatch(
      /create policy "ingest_admission_settings deny browser direct access" on public\.ingest_admission_settings as restrictive for all to anon, authenticated using \(false\) with check \(false\)/,
    );
    expect(sql).toMatch(/revoke all on function public\.claim_ingest_batch_v4\([^;]+from public, anon, authenticated/);
    expect(sql).toMatch(/revoke all on function public\.ingest_admission_decision\(uuid, timestamptz\) from public, anon, authenticated/);
    expect(sql).toMatch(/raise exception 'step 45 left % table\(s\) without row level security'/);
  });
});
