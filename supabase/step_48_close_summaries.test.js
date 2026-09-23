import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXCLUDED_FROM_TOTAL, SEGMENTS } from '../src/domain/operationsSegments.js';

/* WHAT THIS MIGRATION HAS TO KEEP TRUE.
 *
 * It stores figures the manager's first screen used to compute in the browser
 * by downloading every account row in the book. The assertions below pin the
 * four things that make that safe rather than merely smaller:
 *
 *   1. THERE IS NO SEGMENTATION IN SQL. Not a trigger, not a view, not a CASE
 *      over `account_type`. `segmentForAccount` decides which segment an
 *      account close belongs to, in JavaScript, and both ingest paths send the
 *      answer here. deskMoney.js exists because three surfaces on one screen
 *      each ran their own loop and disagreed by 3.1% on the day, with the
 *      weekly figure sign-flipping between two of them on 2026-07-24; a
 *      segmentation rule written a second time in PL/pgSQL is that defect with
 *      a longer fuse.
 *
 *   2. THERE IS NO TOTAL COLUMN. operationsSegments.js refuses one in thirty
 *      lines of comment, and a `total` here would be the same figure coming
 *      back through a table instead of through a function — which is how the
 *      deleted one came back the first time.
 *
 *   3. ONE ROW PER SEGMENT PER CLOSE, replaced wholesale. Two copies of a
 *      close's Cash row would double the desk's cash and nothing on the page
 *      would look wrong.
 *
 *   4. THE ROW NAMES THE ACCOUNTS IT COUNTED. The live/simulated/cash/prop
 *      split is recomputed from each account's CURRENT record on every load, so
 *      a reclassification makes a stored row wrong; naming the accounts is what
 *      lets a reader detect that instead of quietly under-reporting a day.
 */
const migrationUrl = new URL('./step_48_close_summaries.sql', import.meta.url);
const runbookUrl = new URL('./MIGRATIONS_TO_RUN.md', import.meta.url);
const backfillUrl = new URL('../scripts/backfill_close_summaries.mjs', import.meta.url);
const exists = existsSync(migrationUrl);
const raw = exists ? readFileSync(migrationUrl, 'utf8') : '';
/**
 * The statements, with every kind of prose removed.
 *
 * `--` lines, `/* *​/` blocks and the `comment on` statements all go: several of
 * them explain at length why there is no total and why nothing here reads
 * `account_snapshots`, and a guard that fails on its own explanation teaches
 * people to delete the explanation. The prose is checked separately, against
 * `raw`.
 */
const sql = raw
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/comment on [\s\S]*?;\s*$/gim, ' ')
  .toLowerCase()
  .replace(/\s+/g, ' ');
const runbook = readFileSync(runbookUrl, 'utf8');
const backfill = existsSync(backfillUrl) ? readFileSync(backfillUrl, 'utf8') : '';

function functionDefinition(name) {
  const match = raw.match(new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\([\\s\\S]*?\\$function\\$\\s*;`,
    'i',
  ));
  return match?.[0].toLowerCase().replace(/\s+/g, ' ') ?? '';
}

describe('step 48 stores the desk money of one close', () => {
  it('is documented in the runbook, after the migration before it', () => {
    expect(exists).toBe(true);
    expect(runbook).toMatch(/^\| 48 \| `step_48_close_summaries\.sql` \|.*\|$/m);
    expect(runbook.indexOf('| 48 | `step_48_close_summaries.sql`'))
      .toBeGreaterThan(runbook.indexOf('| 47 | `step_47_strategy_ran.sql`'));
    expect(runbook).toMatch(/→ 47 → 48(?: →|\.)/);
  });

  it('says in the runbook what the desk loses by not running it, and how to finish it', () => {
    expect(runbook).toContain('48 degrades gracefully');
    // The backfill is a separate command and the runbook is where an operator
    // finds that out.
    expect(runbook).toContain('node scripts/backfill_close_summaries.mjs');
  });

  it('adds without dropping or rewriting anything', () => {
    expect(sql).toContain('create table if not exists public.close_summaries');
    expect(sql).toContain('create unique index if not exists close_summaries_import_segment_key');
    expect(sql).toContain('create index if not exists close_summaries_client_date_idx');
    expect(sql).not.toMatch(/drop table/);
    expect(sql).not.toMatch(/truncate/);
    expect(sql).not.toMatch(/drop function/);
    expect(sql).not.toMatch(/alter table public\.(account_snapshots|strategy_snapshots|daily_imports)/);
  });

  it('keys one row per segment per close, so a re-upload replaces rather than duplicates', () => {
    expect(sql).toMatch(/create unique index if not exists close_summaries_import_segment_key on public\.close_summaries \(daily_import_id, segment\)/);
    const replace = functionDefinition('replace_close_summaries');
    expect(replace).toContain('delete from public.close_summaries where daily_import_id = any (p_daily_import_ids)');
    // And only the closes the caller named. A payload naming a close nothing
    // deleted first would insert a duplicate and be caught by the index rather
    // than by intent.
    expect(replace).toMatch(/where \(row_value ->> 'daily_import_id'\)::uuid = any \(p_daily_import_ids\)/);
  });

  it('decides no segment anywhere in SQL', () => {
    // THE ASSERTION THIS FILE EXISTS FOR. Anything that looked at an account's
    // type, its name or its simulation mode in here would be a second
    // segmentation, and the desk would have two answers to what it made today.
    expect(sql).not.toMatch(/account_type/);
    expect(sql).not.toMatch(/simulation_mode/);
    expect(sql).not.toMatch(/trading_accounts/);
    expect(sql).not.toMatch(/account_snapshots/);
    expect(sql).not.toMatch(/create trigger/);
    expect(sql).not.toMatch(/create (or replace )?view/);
    // The segment arrives as a string on the payload and is stored as one.
    expect(functionDefinition('replace_close_summaries')).toContain("row_value ->> 'segment'");
  });

  it('has no total column and no check that would reject a new account type', () => {
    expect(sql).not.toMatch(/\btotal\b/);
    // segmentFor() returns an account type nobody has taught it about under
    // that type's own name, so a new type is REPORTED rather than dropped. A
    // CHECK on the segment list would reject the first close that carried one,
    // which is the opposite of reporting it.
    expect(sql).not.toMatch(/check \(segment in \(/);
    expect(sql).toContain('counted_in_total boolean not null default true');
  });

  it('carries the account names the row counted', () => {
    expect(sql).toContain("account_names text[] not null default '{}'");
    expect(functionDefinition('replace_close_summaries')).toContain("row_value -> 'account_names'");
  });

  it('is reachable by the browser and by the collector, and by nobody else', () => {
    expect(sql).toMatch(/revoke all on function public\.replace_close_summaries\(uuid\[\], jsonb\) from public, anon/);
    expect(sql).toMatch(/grant execute on function public\.replace_close_summaries\(uuid\[\], jsonb\) to authenticated, service_role/);
    expect(sql).toContain('security definer');
    expect(sql).toContain('set search_path = pg_catalog, public');
  });

  it('carries its own row level security, because step 43 has already run', () => {
    expect(sql).toContain('alter table public.close_summaries enable row level security');
    expect(sql).toMatch(/create policy "authenticated full access" on public\.close_summaries/);
    expect(sql).toContain('step 48 left % table(s) without row level security');
  });

  it('backfills from the JavaScript that decides the segments, not from SQL', () => {
    // The backfill imports the same module the ingest calls. A PL/pgSQL
    // backfill would have been the second segmentation this whole design
    // refuses, arriving through the back door.
    expect(backfill).toContain("from '../src/domain/closeSummary.js'");
    expect(backfill).toContain('buildCloseSummaryRows');
    expect(backfill).toContain("db.rpc('replace_close_summaries'");
    // One client at a time, and safe to run twice.
    expect(backfill).toContain('for (const client of clients)');
    expect(raw).toContain('Safe to run twice');
  });

  it('stores the same segment strings the product uses', () => {
    // No copy of the vocabulary lives in the migration; this is the check that
    // the two sides are talking about the same nine strings, read out of the
    // module rather than written down here.
    const segments = Object.values(SEGMENTS);
    expect(segments).toContain('Cash');
    expect(segments).toContain('Simulated (not real money)');
    expect([...EXCLUDED_FROM_TOTAL]).toHaveLength(4);
    for (const segment of EXCLUDED_FROM_TOTAL) expect(segments).toContain(segment);
  });
});
