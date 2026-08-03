import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('./step_29_auto_collection_reprocess.sql', import.meta.url);
const trackerUrl = new URL('./DATABASE_TRACKER.md', import.meta.url);
const exists = existsSync(migrationUrl);
const sql = exists ? readFileSync(migrationUrl, 'utf8').toLowerCase().replace(/\s+/g, ' ') : '';
const tracker = readFileSync(trackerUrl, 'utf8');

function definition(name) {
  return sql.match(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\([\\s\\S]*?\\$function\\$\\s*;`, 'i'))?.[0] || '';
}

describe('step 29 controlled replay migration', () => {
  it('is tracked after the immutable auto-collection schema', () => {
    expect(exists).toBe(true);
    expect(tracker.indexOf('supabase/step_29_auto_collection_reprocess.sql')).toBeGreaterThan(tracker.indexOf('supabase/step_28_auto_collection.sql'));
  });

  it('claims only replayable batches under a bounded token lease and audits every attempt', () => {
    const claim = definition('claim_ingest_batch_reprocess');
    expect(claim).toContain('security definer');
    expect(claim).toMatch(/status not in \('failed', 'incomplete', 'late_closed_day', 'processing'\)/);
    expect(claim).toMatch(/processing_attempts = processing_attempts \+ 1/);
    expect(sql).toMatch(/add column if not exists reprocess_mode text/);
    expect(sql).toMatch(/reprocess_mode in \('normal', 'closed_day'\)/);
    expect(claim).toMatch(/reprocess_mode = case when p_confirm_closed_day then 'closed_day' else 'normal' end/);
    expect(claim).toContain('ingest_batch_reprocess_started');
    expect(claim).toMatch(/p_confirm_closed_day[\s\S]*daily\.status = 'closed'/);
    expect(claim).toContain("v_actor.role is distinct from 'manager'");
    expect(claim.indexOf('select client.*')).toBeLessThan(claim.indexOf('select device.*'));
    expect(claim.indexOf('select device.*')).toBeLessThan(claim.lastIndexOf('select batch.*'));
    expect(sql).toMatch(/grant execute on function public\.claim_ingest_batch_reprocess\([^;]+to service_role/);
  });

  it('replaces a closed day atomically while restoring Closed and retaining lineage', () => {
    const replace = definition('persist_closed_auto_daily_import_replacement');
    expect(replace).toContain("v_daily.status is distinct from 'closed'");
    expect(replace).toContain("set status = 'manager replacement in progress'");
    expect(replace).toContain('public.persist_auto_daily_import');
    expect(replace).toContain("set status = 'closed'");
    expect(replace).toContain('v_prior_batch_id := v_daily.source_batch_id');
    expect(replace).toMatch(/v_prior_batch_id is not distinct from p_source_batch_id[\s\S]*'already_applied', true/);
    expect(replace).toContain('closed_day_auto_snapshot_replaced');
    expect(replace).toContain("'closed day automatically replaced'");
    expect(replace.indexOf('select client.*')).toBeLessThan(replace.indexOf('select device.*'));
    expect(replace.indexOf('select device.*')).toBeLessThan(replace.lastIndexOf('select batch.*'));
    expect(sql).toMatch(/grant execute on function public\.persist_closed_auto_daily_import_replacement\([^;]+to service_role/);
  });
});
