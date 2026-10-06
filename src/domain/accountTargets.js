// Infer an account's starting balance from its current balance, and assign the
// standard profit target for its size and type.
//
// Prop accounts start at one of a few standard sizes (50k / 100k / 150k) and a
// live balance stays within roughly 20% of that size, so the starting size can
// be inferred from the current balance. Cash (live) accounts have no standard
// size and no target — only their cash balance matters.
//
// ───────────────────────────────────────────────────────────────────────────────
// THE UNIT OF `trading_accounts.target_profit`: AN ABSOLUTE BALANCE.
//
// A 50k account that passes at 54,100 stores 54100, not 4100. Despite the
// column's name, it is the balance that passes, not the profit that gets there.
// This module is where that is written down because this module owns the table
// the number comes from.
//
// The column used to mean both. `resolveAccountLimits()` returned a field also
// called `targetProfit` holding `rule.profitTarget` — a profit AMOUNT, 3,000 on
// a 50k — and AccountManager wrote that onto the account when a CAM picked a
// plan, while App.jsx wrote `targetForAccount()`, a balance, when a CAM
// classified one. Nine of the eleven readers compare the field to a balance.
// Measured on the book: of 101 evaluation rows with nothing stored, 94 resolve
// to a figure under 10,000 and all 94 balances already exceed it, so the
// amount-unit reading declares 94 of 296 evaluations (31.8%) finished against
// the 21 that have actually reached target.
//
// BALANCE won on four counts, in descending order of how hard they are to argue
// with:
//
//   1. It is what is already stored. 195 of 195 evaluation rows carrying a
//      target store a balance (the smallest is 52,999); across the 685
//      accounts the CRM loads (from 764 trading_accounts rows), 312 carry a
//      stored value and 302 of the 311 with a start to compare against sit at
//      or above it.
//      Those counts are public/local-snapshot.json, whose last close is
//      2026-07-30: the day BEFORE the plan picker started writing the amount
//      (2c9a698, 2026-07-31). So the fixture cannot show whether the amount
//      writer landed a row. Production was counted instead, read only, on
//      2026-10-06: 8 of 726 positive targets sit under 10,000. One is an amount
//      beyond doubt and step 61 converts it; the other seven cannot be told
//      apart and storedTarget.js makes every reader refuse them. That file
//      names all eight.
//   2. It is what the CAM is asked to type. The Target $ input in
//      AccountManager.jsx carries `placeholder="e.g. 52000"`.
//   3. It is what the readers want. `balance >= target` and `(balance - start) /
//      (target - start)` both need a balance; only two readers divide a weekly
//      PnL by the field, and those want the remaining profit. Both get it from
//      App.jsx's `profitNeededForAccount()`, which calls `profitNeededFor()`
//      with the stored start or the size inferred from the current balance.
//      `resolveAccountLimits().targetProfitAmount` is the same function over
//      the resolver's own start (stored, then earliest close, then size), and
//      neither column reads it. `profitNeededFor()` lives in propFirmRules.js
//      rather than here because this module imports reconcile.js and
//      propFirmRules.js is loaded directly by the Node ESM server entrypoints.
//   4. A balance needs no second number to be meaningful. An amount is only
//      interpretable beside a start balance, and start balance is blank on 78 of
//      the 233 rows the report draws — so storing the amount would make the
//      target unreadable on exactly the rows that already lack a start.
//
// The counter-argument, from GENERIC_TARGET_BALANCE in propFirmRules.js, is that
// "writing the profit down instead invites someone to read 4,000 as a balance".
// That is right, and it is the hazard that actually fired: the table is stated in
// balances and `genericProfitTarget()` converted it down into a field named
// `targetProfit` that everybody else read as a balance. Keeping the stored unit
// and the table's unit the same is what removes the invitation.
// ───────────────────────────────────────────────────────────────────────────────

/* `.js` on the specifier, not a style choice: report.js now reaches this module
 * (through evaluationReport.js), report.js is reached by the Vercel ingest route,
 * and native Node ESM will not resolve an extensionless relative import. Vite
 * resolved it happily, so the first thing that noticed was
 * server/tests/api/entrypointsLoadUnderNode.test.js. */
import { ACCOUNT_TYPES, isCashType, isSimulationAccountType } from './reconcile.js';

/* The size inference moved to storedTarget.js, which has no imports, so that
 * reconcile.js can judge a stored target without importing this module (which
 * imports reconcile.js). Re-exported so every existing caller is unchanged. */
import { STANDARD_ACCOUNT_SIZES, inferStartingBalance } from './storedTarget.js';

export { STANDARD_ACCOUNT_SIZES, inferStartingBalance };

// Absolute target balance per starting size. Standard = Funded + normal
// Evaluation; Bullet Bot evaluations pass at a lower target. Only sizes with a
// known rule are listed; anything else returns null (set it manually).
const TARGET_TABLE = {
  standard: { 50000: 54100, 100000: 107300, 150000: 159000 },
  bulletBot: { 50000: 53000 },
};

// The absolute target balance for an account of this type and starting size.
// Cash accounts have no target. Sizes/types without a known rule return null.
export function targetForAccount(accountType, startingBalance) {
  if (isCashType(accountType)) return null;
  // A simulation account has no evaluation to pass and no payout to reach.
  // Without this it would fall to the 'standard' table and — because 10 of the
  // 11 real Sim101s sit at exactly NinjaTrader's stock $100,000 — silently
  // acquire the real 100k evaluation target of $107,300, then queue a
  // "target reached" flag against play money.
  if (isSimulationAccountType(accountType)) return null;
  const table = accountType === ACCOUNT_TYPES.EVALUATION_BULLET ? 'bulletBot' : 'standard';
  return TARGET_TABLE[table][Number(startingBalance)] ?? null;
}

// Suggested defaults to pre-fill when an account first appears in an import.
// Cash accounts get neither (balance is all that matters). Returns only the
// fields we can infer; a null field means "leave for the user to set".
export function suggestAccountDefaults(accountType, currentBalance) {
  if (isCashType(accountType) || isSimulationAccountType(accountType)) {
    return { startingBalance: null, target: null };
  }
  const startingBalance = inferStartingBalance(currentBalance);
  const target = startingBalance != null ? targetForAccount(accountType, startingBalance) : null;
  return { startingBalance, target };
}

/**
 * The fields a classification pre-fills on an account, and only the empty ones.
 *
 * Out of App.jsx's onUpdateAccount handler so the write is testable as the code
 * that runs rather than as a copy of it: this is one of the two writers of
 * `target_profit`, and it writes the absolute BALANCE that passes (the unit this
 * file's header argues for). Never overwrites a value the desk already set.
 *
 * @param {string} accountType the type being assigned
 * @param {object} meta the account's current registry entry
 * @param {number} currentBalance the latest close, for the size
 * @returns {object} the fields to merge into the patch, possibly empty
 */
export function classificationDefaults(accountType, meta = {}, currentBalance = 0) {
  const defaults = suggestAccountDefaults(accountType, currentBalance);
  const isEmpty = (value) => value == null || value === '';
  const augment = {};
  if (defaults.startingBalance != null && isEmpty(meta?.startBalance)) {
    augment.startBalance = defaults.startingBalance;
  }
  if (defaults.target != null && isEmpty(meta?.targetProfit)) {
    augment.targetProfit = defaults.target;
  }
  return augment;
}
