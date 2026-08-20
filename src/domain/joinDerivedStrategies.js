// Joining derived per-strategy P&L onto the Strategies-grid roster.
//
// deriveStrategyPnl answers "what did each strategy make" from the fills. That
// answer is keyed by strategy NAME. The Strategies grid is a separate list of
// rows, also keyed by name, and the two lists are not the same list: a name can
// appear on the grid and nowhere in the fills, in the fills and nowhere on the
// grid, or twice on the grid for one derivation row (same algo, two instruments,
// one account). Joining them by name in one direction with no arithmetic check
// is how a correct derivation still produces a wrong screen.
//
// Two failures were reproduced end-to-end through reconcileDailyImport before
// this module existed, both from `derivation.byStrategy.find(...)?.realized ?? 0`:
//
//   FABRICATION AND DELETION. An account made +$100, all of it derived to
//   RBO-1.8, which had no grid row. The one grid row it did have (IFSP 1.1) was
//   never derived, so the `?? 0` gave it a zero wearing the "derived from fills"
//   label. The panel then said "all 1 days carry a per-algo split", printed
//   "IFSP 1.1 $0 over 1d", and printed no residual. The $100 left the account
//   silently and the split was presented as complete.
//
//   MULTIPLICATION. One derived row landed on two same-named grid rows (one algo
//   on two instruments in one account). Each row took the full figure, so the
//   panel showed double the account's actual P&L, labelled derived, residual 0.
//
// THE RULES HERE, each one a refusal rather than a guess:
//
//   1. A grid row with no derived counterpart gets NULL, never 0. Absent is not
//      a measurement of zero, and this feature exists precisely because a
//      fabricated per-algo number is worse than a missing one.
//   2. A derived strategy with no grid row is never dropped. Its dollars are
//      reported as `offRoster` / `offRosterRealized` so a caller can name them.
//   3. A derived row that matches more than one grid row is refused outright.
//      Splitting it would be a guess and copying it multiplies money.
//   4. After the join, the figures that were actually placed on rows must add up
//      to the gross the derivation reconciled against. If they do not — which is
//      what an off-roster row or an ambiguous name causes — nothing is published
//      at all, whatever the derivation said about itself in isolation.
//
// Nothing here re-derives anything. It only decides which derived figures may be
// carried onto which roster rows, and says why when the answer is none.
//
// WHAT THE 2026-08-20 BOOK SETTLED ABOUT THIS MODULE
//
// The rules above were written from two reproduced failures. A redacted export
// covering 29 trading dates — 14,958 fills, 2,832 traded account-days, 1,176
// places where the Strategies grid reports a non-zero `Realized` — is the first
// evidence about how often they fire and what they are worth.
//
// THE HEADLINE IS THAT NOTHING PUBLISHED IS WRONG. Replaying the shipped
// derivation over that book with its leg lookup sound, 1,049 of 1,053 derived
// per-strategy figures match the grid to the cent, and every one of the four
// that do not sits on an account `deriveStrategyPnl` refuses to certify — so
// status gating alone keeps all four off the screen and $0.00 of wrong per-algo
// money reaches a CAM. The four are visible gaps, not published numbers, which
// is the outcome rule 1 above exists to produce.
//
// AND THE ONE NUMBER THAT LOOKED LIKE THE OPPOSITE WAS THE EVIDENCE, NOT THE
// CODE. Three investigations of that book reported 54 published-wrong rows worth
// $22,899.25 on accounts certified 'exact'. All three resolved each leg's
// Strategy through `external_order_id`, which that export's redactor had
// collapsed from 30,955 distinct values to four. Rebuilt from the fill's own
// Strategy cell, the same 54 rows go to $0.00 with nothing in either module
// changed. Read rule 0 in deriveStrategyPnl.js before replaying anything through
// a redacted book, and never tune a join rule against a number produced that
// way.
//
// WHAT IT DID NOT SETTLE. Only 613 of 2,832 account-days come back publishable
// on that book at all, and that count is proxy-conditioned:
// `account_snapshots.gross_realized_pnl` stores the NET figure, so the
// arithmetic gate in rule 4 is being checked against a column it was not written
// for. The per-strategy agreement counts above are against
// strategy_snapshots.realized directly and are not affected; the publishable
// COUNT is. Do not quote it as a coverage figure.

import { DEFAULT_TOLERANCE } from './deriveStrategyPnl.js';

export const JOIN_STATUS = {
  // Every grid row matched exactly one derived row, every derived row matched a
  // grid row, and the placed figures add up to gross.
  EXACT: 'exact',
  // Balanced and unambiguous, but some grid rows carry no derived figure. Those
  // rows stay null: the fills never named them and nobody measured a zero.
  INCOMPLETE: 'incomplete',
  // One derived row, several grid rows of the same name. Refused.
  AMBIGUOUS: 'ambiguous',
  // A derived strategy that is on no grid row. Its money is reported separately.
  OFF_ROSTER: 'off-roster',
  // The placed figures do not add up to the gross the derivation used.
  UNBALANCED: 'unbalanced',
  // The derivation itself did not come out exact, so there is nothing to join.
  UNAVAILABLE: 'unavailable',
};

// Why one particular row carries no derived figure. Computed per row because
// the answer differs inside a single account, and "no number" with no reason is
// the shape that let a fabricated zero pass for a measurement.
//
// IT IS NOT A STORED COLUMN, and step 37 does not create one. Every value below
// is recoverable from what IS stored — `strategy_snapshots.derived_realized` and
// the account-day `account_snapshots.derivation` — so a per-row copy would be
// the account-day verdict written out once per roster row:
//
//   matched         derived_realized IS NOT NULL
//   no-derived-row  derivation.join.published AND derived_realized IS NULL
//   ambiguous-name  strategy_name IN derivation.join.ambiguousNames
//   refused         derivation.status = 'exact' AND NOT derivation.join.published,
//                   and the name is not one of the ambiguous ones
//   unavailable     derivation IS NULL OR derivation.status <> 'exact'
//
// `ambiguousNames` is the one of those the account-day blob could not answer on
// its own, so reconcile.storableDerivation now keeps it — one small array per
// ambiguous account-day, and nothing at all on a day that had none. See the
// measurement in that function's comment.
export const ROW_JOIN = {
  MATCHED: 'matched',
  NO_DERIVED_ROW: 'no-derived-row',
  AMBIGUOUS_NAME: 'ambiguous-name',
  REFUSED: 'refused',
  UNAVAILABLE: 'unavailable',
};

const name = (value) => String(value ?? '').trim();
const round2 = (value) => Math.round(Number(value) * 100) / 100;

/**
 * Carry an account's derived per-strategy figures onto that account's grid rows.
 *
 * @param {object[]} strategies ONE account's Strategies-grid rows.
 * @param {object|null} derivation that same account's deriveStrategyPnl result.
 * @param {number} tolerance per-row rounding slack for the sum check.
 * @returns {{strategies: object[], join: object}} the rows with
 *   `derivedRealized` and `derivedRealizedJoin` set, and the join report —
 *   including any derived money that reached no row. Only `derivedRealized` is
 *   persisted; see ROW_JOIN above for why the reason is not.
 */
export function joinDerivedStrategies({ strategies = [], derivation = null, tolerance = DEFAULT_TOLERANCE } = {}) {
  const roster = Array.isArray(strategies) ? strategies : [];
  // Only an 'exact' derivation is joinable. 'partial' and 'unreconciled' have
  // already failed their own arithmetic; joining them would dress a known-
  // incomplete split as a whole one.
  const hasDerivation = derivation?.status === 'exact' && Array.isArray(derivation.byStrategy);
  const derivedRows = hasDerivation ? derivation.byStrategy : [];

  const rosterCountByName = new Map();
  for (const strategy of roster) {
    const key = name(strategy?.strategyName);
    rosterCountByName.set(key, (rosterCountByName.get(key) || 0) + 1);
  }

  const matchedByName = new Map();
  const ambiguousNames = [];
  const offRoster = [];
  let joinedTotal = 0;
  let offRosterRealized = 0;

  for (const row of derivedRows) {
    const key = name(row?.strategyName);
    const count = rosterCountByName.get(key) || 0;
    const realized = Number(row?.realized) || 0;
    if (count > 1) {
      ambiguousNames.push(key);
    } else if (count === 1) {
      matchedByName.set(key, realized);
      joinedTotal += realized;
    } else {
      offRoster.push({ strategyName: key, realized });
      offRosterRealized += realized;
    }
  }

  const unmatchedRoster = [...rosterCountByName.keys()]
    .filter((key) => !matchedByName.has(key) && !ambiguousNames.includes(key));

  const reportedGross = derivation && derivation.reportedGross != null ? Number(derivation.reportedGross) : null;
  joinedTotal = round2(joinedTotal);
  offRosterRealized = round2(offRosterRealized);
  // One cent of slack per placed row: deriveStrategyPnl rounds each strategy to
  // cents, so a sum of them can miss the account total by rounding alone. Any
  // real join failure is dollars, not cents — a dropped row, a duplicated one.
  const slack = Math.max(Number(tolerance) || 0, 0.01 * (matchedByName.size + 1));
  const balanced = hasDerivation && reportedGross != null
    && Math.abs(joinedTotal - reportedGross) <= slack;

  const published = hasDerivation && balanced && ambiguousNames.length === 0;

  const status = !hasDerivation
    ? JOIN_STATUS.UNAVAILABLE
    : ambiguousNames.length
      ? JOIN_STATUS.AMBIGUOUS
      : !balanced
        ? (offRoster.length ? JOIN_STATUS.OFF_ROSTER : JOIN_STATUS.UNBALANCED)
        : offRoster.length
          ? JOIN_STATUS.OFF_ROSTER
          : unmatchedRoster.length
            ? JOIN_STATUS.INCOMPLETE
            : JOIN_STATUS.EXACT;

  const joined = roster.map((strategy) => {
    const key = name(strategy?.strategyName);
    let rowJoin = ROW_JOIN.UNAVAILABLE;
    if (hasDerivation) {
      if (ambiguousNames.includes(key)) rowJoin = ROW_JOIN.AMBIGUOUS_NAME;
      else if (!published) rowJoin = ROW_JOIN.REFUSED;
      else if (matchedByName.has(key)) rowJoin = ROW_JOIN.MATCHED;
      else rowJoin = ROW_JOIN.NO_DERIVED_ROW;
    }
    return {
      ...strategy,
      // A number ONLY on a row that matched exactly one derived row inside a
      // join that balanced. Every other case is null — including the row the
      // fills never named, which is absent, not zero.
      derivedRealized: rowJoin === ROW_JOIN.MATCHED ? matchedByName.get(key) : null,
      // Computed and carried on the in-memory row so the caller can say why a
      // row is null without re-deriving it. Never written to a column: the
      // account-day's own verdict lives once in `derivation`, not once per
      // roster row. There is deliberately no `derivedRealizedStatus` here for
      // exactly that reason — it was `derivation.status` copied onto every row
      // of the same account, and `derivation` travels on the same snapshot.
      derivedRealizedJoin: rowJoin,
    };
  });

  return {
    strategies: joined,
    join: {
      status,
      published,
      rosterRows: roster.length,
      derivedRows: derivedRows.length,
      matchedRows: published ? matchedByName.size : 0,
      ambiguousNames: [...new Set(ambiguousNames)].sort(),
      // Grid rows the fills never named. They are not claimed to be zero.
      unmatchedRoster: unmatchedRoster.sort(),
      // Derived strategies that are on no grid row, and what they were worth.
      // This is the money the old one-directional join deleted in silence.
      offRoster: offRoster.sort((a, b) => a.strategyName.localeCompare(b.strategyName)),
      offRosterRealized,
      joinedTotal,
      reportedGross,
      difference: reportedGross == null ? null : round2(joinedTotal - reportedGross),
      balanced,
    },
  };
}
