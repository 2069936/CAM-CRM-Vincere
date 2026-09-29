// Step 51 gets a contract test because what it removes is invisible.
//
// A revoke leaves no object behind to inspect. If a later migration re-grants
// on app_users - or if somebody writes `grant all on all tables in schema
// public to authenticated`, which is the shape that created this - nothing
// fails, nothing logs, and a CAM can promote themselves again. The assertions
// below are the only place that states the intended end state.
//
// The other half, that the browser still only READS this table, is asserted
// against the source rather than remembered: revoking SELECT here would lock
// every user out of the CRM, and the two reads that would break are named.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('./step_51_app_users_write_lockdown.sql', import.meta.url);
const authUrl = new URL('../src/domain/supabaseAuth.js', import.meta.url);
const runbookUrl = new URL('./MIGRATIONS_TO_RUN.md', import.meta.url);
const exists = existsSync(migrationUrl);
const raw = exists ? readFileSync(migrationUrl, 'utf8') : '';
// The executable half. The header discusses SELECT at length and an assertion
// about the statements must not be satisfied by prose.
const sql = raw
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join(' ')
  .toLowerCase()
  .replace(/\s+/g, ' ');
const runbook = readFileSync(runbookUrl, 'utf8');

describe('step 51 takes the write away', () => {
  it('is the next free number after 50 and remains unique', () => {
    expect(exists).toBe(true);
    const numbers = readdirSync(new URL('./', import.meta.url))
      .map((name) => /^step_(\d+)_.*\.sql$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    expect(numbers.filter((n) => n === 51)).toHaveLength(1);
    expect(Math.max(...numbers)).toBe(51);
  });

  it('is in the runbook table and in the run order', () => {
    expect(runbook).toMatch(/^\| 51 \| `step_51_app_users_write_lockdown\.sql` \|.*\|$/m);
    expect(runbook).toContain('→ 50 → 51.');
  });

  it('revokes every write from authenticated', () => {
    expect(sql).toContain('revoke insert, update, delete on public.app_users from authenticated');
  });

  it('revokes them from anon as well', () => {
    // anon reaches nothing today because it has no policy here. Restated so a
    // policy added later does not quietly hand it whatever the grant allows.
    expect(sql).toContain('revoke insert, update, delete on public.app_users from anon');
  });

  it('takes truncate, trigger and references too', () => {
    /* "May only SELECT" has to be true rather than nearly true. TRUNCATE
     * empties the table and is not an INSERT, UPDATE or DELETE; TRIGGER
     * attaches code to somebody else's write; REFERENCES lets an unaudited
     * table decide whether a user can be deleted. None is reachable through
     * PostgREST today, which is why they survived the first pass. */
    expect(sql).toContain('revoke truncate, trigger, references on public.app_users from authenticated');
    expect(sql).toContain('revoke truncate, trigger, references on public.app_users from anon');
  });

  /* THE ONE THING IT MUST NOT TAKE. Revoking SELECT locks every user out: the
   * browser reads this table to sign in, before any session-scoped route
   * exists to read it for them. */
  it('leaves select alone', () => {
    expect(sql).not.toMatch(/revoke[^;]*\bselect\b[^;]*on public\.app_users/);
    expect(sql).not.toMatch(/revoke all[^;]*on public\.app_users/);
  });

  it('the browser only reads app_users, which is why select survives', () => {
    /* Checked against the source, not remembered. If a write ever appears here
     * this test fails, and whoever added it learns from this file that the
     * grant it needs was taken away on purpose. */
    const auth = readFileSync(authUrl, 'utf8');
    const calls = [...auth.matchAll(/\.from\('app_users'\)([\s\S]{0,200})/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toMatch(/\.select\(/);
      expect(call).not.toMatch(/\.(insert|update|upsert|delete)\(/);
    }
  });

  it('drops no table and changes no row', () => {
    // A revoke is the whole migration. Anything else here would be a different
    // change wearing this one's number.
    expect(sql).not.toMatch(/\bdrop table\b|\bdelete from\b|\bupdate public\./);
    expect(sql).not.toContain('alter table');
  });
});
