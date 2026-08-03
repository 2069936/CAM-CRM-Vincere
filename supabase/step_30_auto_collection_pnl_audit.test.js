import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('./step_30_auto_collection_pnl_audit.sql', import.meta.url);
const trackerUrl = new URL('./DATABASE_TRACKER.md', import.meta.url);
const exists = existsSync(migrationUrl);
const sql = exists ? readFileSync(migrationUrl, 'utf8').toLowerCase().replace(/\s+/g, ' ') : '';
const tracker = readFileSync(trackerUrl, 'utf8');

function definition(name) {
  return sql.match(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\([\\s\\S]*?\\$function\\$\\s*;`, 'i'))?.[0] || '';
}

describe('step 30 automatic PnL source audit migration', () => {
  it('is tracked after controlled auto-collection replay', () => {
    expect(exists).toBe(true);
    expect(tracker.indexOf('supabase/step_30_auto_collection_pnl_audit.sql'))
      .toBeGreaterThan(tracker.indexOf('supabase/step_29_auto_collection_reprocess.sql'));
  });

  it('accepts only fixed aggregate PnL source buckets without account names or values', () => {
    const normalizer = definition('normalize_auto_pnl_source_summary');
    expect(normalizer).toContain("'realized'");
    expect(normalizer).toContain("'gross_fallback'");
    expect(normalizer).toContain("'gross_missing_realized'");
    expect(normalizer).toContain("'unavailable'");
    expect(normalizer).toContain("'unknown'");
    expect(normalizer).toMatch(/jsonb_object_keys[\s\S]*not in/);
    expect(normalizer).toMatch(/jsonb_typeof\(p_summary -> v_key\) is distinct from 'number'/);
  });

  it('wraps normal and closed persistence atomically and appends aggregate audit evidence', () => {
    const normal = definition('persist_auto_daily_import_v3');
    const closed = definition('persist_closed_auto_daily_import_replacement_v2');
    for (const wrapper of [normal, closed]) {
      expect(wrapper).toContain('normalize_auto_pnl_source_summary');
      expect(wrapper).toContain("'pnl_sources'");
      expect(wrapper).toContain('auto_pnl_source_summary_recorded');
      expect(wrapper).toContain('security definer');
    }
    expect(normal).toContain('public.persist_auto_daily_import_v2');
    expect(closed).toContain('public.persist_closed_auto_daily_import_replacement');
    expect(sql).toMatch(/grant execute on function public\.persist_auto_daily_import_v3\([^;]+to service_role/);
    expect(sql).toMatch(/revoke execute on function public\.persist_auto_daily_import_v2\([^;]+from service_role/);
    expect(sql).toMatch(/grant execute on function public\.persist_closed_auto_daily_import_replacement_v2\([^;]+to service_role/);
    expect(sql).toMatch(/revoke execute on function public\.persist_closed_auto_daily_import_replacement\([^;]+from service_role/);
  });
});
