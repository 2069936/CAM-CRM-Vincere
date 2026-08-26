// The join between what the fills derived and what the Strategies grid lists.
//
// The derivation itself is checked in deriveStrategyPnl.test.js. Everything here
// is about the seam: the derivation can be arithmetically perfect and the screen
// still wrong, because the two lists being joined are not the same list. Both
// failures below were reproduced end-to-end through reconcileDailyImport before
// this module existed (see the end of reconcile.test.js for the end-to-end
// versions), and both came from one line that joined by name in one direction
// and defaulted the miss to zero.

import { describe, expect, it } from 'vitest';
import { JOIN_STATUS, ROW_JOIN, joinDerivedStrategies } from './joinDerivedStrategies.js';

const roster = (...names) => names.map((strategyName) => ({ strategyName, enabled: true }));

const derivationOf = (byStrategy, reportedGross, overrides = {}) => ({
  status: 'exact',
  byStrategy,
  reportedGross,
  residual: { realized: 0, pairs: 0, reasons: {} },
  ...overrides,
});

describe('a clean one-to-one join', () => {
  it('carries each derived figure onto its own roster row', () => {
    const { strategies, join } = joinDerivedStrategies({
      strategies: roster('IFSP-1.1', 'RBO-1.8'),
      derivation: derivationOf([
        { strategyName: 'IFSP-1.1', realized: 80, pairs: 2 },
        { strategyName: 'RBO-1.8', realized: 30, pairs: 1 },
      ], 110),
    });
    expect(strategies.map((s) => s.derivedRealized)).toEqual([80, 30]);
    expect(strategies.every((s) => s.derivedRealizedJoin === ROW_JOIN.MATCHED)).toBe(true);
    expect(join.status).toBe(JOIN_STATUS.EXACT);
    expect(join.published).toBe(true);
    expect(join.difference).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // The rounding slack, and what it is allowed to wave through.
  //
  // These three replace one test that claimed to exercise the slack and did not:
  // it summed 33.33 + 33.33 + 33.34 against a gross of 100, which is 100.00 to
  // the cent, so the difference it fed the comparison was exactly 0 and every
  // value of `slack` — including 0, including 5 — passed it. A test whose name
  // describes a tolerance has to miss by something.
  // ---------------------------------------------------------------------------

  it('accepts a sum that misses gross by cents, because each row is rounded to cents', () => {
    // 99.99 against 100.00. Three placed rows, so the slack is 0.04 and this is
    // inside it. Set `slack = 0` and this test fails.
    const { join } = joinDerivedStrategies({
      strategies: roster('A', 'B', 'C'),
      derivation: derivationOf([
        { strategyName: 'A', realized: 33.33 },
        { strategyName: 'B', realized: 33.33 },
        { strategyName: 'C', realized: 33.33 },
      ], 100),
    });
    expect(join.difference).toBe(-0.01);
    expect(join.published).toBe(true);
    expect(join.status).toBe(JOIN_STATUS.EXACT);
  });

  it('refuses a sum that misses gross by a dollar, however few rows there are', () => {
    // 99.00 against 100.00. A dollar is not rounding — it is a dropped row, a
    // duplicated one, or a figure that does not belong to this account. Widen
    // `slack` to anything at or above 1 and this test fails.
    const { strategies, join } = joinDerivedStrategies({
      strategies: roster('A', 'B', 'C'),
      derivation: derivationOf([
        { strategyName: 'A', realized: 33.00 },
        { strategyName: 'B', realized: 33.00 },
        { strategyName: 'C', realized: 33.00 },
      ], 100),
    });
    expect(join.difference).toBe(-1);
    expect(join.balanced).toBe(false);
    expect(join.published).toBe(false);
    expect(join.status).toBe(JOIN_STATUS.UNBALANCED);
    // And nothing reaches a row. A refusal that still published the figures
    // would be a comment, not a guard.
    expect(strategies.every((s) => s.derivedRealized === null)).toBe(true);
    expect(strategies.every((s) => s.derivedRealizedJoin === ROW_JOIN.REFUSED)).toBe(true);
  });

  it('scales the slack with the number of placed rows, not with a flat constant', () => {
    // The claim in the comment is "one cent of slack per placed row", and that
    // is a different rule from any fixed tolerance. The same 8-cent miss has to
    // land on opposite sides of it depending on how many rows were rounded:
    // ten rows allow 0.11, one row allows 0.02. Replace the expression with any
    // constant and one of these two halves fails.
    const tenRows = Array.from({ length: 10 }, (unused, i) => `S${i}`);
    const wide = joinDerivedStrategies({
      strategies: roster(...tenRows),
      derivation: derivationOf(
        tenRows.map((strategyName) => ({ strategyName, realized: 9.992 })),
        100,
      ),
    });
    expect(wide.join.difference).toBe(-0.08);
    expect(wide.join.published).toBe(true);

    const narrow = joinDerivedStrategies({
      strategies: roster('A'),
      derivation: derivationOf([{ strategyName: 'A', realized: 99.92 }], 100),
    });
    expect(narrow.join.difference).toBe(-0.08);
    expect(narrow.join.published).toBe(false);
    expect(narrow.join.status).toBe(JOIN_STATUS.UNBALANCED);
  });
});

describe('a roster row the fills never named', () => {
  it('is left absent, never given a derived zero', () => {
    // The fabrication. `?? 0` on the miss put a zero on this row wearing the
    // "derived from fills" label, which is a measurement nobody made. Restore
    // any zero default here and this test fails.
    const { strategies, join } = joinDerivedStrategies({
      strategies: roster('IFSP-1.1', 'RBO-1.8'),
      derivation: derivationOf([{ strategyName: 'IFSP-1.1', realized: 110, pairs: 3 }], 110),
    });
    expect(strategies[0].derivedRealized).toBe(110);
    expect(strategies[1].derivedRealized).toBeNull();
    expect(strategies[1].derivedRealizedJoin).toBe(ROW_JOIN.NO_DERIVED_ROW);
    // The money that IS placed still adds up, so the join is sound; it is just
    // not a whole-roster split, and it says so rather than implying one.
    expect(join.status).toBe(JOIN_STATUS.INCOMPLETE);
    expect(join.published).toBe(true);
    expect(join.unmatchedRoster).toEqual(['RBO-1.8']);
  });
});

describe('a derived strategy that is on no roster row', () => {
  it('keeps its money visible instead of dropping it', () => {
    // The deletion. The account made 100, all of it derived to RBO-1.8, and the
    // only grid row was IFSP-1.1. The old join gave IFSP a zero and lost the
    // 100 without a word.
    const { strategies, join } = joinDerivedStrategies({
      strategies: roster('IFSP-1.1'),
      derivation: derivationOf([{ strategyName: 'RBO-1.8', realized: 100, pairs: 2 }], 100),
    });
    expect(strategies[0].derivedRealized).toBeNull();
    expect(join.offRoster).toEqual([{ strategyName: 'RBO-1.8', realized: 100 }]);
    expect(join.offRosterRealized).toBe(100);
    expect(join.status).toBe(JOIN_STATUS.OFF_ROSTER);
    // Nothing may be published: the rows that would be shown add up to 0 on an
    // account that made 100.
    expect(join.published).toBe(false);
    expect(join.balanced).toBe(false);
    expect(join.joinedTotal).toBe(0);
  });

  it('still publishes the rest when the off-roster row is worth nothing', () => {
    const { strategies, join } = joinDerivedStrategies({
      strategies: roster('IFSP-1.1'),
      derivation: derivationOf([
        { strategyName: 'IFSP-1.1', realized: 100 },
        { strategyName: 'RBO-1.8', realized: 0 },
      ], 100),
    });
    expect(strategies[0].derivedRealized).toBe(100);
    expect(join.published).toBe(true);
    expect(join.offRosterRealized).toBe(0);
    expect(join.status).toBe(JOIN_STATUS.OFF_ROSTER);
  });
});

describe('one derived row, several roster rows of the same name', () => {
  it('refuses rather than copying the figure onto both', () => {
    // The multiplication: one algo on two instruments in one account is two grid
    // rows and one derived row. Copying gives the account double its own P&L
    // labelled derived; splitting it in half is a guess. Neither is a
    // measurement, so neither is published.
    const { strategies, join } = joinDerivedStrategies({
      strategies: [
        { strategyName: 'Alpha-1.0', instrument: 'MNQ SEP26' },
        { strategyName: 'Alpha-1.0', instrument: 'MES SEP26' },
      ],
      derivation: derivationOf([{ strategyName: 'Alpha-1.0', realized: 100, pairs: 4 }], 100),
    });
    expect(strategies.map((s) => s.derivedRealized)).toEqual([null, null]);
    expect(strategies.every((s) => s.derivedRealizedJoin === ROW_JOIN.AMBIGUOUS_NAME)).toBe(true);
    expect(join.status).toBe(JOIN_STATUS.AMBIGUOUS);
    expect(join.ambiguousNames).toEqual(['Alpha-1.0']);
    expect(join.published).toBe(false);
  });
});

describe('an ambiguous name worth nothing', () => {
  it('is still refused, because the arithmetic check cannot see it', () => {
    // The ambiguity clause of `published` is only load-bearing when the ambiguous
    // rows carry no money: with money, the sum check catches the multiplication
    // on its own. Here Alpha derives 0 across two same-named roster rows and Beta
    // carries the whole 100, so the placed figures balance whether or not the
    // ambiguity is refused — the sum check is blind and only the name check is
    // left. Publishing here would put a measured-looking 0 on two rows nobody
    // measured, which is the same fabrication as the rest of this file, just
    // worth nothing today.
    const { strategies, join } = joinDerivedStrategies({
      strategies: [
        { strategyName: 'Alpha-1.0', instrument: 'MNQ SEP26' },
        { strategyName: 'Alpha-1.0', instrument: 'MES SEP26' },
        { strategyName: 'Beta-2.0', instrument: 'NQ SEP26' },
      ],
      derivation: derivationOf([
        { strategyName: 'Alpha-1.0', realized: 0, pairs: 1 },
        { strategyName: 'Beta-2.0', realized: 100, pairs: 2 },
      ], 100),
    });
    expect(join.ambiguousNames).toEqual(['Alpha-1.0']);
    expect(join.published).toBe(false);
    expect(strategies.filter((r) => r.strategyName === 'Alpha-1.0').map((r) => r.derivedRealized)).toEqual([null, null]);
  });
});

describe('the arithmetic check on the join itself', () => {
  it('publishes nothing when the placed rows do not add up to the gross', () => {
    // A derivation that calls itself exact while its own rows miss the gross it
    // claims to reconcile with. Nothing upstream should be able to produce this,
    // which is exactly why the check is here: the join is the last place the
    // numbers can be checked before they are displayed as measurements.
    const { strategies, join } = joinDerivedStrategies({
      strategies: roster('IFSP-1.1'),
      derivation: derivationOf([{ strategyName: 'IFSP-1.1', realized: 60 }], 100),
    });
    expect(strategies[0].derivedRealized).toBeNull();
    expect(strategies[0].derivedRealizedJoin).toBe(ROW_JOIN.REFUSED);
    expect(join.status).toBe(JOIN_STATUS.UNBALANCED);
    expect(join.difference).toBe(-40);
    expect(join.published).toBe(false);
  });

  it('publishes nothing when there is no gross to check against', () => {
    const { strategies, join } = joinDerivedStrategies({
      strategies: roster('IFSP-1.1'),
      derivation: derivationOf([{ strategyName: 'IFSP-1.1', realized: 60 }], null),
    });
    expect(strategies[0].derivedRealized).toBeNull();
    expect(join.balanced).toBe(false);
    expect(join.published).toBe(false);
  });
});

describe('a derivation that is not exact, or is not there at all', () => {
  it('joins nothing from a partial derivation and says which status refused it', () => {
    const derivation = derivationOf([{ strategyName: 'IFSP-1.1', realized: 100 }], 100, { status: 'partial' });
    const { strategies, join } = joinDerivedStrategies({ strategies: roster('IFSP-1.1'), derivation });
    expect(strategies[0].derivedRealized).toBeNull();
    expect(strategies[0].derivedRealizedJoin).toBe(ROW_JOIN.UNAVAILABLE);
    expect(join.status).toBe(JOIN_STATUS.UNAVAILABLE);
    // The verdict that refused it is the ACCOUNT-DAY's, and it is not copied
    // onto the row. It is `derivation.status`, which travels on the snapshot
    // beside these rows and is stored once; a per-row copy measured 35.4 B on
    // every strategy row of the real export to repeat what the caller was
    // already holding. The row's own field is the join reason above.
    expect(strategies[0].derivedRealizedStatus).toBeUndefined();
    expect(derivation.status).toBe('partial');
  });

  it.each([
    ['refused', 'a book that could not be priced at all'],
    ['no-reported-gross', 'no Gross realized PnL column to check the total against'],
  ])('publishes nothing from a %s derivation (%s)', (status) => {
    // Both statuses carry a byStrategy list that looks perfectly usable: the
    // books that COULD be priced produced real rows. That is exactly why the
    // refusal has to be enforced here as well as recorded there — a refused
    // account's remaining rows are plausible, and plausible is the failure mode.
    const derivation = derivationOf([{ strategyName: 'IFSP-1.1', realized: 100 }], 100, { status });
    const { strategies, join } = joinDerivedStrategies({ strategies: roster('IFSP-1.1'), derivation });
    expect(strategies[0].derivedRealized).toBeNull();
    expect(strategies[0].derivedRealizedJoin).toBe(ROW_JOIN.UNAVAILABLE);
    expect(join.status).toBe(JOIN_STATUS.UNAVAILABLE);
    expect(join.published).toBe(false);
  });

  it('leaves an account with no derivation exactly as it found it', () => {
    const { strategies, join } = joinDerivedStrategies({ strategies: roster('IFSP-1.1'), derivation: null });
    expect(strategies[0].derivedRealized).toBeNull();
    // No derivation and a 'no-trades' derivation reach this row identically, and
    // that is deliberate: reconcile stores neither, and every reader treats them
    // the same. The row says 'unavailable' either way.
    expect(strategies[0].derivedRealizedJoin).toBe(ROW_JOIN.UNAVAILABLE);
    expect(strategies[0].derivedRealizedStatus).toBeUndefined();
    expect(join.status).toBe(JOIN_STATUS.UNAVAILABLE);
    expect(join.offRosterRealized).toBe(0);
  });

  it('reports off-roster money for an account with a derivation and no roster at all', () => {
    const { strategies, join } = joinDerivedStrategies({
      strategies: [],
      derivation: derivationOf([{ strategyName: 'RBO-1.8', realized: 100 }], 100),
    });
    expect(strategies).toEqual([]);
    expect(join.offRosterRealized).toBe(100);
    expect(join.published).toBe(false);
  });
});
