// Real money whose pool nobody has named yet, on the client's own report.
//
// WHY THIS FILE EXISTS. dcd3196 exists because Craig Weschke's 2026-08-06
// report read $0 on a day he traded. The sim split fixed the cause it was aimed
// at — the rows were being deleted before they reached the report — but the
// report still read $0.00 / 0 accounts afterwards, from a second cause nobody
// had looked at: buildDailyReportSummary grouped an account with no accountType
// into `ignored`, and `ignored` is in no total.
//
// That is the state EVERY account is in on a first import; reconcile raises
// "New account ... needs manual classification" for exactly this. Replayed
// through the 11 real 2026-08-06 exports with an empty registry, all 11 client
// reports read $0.00 real money against a simulation block showing $100,000.
// With the accounts counted, the same 11 reports sum to $3,329,322.48 over 61
// accounts — the desk total derived independently from the CSVs by header.
//
// None of the 1782 tests in the suite moved when the grouping was changed, in
// either direction, which is why these exist.
//
// Figures are Craig's real close: Craig - Main $55,893.06, Craig - Sub 1
// $29,936.54, Sim101 $99,590.00 at -$1,298.00.

import { describe, expect, it } from 'vitest';
import { ACCOUNT_TYPES, makeAccountAlias } from './reconcile';
import { buildDailyReportSummary } from './report';

const CRAIG_MAIN = 55893.06;
const CRAIG_SUB1 = 29936.54;

const snapshot = (accountName, accountBalance, over = {}) => ({
  accountName,
  connection: 'Legends',
  accountBalance,
  grossRealizedPnl: 0,
  weeklyPnl: 0,
  unrealizedPnl: 0,
  strategies: [],
  ...over,
});

// A first import: rows have arrived, nobody has classified anything yet.
const firstImport = {
  date: '2026-08-06',
  status: 'Reconciled',
  snapshots: [
    snapshot('Craig - Main', CRAIG_MAIN),
    snapshot('Craig - Sub 1', CRAIG_SUB1),
  ],
  accounts: {},
  flags: [],
};

const clientWith = (dailyImport, accountRegistry = {}) => ({
  id: 'craig',
  name: 'Craig Weschke',
  accountRegistry,
  dailyImports: [dailyImport],
});

describe('an account nobody has classified yet is still the client\'s money', () => {
  it('counts an unclassified close in the report total instead of reporting $0', () => {
    const report = buildDailyReportSummary(clientWith(firstImport), firstImport);

    // The whole point: not 0.
    expect(report.totals.aggregateBalance).toBeCloseTo(CRAIG_MAIN + CRAIG_SUB1, 2);
    expect(report.counts.accounts).toBe(2);
  });

  it('itemises every account it counts, so no balance is stated without a table', () => {
    const report = buildDailyReportSummary(clientWith(firstImport), firstImport);

    // A pool counted in the totals must be rendered. App.jsx walks the group
    // names; a counted group missing from `grouped` would state a figure the
    // report never breaks down.
    expect(report.grouped.unclassified.map((row) => row.accountName))
      .toEqual(['Craig - Main', 'Craig - Sub 1']);
    expect(report.grouped.ignored).toHaveLength(0);
  });

  it('still leaves an explicitly ignored account out of every figure', () => {
    // "Not yet looked at" and "a human decided this does not count" are
    // different facts, and only the second one is excluded.
    const dailyImport = {
      ...firstImport,
      accounts: { 'Craig - Sub 1': { accountType: ACCOUNT_TYPES.IGNORE } },
    };
    const report = buildDailyReportSummary(clientWith(dailyImport), dailyImport);

    expect(report.totals.aggregateBalance).toBeCloseTo(CRAIG_MAIN, 2);
    expect(report.counts.accounts).toBe(1);
    expect(report.grouped.ignored.map((row) => row.accountName)).toEqual(['Craig - Sub 1']);
  });

  it('does not change a report whose accounts are all classified', () => {
    const dailyImport = {
      ...firstImport,
      accounts: {
        'Craig - Main': { accountType: ACCOUNT_TYPES.FUNDED },
        'Craig - Sub 1': { accountType: ACCOUNT_TYPES.FUNDED },
      },
    };
    const report = buildDailyReportSummary(clientWith(dailyImport), dailyImport);

    expect(report.totals.aggregateBalance).toBeCloseTo(CRAIG_MAIN + CRAIG_SUB1, 2);
    expect(report.grouped.funded).toHaveLength(2);
    expect(report.grouped.unclassified).toHaveLength(0);
  });
});

describe('makeAccountAlias keeps issued account numbers masked', () => {
  it('masks a prop-firm number however the CAM spaced it', () => {
    // The masking exists so a full prop-firm account number does not sit in
    // front of whoever is reading. A CAM who types the firm in beside the
    // number produces a name with a space in it, and a bare "has a space means
    // it is a nickname" rule printed the whole number.
    expect(makeAccountAlias('Apex 12345678', 'Legends')).toBe('Legends - 5678');
    expect(makeAccountAlias('Topstep Eval 50285301', 'Legends')).toBe('Legends - 5301');
    expect(makeAccountAlias('John Smith 507842586341', 'Legends')).toBe('Legends - 6341');
    expect(makeAccountAlias('LTATAGREH506107949826', 'Legends Trading'))
      .toBe('Legends Trading - 9826');
  });

  it('still shows a typed nickname whole', () => {
    // `Craig - Sub 1` rendered to the client as "Live - ub 1", which reads as
    // breakage on a funded account.
    expect(makeAccountAlias('Craig - Sub 1', 'Live')).toBe('Live - Craig - Sub 1');
    expect(makeAccountAlias('Craig - Main', 'Live')).toBe('Live - Craig - Main');
    expect(makeAccountAlias('Sim101', 'Live')).toBe('Live - Sim101');
  });
});
