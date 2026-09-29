// Step 50 gets a contract test for one reason above all the others.
//
// It replaces `persist_auto_daily_import`, and that function has been replaced
// before: step 28 created it, 30 rewrote it, 37 touched it, 47 rewrote it again
// to carry `ran` and `ran_basis`. A replacement written against the wrong
// ancestor does not fail. It applies cleanly, returns no error, and quietly
// stops writing whatever the ancestor did not know about.
//
// That is not hypothetical. The first draft of this change was written in a
// checkout that stopped at PR 15, where step 39 was the last migration and this
// function was still step 28's. Its body has no `ran` and no `ran_basis`.
// Running it on production would have left 16,891 populated rows in place and
// written NULL into every row after, with nothing in any log to say so.
//
// So the assertions below are in two halves. The first is about what this step
// ADDS. The second is about what it must not LOSE, and it exists because the
// losing kind of mistake is the kind nothing else catches.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('./step_50_auto_collection_derived_pnl.sql', import.meta.url);
const ancestorUrl = new URL('./step_47_strategy_ran.sql', import.meta.url);
const runbookUrl = new URL('./MIGRATIONS_TO_RUN.md', import.meta.url);
const exists = existsSync(migrationUrl);
const raw = exists ? readFileSync(migrationUrl, 'utf8') : '';
// The executable half, comments dropped: the header discusses the columns it
// must not lose, and an assertion about the body must not be satisfied by prose.
const sql = raw
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');
const flat = sql.toLowerCase().replace(/\s+/g, ' ');
const runbook = readFileSync(runbookUrl, 'utf8');

/** The one statement this step exists to change, without the file around it. */
function functionBody(text) {
  const start = text.indexOf('create or replace function public.persist_auto_daily_import');
  const end = text.indexOf('$function$;', start);
  return start === -1 || end === -1 ? '' : text.slice(start, end);
}

describe('step 50 stores the per-algo split the collector already computes', () => {
  it('is the next free number after 49 and remains unique', () => {
    expect(exists).toBe(true);
    const numbers = readdirSync(new URL('./', import.meta.url))
      .map((name) => /^step_(\d+)_.*\.sql$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    expect(numbers.filter((n) => n === 50)).toHaveLength(1);
    expect(Math.max(...numbers)).toBe(50);
    // 40 stays retired. It held the heartbeat ordering rule and was removed on
    // 2026-08-31 in bb35ff3; the run order has read 39 → 41 ever since, and
    // reusing the slot would make the runbook disagree with the history.
    expect(numbers).not.toContain(40);
  });

  it('is in the runbook table and in the run order', () => {
    expect(runbook).toMatch(/^\| 50 \| `step_50_auto_collection_derived_pnl\.sql` \|.*\|$/m);
    expect(runbook).toContain('→ 49 → 50.');
  });

  it('says in the runbook that it is not independent', () => {
    // 35–39 are independent of each other and the runbook says so. This one is
    // not: it needs 37 for the columns and 47 for the body it replaces.
    expect(runbook).toMatch(/50 is not independent/);
    expect(runbook).toMatch(/after 37 .*after 47|after 47/s);
  });
});

describe('what it adds', () => {
  it('puts the derivation on the account snapshot insert', () => {
    expect(flat).toContain('unrealized_pnl, derivation');
    expect(flat).toContain("case when jsonb_typeof(v_item -> 'derivation') = 'object'");
  });

  it('carries the derivation through the upsert, not only the insert', () => {
    // account_snapshots has on conflict (daily_import_id, account_name), so a
    // re-ingested close takes the update branch. A column added to the insert
    // and forgotten in the update writes once and never again.
    expect(flat).toContain('derivation = excluded.derivation');
  });

  it('puts derived_realized on the strategy insert', () => {
    expect(flat).toContain('realized, unrealized, derived_realized');
    expect(flat).toContain("nullif(v_item ->> 'derivedrealized', '')::numeric");
  });

  it('never fabricates a zero for either', () => {
    /* NULL and 0 are different claims. 0 says "this strategy made nothing";
     * NULL says "the fills could not name this row". step 37 named the
     * fabricated zero as the thing to avoid, and a coalesce(..., 0) on either
     * of these two columns would reintroduce it below every line of product
     * code. */
    expect(flat).not.toMatch(/coalesce\([^)]*derivedrealized[^)]*, 0\)/);
    expect(flat).not.toMatch(/coalesce\([^)]*'derivation'[^)]*\)/);
  });

  it('stops collapsing a reported-but-empty realized to zero', () => {
    // Absent from the payload still means 0, matching numberOrLegacyZero on the
    // manual path. Present and empty is NinjaTrader saying it did not report.
    expect(flat).toContain("case when v_item ? 'realized'");
    expect(flat).not.toContain("coalesce(nullif(v_item ->> 'realized', '')::numeric, 0)");
  });
});

describe('what it must not lose', () => {
  /* The assertions that would have caught the draft written against PR 15.
   * Each names a thing an earlier migration put into this function, which a
   * replacement built on the wrong ancestor drops without erroring. */

  it('keeps step 47: ran and ran_basis are still written', () => {
    expect(flat).toContain('enabled, ran, ran_basis');
    expect(flat).toContain("nullif(v_item ->> 'ran', '')::boolean");
    expect(flat).toContain("nullif(v_item ->> 'ranbasis', '')");
  });

  it('changes nothing in the function except the two insert lists', () => {
    /* The strongest form of the rule: diff this body against the ancestor it
     * claims to copy, and allow only lines that mention the columns this step
     * is for. Anything else differing means the body came from somewhere
     * else. */
    const mine = functionBody(sql).split('\n').map((l) => l.trim()).filter(Boolean);
    const theirs = new Set(
      functionBody(readFileSync(ancestorUrl, 'utf8')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n'))
        .split('\n').map((l) => l.trim()).filter(Boolean),
    );
    /* A line whose only change is its trailing `,` or `;` is the same line
     * with something new after it, which is exactly what adding a column to a
     * values list or an assignment to an update set does. Comparing without
     * that punctuation keeps the check on the code rather than on the commas
     * the change necessarily moves. */
    const bare = (line) => line.replace(/[,;]$/, '');
    const ancestor = new Set([...theirs].map(bare));
    const same = (line) => ancestor.has(bare(line));
    const allowed = /derivation|derived_realized|derivedRealized|case when v_item \? 'realized'|then nullif\(v_item ->> 'realized'/i;
    expect(mine.filter((line) => !same(line) && !allowed.test(line))).toEqual([]);
  });

  it('keeps the function unreachable except through the chain that calls it', () => {
    // step 28 revoked it from every role and 47 restated that rather than
    // assume it. `create or replace` keeps existing privileges, so a file that
    // dropped this line would still be correct today and wrong on a rebuild.
    expect(flat).toContain('revoke all on function public.persist_auto_daily_import(uuid, uuid, jsonb)');
  });

  it('replaces rather than drops, so no privilege and no dependency is lost', () => {
    expect(flat).toContain('create or replace function public.persist_auto_daily_import');
    expect(flat).not.toMatch(/drop function public\.persist_auto_daily_import/);
  });
});

describe('what it does not touch', () => {
  it('rewrites no existing row', () => {
    /* Closes imported before this runs keep their NULLs, which stay honest:
     * nothing was derived for them at write time. Replaying a batch through
     * step 29 is the way to fill them, and that is a decision, not a side
     * effect of a migration. */
    expect(flat).not.toMatch(/\bupdate public\.(strategy_snapshots|account_snapshots)\b/);
    expect(flat).not.toMatch(/\bdelete from public\.(daily_imports|trading_accounts|clients)\b/);
  });

  it('adds no column, because step 37 already added both', () => {
    expect(flat).not.toContain('add column');
  });
});
