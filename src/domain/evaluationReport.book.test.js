// The book-backed half of the evaluations section's suite.
//
// Split out for one reason: it reads public/local-snapshot.json, so vite.config.js
// drops it on every clone that does not hold the export. The RULES live in
// evaluationReport.test.js, which runs everywhere; the NUMBERS live here, where the
// book is.
//
// Every figure below was printed before it was written down. They are the ones
// that would catch a change keeping every fixture green while quietly rewriting
// what a third of the book's clients read on their report — and they are the
// figures the decisions in reportConfig.js and evaluationReport.js were made on,
// so a change that moves them is a change that should re-make those decisions.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EVALUATION_PROGRESS, evaluationProgressFor, isEvaluationType } from './evaluationReport';
import { buildDailyReportSummary } from './report';
import { buildCrmStateFromTables } from './supabaseStore';
import { resolveAccountLimits } from './propFirmRules';

const snapshot = JSON.parse(
  readFileSync(new URL('../../public/local-snapshot.json', import.meta.url), 'utf8'),
);
const clients = buildCrmStateFromTables(snapshot.tables).clients;

/** Every close that carries at least one account row. */
const closes = [];
for (const client of clients) {
  for (const dailyImport of client.dailyImports || []) {
    if (!(dailyImport.snapshots || []).length) continue;
    closes.push({ client, dailyImport, report: buildDailyReportSummary(client, dailyImport) });
  }
}
const latestPerClient = new Map();
for (const close of closes) latestPerClient.set(close.client.id, close);

/** Distinct evaluation accounts that appear on at least one close. */
const cohort = [];
for (const client of clients) {
  const seen = new Set();
  for (const dailyImport of client.dailyImports || []) {
    for (const row of dailyImport.snapshots || []) seen.add(row.accountName);
  }
  for (const [accountName, meta] of Object.entries(client.accountRegistry || {})) {
    if (!isEvaluationType(meta?.accountType) || !seen.has(accountName)) continue;
    let balance = null;
    const imports = client.dailyImports || [];
    for (let i = imports.length - 1; i >= 0 && balance === null; i -= 1) {
      const row = (imports[i].snapshots || []).find((item) => item.accountName === accountName);
      if (row) balance = Number(row.accountBalance);
    }
    cohort.push({ client, accountName, meta, balance });
  }
}

describe('how much of the book the evaluations section is for', () => {
  it('is half the clients, not a handful', () => {
    /* THE MEASUREMENT THE DEFAULT AND THE SHAPE WERE DECIDED ON.
     *
     * showSimulation's default was justified by "prints nothing on 33% of imports,
     * median 2 lines where it does". Copying that conclusion here would have
     * produced a section nobody sees: evaluations are the majority case. */
    const withEvaluations = clients.filter(
      (client) => Object.values(client.accountRegistry || {}).some((meta) => isEvaluationType(meta?.accountType)),
    );
    expect(clients).toHaveLength(96);
    expect(withEvaluations).toHaveLength(51);

    const perClient = withEvaluations
      .map((client) => Object.values(client.accountRegistry).filter((meta) => isEvaluationType(meta?.accountType)).length)
      .sort((a, b) => a - b);
    expect(perClient[0]).toBe(1);
    expect(perClient[perClient.length - 1]).toBe(15);
    // Median 5. "Five clients with 12 to 16 evaluations each" is the top of this
    // tail, 5 of the 51, and anyone sizing the feature against it gets it wrong.
    expect(perClient[Math.floor(perClient.length / 2)]).toBe(5);
  });

  it('prints on 95.1% of the closes belonging to those clients', () => {
    const theirCloses = closes.filter((close) => Object.values(close.client.accountRegistry || {})
      .some((meta) => isEvaluationType(meta?.accountType)));
    expect(theirCloses).toHaveLength(329);
    const withRows = theirCloses.filter((close) => close.report.grouped.evaluations.length);
    expect(withRows).toHaveLength(313);
    expect(Math.round((withRows.length / theirCloses.length) * 1000) / 10).toBe(95.1);

    const rowCounts = withRows.map((close) => close.report.grouped.evaluations.length).sort((a, b) => a - b);
    // Median 4 rows, not 2.
    expect(rowCounts[Math.floor(rowCounts.length / 2)]).toBe(4);
    expect(rowCounts[rowCounts.length - 1]).toBe(12);
    expect(rowCounts.reduce((sum, n) => sum + n, 0)).toBe(1360);
  });

  it('is absent, not empty, for every client who holds no challenge account', () => {
    // The one piece of the simulation precedent that DOES transfer: a client with
    // none gets no section rather than a section full of zeros. 45 of the 96
    // clients hold no evaluation account; 29 of those are among the 79 that have a
    // close at all, so 29 report sheets carry no section no matter what a CAM
    // ticks.
    const absent = closes.filter((close) => close.report.evaluations === null);
    const absentClients = new Set(absent.map((close) => close.client.id));
    expect(absentClients.size).toBe(29);
    for (const close of absent) expect(close.report.grouped.evaluations).toHaveLength(0);
    // Every close that carries an evaluation row builds a section.
    for (const close of closes) {
      if (close.report.grouped.evaluations.length) expect(close.report.evaluations).not.toBeNull();
    }
  });

  it('has a sentence rather than a table for the clients whose challenge accounts went quiet', () => {
    const latest = [...latestPerClient.values()].filter((close) => close.report.evaluations);
    const silent = latest.filter((close) => !close.report.evaluations.hasRows);
    expect(latest).toHaveLength(50);
    expect(silent).toHaveLength(3);
    for (const close of silent) {
      expect(close.report.evaluations.counts.onRecord).toBeGreaterThan(0);
      // The sentence agrees with its own number: one of these three clients holds
      // exactly one challenge account (Ellis Iris), and "1 ... none of them" was
      // printing on the PDF.
      expect(close.report.evaluations.note).toContain(
        close.report.evaluations.counts.onRecord === 1
          ? 'it reported no close on this date'
          : 'none of them reported a close on this date',
      );
      // And the heading over it never states a count that contradicts it.
      expect(close.report.evaluations.label).toBe('Evaluations (none reported today)');
    }
  });
});

describe('what the section says about the latest close of every client', () => {
  const latest = [...latestPerClient.values()]
    .filter((close) => close.report.evaluations?.hasRows)
    .map((close) => close.report.evaluations);

  it('covers 203 rows across 47 clients', () => {
    expect(latest).toHaveLength(47);
    expect(latest.reduce((sum, section) => sum + section.counts.accounts, 0)).toBe(203);
  });

  it('finds most of them idle, which is why idle is worded apart from flat', () => {
    // 164 of 203 ran no algorithm at all. Reporting those as a $0 day is a
    // different claim from the true one, and SimulationReportSection already draws
    // exactly this distinction for the same reason.
    expect(latest.reduce((sum, section) => sum + section.counts.idle, 0)).toBe(164);
    expect(latest.reduce((sum, section) => sum + section.counts.traded, 0)).toBe(39);
    expect(latest.filter((section) => section.counts.traded === 0)).toHaveLength(32);
  });

  it('rests almost half its percentages on a start nobody typed, and says which', () => {
    /* THE NUMBER THAT DECIDED THE DISCLOSURE, and it is the same class of defect
     * as the 90%-for-nothing one this change already fixed: an inferred figure
     * presented as a measured one.
     *
     * The denominator is `target - start`, so the start moves the percentage
     * exactly as much as the target does. The inferred TARGET has been labelled
     * since this section shipped; the inferred START was labelled nowhere, and a
     * CAM reading "63%" to a client could not tell whether the floor under it was
     * typed by the desk or was whatever balance the CRM happened to see first.
     *
     * Three options were measured. REFUSING the percentage on an inferred start
     * blanks the figures below — too many to delete over a fact about the desk's
     * own data entry. LEAVING IT SILENT is the defect. LABELLING it costs one
     * muted line per affected row and is what the Target cell beside it already
     * does, so that is what the cell does.
     */
    const sum = (field) => latest.reduce((total, section) => total + section.coverage[field], 0);
    expect(sum('startStored') + sum('startObserved')).toBe(203);
    expect(sum('startStored')).toBe(107);
    expect(sum('startObserved')).toBe(96);
    // Of the bars actually drawn, the ones whose floor is a guess. This is the
    // figure the choice was made on: too many to refuse, too many to leave silent.
    const bars = latest.reduce(
      (total, section) => total + section.accounts.filter((row) => row.progress.state === EVALUATION_PROGRESS.BELOW).length,
      0,
    );
    expect(bars).toBe(186);
    expect(sum('percentFromObservedStart')).toBe(82);
    // And never counted where the start is not a denominator: a row reading
    // "Target reached" compares a balance against a target and the start does not
    // enter it.
    expect(sum('percentFromObservedStart')).toBeLessThan(sum('startObserved'));
  });

  it('names 21 failed rows as broken on this close, and never leads with them', () => {
    // Every one of the 21 prints because a breach flag fired on that close, and 4
    // of the 27 accounts that ever print that way do it on more than one close,
    // one of them on 7. A section leading with breaches would repeat a death.
    expect(latest.reduce((sum, section) => sum + section.counts.failed, 0)).toBe(21);
  });
});

describe('progress toward the target, and the trap under it', () => {
  it('is definable on 93.4% of the evaluation accounts on the book', () => {
    expect(cohort).toHaveLength(289);
    const states = cohort.map((entry) => evaluationProgressFor(
      { accountName: entry.accountName, accountBalance: entry.balance, meta: entry.meta },
      entry.client.dailyImports || [],
    ));
    const shown = states.filter((state) => state.state === EVALUATION_PROGRESS.BELOW
      || state.state === EVALUATION_PROGRESS.REACHED);
    // 270 of 289. The orchestrator's fear — "a progress bar blank on most rows is
    // worse than no progress bar" — points the other way on this book, which is
    // why the column was built and why its coverage is printed above it.
    expect(shown).toHaveLength(270);
    expect(Math.round((shown.length / cohort.length) * 1000) / 10).toBe(93.4);
    expect(states.filter((state) => state.state === EVALUATION_PROGRESS.REACHED)).toHaveLength(18);
    // The 18 whose recorded target is at or below their own starting balance get a
    // sentence, not a 0% and not a 100%.
    expect(states.filter((state) => state.state === EVALUATION_PROGRESS.TARGET_NOT_ABOVE_START)).toHaveLength(18);
    expect(states.filter((state) => state.state === EVALUATION_PROGRESS.NO_START)).toHaveLength(0);
    // One account out of 289 has no target and none derivable. The firm-rule path
    // would have covered it, at the price of writing the unit confusion below into
    // a second place, so it gets the sentence instead.
    expect(states.filter((state) => state.state === EVALUATION_PROGRESS.NO_TARGET)).toHaveLength(1);
  });

  it('takes 195 targets from the record and 93 from the standard table', () => {
    const sources = cohort.map((entry) => evaluationProgressFor(
      { accountName: entry.accountName, accountBalance: entry.balance, meta: entry.meta },
      entry.client.dailyImports || [],
    ));
    expect(sources.filter((state) => state.targetSource === 'stored')).toHaveLength(195);
    expect(sources.filter((state) => state.targetSource === 'inferred')).toHaveLength(93);
    // The start fallback is what makes the column worth having: stored on 129 of
    // 289, and the earliest close on record closes the rest.
    expect(sources.filter((state) => state.startSource === 'stored')).toHaveLength(129);
    expect(sources.filter((state) => state.startSource === 'observed')).toHaveLength(160);
    expect(sources.filter((state) => state.start === null)).toHaveLength(0);
  });

  it('would have called 94 of 289 accounts finished if it read the resolver', () => {
    /* THE CENTRAL TRAP, measured.
     *
     * `trading_accounts.target_profit` stores an absolute target BALANCE, and
     * `resolveAccountLimits().targetProfit` returns that stored value when there is
     * one and a profit AMOUNT when there is not. Both read naturally as "the
     * target", and comparing a balance against the second looks exactly like the
     * comparison bulletBotStats.js and App.jsx's progress table already make. */
    const nonStored = cohort
      .map((entry) => ({
        entry,
        limits: resolveAccountLimits({ ...entry.meta, accountName: entry.accountName }, { dailyImports: entry.client.dailyImports || [] }),
      }))
      .filter(({ limits }) => limits.targetSource !== 'stored' && limits.targetProfit);
    expect(nonStored).toHaveLength(94);
    // Every one of them under 10,000, and on every one of them the balance is
    // already past it.
    expect(nonStored.filter(({ limits }) => limits.targetProfit < 10000)).toHaveLength(94);
    expect(nonStored.filter(({ entry, limits }) => entry.balance >= limits.targetProfit)).toHaveLength(94);
    expect(Math.round((nonStored.length / cohort.length) * 1000) / 10).toBe(32.5);

    // Against the right number, those same 94 are not finished: 4 of them have
    // reached their target and 90 have not. The resolver would have said 94.
    const honest = nonStored.map(({ entry }) => evaluationProgressFor(
      { accountName: entry.accountName, accountBalance: entry.balance, meta: entry.meta },
      entry.client.dailyImports || [],
    ));
    expect(honest.filter((state) => state.state === EVALUATION_PROGRESS.REACHED)).toHaveLength(4);
    expect(honest.filter((state) => state.state !== EVALUATION_PROGRESS.REACHED)).toHaveLength(90);
  });

  it('never carries a stored drawdown limit, which is why the buffer comes from the platform', () => {
    /* 7 evaluation rows in the raw table have max_drawdown_limit > 0 and all 7
     * belong to clients absent from the built state, so on the book the report
     * actually renders from it is 0 of 289. The rules table would fill 93% of them
     * and `planKnown` is false on every single one, because prop_firm_plan is unset
     * on all 319 evaluation rows. The platform's own reported trailing figure needs
     * no rules table and is the honest number. */
    const stored = cohort.filter((entry) => Number(entry.meta.maxDrawdownLimit) > 0);
    expect(stored).toHaveLength(0);
    const resolved = cohort.map((entry) => resolveAccountLimits(
      { ...entry.meta, accountName: entry.accountName },
      { dailyImports: entry.client.dailyImports || [] },
    ));
    expect(resolved.filter((limits) => limits.planKnown)).toHaveLength(0);
    expect(resolved.filter((limits) => limits.drawdownSource === 'firm-rule')).toHaveLength(269);

    const rows = closes.flatMap((close) => close.report.evaluations?.accounts || []);
    expect(rows).toHaveLength(1360);
    // Room on 1,050 (77.2%), past the drawdown on 184, nothing reported on 126.
    // A negative trailing figure is not a negative buffer, and the section says so
    // in words rather than printing a minus sign under a heading saying "buffer".
    expect(rows.filter((row) => row.reportedBuffer !== null)).toHaveLength(1050);
    expect(rows.filter((row) => row.pastDrawdown)).toHaveLength(184);
    expect(rows.filter((row) => row.reportedBuffer === null && !row.pastDrawdown)).toHaveLength(126);
  });
});

describe('the figures never reach the client\'s own total', () => {
  it('leaves every evaluation out of report.totals and out of the segment tiles', () => {
    let checked = 0;
    for (const close of closes) {
      const section = close.report.evaluations;
      if (!section?.hasRows) continue;
      checked += 1;
      const evalPnl = section.totals.grossRealizedPnl;
      const counted = [
        ...close.report.grouped.funded,
        ...close.report.grouped.cash,
        ...close.report.grouped.unclassified,
      ].reduce((sum, row) => sum + Number(row.grossRealizedPnl || 0), 0);
      expect(close.report.totals.grossRealizedPnl).toBeCloseTo(counted, 6);
      // The tiles the sheet draws. `evalStandard` is suppressed in App.jsx while
      // the section is on, so no tile can restate this figure differently.
      const tiled = ['funded', 'cashIra', 'cashStraight', 'cashLegacy']
        .reduce((sum, key) => sum + Number(close.report.segments[key].dailyPnl || 0), 0);
      if (evalPnl !== 0) expect(tiled).not.toBeCloseTo(tiled + evalPnl, 6);
    }
    expect(checked).toBe(313);
  });

  it('is the same subtotal report.evaluationTotals already published', () => {
    // One arithmetic. A second pass over the same rows is a second answer waiting
    // to drift from the first, which is why buildClientMessageReport stopped
    // computing its own.
    for (const close of closes) {
      if (!close.report.evaluations) continue;
      expect(close.report.evaluations.totals).toBe(close.report.evaluationTotals);
    }
  });
});
