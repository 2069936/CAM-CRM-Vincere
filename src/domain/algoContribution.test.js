// Every fixture in this file is SYNTHETIC, and that is what makes the file
// worth its name: it reads nothing off public/local-snapshot.json, so it is not
// in vite.config.js's localSnapshotTests list and it runs on CI and on every
// clone, not only on the one machine that holds the book.
//
// That distinction is load-bearing rather than tidy. The two guards below —
// "refuses a partial split even when some algos on the roster do carry one" and
// "refuses a day whose derived rows add up to more than the account made" — are
// the only things standing between a wrong per-algo split and a screen. While
// they lived in a snapshot-gated file, both mutations that break them passed a
// full CI run. Do not move a test into a gated file unless it genuinely needs
// the book; the book-backed assertions for this module are in
// algoContribution.book.test.js.

import { describe, expect, it } from 'vitest';
import { buildAlgoAccountHistory, buildComboPeriods, summarize } from './algoContribution';

function client(days) {
  return {
    dailyImports: days.map((d) => ({
      date: d.date,
      snapshots: [{
        accountName: 'ACC1',
        grossRealizedPnl: d.pnl,
        accountBalance: 0,
        trailingMaxDrawdown: 0,
        strategies: d.strategies,
      }],
    })),
  };
}

const algo = (family, realized, enabled = true) => ({
  strategyFamily: family, strategyVersion: '1.0', direction: 'Both', instrument: 'MNQ', enabled, realized,
});

describe('refusing to invent a split', () => {
  it('does not attribute a day whose strategies all report zero', () => {
    // The common case in the book: the account moved, the Strategies tab did
    // not say who moved it. Splitting 110 across two algos here would be
    // fabrication.
    const { algos, attribution } = buildAlgoAccountHistory(
      client([{ date: '2026-07-13', pnl: 110, strategies: [algo('IFSP', 0), algo('RBO', 0)] }]),
      'ACC1',
    );
    expect(attribution.status).toBe('unavailable');
    expect(attribution.unattributedPnl).toBe(110);
    expect(algos.every((a) => a.reportedDays === 0)).toBe(true);
  });

  it('does not call a flat day reported just because zero equals zero', () => {
    // THE SIBLING THE TEST ABOVE CANNOT STAND IN FOR, and the only ungated thing
    // pinning the `!== 0` in `anyReported`.
    //
    // Above, the account moved 110 against a reported sum of 0, so
    // `Math.abs(reportedSum - dayPnl) < 1` rejects the day on arithmetic alone —
    // whether or not `anyReported` is honest. Drop the `!== 0` clause and that
    // test still passes. Here the arithmetic is switched off: the account was
    // flat AND every grid row says an explicit 0, so `reportedSum - dayPnl` is
    // exactly 0 and the only thing left standing between this day and the label
    // "reported by NinjaTrader" is the clause.
    //
    // What it costs to lose: the panel announces "all 1 days carry a per-algo
    // split (1 reported by NinjaTrader)" and prints "$0 over 1d" against every
    // algo — a measurement nobody took, wearing the label of one. That is the
    // same failure as the fabricated derived zero, arriving through the reported
    // half of the same screen.
    const { algos, attribution } = buildAlgoAccountHistory(
      client([{ date: '2026-07-13', pnl: 0, strategies: [algo('IFSP', 0), algo('RBO', 0)] }]),
      'ACC1',
    );
    expect(attribution.status).toBe('unavailable');
    expect(attribution.attributedDays).toBe(0);
    expect(attribution.reportedDays).toBe(0);
    expect(algos.every((a) => a.reportedDays === 0)).toBe(true);
  });

  it('still attributes a flat day the grid genuinely did report', () => {
    // The other half of the pair, so the clause above cannot be "fixed" by
    // refusing every flat day instead. +50 and -50 on an account that finished
    // flat is a real report that really reconciles: two algos ran, they cancelled
    // out, and the export said so by name. Refusing this would be the opposite
    // error — deleting an answer the export actually gave.
    const { algos, attribution } = buildAlgoAccountHistory(
      client([{ date: '2026-07-13', pnl: 0, strategies: [algo('IFSP', 50), algo('RBO', -50)] }]),
      'ACC1',
    );
    expect(attribution.status).toBe('complete');
    expect(attribution.reportedDays).toBe(1);
    expect(algos.find((a) => a.key.startsWith('IFSP')).reportedPnl).toBe(50);
    expect(algos.find((a) => a.key.startsWith('RBO')).reportedPnl).toBe(-50);
  });

  it('rejects a day that reports a split which does not add up', () => {
    // The dangerous case. Partial reporting looks like real data: two algos
    // report 40 and 30 while the account made 500. Believing it would show
    // IFSP as the day's driver at 40 when 430 came from somewhere unreported.
    const { algos, attribution } = buildAlgoAccountHistory(
      client([{ date: '2026-07-13', pnl: 500, strategies: [algo('IFSP', 40), algo('RBO', 30)] }]),
      'ACC1',
    );
    expect(attribution.attributedDays).toBe(0);
    expect(algos.find((a) => a.key.startsWith('IFSP')).reportedPnl).toBe(0);
  });

  it('accepts a day whose reported split reconciles with the account', () => {
    const { algos, attribution } = buildAlgoAccountHistory(
      client([{ date: '2026-07-13', pnl: 220, strategies: [algo('IFSP', -80), algo('RBO', 300)] }]),
      'ACC1',
    );
    expect(attribution.status).toBe('complete');
    expect(algos.find((a) => a.key.startsWith('RBO')).reportedPnl).toBe(300);
    expect(algos.find((a) => a.key.startsWith('IFSP')).reportedPnl).toBe(-80);
  });

  it('sums an algo only over the days that reconciled', () => {
    const { algos } = buildAlgoAccountHistory(
      client([
        { date: '2026-07-13', pnl: 100, strategies: [algo('IFSP', 100)] },   // reconciles
        { date: '2026-07-14', pnl: 900, strategies: [algo('IFSP', 50)] },    // does not
        { date: '2026-07-15', pnl: -60, strategies: [algo('IFSP', -60)] },   // reconciles
      ]),
      'ACC1',
    );
    const ifsp = algos[0];
    expect(ifsp.reportedDays).toBe(2);
    expect(ifsp.reportedPnl).toBe(40);
    expect(ifsp.daysPresent).toBe(3);
  });
});

describe('the day-level re-check of what the producer said', () => {
  // buildAlgoAccountHistory re-checks the derivation's own verdict rather than
  // trusting it. These pin the two clauses that do that. Neither is reachable
  // from a well-behaved producer, which is the point: the display is the last
  // place the numbers can be refused, and a re-check nothing tests is decoration.
  const oneAlgoDay = (derivation) => ({
    dailyImports: [{
      date: '2026-08-18',
      snapshots: [{
        accountName: 'A',
        grossRealizedPnl: 20,
        derivation,
        strategies: [{
          strategyFamily: 'Alpha', strategyVersion: '1.0', enabled: true,
          realized: null, derivedRealized: 20,
        }],
      }],
    }],
  });

  it('refuses a day whose derivation did not come out exact, however complete its rows look', () => {
    // Every roster row carries a figure and they add up. Only the producer's own
    // status says the day is not fully accounted for — so only that says it.
    const { attribution } = buildAlgoAccountHistory(
      oneAlgoDay({ status: 'partial', reportedGross: 20, join: {}, residual: {} }),
      'A',
    );
    expect(attribution.derivedDays).toBe(0);
  });

  it('does not call an empty roster a derived day', () => {
    // `every` on an empty array is true. Without the length check, an account
    // with an exact derivation and no strategy rows at all would report a
    // complete split of nothing.
    const { attribution } = buildAlgoAccountHistory(
      {
        dailyImports: [{
          date: '2026-08-18',
          snapshots: [{
            accountName: 'A', grossRealizedPnl: 0, strategies: [],
            derivation: { status: 'exact', reportedGross: 0, join: {}, residual: {} },
          }],
        }],
      },
      'A',
    );
    expect(attribution.derivedDays).toBe(0);
  });
});

describe('combination periods', () => {
  it('splits on a roster change and keeps each side whole', () => {
    const periods = buildComboPeriods([
      { date: 'd1', dayPnl: -100, combo: 'A + B' },
      { date: 'd2', dayPnl: -200, combo: 'A + B' },
      { date: 'd3', dayPnl: 300, combo: 'A' },
    ]);
    expect(periods).toHaveLength(2);
    expect(periods[0]).toMatchObject({ combo: 'A + B', days: 2, totalPnl: -300, greenDays: 0, from: 'd1', to: 'd2' });
    expect(periods[1]).toMatchObject({ combo: 'A', days: 1, totalPnl: 300, greenDays: 1 });
    expect(periods[0].avgPnl).toBe(-150);
  });

  it('reopens a combination that comes back rather than merging it', () => {
    // A → B → A is three periods, not two. Merging them would hide that the
    // account ran A twice with different results.
    const periods = buildComboPeriods([
      { date: 'd1', dayPnl: 10, combo: 'A' },
      { date: 'd2', dayPnl: 20, combo: 'B' },
      { date: 'd3', dayPnl: 30, combo: 'A' },
    ]);
    expect(periods.map((p) => p.combo)).toEqual(['A', 'B', 'A']);
  });

  it('counts a day with every algo disabled as its own combination', () => {
    // The account still trades on those days in the real book. Folding them
    // into the neighbouring roster would credit algos that were switched off.
    const { periods } = buildAlgoAccountHistory(
      client([
        { date: '2026-07-13', pnl: -300, strategies: [algo('IFSP', 0)] },
        { date: '2026-07-14', pnl: -776, strategies: [algo('IFSP', 0, false)] },
      ]),
      'ACC1',
    );
    expect(periods).toHaveLength(2);
    expect(periods[1].combo).toBe('None');
    expect(periods[1].totalPnl).toBe(-776);
  });
});

describe('summarize', () => {
  it('calls an empty history empty rather than unavailable', () => {
    expect(summarize([]).status).toBe('empty');
  });
});

// ---------------------------------------------------------------------------
// The derived path. These fixtures are synthetic because they HAVE to be:
// public/local-snapshot.json has its `time_text` and `entry_exit` columns
// REDACTED, so nothing in it can be paired and it cannot exercise derivation at
// all — trying to do so is exactly the mistake that produced the 216/1112 figure
// this module's header now supersedes. Which is also why these tests lose
// nothing by living outside the snapshot gate, and gain the only thing that
// matters: they run where the book is not.
// ---------------------------------------------------------------------------

// `reportedGross` is on every derivation reconcile emits (deriveStrategyPnl
// always returns it) and it is what the derived rows are checked to add up to,
// so a fixture without it is not a shape production can produce. `gross`
// defaults to the day's PnL and is set apart from it only where a test is about
// the two disagreeing.
function derivedClient(days) {
  return {
    dailyImports: days.map((d) => ({
      date: d.date,
      snapshots: [{
        accountName: 'ACC1',
        grossRealizedPnl: d.pnl,
        accountBalance: 0,
        trailingMaxDrawdown: 0,
        derivation: {
          status: 'exact',
          residual: { realized: 0, pairs: 0, reasons: {} },
          reportedGross: d.gross ?? d.pnl,
          ...(d.derivation || {}),
        },
        strategies: d.strategies,
      }],
    })),
  };
}

const derivedAlgo = (family, { reported = null, derived = null, enabled = true } = {}) => ({
  strategyFamily: family,
  strategyVersion: '1.0',
  direction: 'Both',
  instrument: 'MNQ',
  enabled,
  realized: reported,
  derivedRealized: derived,
});

describe('a split the fills derived', () => {
  it('attributes a day the Strategies grid said nothing about', () => {
    // The common case, and the whole reason the feature exists: the account
    // moved 110 and the export named nobody. Before derivation this was
    // unattributable; now the fills answer it.
    const { algos, attribution } = buildAlgoAccountHistory(
      derivedClient([{
        date: '2026-08-18',
        pnl: 110,
        strategies: [derivedAlgo('IFSP', { derived: 80 }), derivedAlgo('RBO', { derived: 30 })],
      }]),
      'ACC1',
    );
    expect(attribution.status).toBe('complete');
    expect(attribution.derivedDays).toBe(1);
    expect(attribution.reportedDays).toBe(0);
    const ifsp = algos.find((a) => a.key.startsWith('IFSP'));
    expect(ifsp.derivedPnl).toBe(80);
    expect(ifsp.contributionPnl).toBe(80);
    expect(ifsp.reportedPnl).toBe(0);
    expect(ifsp.reportedDays).toBe(0);
  });

  it('keeps derived and reported totals separate on a day that has both', () => {
    const { algos } = buildAlgoAccountHistory(
      derivedClient([{
        date: '2026-08-18',
        pnl: 100,
        strategies: [derivedAlgo('IFSP', { reported: 100, derived: 100 })],
      }]),
      'ACC1',
    );
    const ifsp = algos[0];
    expect(ifsp.derivedPnl).toBe(100);
    expect(ifsp.reportedPnl).toBe(100);
    expect(ifsp.derivedDays).toBe(1);
    expect(ifsp.reportedDays).toBe(1);
    // Counted once, not twice: the contribution is one day's money.
    expect(ifsp.contributionPnl).toBe(100);
  });

  it('refuses to derive a day whose derivation did not come out exact', () => {
    const { algos, attribution } = buildAlgoAccountHistory(
      derivedClient([{
        date: '2026-08-18',
        pnl: 110,
        derivation: { status: 'unreconciled', residual: { realized: 0, pairs: 0, reasons: {} } },
        strategies: [derivedAlgo('IFSP', { derived: null })],
      }]),
      'ACC1',
    );
    expect(attribution.status).toBe('unavailable');
    expect(algos[0].contributionPnl).toBe(0);
    expect(algos[0].derivedDays).toBe(0);
  });

  it('refuses a partial split even when some algos on the roster do carry one', () => {
    // Half a split is not a split. Showing IFSP at 110 while RBO is blank reads
    // as "RBO made nothing", which is a claim nobody measured.
    //
    // The whole 110 is on IFSP on purpose: the rows that DO carry a figure add
    // up to the account's gross, so the arithmetic check passes and the only
    // thing refusing this day is `algos.every((a) => a.derived != null)`. This
    // is the production shape — reconcile leaves a roster row the fills never
    // named at null, never at a fabricated zero — and it is what pins that
    // guard. Relax `every` to `some` and this test fails.
    const { attribution, algos } = buildAlgoAccountHistory(
      derivedClient([{
        date: '2026-08-18',
        pnl: 110,
        strategies: [derivedAlgo('IFSP', { derived: 110 }), derivedAlgo('RBO', { derived: null })],
      }]),
      'ACC1',
    );
    expect(attribution.status).toBe('unavailable');
    expect(algos.every((a) => a.derivedDays === 0)).toBe(true);
  });

  it('refuses a day whose derived rows add up to more than the account made', () => {
    // The reproduced multiplication: one derived row landed on two same-named
    // roster rows (one algo, two instruments, one account) and each row took the
    // whole figure, so the panel showed double the account's P&L labelled
    // derived with a residual of 0. Every row is non-null and the derivation
    // says 'exact', so only the arithmetic can catch it. Remove the
    // `derivedReconciles` term from `derivedDay` and this test fails.
    const { attribution, algos } = buildAlgoAccountHistory(
      derivedClient([{
        date: '2026-08-18',
        pnl: 100,
        strategies: [
          { ...derivedAlgo('IFSP', { derived: 100 }), instrument: 'MNQ' },
          { ...derivedAlgo('IFSP', { derived: 100 }), instrument: 'MES' },
        ],
      }]),
      'ACC1',
    );
    expect(attribution.status).toBe('unavailable');
    expect(attribution.derivedDays).toBe(0);
    expect(algos.reduce((n, a) => n + a.contributionPnl, 0)).toBe(0);
  });

  it('accepts a derived split that misses gross by cents, because each row is rounded', () => {
    // The other side of the guard above. deriveStrategyPnl rounds every row to
    // cents, so a two-row split can land a cent off the account's own gross by
    // arithmetic alone, and refusing that would refuse nearly every real day.
    // Two rows, so the display tolerance is 0.03 and this 0.01 is inside it.
    // Tighten the tolerance to 0 and this test fails.
    const { attribution, algos } = buildAlgoAccountHistory(
      derivedClient([{
        date: '2026-08-18',
        pnl: 100,
        strategies: [derivedAlgo('IFSP', { derived: 33.33 }), derivedAlgo('RBO', { derived: 66.66 })],
      }]),
      'ACC1',
    );
    expect(attribution.status).toBe('complete');
    expect(attribution.derivedDays).toBe(1);
    expect(algos.reduce((n, a) => n + a.contributionPnl, 0)).toBeCloseTo(99.99, 6);
  });

  it('refuses a split that overstates the account by five dollars', () => {
    // Five dollars is not rounding on a two-row split — the tolerance there is
    // three cents. This is the size of fabrication that would publish as an
    // exact derived split if the check were widened to a flat few dollars:
    // every row non-null, the derivation saying 'exact', and $5 of the account's
    // money invented between the roster and the screen. Widen the tolerance to
    // `<= 5` and this test fails.
    const { attribution, algos } = buildAlgoAccountHistory(
      derivedClient([{
        date: '2026-08-18',
        pnl: 100,
        strategies: [derivedAlgo('IFSP', { derived: 55 }), derivedAlgo('RBO', { derived: 50 })],
      }]),
      'ACC1',
    );
    expect(attribution.status).toBe('unavailable');
    expect(attribution.derivedDays).toBe(0);
    expect(algos.reduce((n, a) => n + a.contributionPnl, 0)).toBe(0);
  });

  it('checks the derived rows against the raw gross, not against the netted day P&L', () => {
    // The basis this module's header spends five lines justifying, and the one
    // thing that makes it checkable. NinjaTrader's Accounts grid exports both a
    // 'Gross realized PnL' and a commission-netted 'Realized PnL', and csvImport
    // prefers the NETTED one for `grossRealizedPnl` — the day P&L on screen —
    // whenever both are present. They differ on nearly every traded account.
    //
    // The derivation reconciles against GROSS, because that is what the fills
    // reproduce: a FIFO pairing knows nothing about commissions. So the display
    // check has to use the derivation's own `reportedGross` too. Here the fills
    // split 20.00 of gross exactly while the day shows 15.64 net, which is a
    // real day, and it must publish. Swap the basis to `dayPnl` and this test
    // fails — which is the whole point: the safe-failing choice was untestable
    // until a fixture separated the two numbers.
    const { attribution, algos } = buildAlgoAccountHistory(
      derivedClient([{
        date: '2026-08-18',
        pnl: 15.64,
        gross: 20,
        strategies: [derivedAlgo('IFSP', { derived: 12 }), derivedAlgo('RBO', { derived: 8 })],
      }]),
      'ACC1',
    );
    expect(attribution.status).toBe('complete');
    expect(attribution.derivedDays).toBe(1);
    expect(algos.find((a) => a.key.startsWith('IFSP')).contributionPnl).toBe(12);
    // The day's own P&L stays the netted figure. The basis question is about
    // what the derived rows are CHECKED against, never about what is displayed
    // as the account's result.
    expect(attribution.accountTotal).toBe(15.64);
  });

  it('names derived money that belongs to a strategy the roster never listed', () => {
    // The reproduced deletion, seen from the display end: the account made 100,
    // the fills credited all of it to RBO, and RBO is on no row of this
    // account's Strategies grid. The money must not disappear behind a roster
    // that adds up to nothing.
    const { attribution } = buildAlgoAccountHistory(
      derivedClient([{
        date: '2026-08-18',
        pnl: 100,
        derivation: {
          join: {
            status: 'off-roster',
            published: false,
            offRoster: [{ strategyName: 'RBO-1.8', realized: 100 }],
            offRosterRealized: 100,
          },
        },
        strategies: [derivedAlgo('IFSP', { derived: null })],
      }]),
      'ACC1',
    );
    expect(attribution.status).toBe('unavailable');
    expect(attribution.offRosterPnl).toBe(100);
    expect(attribution.offRosterNames).toEqual(['RBO-1.8']);
    // Stated once. The 100 is already the day's unattributed total, so counting
    // it again as a residual would read as 200.
    expect(attribution.unattributedPnl).toBe(100);
    expect(attribution.residualPnl).toBe(0);
  });

  it('surfaces money the fills paired but could not credit to any one algo', () => {
    const { attribution } = buildAlgoAccountHistory(
      derivedClient([{
        date: '2026-08-18',
        pnl: 110,
        derivation: { status: 'partial', residual: { realized: -72, pairs: 1, reasons: { 'manual-leg': 1 } } },
        strategies: [derivedAlgo('IFSP', { reported: 110 })],
      }]),
      'ACC1',
    );
    expect(attribution.residualPnl).toBe(-72);
    // The day still counts as reported — the grid reconciled — but the residual
    // travels with it so the UI can say the split is not the whole story.
    expect(attribution.reportedDays).toBe(1);
  });

  it('treats an absent reported value as absent, not as a reported zero', () => {
    // Cause 2 of the original Bullet Bot mystery: one client's Strategies grid
    // had no Realized column, parseCurrency read it as a confident 0, and the
    // cross-check scored that absence as a disagreement.
    const { attribution } = buildAlgoAccountHistory(
      derivedClient([{
        date: '2026-08-18',
        pnl: 0,
        derivation: { status: 'no-trades', residual: { realized: 0, pairs: 0, reasons: {} } },
        strategies: [derivedAlgo('IFSP', { reported: null })],
      }]),
      'ACC1',
    );
    expect(attribution.status).toBe('unavailable');
    expect(attribution.reportedDays).toBe(0);
  });
});

describe('closes stored before derivation existed', () => {
  it('behaves exactly as it did, with no derived figures invented for them', () => {
    // Every stored snapshot in the book predates `derivation`. Absent must be a
    // no-op, not a trigger.
    const { algos, attribution } = buildAlgoAccountHistory(
      client([{ date: '2026-07-13', pnl: 220, strategies: [algo('IFSP', -80), algo('RBO', 300)] }]),
      'ACC1',
    );
    expect(attribution.status).toBe('complete');
    expect(attribution.derivedDays).toBe(0);
    expect(attribution.reportedDays).toBe(1);
    expect(algos.find((a) => a.key.startsWith('RBO')).contributionPnl).toBe(300);
  });
});
