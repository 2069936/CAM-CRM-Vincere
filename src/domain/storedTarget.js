// Whether a stored `trading_accounts.target_profit` can be read as what it is
// supposed to be: the absolute BALANCE that passes the account
// (accountTargets.js carries the argument for that unit).
//
// WHY A GATE AND NOT JUST A UNIT. Fixing the writers stops new amounts from
// landing in the column. It does nothing for a value already stored in the
// wrong unit, and every reader answers `balance >= target`, so a 3,000 stored on
// a 50k evaluation reads as passed on the day it opens. Measured in production,
// read only, on 2026-10-06: of the 726 trading_accounts with a positive target,
// 8 hold a value under 10,000.
//
//   * 1 Evaluation (Bullet Bot), target 3,000 on a stored start of 50,000. An
//     amount beyond doubt. Step 61 converts it to 53,000.
//   * 1 Funded, target 8,000 on a stored start of 6,000. Above its start, so it
//     reads as a balance and is left alone.
//   * 6 Funded, target 4,000 with NO stored start. Nothing says whether 4,000 is
//     a balance on a small account or an amount on a 50k one, so step 61 leaves
//     them and this gate refuses them.
//
// THE RULE. A stored target is used only when it sits ABOVE a start the book
// actually knows: the stored start balance, or, with none stored, the size the
// target itself sits on. That size comes from propFirmRules.inferAccountSize,
// the same snap the plan picker uses to size an account, over the full ladder
// firms sell (5k to 300k, within 15%): 26,500 sits on a 25k, 80,000 on a 75k,
// 54,100 on a 50k. A value that sits on no size and has no start beside it is
// unreadable, and a value at or below its start would be "reached" by an
// account that has made nothing. Either way the reader is told NO TARGET, the
// same answer it gives an account where nobody typed one, and the screen says
// "Target not set" instead of 100%.
//
// Why 15% and not wider: the widest published target is 8% over its size
// (GENERIC_TARGET_BALANCE, 54,000 on 50k), so 15% keeps every real balance. A
// profit AMOUNT stored with no start must still be refused, and 6,000 (the 100k
// amount every firm here publishes) is exactly 20% over a 5k account. 4,000 and
// 3,000 sit on no size at all. targetProfitUnit.test.jsx refuses every
// published amount.
//
// The start here is only the yardstick for that question. It is deliberately
// NOT the start a reader measures progress from: each reader keeps its own (a
// stored start, the earliest close, an inferred size) and nothing about that
// changes.
//
// One import, on purpose a leaf: reconcile.js reads this, accountTargets.js
// imports reconcile.js, and the Node ESM server entrypoints load several of them
// with no bundler to resolve a cycle. propFirmRules.js imports nothing.

import { inferAccountSize } from './propFirmRules.js';

// The 50k/100k/150k snap below is for a LIVE balance (accountTargets and the
// report readers infer an account's start from it). It is not the yardstick
// for a stored target, which uses the full ladder above.
export const STANDARD_ACCOUNT_SIZES = [50000, 100000, 150000];

// How far a live balance can drift from its starting size and still be inferred.
const INFER_BAND = 0.2;

// Snap a current balance to the standard starting size within INFER_BAND, or
// null when it is not close enough to any (e.g. a cash account, or a balance in
// the gap between sizes).
export function inferStartingBalance(currentBalance) {
  const balance = Number(currentBalance);
  if (!Number.isFinite(balance) || balance <= 0) return null;
  for (const size of STANDARD_ACCOUNT_SIZES) {
    if (Math.abs(balance - size) <= size * INFER_BAND) return size;
  }
  return null;
}

/** Why a stored target is or is not used. */
export const STORED_TARGET = {
  /** Above a known start: the reader uses it. */
  USABLE: 'usable',
  /** Nothing stored. */
  NONE: 'none',
  /** At or below the start it is judged against. */
  NOT_ABOVE_START: 'not-above-start',
  /** No stored start, and the value sits on no standard size. */
  NO_START: 'no-start',
};

const positive = (value) => {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * The verdict on one account's stored target.
 *
 * @param {object} meta a registry entry (`targetProfit`, `startBalance`)
 * @returns {{ target: number|null, stored: number|null, judgedAgainst: number|null, state: string }}
 *   `target` is the balance a reader may use, null when it may not.
 */
export function storedTargetStatus(meta) {
  const stored = positive(meta?.targetProfit);
  if (stored == null) {
    return { target: null, stored: null, judgedAgainst: null, state: STORED_TARGET.NONE };
  }
  const judgedAgainst = positive(meta?.startBalance) ?? inferAccountSize(stored);
  if (judgedAgainst == null) {
    return { target: null, stored, judgedAgainst: null, state: STORED_TARGET.NO_START };
  }
  if (stored <= judgedAgainst) {
    return { target: null, stored, judgedAgainst, state: STORED_TARGET.NOT_ABOVE_START };
  }
  return { target: stored, stored, judgedAgainst, state: STORED_TARGET.USABLE };
}

/** The stored target balance when a reader may use it, null otherwise. */
export function usableStoredTarget(meta) {
  return storedTargetStatus(meta).target;
}
