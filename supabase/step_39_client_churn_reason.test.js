// Step 39 gets a contract test for a different reason than step 38 did.
//
// 38 has one because it rewrites 460 existing rows and a wrong one is
// unrecoverable. 39 rewrites nothing. What it can get wrong is the shape of the
// columns, and one particular wrong shape is a decision the desk manager made
// explicitly and by name:
//
//   "Existing rows have no reason and must not be given a fabricated one:
//    absent is a real state and the panel must show it as such, not as 'Other'."
//
// A `default 'other'` or a `not null` on churn_reason would carry that out
// silently at the database level, below every line of product code, and the
// column that exists to be COUNTED would be the one telling the lie. So the
// absence of both is asserted here rather than remembered.
//
// The product-side half — that the app never fabricates a reason either — is in
// src/domain/clientLifecycle.test.js.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('./step_39_client_churn_reason.sql', import.meta.url);
const runbookUrl = new URL('./MIGRATIONS_TO_RUN.md', import.meta.url);
const exists = existsSync(migrationUrl);
const raw = exists ? readFileSync(migrationUrl, 'utf8') : '';
// The executable half, comments dropped: the header prints the reversal as a
// comment and counting DDL over the whole text would count that too.
const sql = raw
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join(' ')
  .toLowerCase()
  .replace(/\s+/g, ' ');
// The commentary half, with the `--` markers stripped, so an assertion about
// what the file SAYS is not also an assertion about where its lines wrap.
const prose = raw
  .split('\n')
  .map((line) => line.replace(/^\s*--\s?/, ''))
  .join(' ')
  .replace(/\s+/g, ' ');
const runbook = readFileSync(runbookUrl, 'utf8');

describe('step 39 records why a client left', () => {
  it('is the next free number after 38 and is the highest step there is', () => {
    expect(exists).toBe(true);
    // A directory scan, not an existsSync on one guessed filename. The check
    // this replaces looked for a literal `step_39_.sql` and would have missed
    // `step_39_anything.sql` — which is the only spelling a real next step has.
    const numbers = readdirSync(new URL('.', import.meta.url))
      .map((name) => /^step_(\d+)_.*\.sql$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    expect(Math.max(...numbers)).toBe(39);
    expect(numbers.filter((n) => n === 39)).toHaveLength(1);
  });

  it('is in the runbook table and in the run order', () => {
    expect(runbook).toMatch(/^\| 39 \| `step_39_client_churn_reason\.sql` \|.*\|$/m);
    expect(runbook.indexOf('| 39 | `step_39_client_churn_reason.sql`'))
      .toBeGreaterThan(runbook.indexOf('| 38 | `step_38_flag_acknowledged_to_resolved.sql`'));
    expect(runbook).toContain('→ 38 → 39.');
  });

  it('adds three nullable columns and no more', () => {
    expect(sql).toContain('alter table public.clients');
    expect(sql).toContain('add column if not exists churn_reason text');
    expect(sql).toContain('add column if not exists churn_note text');
    expect(sql).toContain('add column if not exists churned_at date');
    expect((sql.match(/add column if not exists/g) || []).length).toBe(3);
  });

  it('gives churn_reason no default and no not null', () => {
    // THE assertion of this file. Either one would back-fill every client
    // already marked Inactive with a reason nobody gave, in the column the
    // retention panel counts. `other` is a real option a CAM can choose;
    // silence has to stay distinguishable from it.
    expect(sql).not.toMatch(/churn_reason[^,;]*default/);
    expect(sql).not.toMatch(/churn_reason[^,;]*not null/);
    expect(sql).not.toMatch(/churned_at[^,;]*default/);
    expect(sql).not.toMatch(/churn_note[^,;]*not null/);
    // And no separate back-fill pass either. This step touches no existing row.
    expect(sql).not.toContain('update public.clients');
    expect(prose).toContain('ALL THREE ARE NULLABLE, AND THAT IS THE POINT');
  });

  it('adds no CHECK constraint on the reason', () => {
    // Same call as step 38 made on operational_flags.status, for the same
    // reason: a constraint binds every writer including the SQL editor, and the
    // failure mode of a wrong allow-list is a rejected churn classification —
    // the exact write this step exists to make possible.
    expect(sql).not.toMatch(/check\s*\(\s*churn_reason/);
    expect(prose).toContain('No CHECK constraint on churn_reason');
  });

  it('is idempotent and says how to reverse it', () => {
    expect((sql.match(/if not exists/g) || []).length).toBe(3);
    expect(prose.toLowerCase()).toContain('drop column if exists churn_reason');
  });

  it('states that reads degrade and the write does not', () => {
    // The one way this step differs from 31–38, and the thing someone deploying
    // ahead of it needs to have been told.
    expect(prose).toContain('READS degrade gracefully');
    expect(prose).toContain('The WRITE does not degrade');
    expect(runbook).toContain('**39 reads gracefully and writes loudly, which is not the same thing.**');
  });
});
