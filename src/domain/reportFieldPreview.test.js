// The sentence the report designer prints under a toggle that would show nothing.
//
// This is the family fix for the complaint that started the change: a CAM turned a
// section on, nothing appeared, and the product never said why. Nine of the
// fourteen fields in REPORT_FIELDS can render nothing at all, so the guard that
// matters most is the LIST — that every field which can go silent is covered, and
// that a field which will show something gets no caption. Both directions are
// asserted below, because a module that explains eight of nine is the same defect
// with a smaller denominator.

import { describe, expect, it } from 'vitest';
import { describeSilentReportFields } from './reportFieldPreview';
import { REPORT_FIELDS } from './reportConfig';

/** A report with something in every section, so nothing is explained. */
function fullReport(over = {}) {
  return {
    priorDailyPnl: 120,
    grouped: {
      evaluations: [{ accountName: 'E1', accountBalance: 50000, meta: { targetProfit: 53000 } }],
      funded: [{ accountName: 'F1', accountBalance: 100000, meta: { targetProfit: 107300 } }],
      cashIra: [], cashStraight: [], cashLegacy: [], unclassified: [],
    },
    segments: {
      funded: { count: 1 }, evalStandard: { count: 1 },
      cashIra: { count: 0 }, cashStraight: { count: 0 }, cashLegacy: { count: 0 },
    },
    simulation: { label: 'Simulation (not real money)' },
    evaluations: { label: 'Evaluations (1)' },
    openFlags: [{ id: 'f1' }],
    ...over,
  };
}

/** Two closes with capital working on both, which is what the charts need.
 * `capitalAtStartOfDay` is balance minus that day's P&L, so a positive base
 * needs a balance. */
const history = [
  { date: '2026-07-29', dailyPnl: 100, balance: 50100, accounts: 1 },
  { date: '2026-07-30', dailyPnl: -40, balance: 50060, accounts: 1 },
];

describe('a report with something in every section', () => {
  it('explains nothing, because nothing is silent', () => {
    expect(describeSilentReportFields({
      report: fullReport(), cfg: {}, history, reasons: [{ id: 'r1' }],
    })).toEqual({});
  });

  it('returns nothing at all without a report', () => {
    expect(describeSilentReportFields({})).toEqual({});
    expect(describeSilentReportFields()).toEqual({});
  });
});

describe('every field that can go silent is covered', () => {
  /* The empty close: no prior close, nothing grouped, no segment, no simulation,
   * no evaluation account, no reason, no flag, no history. Every field that can
   * print nothing does so here at once, which makes this the list. */
  const empty = {
    priorDailyPnl: null,
    grouped: { evaluations: [], funded: [], cashIra: [], cashStraight: [], cashLegacy: [], unclassified: [] },
    segments: { funded: { count: 0 }, evalStandard: { count: 0 }, cashIra: { count: 0 }, cashStraight: { count: 0 }, cashLegacy: { count: 0 } },
    simulation: null,
    evaluations: null,
    openFlags: [],
  };
  const silent = describeSilentReportFields({ report: empty, cfg: {}, history: [], reasons: [] });

  it('names the nine that Scout 2 measured, plus the new one', () => {
    expect(Object.keys(silent).sort()).toEqual([
      'chartAsPercent',
      'showAccountTable',
      'showCumulativeChart',
      'showDailyChart',
      'showEvaluations',
      'showFlags',
      'showPriorDelta',
      'showProgressToTarget',
      'showReasons',
      'showSegmentTiles',
      'showSimulation',
    ].sort());
  });

  it('only ever names real fields, so a renamed key cannot leave a caption behind', () => {
    const keys = REPORT_FIELDS.map((field) => field.key);
    for (const key of Object.keys(silent)) expect(keys).toContain(key);
  });

  it('writes every sentence in the one grammar: the missing fact, then what cannot be shown', () => {
    // PerformanceCharts.jsx:195 is the house example and the only field in the
    // family that already explained itself. Keeping one grammar is what makes the
    // drawer readable at eleven captions.
    for (const [key, text] of Object.entries(silent)) {
      expect(text, key).toMatch(/, so /);
      expect(text, key).toMatch(/\.$/);
    }
  });
});

describe('what each sentence says', () => {
  it('names the first close rather than claiming there is no change', () => {
    const silent = describeSilentReportFields({ report: fullReport({ priorDailyPnl: null }), history, reasons: [{}] });
    expect(silent.showPriorDelta).toBe('This is the earliest close on record for this client, so there is no prior close to compare against.');
  });

  it('names Target $ for the progress table, because a CAM can set it', () => {
    const report = fullReport();
    report.grouped.funded = [{ accountName: 'F1', meta: {} }];
    report.grouped.evaluations = [{ accountName: 'E1', meta: {} }];
    const silent = describeSilentReportFields({ report, history, reasons: [{}] });
    expect(silent.showProgressToTarget).toContain('2 funded or evaluation accounts closed today');
    expect(silent.showProgressToTarget).toContain('no Target $ is on record for any of them');
    expect(silent.showProgressToTarget).toContain("Set Target $ in the client's Accounts tab");
  });

  it('distinguishes nothing-closed from nothing-targeted on the same table', () => {
    const report = fullReport();
    report.grouped.funded = [];
    report.grouped.evaluations = [];
    const silent = describeSilentReportFields({ report, history, reasons: [{}] });
    expect(silent.showProgressToTarget).toBe('No funded or evaluation account filed a close on this date, so there is no progress to measure.');
  });

  it('does not claim the client has no simulation account, because the section also holds undetermined ones', () => {
    /* report.js:231 checks the simulated list OR the undetermined one, and
     * report.js:260-266 retitles the block for the second case. A line reading
     * "you have no simulation accounts" would be false for a client whose accounts
     * are merely conflicted — the exact misreport report.js:253-259 was written to
     * stop. And it names the control, because until this change nothing in src/
     * rendered a way to set simulation_mode at all. */
    const silent = describeSilentReportFields({ report: fullReport({ simulation: null }), history, reasons: [{}] });
    expect(silent.showSimulation).toContain('none is undetermined');
    expect(silent.showSimulation).toContain("Set Sim / Live on the account in the client's Accounts tab");
  });

  it('explains the new evaluations toggle the same way as the rest', () => {
    const silent = describeSilentReportFields({ report: fullReport({ evaluations: null }), history, reasons: [{}] });
    expect(silent.showEvaluations).toContain("No evaluation account on this client's record");
  });

  it('counts the closes a chart would need, because both charts return null under two points', () => {
    // PerformanceCharts.jsx:152 returns before either of the two "Not enough
    // history to chart yet." messages inside the chart components can mount, so
    // grepping for that string suggests the charts explain themselves. They do
    // not, for 65 of the book's 136 clients.
    const one = describeSilentReportFields({ report: fullReport(), history: [history[0]], reasons: [{}] });
    expect(one.showCumulativeChart).toBe('Only 1 close on record for this client and a line needs two points, so no chart can be drawn.');
    expect(one.showDailyChart).toBe(one.showCumulativeChart);
    expect(one.chartAsPercent).toBe(one.showCumulativeChart);
  });

  it('explains the percentage switch separately when the charts themselves will draw', () => {
    // Balance equal to the day's P&L leaves a zero base: no capital was working,
    // so a percentage would be a division by zero dressed up as a number.
    const noCapital = [
      { date: '2026-07-29', dailyPnl: 0, balance: 0, accounts: 1 },
      { date: '2026-07-30', dailyPnl: 0, balance: 0, accounts: 1 },
    ];
    const silent = describeSilentReportFields({ report: fullReport(), history: noCapital, reasons: [{}] });
    expect(silent.showCumulativeChart).toBeUndefined();
    expect(silent.showDailyChart).toBeUndefined();
    expect(silent.chartAsPercent).toBe('No capital on record for these days, so a percentage cannot be shown and the chart stays in dollars.');
  });
});

describe('the two sections that hand work to each other', () => {
  it('warns that the per-account table empties when the evaluations section takes its only pool', () => {
    // 203 evaluation rows across 47 clients on the book's latest closes, and 11 of
    // the 47 would have nothing else in the table. A CAM who turns the evaluations
    // section on and watches the table vanish is owed the reason.
    const report = fullReport();
    report.grouped.funded = [];
    const silent = describeSilentReportFields({ report, cfg: { showEvaluations: true }, history, reasons: [{}] });
    expect(silent.showAccountTable).toContain('the Evaluations section below is showing them');
  });

  it('does not warn when the table still has a pool of its own', () => {
    const silent = describeSilentReportFields({ report: fullReport(), cfg: { showEvaluations: true }, history, reasons: [{}] });
    expect(silent.showAccountTable).toBeUndefined();
  });

  it('says nothing closed at all when that is the real reason', () => {
    const report = fullReport();
    report.grouped.funded = [];
    report.grouped.evaluations = [];
    const silent = describeSilentReportFields({ report, cfg: { showEvaluations: true }, history, reasons: [{}] });
    expect(silent.showAccountTable).toBe('No account filed a close on this date, so the per-account table would have no rows.');
  });
});
