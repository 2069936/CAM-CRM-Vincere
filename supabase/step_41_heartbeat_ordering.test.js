import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('./step_41_heartbeat_ordering.sql', import.meta.url);
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

describe('step 41 accepts ordinary heartbeat timestamp ordering', () => {
  it('is documented after the migrations it follows', () => {
    expect(exists).toBe(true);
    expect(runbook).toMatch(/^\| 41 \| `step_41_heartbeat_ordering\.sql` \|.*\|$/m);
    expect(runbook.indexOf('| 41 | `step_41_heartbeat_ordering.sql`'))
      .toBeGreaterThan(runbook.indexOf('| 39 | `step_39_client_churn_reason.sql`'));
    expect(runbook).toContain('→ 39 → 41.');
  });

  it('removes both payload and effective timestamp ordering rejections', () => {
    expect(sql).not.toMatch(/p_last_success_at\s*>\s*p_last_capture_at/);
    expect(sql).not.toMatch(/v_effective_success_at\s*>\s*v_effective_capture_at/);
    expect(sql).not.toMatch(/v_effective_capture_at\s+is\s+null[^;]+invalid_heartbeat_request/);
  });

  it('keeps independent future-skew validation for both timestamps', () => {
    expect(sql).toContain("p_last_capture_at > v_now + interval '5 minutes'");
    expect(sql).toContain("p_last_success_at > v_now + interval '5 minutes'");
  });

  it('only replaces the heartbeat function and performs no migration-time data write', () => {
    expect(sql).toContain('create or replace function public.record_ingest_heartbeat');
    expect(sql).not.toMatch(/(?:^|;)\s*(?:delete|truncate|drop)\s/);
    // The UPDATE inside the function is runtime behavior, not executed by the
    // migration itself. There must be no statement after the function body.
    expect(sql.trim()).toMatch(/\$function\$;$/);
  });
});
