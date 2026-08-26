// The Acknowledge action is gone, and the flags it already wrote are still closed.
//
// Two halves, and they pull in opposite directions on purpose.
//
// A flag had Resolve and Acknowledge ("seen, hide for now"). The desk manager
// wanted one way to close a flag, so Acknowledge went — the buttons, the status
// the buttons wrote, the audit action, the activity wording. What could NOT go
// is the 460 rows already carrying that status on the real book (409 Warning,
// 51 Critical, against 4,141 Resolved and 1,952 Open across 6,553). Those were a
// CAM deciding the thing was seen and needed nothing more, and every read path
// in the app has always excluded that status exactly where it excludes Resolved.
//
// So the rule this file pins is one sentence: 'Acknowledged' may be COMPARED
// AGAINST and never WRITTEN. Deleting the comparison resurrects 460 closed items
// into the CAM flag queue — which is the only screen that reaches flags stranded
// behind a client's latest close, so nothing would ever take them out again.
// Re-adding the write brings back the two-buttons-one-outcome choice the manager
// removed. Both directions fail here.
//
// Ungated on purpose. Every fixture below is synthetic, the source scan needs no
// data at all, and a guard that only runs on the one machine holding
// public/local-snapshot.json is not a guard. The book's own 460 are counted in
// camFlagQueue.book.test.js.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isFlagOpen, buildCamFlagQueue, createCamFlagResolver, flagResolutionPlan } from './camFlagQueue';
import { buildDailyReportSummary } from './report';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');

/**
 * Every file that can write a flag status, plus the two that render the
 * buttons. If a new one appears it belongs on this list; the alternative is
 * scanning the whole tree, which would trip over this file and over the read
 * filters it exists to protect.
 */
const WRITE_PATH_FILES = [
  'src/App.jsx',
  'src/components/Dashboard.jsx',
  'src/components/CamFlagQueue.jsx',
  'src/domain/camFlagQueue.js',
  'src/domain/supabaseStore.js',
  'src/domain/reconcile.js',
  'src/domain/report.js',
];

/**
 * Source lines mentioning the status, with comments and JSDoc dropped.
 *
 * Comments are excluded because several of them explain at length why the
 * status still exists, and a guard that fails on its own explanation teaches
 * people to delete the explanation.
 */
function codeMentions(file) {
  const out = [];
  let inBlock = false;
  const lines = readFileSync(`${ROOT}/${file}`, 'utf8').split('\n');
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (inBlock) {
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlock = true;
      continue;
    }
    if (line.startsWith('//') || line.startsWith('*')) continue;
    if (line.includes('Acknowledged')) out.push({ file, line: index + 1, text: line });
  }
  return out;
}

/** The only shape allowed: a not-equal test against the literal. */
const COMPARISON = /!==\s*(['"])Acknowledged\1/g;

describe('Acknowledged is compared against and never written', () => {
  it('appears in no write path except as a `!== "Acknowledged"` exclusion', () => {
    const offenders = [];
    for (const file of WRITE_PATH_FILES) {
      for (const mention of codeMentions(file)) {
        // Strip the legal shape and see whether the status survives. An
        // assignment, an argument, an array member or a `===` all do.
        const residue = mention.text.replace(COMPARISON, '');
        if (residue.includes('Acknowledged')) offenders.push(`${mention.file}:${mention.line} ${mention.text}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('still carries the exclusions that keep the stored ones closed', () => {
    // The other direction. A tidy-up that deletes `!== 'Acknowledged'` because
    // "nothing writes it any more" is the mutation this half exists to catch,
    // and it would be invisible on a database where step 38 has already run —
    // right up until someone opens an older export or an un-migrated instance.
    const required = [
      ['src/domain/camFlagQueue.js', 1],   // isFlagOpen
      ['src/domain/report.js', 1],         // buildDailyReportSummary's openFlags
      ['src/components/Dashboard.jsx', 1], // the client's own flag list
    ];
    for (const [file, atLeast] of required) {
      const found = codeMentions(file).reduce(
        (total, mention) => total + (mention.text.match(COMPARISON) || []).length,
        0,
      );
      expect({ file, found: found >= atLeast }).toEqual({ file, found: true });
    }
  });

  it('offers no acknowledge audit action anywhere', () => {
    // Both `flag.acknowledge` and `flag.bulk_acknowledge` were written from
    // App.jsx and from createCamFlagResolver. An audit action nobody can produce
    // is a row type that quietly stops appearing; an audit action that comes
    // back means the write did too.
    for (const file of WRITE_PATH_FILES) {
      const source = readFileSync(`${ROOT}/${file}`, 'utf8');
      expect({ file, has: source.includes('flag.acknowledge') }).toEqual({ file, has: false });
      expect({ file, has: source.includes('flag.bulk_acknowledge') }).toEqual({ file, has: false });
    }
  });
});

/* ── What that means for a flag already stored as Acknowledged ────────────── */

const ackFlag = (overrides = {}) => ({
  id: 'f-ack',
  type: 'Strategy disabled',
  severity: 'Warning',
  accountName: 'ACC-1',
  message: 'Strategy Bullet 3.2 is disabled on ACC-1',
  status: 'Acknowledged',
  ...overrides,
});

const bookWithAcknowledged = () => [
  {
    id: 'client-1',
    name: 'Harper Juniper',
    accountRegistry: { 'ACC-1': { alias: 'Lucid - 1001', accountType: 'Funded' } },
    dailyImports: [
      {
        id: 'imp-0715',
        date: '2026-07-15',
        snapshots: [],
        flags: [ackFlag(), ackFlag({ id: 'f-crit', severity: 'Critical' }), ackFlag({ id: 'f-open', status: 'Open' })],
      },
    ],
  },
];

describe('a flag stored as Acknowledged stays closed', () => {
  it('is not open, at either severity', () => {
    expect(isFlagOpen({ status: 'Acknowledged' })).toBe(false);
    expect(isFlagOpen({ status: 'Acknowledged', severity: 'Critical' })).toBe(false);
    expect(isFlagOpen({ status: 'Resolved' })).toBe(false);
    expect(isFlagOpen({ status: 'Open' })).toBe(true);
    expect(isFlagOpen({})).toBe(true);
  });

  it('never reaches the CAM flag queue, so no CAM is handed it back', () => {
    const queue = buildCamFlagQueue(bookWithAcknowledged(), { today: '2026-08-11' });
    // One open flag on the import; the two acknowledged ones are not work.
    expect(queue.totals.rows).toBe(1);
    expect(queue.totals.occurrences).toBe(1);
    expect(queue.totals.critical).toBe(0);
    const offered = queue.groups.flatMap((group) => group.rows).flatMap(flagResolutionPlan);
    expect(offered.map((call) => call.flagId)).toEqual(['f-open']);
  });

  it('is not counted as an open or critical flag on the daily report', () => {
    const [client] = bookWithAcknowledged();
    const report = buildDailyReportSummary(client, client.dailyImports[0]);
    expect(report.openFlags).toHaveLength(1);
    expect(report.openFlags[0].id).toBe('f-open');
    expect(report.criticalFlags).toEqual([]);
  });
});

describe('the one write path left', () => {
  it('sends Resolved and audits it as a resolution', async () => {
    const writes = [];
    const audits = [];
    const resolve = createCamFlagResolver({
      setState: null,
      updateFlag: (flagId, status) => { writes.push({ flagId, status }); return Promise.resolve(null); },
      audit: (entry) => audits.push(entry),
    });
    await resolve('client-1', 'imp-0715', 'f-open');
    expect(writes).toEqual([{ flagId: 'f-open', status: 'Resolved' }]);
    expect(audits[0].action).toBe('flag.resolve');
    expect(audits[0].afterData.status).toBe('Resolved');
  });
});
