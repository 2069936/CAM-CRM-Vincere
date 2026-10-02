// What the progress-to-target table was printing, and what it prints now, on the
// real book.
//
// The book-backed half: it reads public/local-snapshot.json, so vite.config.js
// drops it on every clone without the export. The rules are in
// progressToTarget.test.js and run everywhere.
//
// These numbers are the whole argument for touching an existing, shipping section
// as part of this change. A correct progress bar in the new evaluations block, next
// to a bar on the same page that reads 95% for an account that has made nothing, is
// two progress figures for one account — the same defect as two totals. So the old
// one is fixed rather than left beside the new one.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROGRESS_STATE, buildProgressToTargetRows } from './progressToTarget';
import { buildDailyReportSummary } from './report';
import { buildCrmStateFromTables } from './supabaseStore';

const snapshot = JSON.parse(
  readFileSync(new URL('../../public/local-snapshot.json', import.meta.url), 'utf8'),
);
const clients = buildCrmStateFromTables(snapshot.tables).clients;

const closes = [];
const latest = [];
for (const client of clients) {
  const imports = (client.dailyImports || []).filter((entry) => (entry.snapshots || []).length);
  for (const dailyImport of imports) {
    const report = buildDailyReportSummary(client, dailyImport);
    closes.push({ client, report, rows: buildProgressToTargetRows(report, client.dailyImports || []) });
  }
  const last = imports[imports.length - 1];
  if (!last) continue;
  const report = buildDailyReportSummary(client, last);
  latest.push({ client, report, rows: buildProgressToTargetRows(report, client.dailyImports || []) });
}

/** Exactly the arithmetic App.jsx used before this change. */
const oldPercent = (row) => {
  const start = Number(row.meta?.startBalance || 0);
  const target = Number(row.meta?.targetProfit || 0);
  const need = target - start;
  return need > 0
    ? Math.max(0, Math.min(100, Math.round(((Number(row.accountBalance || 0) - start) / need) * 100)))
    : 0;
};

describe('what the old arithmetic was printing', () => {
  const drawn = latest.flatMap(({ report }) => [...report.grouped.funded, ...report.grouped.evaluations]
    .filter((row) => Number(row.meta?.targetProfit) > 0));

  it('drew 233 rows on the latest closes, 78 of them against a start of zero', () => {
    expect(drawn).toHaveLength(233);
    const blankStart = drawn.filter((row) => !(Number(row.meta?.startBalance) > 0));
    expect(blankStart).toHaveLength(78);
  });

  it('printed 90% or more on 70 of those 78, which is the defect', () => {
    const blankStart = drawn.filter((row) => !(Number(row.meta?.startBalance) > 0));
    const nearlyDone = blankStart.filter((row) => oldPercent(row) >= 90);
    expect(nearlyDone).toHaveLength(70);
    // Not a rounding artefact: with the start at zero the figure is simply
    // `balance / target`, and a prop account sits near its own size.
    for (const row of nearlyDone.slice(0, 5)) {
      expect(oldPercent(row)).toBe(
        Math.round((Number(row.accountBalance) / Number(row.meta.targetProfit)) * 100),
      );
    }
  });

  it('put a heading and four column headings over an empty table on 44.9% of closes', () => {
    // And SIMPLIFIED_REPORT_CONFIG sets showProgressToTarget true, so the
    // one-click preset has been shipping that to clients.
    const empty = closes.filter(({ rows }) => rows.length === 0);
    expect(closes).toHaveLength(477);
    expect(empty).toHaveLength(214);
    expect(Math.round((empty.length / closes.length) * 1000) / 10).toBe(44.9);
  });
});

describe('what it prints now', () => {
  const rows = latest.flatMap((entry) => entry.rows);

  it('recovers a start for 77 of the 78, and refuses a number for the one it cannot', () => {
    expect(rows).toHaveLength(233);
    const recovered = rows.filter((entry) => entry.startSource === 'observed');
    expect(recovered).toHaveLength(77);
    const refused = rows.filter((entry) => entry.state === PROGRESS_STATE.NO_START);
    expect(refused).toHaveLength(1);
    for (const entry of refused) expect(entry.percent).toBeNull();
  });

  it('no longer reports 70 untouched accounts as nearly finished: 5 are, 65 were not', () => {
    const blankStart = rows.filter((entry) => entry.startSource !== 'stored');
    const nowHigh = blankStart.filter((entry) => entry.percent !== null && entry.percent >= 90);
    // 70 before, 5 after. The five are accounts genuinely within 10% of their
    // target measured from the balance they opened at; the other 65 were accounts
    // sitting at their own opening size, and they now read as what they are.
    expect(nowHigh).toHaveLength(5);
  });

  it('says so instead of printing 0% where the recorded target is not above the start', () => {
    const notAbove = rows.filter((entry) => entry.state === PROGRESS_STATE.TARGET_NOT_ABOVE_START);
    expect(notAbove).toHaveLength(7);
    for (const entry of notAbove) expect(entry.percent).toBeNull();
  });

  it('rests half its percentages on a recovered start, which the cell now names', () => {
    /* THE HALF OF THE FIRST FIX THAT WAS LEFT UNSAID.
     *
     * Recovering the start is what took this column from a figure that read 90%
     * for an account that had made nothing to a figure that reads what it is. It
     * also means the floor under half the percentages here is a balance the CRM
     * observed rather than one the desk typed, and nothing on the page said so —
     * the same shape of defect, one step along: an inferred number presented as a
     * measured one. The cell says it now, in the words the Target cell in the
     * evaluations section already uses.
     *
     * Over every close on the book, not just the latest, because this section
     * ships `true` in SIMPLIFIED_REPORT_CONFIG and reaches clients from a config
     * nobody touched. */
    const all = closes.flatMap((entry) => entry.rows);
    const measured = all.filter((entry) => entry.state === PROGRESS_STATE.MEASURED);
    expect(all).toHaveLength(1687);
    expect(measured).toHaveLength(1623);
    expect(measured.filter((entry) => entry.startSource === 'stored')).toHaveLength(826);
    expect(measured.filter((entry) => entry.startSource === 'observed')).toHaveLength(797);
    // Every measured row has one or the other. A third state here would be a
    // percentage drawn from a start that is neither on record nor recovered.
    expect(measured.filter((entry) => entry.startSource === null)).toHaveLength(0);
  });

  it('keeps exactly the rows it kept before: no client gains or loses a line', () => {
    // Eligibility is unchanged on purpose. The figures moved; the row set did not.
    for (const entry of latest) {
      const before = [...entry.report.grouped.funded, ...entry.report.grouped.evaluations]
        .filter((row) => Number(row.meta?.targetProfit) > 0)
        .map((row) => row.accountName);
      expect(entry.rows.map((item) => item.accountName)).toEqual(before);
    }
  });
});
