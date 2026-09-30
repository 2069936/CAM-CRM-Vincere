// What the stored book actually says about the per algorithm temperature panel.
//
// WHY THIS FILE EXISTS AT ALL. The rules live in algorithmTemperature.test.js,
// which is synthetic and ungated, and they stay there: vite.config.js drops this
// file on every clone that does not hold public/local-snapshot.json, so NOTHING
// HERE IS PINNED ON CI. What is here is the other half, and it is the half that
// had already gone wrong twice: the module header explains a client-facing
// -$53,417.10 with counted figures from this book, and a sentence of it was WRONG
// for 72 of the 115 days it described while every test in the repository passed;
// a second sentence promised that the reduction "drifts upward as the selection
// grows", and this book walks it downward at 6 of the 12 steps it has. A prose paragraph
// about a book nothing re-measures is a claim, not a measurement.
//
// TWO LAYERS, AND THE DIFFERENCE MATTERS WHEN THE BOOK IS RE-EXPORTED.
//
//   * INVARIANTS. Relations that must hold on any book: the buckets partition the
//     funded population, the rows partition the attributable P&L date by date, a
//     dip is never positive, the sum of the parts never shrinks as parts are
//     added. These survive an import and a failure here is a defect in the module.
//   * HEADER MIRRORS, marked `MIRROR` on the line. Exact figures that exist only
//     because algorithmTemperature.js's header quotes them to a reader. They ROT
//     BY DESIGN: when the book grows, the assertion fails, and the fix is to edit
//     the header and the assertion together in one change. That coupling is the
//     only mechanism that has ever caught a wrong sentence in that header, so the
//     exactness is the point and must not be relaxed into a range. A mirror whose
//     header sentence is deleted should be deleted with it.
//
// Every mirror below therefore carries the sentence it pins, and the exact
// figures are reported outside this file as well, in the answer that accompanied
// the change, so nobody has to run a gated suite to find out what the book said.
//
// THE REDACTION, AND WHAT IT DOES NOT TOUCH. This fixture has `time_text` and
// `entry_exit` blanked (see the SUPERSEDED CLAIM header in algoContribution.js),
// so nothing here measures fill PAIRING. Every figure below reads per strategy
// `realized` and `derivedRealized`, which the redaction does not affect, and
// `snapshot.grossRealizedPnl`, which it does not affect either.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  HEAT_DATES,
  RECONCILE_TOLERANCE,
  UNMEASURED_TEMPERATURE,
  buildAlgorithmComposite,
  buildAlgorithmTemperature,
  temperatureOf,
} from './algorithmTemperature';
import {
  buildComboPerformance,
  comboKeyFromDay,
  dayAlgoRows,
  executionsForAccount,
  fundedAccountDays,
  resolveWindow,
} from './comboPerformance';
import { measuredOnAccountDay } from './algorithmRanking';
import { buildCrmStateFromTables } from './supabaseStore';

const snapshot = JSON.parse(
  readFileSync(new URL('../../public/local-snapshot.json', import.meta.url), 'utf8'),
);
const { clients } = buildCrmStateFromTables(snapshot.tables);

// The header's own conditions: the whole stored book, funded accounts, family
// level, traded basis, Failed accounts kept.
const OPTIONS = { basis: 'traded', level: 'family', window: { preset: 'all' }, includeFailed: true };
const result = buildAlgorithmTemperature(clients, OPTIONS);
const row = (key) => result.rows.find((r) => r.key === key) || null;

// One walk of the book, reused by the tests that need the raw per account day
// shape rather than the built rows. 896 days on this book, so walking it once per
// assertion is affordable, but doing it once is clearer about what the fixture is.
const accountDays = (() => {
  const { from, to } = resolveWindow(clients, OPTIONS.window);
  const out = [];
  for (const funded of fundedAccountDays(clients, { from, to, includeFailed: true })) {
    const executions = executionsForAccount(funded.dailyImport, funded.accountName);
    const algos = dayAlgoRows(funded.snapshot, executions, OPTIONS);
    const figures = algos.map((algo) => {
      let figure = null;
      for (const strategy of algo.strategies) {
        const measured = measuredOnAccountDay(strategy);
        if (measured == null) continue;
        figure = (figure == null ? 0 : figure) + measured;
      }
      return figure;
    });
    out.push({ ...funded, executions, algos, figures });
  }
  return out;
})();

// The same three cases the module resolves, re-derived here from the raw day so
// no test below has to trust the row totals to say which case a day fell into.
function caseOf(day) {
  if (!day.algos.length) return 'unknown';
  if (day.algos.length === 1) return 'sole';
  if (!day.figures.every((figure) => figure != null)) return 'unsplit';
  const sum = day.figures.reduce((total, figure) => total + figure, 0);
  if (!day.figures.some((figure) => figure !== 0)) return 'unsplit';
  return Math.abs(sum - day.pnl) <= RECONCILE_TOLERANCE ? 'measured' : 'unsplit';
}

const cases = accountDays.map(caseOf);
const daysIn = (name) => accountDays.filter((_, i) => cases[i] === name);
const sumOf = (days) => days.reduce((total, day) => total + day.pnl, 0);

describe('the population the header quotes', () => {
  it('walks the book the header says it walks', () => {
    // INVARIANT: the window covers every close the built book holds, so "the whole
    // stored book" is not an assumption about two dates.
    const dates = new Set();
    for (const client of clients) for (const di of client.dailyImports || []) dates.add(di.date);
    const sorted = [...dates].sort();
    expect(result.window.from).toBe(sorted[0]);
    expect(result.window.to).toBe(sorted[sorted.length - 1]);
    expect(result.population.fundedDays).toBe(accountDays.length);
    // MIRROR: "Over the whole stored book (2026-07-13 to 2026-07-30) [...] 896
    // funded account days".
    expect(result.window).toMatchObject({ from: '2026-07-13', to: '2026-07-30' });
    expect(sorted).toHaveLength(14);
    expect(result.population.fundedDays).toBe(896);
  });

  it('resolves 350 SOLE, 35 MEASURED, 214 UNSPLIT and 297 with nothing to attribute', () => {
    // INVARIANT: the four cases partition the funded population, in days and in
    // dollars, and the module's own counters agree with a walk that re-derives
    // them. One row is touched per SOLE day by definition, so the row-touch count
    // IS the day count; a MEASURED day touches every algorithm that ran on it, so
    // its day count comes off the population instead.
    const soleDays = result.rows.reduce((total, r) => total + r.attribution.soleDays, 0);
    expect(soleDays).toBe(daysIn('sole').length);
    expect(result.population.includedDays - soleDays).toBe(daysIn('measured').length);
    expect(result.unsplit.days).toBe(daysIn('unsplit').length);
    expect(result.population.unknownDays).toBe(daysIn('unknown').length);
    expect(daysIn('sole').length + daysIn('measured').length
      + daysIn('unsplit').length + daysIn('unknown').length).toBe(result.population.fundedDays);
    expect(sumOf(daysIn('sole')) + sumOf(daysIn('measured')))
      .toBeCloseTo(result.population.includedPnl, 6);
    expect(sumOf(daysIn('unsplit'))).toBeCloseTo(result.unsplit.pnl, 6);
    expect(sumOf(daysIn('unknown'))).toBeCloseTo(result.population.unknownPnl, 6);

    // MIRROR: "896 funded account days resolve as 350 SOLE, 35 MEASURED and 214
    // UNSPLIT, with 297 more carrying no attributable algorithm at all."
    expect(soleDays).toBe(350);
    expect(result.population.includedDays - soleDays).toBe(35);
    expect(result.population.includedDays).toBe(385);
    expect(result.unsplit.days).toBe(214);
    expect(result.population.unknownDays).toBe(297);
  });

  it('holds the two published identities to floating point noise', () => {
    // INVARIANT, and the second one is the no double counting property stated over
    // the whole book. Both are published in the module's own doc comment.
    const { population, unsplit, reconciliation } = result;
    expect(population.includedPnl + population.unknownPnl + unsplit.pnl)
      .toBeCloseTo(population.fundedPnl, 6);
    expect(result.rows.reduce((total, r) => total + r.totalPnl, 0))
      .toBeCloseTo(population.includedPnl + reconciliation.residualPnl, 6);
    // MIRROR: the funded and unknown totals the header's share paragraph quotes.
    expect(population.fundedPnl).toBeCloseTo(-132506.55, 2);
    expect(population.unknownPnl).toBeCloseTo(-8514.70, 2);
    expect(population.includedPnl).toBeCloseTo(-70574.75, 2);
    // The tolerance buys the rows essentially nothing on real data: 35 accepted
    // days leave under a ten-billionth of a dollar between them.
    expect(Math.abs(reconciliation.residualPnl)).toBeLessThan(1e-6);
  });

  it('rests on under half the funded days, which is the share the panel has to print', () => {
    // The figure that decides whether the panel is worth showing at all. Asserted
    // as a BOUND rather than a value: if a re-export pushes the attributable share
    // above half the days the header's share paragraph is wrong in the reader's
    // favour, which is the direction that matters, and this fails.
    const dayShare = result.population.includedDays / result.population.fundedDays;
    const moneyShare = result.population.includedPnl / result.population.fundedPnl;
    expect(dayShare).toBeGreaterThan(0.3);
    expect(dayShare).toBeLessThan(0.5);
    expect(moneyShare).toBeGreaterThan(0.4);
    expect(moneyShare).toBeLessThan(0.6);
    // MIRROR: "The curve rests on 385 of 896 funded account days, 43.0%, and on
    // -$70,574.75 of -$132,506.55, 53.3%."
    expect(dayShare * 100).toBeCloseTo(43.0, 1);
    expect(moneyShare * 100).toBeCloseTo(53.3, 1);
    // MIRROR: "35 are MEASURED [...] and they hold -$8,637.00, 12.2% of the
    // credited money", the whole reach of the division rule on this book.
    expect(sumOf(daysIn('measured'))).toBeCloseTo(-8637.00, 2);
    expect(sumOf(daysIn('sole'))).toBeCloseTo(-61937.75, 2);
    expect(100 * sumOf(daysIn('measured')) / result.population.includedPnl).toBeCloseTo(12.2, 1);
    expect(100 * daysIn('measured').length / result.population.fundedDays).toBeCloseTo(3.9, 1);
  });
});

describe('why the 214 unsplit days sat out, which the header got wrong once', () => {
  it('holds the money that sat out', () => {
    // INVARIANT: more money sits out than any single row carries. That is the
    // sentence the caption is built on, and it is the comparison rather than
    // either figure that has to survive a re-import.
    const worstRow = Math.min(...result.rows.map((r) => r.totalPnl));
    expect(result.unsplit.pnl).toBeLessThan(worstRow);
    // MIRROR: "The 214 unsplit days hold -$53,417.10. The largest single row on
    // that book carries -$16,547."
    expect(result.unsplit.pnl).toBeCloseTo(-53417.10, 2);
    expect(worstRow).toBeCloseTo(-16547.06, 2);
  });

  it('divides them 99 / 72 / 43 across the three reasons, in days and in dollars', () => {
    // INVARIANT: the three reasons partition `unsplit`, exactly, in both units. A
    // reason bucket that does not add up is a caption that explains the wrong
    // dollars.
    const { reasons } = result.unsplit;
    expect(reasons.missingFigure.days + reasons.unreported.days + reasons.mismatched.days)
      .toBe(result.unsplit.days);
    expect(reasons.missingFigure.pnl + reasons.unreported.pnl + reasons.mismatched.pnl)
      .toBeCloseTo(result.unsplit.pnl, 6);
    // INVARIANT: and each bucket is the one a fresh walk puts the day in.
    const refusedFor = (name) => accountDays.filter((day, i) => {
      if (cases[i] !== 'unsplit') return false;
      if (!day.figures.every((f) => f != null)) return name === 'missingFigure';
      return name === (day.figures.some((f) => f !== 0) ? 'mismatched' : 'unreported');
    });
    for (const name of ['missingFigure', 'unreported', 'mismatched']) {
      expect(reasons[name].days).toBe(refusedFor(name).length);
      expect(reasons[name].pnl).toBeCloseTo(sumOf(refusedFor(name)), 6);
    }

    // MIRROR, AND THE SENTENCE THIS FILE EXISTS FOR. The header used to say the
    // 115 checked-and-refused days all "carried a figure and still did not add
    // up". That is the third bucket, 43 days and -$8,335.60. The second is 72 days
    // and -$13,041.00 on which every algorithm reported exactly $0, which the
    // code's own comment calls an unreported day.
    expect(reasons.missingFigure.days).toBe(99);
    expect(reasons.missingFigure.pnl).toBeCloseTo(-32040.50, 2);
    expect(reasons.unreported.days).toBe(72);
    expect(reasons.unreported.pnl).toBeCloseTo(-13041.00, 2);
    expect(reasons.mismatched.days).toBe(43);
    expect(reasons.mismatched.pnl).toBeCloseTo(-8335.60, 2);
  });

  it('counts the 28 days whose zeros do add up and are refused anyway', () => {
    // INVARIANT: a flat day counted here is a day whose reported zeros reconcile
    // with the close to the cent, and it is refused anyway, because nothing
    // measured it. Re-derived rather than read off the bucket.
    const flat = accountDays.filter((day, i) => cases[i] === 'unsplit'
      && day.figures.every((f) => f != null)
      && day.figures.every((f) => f === 0)
      && day.pnl === 0);
    expect(result.unsplit.reasons.unreported.flatDays).toBe(flat.length);
    // MIRROR: "on 28 of those 72 the account was flat as well."
    expect(result.unsplit.reasons.unreported.flatDays).toBe(28);
  });

  it('checked 150 days, accepted 35 and refused 115', () => {
    // INVARIANT: the refused count is exactly the two checked reasons, and
    // checked = accepted + refused, so the header's "115" cannot drift away from
    // the breakdown beside it.
    const { reconciliation, unsplit } = result;
    expect(reconciliation.reconciledDays + reconciliation.refusedDays).toBe(reconciliation.checkedDays);
    expect(unsplit.reasons.unreported.days + unsplit.reasons.mismatched.days)
      .toBe(reconciliation.refusedDays);
    // MIRROR: "`reconciliation` publishes the tolerance, the 150 days it checked,
    // the 35 it accepted and the 115 it refused."
    expect(reconciliation).toMatchObject({
      tolerance: 1, checkedDays: 150, reconciledDays: 35, refusedDays: 115,
    });
  });

  it('accepts nothing the tolerance had to stretch for, and refuses nothing it nearly caught', () => {
    // The tolerance is imported from algoContribution.js and the header explains
    // why it is a flat dollar. On THIS book it decides nothing: every accepted day
    // reconciles to the cent, and the smallest refused gap is $2.00, so the same
    // 35 days are accepted for any tolerance anywhere in (0, 2). Worth measuring
    // rather than assuming, because a panel whose population turned on a
    // borrowed constant would be one re-import away from moving.
    const checked = accountDays.filter((day, i) => day.algos.length > 1
      && day.figures.every((f) => f != null)
      && day.figures.some((f) => f !== 0)
      && cases[i] !== 'unknown');
    const gaps = checked.map((day) => Math.abs(day.figures.reduce((t, f) => t + f, 0) - day.pnl));
    const accepted = gaps.filter((gap) => gap <= RECONCILE_TOLERANCE);
    const refused = gaps.filter((gap) => gap > RECONCILE_TOLERANCE);
    // INVARIANT: no accepted day used any of the allowance.
    expect(Math.max(...accepted)).toBeLessThan(0.005);
    // MIRROR: "every accepted MEASURED day reconciles to the cent, and the
    // smallest refused gap is $2.00."
    expect(accepted).toHaveLength(35);
    expect(refused).toHaveLength(43);
    expect(Math.min(...refused)).toBeCloseTo(2.00, 2);
    expect(Math.max(...refused)).toBeCloseTo(328.00, 2);
  });
});

describe('the rows this book produces', () => {
  it('names real algorithms and never a combination, which is the whole complaint', () => {
    // INVARIANT, and it is the reason the file exists: "lo separa por esas
    // combinaciones raras". A row key that joins two algorithms means the panel
    // has regressed into the combo table beside it.
    for (const r of result.rows) {
      expect(r.key).not.toMatch(/\s\+\s/);
      expect(r.level).toBe('family');
    }
  });

  it('produces 14, with the _PF algorithms kept apart from their namesakes', () => {
    // INVARIANT: the identity rule reaches this panel, so a version suffix is not
    // folded into its namesake. If a book ever holds only one of a pair this
    // weakens to vacuous, which is why the pair list is checked for presence.
    for (const key of ['IFSP', 'IFSP_PF', 'OGX', 'OGX_PF']) expect(row(key)).not.toBeNull();
    expect(row('IFSP').totalPnl).not.toBeCloseTo(row('IFSP_PF').totalPnl, 2);
    expect(row('OGX').totalPnl).not.toBeCloseTo(row('OGX_PF').totalPnl, 2);
    // MIRROR: "the 14 rows the stored book produces include IFSP and IFSP_PF as
    // two separate algorithms, and OGX and OGX_PF as two more."
    expect(result.rows).toHaveLength(14);
  });

  it('publishes a coherent row for every algorithm, in the order the panel draws them', () => {
    // INVARIANT, one assertion per published field, because this is the table a
    // CAM reads: measured days, P&L, the dip, heat and the temperature badge.
    for (const r of result.rows) {
      expect(r.days).toBe(r.attribution.measuredDays + r.attribution.soleDays);
      expect(r.accounts).toBeGreaterThan(0);
      expect(r.lowSample).toBe(r.days < result.minDays || r.accounts < result.minAccounts);
      // The curve ends where the total says it does, and the dip is a fall on it.
      const last = r.equity[r.equity.length - 1];
      expect(last.cum).toBeCloseTo(r.totalPnl, 6);
      expect(r.deepestDip).toBeLessThanOrEqual(0);
      expect(r.deepestDip).toBeLessThanOrEqual(Math.min(0, r.totalPnl) + 1e-9);
      expect(r.deepestDip).toBeCloseTo(Math.min(0, ...r.equity.map((p) => p.dip)), 6);
      // Heat is the last three CREDITED dates, and `heatDates` names them.
      expect(r.heatDates).toEqual(r.series.slice(-HEAT_DATES).map((p) => p.date));
      expect(r.heat).toBeCloseTo(r.series.slice(-HEAT_DATES).reduce((t, p) => t + p.pnl, 0), 6);
      expect(r.temperature).toBe(temperatureOf(r.heat));
      // No field on a row may carry the prop firm's word for a different fall.
      for (const key of Object.keys(r)) expect(key).not.toMatch(/drawdown/i);
    }
    // INVARIANT: unmeasured rows below measured ones, then signed heat descending.
    const ranks = result.rows.map((r) => [Number(r.unmeasured), r.unmeasured ? 0 : -r.heat]);
    for (let i = 1; i < ranks.length; i += 1) {
      expect(ranks[i][0]).toBeGreaterThanOrEqual(ranks[i - 1][0]);
      if (ranks[i][0] === ranks[i - 1][0] && !result.rows[i].unmeasured) {
        expect(ranks[i][1]).toBeGreaterThanOrEqual(ranks[i - 1][1] - 1e-9);
      }
    }
  });

  it('measures every row on this book, so the unmeasured shape is latent here', () => {
    // The all-unsplit row shape (temperature 'Unmeasured', deepestDip null) is a
    // real shape this module publishes and no row on THIS book is in it: every one
    // of the 14 was credited at least one day. If a re-export changes that, this
    // is where it surfaces rather than on a client's screen.
    expect(result.rows.filter((r) => r.unmeasured)).toEqual([]);
    expect(result.rows.every((r) => r.days >= 1)).toBe(true);
    expect(result.rows.map((r) => r.temperature)).not.toContain(UNMEASURED_TEMPERATURE);
    // MIRROR: four rows are thin enough for the gate to flag, ten are not.
    expect(result.rows.filter((r) => r.lowSample)).toHaveLength(4);
  });

  it('puts a single stale account day at the top, which is what heat can do to rank 1', () => {
    // MIRROR of the ordering paragraph: "the panel's first row is ARPD_PF, +$430
    // Hot, and it is the only row of 14 with positive heat: it was credited on
    // exactly ONE account day, 2026-07-13, seventeen days before the window ends."
    //
    // Pinned because it is the panel's worst reading risk and the disclosure is
    // two fields the screen has to print. If a re-export changes which row is
    // first, the header paragraph needs rewriting with it.
    const top = result.rows[0];
    expect(top.key).toBe('ARPD_PF');
    expect(top.temperature).toBe('Hot');
    expect(top.days).toBe(1);
    expect(top.heat).toBeCloseTo(430, 2);
    expect(top.heatDates).toEqual(['2026-07-13']);
    expect(result.rows.filter((r) => r.heat > 0)).toHaveLength(1);
    // INVARIANT: whatever the book, the two fields that disclose staleness and
    // thinness are on the row, so the screen can never be short of them.
    expect(top.lowSample).toBe(true);
    expect(top.heatDates.length).toBeGreaterThan(0);
    expect(top.heatDates[top.heatDates.length - 1] <= result.window.to).toBe(true);
  });
});

describe('the reduction the header quotes, on the selections it quotes it for', () => {
  it('is 4.44% over the ten gated rows, with 14 overlapping dates', () => {
    const gated = result.rows.filter((r) => !r.lowSample);
    const composite = buildAlgorithmComposite(result, gated.map((r) => r.key));
    // INVARIANT: the composite's fall is never deeper than the sum of the parts'
    // falls, so the reduction is in [0, 1). A negative one would mean the combined
    // curve fell further than every part added up, which is arithmetically
    // impossible and would mean the composite is not built from the parts.
    expect(composite.deepestDip).toBeGreaterThanOrEqual(composite.sumOfPartDips - 1e-9);
    expect(composite.reduction).toBeGreaterThanOrEqual(0);
    expect(composite.reduction).toBeLessThan(1);
    expect(composite.unmeasuredKeys).toEqual([]);

    // MIRROR: "Selecting the ten rows that pass the sample gate on the stored
    // book, the composite's deepest dip is -$66,855.34 against -$69,962.04 for the
    // sum of the parts: a reduction of 4.44%."
    expect(gated).toHaveLength(10);
    expect(composite.deepestDip).toBeCloseTo(-66855.34, 2);
    expect(composite.sumOfPartDips).toBeCloseTo(-69962.04, 2);
    expect(composite.reduction).toBeCloseTo(0.0444, 4);
    expect(composite.overlapDays).toBe(14);

    // MIRROR, measured rather than asserted: the dip equals the total loss on any
    // curve that never gets back above where it opened, and that is true of 6 of
    // these 10 parts exactly, of a 7th (URGO) within $31, and of the composite
    // itself. There is almost nothing for the parts to offset.
    expect(composite.parts.filter((p) => Math.abs(p.deepestDip - p.totalPnl) < 0.005)).toHaveLength(6);
    expect(composite.parts.filter((p) => Math.abs(p.deepestDip - p.totalPnl) < 35)).toHaveLength(7);
    expect(composite.deepestDip)
      .toBeCloseTo(composite.parts.reduce((total, p) => total + p.totalPnl, 0), 2);

    // MIRROR of the basis sentence ON THIS SELECTION, which is the one the module
    // header quotes as the reduction this checkout can reproduce. Every credited
    // date is also an overlap date here, so the sentence states the count ONCE.
    // It used to read "Measured over 14 dates [...] not only the 14 dates [...]",
    // which denies itself, and it landed on the headline figure of the change.
    expect(composite.reductionDateCount).toBe(composite.overlapDays);
    expect(composite.reductionBasis).toBe(
      'Measured over 14 dates on which at least one selected algorithm was credited, '
      + 'and more than one of them was credited on every one of those dates.',
    );
    expect(composite.reductionBasis).not.toContain('not only');
  });

  it('publishes 0.00% and never "-0.00%" where the two dips are one summation apart', () => {
    // THE LAST MEMBER OF THE "100.00% lower" FAMILY, on the book rather than on a
    // fixture. IFSP + RBO are two ordinary gated rows two clicks apart, both
    // falling monotonically, so the composite's dip and the sum of the parts'
    // dips are the same money added up in two orders. Unclamped the ratio is
    // -2.220446049250313e-16 and the panel renders it in bold as "-0.00% lower."
    const composite = buildAlgorithmComposite(result, ['IFSP', 'RBO']);
    expect(composite.deepestDip).toBeCloseTo(-20642.2, 2);
    expect(composite.sumOfPartDips).toBeCloseTo(-20642.2, 2);
    // The two doubles really do differ, so this book still reaches the case.
    expect(composite.deepestDip).not.toBe(composite.sumOfPartDips);
    expect(1 - (composite.deepestDip / composite.sumOfPartDips)).toBeLessThan(0);
    expect(composite.reduction).toBe(0);
    expect(`${(composite.reduction * 100).toFixed(2)}%`).toBe('0.00%');

    // INVARIANT over every selection this book can reach, not just the six that
    // used to go negative: a reduction below 0 would say the combined curve fell
    // FURTHER than its parts did apart, which the subadditivity above forbids.
    const keys = result.rows.map((r) => r.key);
    let published = 0;
    for (let mask = 1; mask < (1 << keys.length); mask += 1) {
      const selection = keys.filter((_, i) => mask & (1 << i));
      const step = buildAlgorithmComposite(result, selection);
      if (step.reduction === null) continue;
      published += 1;
      expect(step.reduction).toBeGreaterThanOrEqual(0);
      expect(step.reduction).toBeLessThanOrEqual(1);
    }
    expect(published).toBe(16365);
  });

  it('is nothing at all on a plausible three algorithm selection', () => {
    // The selection a CAM would actually make, and the one the brief asks for: the
    // three rows with the most MEASURED days, then the three with the most
    // credited days. Both are under one percent, which is the honest headline.
    const top3 = (rank) => [...result.rows].sort(rank).slice(0, 3).map((r) => r.key);
    const byMeasured = top3((a, b) => b.attribution.measuredDays - a.attribution.measuredDays
      || a.key.localeCompare(b.key));
    const byCredited = top3((a, b) => b.days - a.days || a.key.localeCompare(b.key));

    for (const keys of [byMeasured, byCredited]) {
      const composite = buildAlgorithmComposite(result, keys);
      // INVARIANT: subadditive, and the composite is the sum of its parts, so no
      // account day is counted twice inside it.
      expect(composite.deepestDip).toBeGreaterThanOrEqual(composite.sumOfPartDips - 1e-9);
      expect(composite.series.reduce((t, p) => t + p.pnl, 0))
        .toBeCloseTo(composite.parts.reduce((t, p) => t + p.totalPnl, 0), 6);
      expect(composite.overlapDays).toBeGreaterThan(0);
      // The reduction is a rounding error on this book, not a diversification
      // story. Asserted as a bound: anything above a percent here would mean the
      // header's "reads as nothing" is the wrong sentence.
      expect(composite.reduction).toBeGreaterThanOrEqual(0);
      expect(composite.reduction).toBeLessThan(0.01);
    }

    // MIRROR: "the three rows with the most MEASURED days (IFSP, IFSP_PF, URGO)
    // give -$28,745.66 against -$28,776.66, a reduction of 0.11%, and the three
    // with the most credited days (URGO, B2X, G4M) give 0.08%."
    expect(byMeasured).toEqual(['IFSP', 'IFSP_PF', 'URGO']);
    expect(byCredited).toEqual(['URGO', 'B2X', 'G4M']);
    const measured = buildAlgorithmComposite(result, byMeasured);
    expect(measured.deepestDip).toBeCloseTo(-28745.66, 2);
    expect(measured.sumOfPartDips).toBeCloseTo(-28776.66, 2);
    expect(measured.reduction * 100).toBeCloseTo(0.11, 2);
    expect(measured.overlapDays).toBe(13);
    expect(buildAlgorithmComposite(result, byCredited).reduction * 100).toBeCloseTo(0.08, 2);
  });

  it('refuses the top two rows of its own default view instead of printing 100% lower', () => {
    // THE THIRD SENTENCE THIS FILE CATCHES, and the first one a CAM would have
    // read out loud. The panel sorts by heat, so the default view opens on
    // ARPD_PF and DJDR, and selecting the first two rows is two clicks from a
    // cold open. Both were credited on one account day, 2026-07-13: ARPD_PF won
    // and never fell, DJDR lost $25.50. The committed module guarded only the
    // denominator, so 1 - (0 / -25.50) reached the screen as "Combined $0
    // against -$26 for the sum of the parts, 100.00% lower".
    const topTwo = result.rows.slice(0, 2).map((r) => r.key);
    expect(topTwo).toEqual(['ARPD_PF', 'DJDR']);
    const composite = buildAlgorithmComposite(result, topTwo);
    expect(composite.deepestDip).toBe(0);
    expect(composite.sumOfPartDips).toBeCloseTo(-25.5, 2);
    expect(composite.overlapDays).toBe(1);
    expect(composite.reductionDateCount).toBe(1);
    expect(composite.reduction).toBeNull();
    expect(composite.reduction).not.toBe(1);
    expect(composite.reductionRefusal).toBe('compositeNeverFell');
    expect(composite.reductionNote).toContain('not a reduction of 100%');

    // MIRROR: "all 14 of this book's single row selections" are refused as a
    // curve compared against itself, and "3 of this book's 91 pairs" never
    // shared a credited date.
    const keys = result.rows.map((r) => r.key);
    expect(keys).toHaveLength(14);
    expect(new Set(keys.map((key) => buildAlgorithmComposite(result, [key]).reductionRefusal)))
      .toEqual(new Set(['singleAlgorithm']));
    const pairs = [];
    for (let i = 0; i < keys.length; i += 1) {
      for (let j = i + 1; j < keys.length; j += 1) {
        pairs.push(buildAlgorithmComposite(result, [keys[i], keys[j]]).reductionRefusal);
      }
    }
    expect(pairs).toHaveLength(91);
    expect(pairs.filter((refusal) => refusal === 'noSharedDate')).toHaveLength(3);
    expect(pairs.filter((refusal) => refusal === 'compositeNeverFell')).toHaveLength(1);
    expect(pairs.filter((refusal) => refusal === null)).toHaveLength(87);
  });

  it('measures the reduction over every credited date and not over the overlap', () => {
    // MIRROR: "the panel printed the overlap count as the basis and on this book
    // that said 4 where the comparison spanned 12 (ARPD_PF, OGX_PF and ARPD,
    // 20.69% over 12 credited dates of which 4 carry more than one)". The
    // selection is the largest three algorithm figure on this book, which is the
    // one most likely to be quoted.
    const composite = buildAlgorithmComposite(result, ['ARPD_PF', 'OGX_PF', 'ARPD']);
    expect(composite.reduction * 100).toBeCloseTo(20.69, 2);
    expect(composite.reductionDateCount).toBe(12);
    expect(composite.overlapDays).toBe(4);
    expect(composite.reductionDates).toHaveLength(12);
    expect(composite.reductionBasis).toBe(
      'Measured over 12 dates on which at least one selected algorithm was credited, '
      + 'not only the 4 dates on which more than one of them was.',
    );
    // INVARIANT: the dates the figure covers are the composite's own series, and
    // the overlap is a subset of them rather than a different list.
    expect(composite.reductionDates).toEqual(composite.series.map((p) => p.date));
    expect(composite.overlapDates.every((date) => composite.reductionDates.includes(date))).toBe(true);
  });

  it('does not walk upward as the selection grows, which the header used to promise', () => {
    // THE SECOND SENTENCE THIS FILE CAUGHT. The header said "the figure drifts
    // upward as the selection grows" and REDUCTION_CAVEAT told a paying client
    // "the sum grows with every algorithm added and this reduction grows with it".
    // Adding the 14 rows one at a time falsifies both.
    const order = [...result.rows].sort((a, b) => b.attribution.measuredDays - a.attribution.measuredDays
      || a.key.localeCompare(b.key));
    const steps = order.map((_, i) => buildAlgorithmComposite(result, order.slice(0, i + 1).map((r) => r.key)));

    // INVARIANT: the denominator's magnitude never shrinks. It is a sum of non
    // positive dips, so this is the one direction the caveat may claim.
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i].sumOfPartDips).toBeLessThanOrEqual(steps[i - 1].sumOfPartDips + 1e-9);
    }
    // MIRROR: "walking the 14 rows of this book one at a time, from the two row
    // selection that is the first one comparable at all, it falls at 6 of the 12
    // steps [...] while ending at 5.52% against the 0.00% it starts from."
    //
    // INVARIANT: the walk starts at the SECOND step. A one row selection is a
    // curve compared against itself and this module refuses it, so there is no
    // first figure to step away from and no arithmetic to do on a null.
    expect(steps[0].reduction).toBeNull();
    expect(steps[0].reductionRefusal).toBe('singleAlgorithm');
    const comparable = steps.filter((step) => step.reduction !== null);
    expect(comparable).toHaveLength(13);
    const falls = comparable
      .map((step, i) => (i > 0 && step.reduction < comparable[i - 1].reduction - 1e-12 ? order[i + 1].key : null))
      .filter(Boolean);
    expect(falls).toEqual(['RBO', 'B2X', 'G4M', 'ARPD', 'Bullet Bot', 'DJDR']);
    expect(comparable[0].reduction * 100).toBeCloseTo(0, 2);
    expect(comparable[comparable.length - 1].reduction * 100).toBeCloseTo(5.52, 2);
    expect(comparable[comparable.length - 1].reduction).toBeGreaterThan(comparable[0].reduction);

    // MIRROR: "a real row can have a dip of exactly 0 and this book has one
    // (ARPD_PF, whose one credited day was a winning day). Adding THAT row moved
    // the reduction up by lifting the composite's own curve, not by moving the
    // denominator at all."
    const zeroDip = result.rows.filter((r) => r.deepestDip === 0);
    expect(zeroDip.map((r) => r.key)).toEqual(['ARPD_PF']);
    const withoutIt = order.filter((r) => r.key !== 'ARPD_PF').map((r) => r.key);
    const before = buildAlgorithmComposite(result, withoutIt);
    const after = buildAlgorithmComposite(result, [...withoutIt, 'ARPD_PF']);
    expect(after.sumOfPartDips).toBeCloseTo(before.sumOfPartDips, 6);
    expect(after.deepestDip).toBeGreaterThan(before.deepestDip);
    expect(after.reduction).toBeGreaterThan(before.reduction);
  });
});

describe('the per close share, which is the header figure nothing used to mirror', () => {
  it('reproduces the range the header quotes, floor included', () => {
    // WHY THIS TEST EXISTS. Every other figure in that header has a mirror in
    // this file. This one did not, and it was wrong: it read "ranges from 27.7%
    // (2026-07-20) to 129.9%". 27.7% is not the minimum, it is only the smallest
    // share that happens to be POSITIVE, and naming it as the floor hid the end
    // of the range a reader needs to know about. The true floor is -4.2%.
    const fundedByDate = new Map();
    for (const day of accountDays) {
      fundedByDate.set(day.date, (fundedByDate.get(day.date) || 0) + day.pnl);
    }
    const attrByDate = new Map();
    for (const r of result.rows) {
      for (const point of r.series) attrByDate.set(point.date, (attrByDate.get(point.date) || 0) + point.pnl);
    }
    // The walk is the module's own: its attributable column sums to includedPnl.
    let attrTotal = 0;
    for (const value of attrByDate.values()) attrTotal += value;
    expect(attrTotal).toBeCloseTo(result.population.includedPnl, 6);

    const shares = [...fundedByDate.entries()]
      .filter(([, funded]) => funded !== 0)
      .map(([date, funded]) => ({ date, funded, attr: attrByDate.get(date) || 0, share: 100 * (attrByDate.get(date) || 0) / funded }));
    const min = shares.reduce((a, b) => (b.share < a.share ? b : a));
    const max = shares.reduce((a, b) => (b.share > a.share ? b : a));

    // MIRROR: "Per close the attributable share of the desk's funded P&L ranges
    // from -4.2% (2026-07-14) to 129.9% (2026-07-21, where the attributable
    // accounts were up $1,409.30 while the rest of the desk gave back $324.50)".
    expect(min.date).toBe('2026-07-14');
    expect(min.share).toBeCloseTo(-4.2, 1);
    expect(max.date).toBe('2026-07-21');
    expect(max.share).toBeCloseTo(129.9, 1);

    // MIRROR: "the desk's funded accounts lost $2,059.00 while the accounts this
    // panel can attribute MADE $87.00". The sign inversion is the whole point of
    // naming this close, so pin both signs and not only the ratio.
    expect(min.funded).toBeCloseTo(-2059, 2);
    expect(min.attr).toBeCloseTo(87, 2);
    expect(min.funded).toBeLessThan(0);
    expect(min.attr).toBeGreaterThan(0);
    expect(max.attr).toBeCloseTo(1409.3, 2);
    expect(max.funded - max.attr).toBeCloseTo(-324.5, 2);

    // INVARIANT: 27.7% on 2026-07-20 is a real figure and the header was only
    // wrong to call it the floor, so it stays reproducible and stays above it.
    const jul20 = shares.find((entry) => entry.date === '2026-07-20');
    expect(jul20.share).toBeCloseTo(27.7, 1);
    expect(jul20.share).toBeGreaterThan(min.share);
  });
});

describe('what the two panels on one screen each credit out of the same book', () => {
  it('credits a subset, which is the claim the Stack Playbook caption makes', () => {
    // StackPlaybook.jsx's caption tells a reader the gap between its two badges
    // "is that rule and nothing else", that "every account day this panel
    // credits is credited by the table too", and that the difference is the days
    // "credited to nobody". That sentence replaced one which said no account day
    // was in one build and absent from the other, which was false for exactly
    // these 214 days. So the replacement gets a measurement rather than a claim.
    const combo = buildComboPerformance(clients, OPTIONS);

    // Both builds walk the SAME funded population, so the badges share a
    // denominator and the caption may say so.
    expect(combo.population.fundedDays).toBe(result.population.fundedDays);
    expect(combo.population.fundedPnl).toBeCloseTo(result.population.fundedPnl, 6);

    // The bucket neither build credits is identical in days AND in money, which
    // is what makes the remainder a partition rather than two similar totals.
    expect(combo.population.unknownDays).toBe(result.population.unknownDays);
    expect(combo.population.unknownPnl).toBeCloseTo(result.population.unknownPnl, 6);

    // MIRROR of the caption: 599 against 385, and the 214 between them are the
    // unsplit days the panel prints above it as credited to nobody.
    expect(result.population.includedDays).toBe(385);
    expect(combo.population.includedDays).toBe(599);
    expect(result.unsplit.days).toBe(214);
    expect(combo.population.includedDays).toBe(result.population.includedDays + result.unsplit.days);
    expect(combo.population.includedPnl)
      .toBeCloseTo(result.population.includedPnl + result.unsplit.pnl, 6);

    // And the table's credited population is a superset on both counts, so the
    // caption's "accepts more of it" is true of accounts and clients as well.
    expect(combo.population.accounts).toBeGreaterThanOrEqual(result.population.accounts);
    expect(combo.population.clients).toBeGreaterThanOrEqual(result.population.clients);
  });
});

describe('no double counting, against the desk P&L rather than a fixture', () => {
  it('reproduces the attributable part of the desk daily P&L, date by date', () => {
    // THE PROPERTY, on real data. The per algorithm series are a PARTITION of the
    // account days they were credited on, so summing every row's contribution on a
    // date must give back exactly the desk's P&L over the account days that date
    // credited, and nothing more. An equal split would pass this. Crediting each
    // algorithm the whole day would fail it by a factor of the stack size, which
    // on this book averages 2.16 algorithms per multi algorithm day.
    const deskByDate = new Map();
    for (const [i, day] of accountDays.entries()) {
      if (cases[i] !== 'sole' && cases[i] !== 'measured') continue;
      deskByDate.set(day.date, (deskByDate.get(day.date) || 0) + day.pnl);
    }
    const rowsByDate = new Map();
    for (const r of result.rows) {
      for (const point of r.series) rowsByDate.set(point.date, (rowsByDate.get(point.date) || 0) + point.pnl);
    }
    expect([...rowsByDate.keys()].sort()).toEqual([...deskByDate.keys()].sort());
    let worst = 0;
    for (const [date, credited] of rowsByDate) {
      const gap = credited - deskByDate.get(date);
      if (Math.abs(gap) > Math.abs(worst)) worst = gap;
      expect(credited).toBeCloseTo(deskByDate.get(date), 6);
    }
    expect(Math.abs(worst)).toBeLessThan(1e-6);
  });

  it('never credits more or less than an account day, one account day at a time', () => {
    // The per date check above would survive two account days whose errors
    // cancelled inside one close. This one does not: every credited account day is
    // checked on its own, and a MEASURED day may differ from the close only by
    // what the tolerance allows.
    let worst = 0;
    let credited = 0;
    for (const [i, day] of accountDays.entries()) {
      if (cases[i] === 'sole') {
        credited += 1;
        continue;
      }
      if (cases[i] !== 'measured') continue;
      credited += 1;
      const gap = day.figures.reduce((total, figure) => total + figure, 0) - day.pnl;
      expect(Math.abs(gap)).toBeLessThanOrEqual(RECONCILE_TOLERANCE);
      if (Math.abs(gap) > Math.abs(worst)) worst = gap;
    }
    expect(credited).toBe(result.population.includedDays);
    // MIRROR: on this book no credited account day is off by so much as a cent.
    expect(Math.abs(worst)).toBeLessThan(0.005);
  });

  it('carries a count and no dollars for the days it could not partition', () => {
    // INVARIANT: unsplit dollars are named ONCE, in `unsplit`, and never per row.
    // Summing a per row unsplit column would over-count the money by the stack
    // size on every multi algorithm day, which is the mistake the panel exists to
    // avoid. The row touches prove the factor is real rather than theoretical.
    const touches = result.rows.reduce((total, r) => total + r.attribution.unsplitDays, 0);
    expect(touches).toBeGreaterThan(result.unsplit.days);
    for (const r of result.rows) {
      for (const key of Object.keys(r.attribution)) expect(key).not.toMatch(/pnl|money|dollars/i);
    }
    // MIRROR: 463 row touches over 214 unsplit days, 2.16 algorithms a day.
    expect(touches).toBe(463);
    expect(touches / result.unsplit.days).toBeCloseTo(2.16, 2);
  });
});

describe('the measurement behind testing SOLE before MEASURED', () => {
  it('finds 350 solo days, 184 with no figure at all and 110 of 166 agreeing', () => {
    // The header's justification for the case order, re-walked on this module's OWN
    // rule for which algorithms ran rather than on the spec's export-time `enabled`
    // flag, because those are two different populations that happen to produce the
    // same 166 on this book.
    const solo = accountDays.filter((day) => day.algos.length === 1);
    const withFigure = solo.filter((day) => day.figures[0] != null);
    const gaps = withFigure.map((day) => day.figures[0] - day.pnl);
    const equal = gaps.filter((gap) => Math.abs(gap) < 0.005);
    const off = gaps.filter((gap) => Math.abs(gap) >= 0.005);

    // INVARIANT: the rule this justifies is live, and the solo count IS the SOLE
    // count because that branch never refuses.
    expect(result.rows.reduce((total, r) => total + r.attribution.soleDays, 0)).toBe(solo.length);

    // MIRROR: "of the 350 SOLE account days on the stored book, 184 carry no
    // figure at all [...] 166 do carry one, and it equals the account day on 110;
    // on the other 56, crediting the row rather than the account day would have
    // moved $6,470.28 and lost $3,914.68 of it net."
    expect(solo).toHaveLength(350);
    expect(solo.length - withFigure.length).toBe(184);
    expect(withFigure).toHaveLength(166);
    expect(equal).toHaveLength(110);
    expect(off).toHaveLength(56);
    expect(off.reduce((total, gap) => total + Math.abs(gap), 0)).toBeCloseTo(6470.28, 2);
    expect(off.reduce((total, gap) => total + gap, 0)).toBeCloseTo(3914.68, 2);
  });
});

describe('one resolve, on every day of the book', () => {
  it('agrees with the combo table beside it about which algorithms ran', () => {
    // comboPerformance.js states that `dayAlgoRows(...).map(e => e.key)` equals
    // `comboKeyFromDay(...).elements`. The synthetic half of this suite pins the
    // rule; this is the same check over all 896 funded account days, because the
    // two panels sit under one heading and a disagreement between them is the
    // failure a reader would attribute to the attribution.
    let mismatches = 0;
    for (const day of accountDays) {
      const { elements } = comboKeyFromDay(day.snapshot, day.executions, OPTIONS);
      if (day.algos.map((entry) => entry.key).join('|') !== elements.join('|')) mismatches += 1;
    }
    expect(accountDays).toHaveLength(896);
    expect(mismatches).toBe(0);
  });
});

describe('the book this panel walks is not the raw export', () => {
  it('drops only the closes of soft deleted clients, so no close is silently missing', () => {
    // Read this before comparing a panel figure to the export. The raw
    // daily_imports table spans 21 trading dates from 2026-06-25; the book the
    // panel walks holds 14 from 2026-07-13, and the module header is right to call
    // that "the whole stored book" because it is the whole book the CRM state
    // exposes. The difference is entirely clients with `deleted_at` set.
    //
    // INVARIANT: every dropped close belongs to a client row that is soft deleted
    // or absent, and no close of a visible client is missing.
    const clientRows = snapshot.tables.clients;
    const byUuid = new Map(clientRows.map((c) => [c.id, c]));
    const raw = snapshot.tables.daily_imports;
    const visible = raw.filter((di) => {
      const client = byUuid.get(di.client_id);
      return client && !client.deleted_at;
    });
    const built = clients.reduce((total, client) => total + (client.dailyImports || []).length, 0);
    expect(built).toBe(visible.length);
    const builtDates = new Set();
    for (const client of clients) for (const di of client.dailyImports || []) builtDates.add(di.date);
    const visibleDates = new Set(visible.map((di) => (di.trading_date || '').slice(0, 10)));
    expect([...builtDates].sort()).toEqual([...visibleDates].sort());

    // MIRROR: 535 raw closes over 21 trading dates, 50 of them on soft deleted
    // clients, leaving 485 over 14 dates and 96 clients.
    expect(raw).toHaveLength(535);
    expect(new Set(raw.map((di) => (di.trading_date || '').slice(0, 10))).size).toBe(21);
    expect(raw.length - visible.length).toBe(50);
    expect(built).toBe(485);
    expect(builtDates.size).toBe(14);
    expect(clients).toHaveLength(96);
  });
});
