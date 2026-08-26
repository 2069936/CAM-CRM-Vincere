// Step 38 is the only migration in this directory that rewrites existing rows,
// which is why it has a contract test where 31–37 do not: those add a nullable
// column and a wrong one is inert, whereas this one changes 460 flag records and
// a wrong one is unrecoverable if the provenance is not written alongside.
//
// The decision it carries out: the desk manager removed the Acknowledge action
// on flags, and the rows already stored as 'Acknowledged' become 'Resolved'
// rather than reopening. Reopening would resurrect 460 items a CAM had already
// closed into the CAM flag queue, which is the only screen that reaches flags
// stranded behind a client's latest close. The product-side half of that
// decision is pinned in src/domain/flagStatusWrites.test.js.

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('./step_38_flag_acknowledged_to_resolved.sql', import.meta.url);
const runbookUrl = new URL('./MIGRATIONS_TO_RUN.md', import.meta.url);
const exists = existsSync(migrationUrl);
const raw = exists ? readFileSync(migrationUrl, 'utf8') : '';
// The executable half, with the comment lines dropped. The file's header prints
// the reversal statement as a comment, so counting statements over the whole
// text would count it as a second UPDATE — which is exactly the thing this
// asserts there is only one of.
const sql = raw
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join(' ')
  .toLowerCase()
  .replace(/\s+/g, ' ');
// And the commentary half, with the `--` markers stripped so an assertion about
// what the file SAYS does not also assert where its lines happen to wrap.
const prose = raw
  .split('\n')
  .map((line) => line.replace(/^\s*--\s?/, ''))
  .join(' ')
  .replace(/\s+/g, ' ');
const runbook = readFileSync(runbookUrl, 'utf8');

describe('step 38 retires the Acknowledged flag status', () => {
  it('sits after 37 in the runbook', () => {
    expect(exists).toBe(true);
    // The run-order TABLE, not merely a mention somewhere in the prose: the
    // table is what someone applying migrations actually reads down.
    expect(runbook).toMatch(
      /^\| 38 \| `step_38_flag_acknowledged_to_resolved\.sql` \|.*\|$/m,
    );
    expect(runbook.indexOf('| 38 | `step_38_flag_acknowledged_to_resolved.sql`'))
      .toBeGreaterThan(runbook.indexOf('| 37 | `step_37_derived_strategy_pnl.sql`'));
    // Written when 38 was the last step, as `→ 37 → 38.` with the sentence's
    // full stop. 39 took the next number, so the run-order line now continues
    // past it and only the link 37 → 38 is this file's to assert. Which number
    // is highest is checked by the highest step's own test.
    expect(runbook).toContain('→ 37 → 38 →');
  });

  it('records what each row was in the same statement that changes it', () => {
    // Not two statements. A run that fails between them would leave rows
    // resolved with no way to tell them from the 4,141 that always were, and the
    // reversal at the top of the file would then be a lie.
    expect(sql).toContain('add column if not exists acknowledged_before_step_38 boolean not null default false');
    expect(sql).toMatch(
      /update public\.operational_flags set status = 'resolved', acknowledged_before_step_38 = true where status = 'acknowledged';/,
    );
    // One UPDATE, so there is no second pass to get out of step with the first.
    expect((sql.match(/update public\.operational_flags/g) || []).length).toBe(1);
  });

  it('leaves resolved_at alone', () => {
    // Acknowledging already stamped it, so every one of these rows carries the
    // moment the CAM actually closed it. Overwriting that with the time the
    // migration ran would destroy the only timestamp there is.
    expect(sql).not.toMatch(/set[^;]*resolved_at/);
    expect(prose).toContain('resolved_at is NOT rewritten');
  });

  it('is idempotent and reversible, and says how', () => {
    // `where status = 'Acknowledged'` finds nothing on a second run, and the
    // column add is guarded. The reversal is printed in the file rather than
    // left to be reconstructed by whoever needs it under pressure.
    expect(sql).toContain("where status = 'acknowledged'");
    expect(sql).toContain('add column if not exists');
    // The reversal lives in the header, so it is read off the prose.
    expect(prose.toLowerCase()).toContain(
      "update public.operational_flags set status = 'acknowledged' where acknowledged_before_step_38;",
    );
  });

  it('adds no CHECK constraint on the status column', () => {
    // Deliberate, and stated in the file: a constraint would be enforced against
    // every writer including the SQL editor and any backfill, and getting its
    // allowed list wrong fails a CAM's flag resolution. The guarantee that
    // matters is that the product never writes the status, and that is pinned by
    // src/domain/flagStatusWrites.test.js.
    expect(sql).not.toMatch(/check\s*\(\s*status/);
    expect(prose).toContain('this step does not add one');
    expect(prose).toContain('src/domain/flagStatusWrites.test.js');
  });
});
