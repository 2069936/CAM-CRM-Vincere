// The rules of the progress-to-target table, and the gate that keeps it off a
// client's page when it has nothing to draw.
//
// The NUMBERS are in progressToTarget.book.test.js. These are the rules, and the
// first two are the defect this file was written for: a start defaulting to zero
// turned `balance / target` into "progress", which on a prop account sitting
// untouched at its opening balance reads as 90-something. It was shipping — the
// Simplified preset turns this section on — so a client was being told an account
// that had not made a dollar was nearly funded.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROGRESS_STATE, buildProgressToTargetRows } from './progressToTarget';
import { ACCOUNT_TYPES } from './reconcile';

const APP = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');

const report = (funded = [], evaluations = []) => ({ grouped: { funded, evaluations } });
const account = (accountName, accountBalance, meta) => ({
  accountName, accountBalance, meta: { accountName, ...meta },
});

describe('the start a percentage is measured from', () => {
  it('uses the stored starting balance', () => {
    const [entry] = buildProgressToTargetRows(
      report([account('F1', 102050, { accountType: ACCOUNT_TYPES.FUNDED, startBalance: 100000, targetProfit: 107300 })]),
    );
    expect(entry).toMatchObject({ start: 100000, startSource: 'stored', percent: 28, state: PROGRESS_STATE.MEASURED });
  });

  it('falls back to the earliest balance on record, not to zero', () => {
    /* THE DEFECT. With `Number(row.meta?.startBalance || 0)` this row's percentage
     * was round(50500 / 53000 * 100) = 95%: an account that has made $500 of a
     * $3,000 challenge, printed as all but finished. 70 of the 78 rows the book
     * drew with a blank start printed 90% or more. */
    const dailyImports = [
      { date: '2026-07-01', snapshots: [{ accountName: 'E1', accountBalance: 50000 }] },
      { date: '2026-07-30', snapshots: [{ accountName: 'E1', accountBalance: 50500 }] },
    ];
    const [entry] = buildProgressToTargetRows(
      report([], [account('E1', 50500, { accountType: ACCOUNT_TYPES.EVALUATION_BULLET, targetProfit: 53000 })]),
      dailyImports,
    );
    expect(entry).toMatchObject({ start: 50000, startSource: 'observed', percent: 17 });
    // And the number the old arithmetic would have produced is not this one.
    expect(Math.round((50500 / 53000) * 100)).toBe(95);
    expect(entry.percent).not.toBe(95);
  });

  it('says so rather than printing a percentage when there is no start at all', () => {
    const [entry] = buildProgressToTargetRows(
      report([], [account('E1', 50500, { accountType: ACCOUNT_TYPES.EVALUATION_BULLET, targetProfit: 53000 })]),
      [],
    );
    expect(entry.state).toBe(PROGRESS_STATE.NO_START);
    expect(entry.percent).toBeNull();
  });

  it('says so rather than printing 0% when the target is not above the start', () => {
    // The old code's `: 0`, which is a claim about the account rather than about
    // the record.
    const [entry] = buildProgressToTargetRows(
      report([account('F1', 54100, { accountType: ACCOUNT_TYPES.FUNDED, startBalance: 54100, targetProfit: 54100 })]),
    );
    expect(entry.state).toBe(PROGRESS_STATE.TARGET_NOT_ABOVE_START);
    expect(entry.percent).toBeNull();
  });

  it('clamps rather than printing a number outside the bar', () => {
    const [over] = buildProgressToTargetRows(
      report([account('F1', 120000, { accountType: ACCOUNT_TYPES.FUNDED, startBalance: 100000, targetProfit: 107300 })]),
    );
    expect(over.percent).toBe(100);
    const [under] = buildProgressToTargetRows(
      report([account('F2', 90000, { accountType: ACCOUNT_TYPES.FUNDED, startBalance: 100000, targetProfit: 107300 })]),
    );
    expect(under.percent).toBe(0);
  });
});

describe('which rows the table is for', () => {
  it('is funded and evaluation accounts with a stored target, unchanged', () => {
    // Deliberately NOT widened. Adding rows would change an existing section's
    // shape for every client who already has it on.
    const rows = buildProgressToTargetRows(report(
      [
        account('F1', 100000, { accountType: ACCOUNT_TYPES.FUNDED, targetProfit: 107300, startBalance: 100000 }),
        account('F2', 100000, { accountType: ACCOUNT_TYPES.FUNDED }),
      ],
      [account('E1', 50000, { accountType: ACCOUNT_TYPES.EVALUATION_BULLET, targetProfit: 53000, startBalance: 50000 })],
    ));
    expect(rows.map((entry) => entry.accountName)).toEqual(['F1', 'E1']);
  });

  it('is empty rather than throwing on a report with nothing in it', () => {
    expect(buildProgressToTargetRows(null)).toEqual([]);
    expect(buildProgressToTargetRows({})).toEqual([]);
  });
});

describe('the section is withheld when it would be a heading over nothing', () => {
  it('is gated on having a row, not only on the toggle', () => {
    /* It emitted the <h2> and the full <thead> unconditionally and filtered only
     * the body, so 214 of the book's 477 closes (44.9%) printed a heading and four
     * column headings over an empty table — on the client's PDF, because
     * SIMPLIFIED_REPORT_CONFIG sets this true. The CAM's half of the same fix is
     * the designer line (reportFieldPreview.js), which says what is missing. */
    expect(APP).toMatch(/\{cfg\.showProgressToTarget && progressRows\.length \? \(/);
    // And the body no longer re-derives anything: one call, one arithmetic.
    expect(APP).toContain('buildProgressToTargetRows(report, client?.dailyImports || [])');
    expect(APP).not.toContain('Number(row.meta?.startBalance || 0)');
  });
});
