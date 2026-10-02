// The evaluations block of a client report: its own accounts, its own subtotal,
// and progress toward the one outcome an evaluation has.
//
// WHY IT EXISTS. A CAM on Pedro's desk tried to put the evaluation accounts on a
// client's report and could not. Before this, evaluations appeared in exactly one
// place on the sheet — as one more group inside the per-account table, behind
// `cfg.showAccountTable` — so they could be shown or hidden only by showing or
// hiding every other pool with them, and they had no section, no subtotal and no
// statement of what kind of money they hold. `buildClientMessageReport` has
// printed them as their own block headed "Evaluations (n)" since report.js:150;
// the paper never caught up.
//
// WHAT AN EVALUATION IS, and report.js:432-453 is the authority: CHALLENGE
// CAPITAL. Its profit and loss is not the client's money. A client with a flat
// day on real capital and a failed evaluation read as a losing day until that
// was fixed, so these figures stay out of `report.totals` and out of the segment
// tiles, exactly like the simulation block beside them.
//
// WHAT AN EVALUATION HAS THAT A SIMULATION DOES NOT: it can be PASSED, and the
// desk is paid to pass them. So the primary column here is progress toward the
// target, not P&L. Measured over the 289 evaluation accounts on the book that
// appear on at least one close:
//
//   * an absolute target BALANCE is available on 288 (99.7%) — 195 stored on the
//     account, 93 from accountTargets.targetForAccount on an inferred size
//   * a starting balance on 289 (100%) — 129 stored, 160 from the earliest close
//     on record (propFirmRules.firstObservedBalance)
//   * so "X% of the way to its target" is definable on 270 (93.4%): 252 below
//     target, 18 already at or above it, 18 whose stored target is at or below
//     their own starting balance and get a sentence instead of a bar
//
// WHICH NUMBER IS THE TARGET, and this is the trap the whole file is arranged
// around. `trading_accounts.target_profit` stores an absolute target BALANCE:
// all 198 stored values on evaluation accounts are >= 40,000 (min 52,999, max
// 107,300), which is what App.jsx's progress table and bulletBotStats.js already
// compare a balance against. `resolveAccountLimits().targetProfit` returns that
// same stored value when there is one and otherwise falls back to
// `rule.profitTarget` or `genericProfitTarget(size)`, which are profit AMOUNTS:
// all 94 accounts that take that fallback get a number under 10,000, and on
// every one of those 94 the current balance already exceeds it. Reading that
// field here would have declared 94 of 289 evaluations (32.5%) finished. The
// function that looks like the right abstraction is the one that breaks it, so
// this file does not call it, and the firm-rule path is refused even as a
// `size + profitTarget` sum: it would have covered ONE account out of 289 at the
// price of writing the unit confusion into a second place.
//
// WHAT IS NOT HERE, deliberately. No drawdown limit derived from
// PROP_FIRM_RULES. It resolves for 93.1% of these accounts, and on all of them
// through `tightestRuleFor` — the pessimistic guess AccountManager labels "using
// tightest" for the desk — because `prop_firm_plan` is unset on all 319
// evaluation rows. propFirmRules.js:122-135 is explicit that a derived figure
// answers "how much room there was at the close" and never "was the account safe
// today". A client is shown the buffer the platform itself reported, or nothing.

import { inferStartingBalance, targetForAccount } from './accountTargets.js';
import { firstObservedBalance } from './propFirmRules.js';
import { strategyRan } from './strategyRan.js';

/** True for both evaluation types, and for neither funded nor cash nor sim. */
export function isEvaluationType(accountType) {
  return String(accountType || '').startsWith('Evaluation');
}

/**
 * Why a row has no progress figure, or that it has one.
 *
 * Five outcomes rather than a percentage and a blank, because a 0% and "nobody
 * has recorded what this account has to reach" are different facts and only one
 * of them is about the client's trading.
 */
export const EVALUATION_PROGRESS = {
  /** On its way: `percent` is meaningful. */
  BELOW: 'below',
  /**
   * Balance is at or past the target. "Reached", never "passed": the firm
   * decides whether an evaluation passed, and it also checks minimum days and
   * consistency rules this CRM does not hold. The desk's own panel settled this
   * vocabulary first (bulletBotDeskStats.js) and the report follows it.
   */
  REACHED: 'reached',
  /**
   * A target is on record and it is at or below the account's own starting
   * balance, so the account is "100% there" the day it opens. 18 of the book's
   * 289 evaluation accounts are in this state. Neither 0% nor 100% is true, so
   * neither is printed.
   */
  TARGET_NOT_ABOVE_START: 'target-not-above-start',
  /** No starting balance stored and no close on record to take one from. */
  NO_START: 'no-start',
  /** No stored target and no standard target for this type at this size. */
  NO_TARGET: 'no-target',
};

const positive = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * The absolute target BALANCE for one evaluation row, and where it came from.
 *
 * Stored first — someone typed it deliberately. Then the standard target for the
 * account's type at its inferred size, which is the same table
 * `suggestAccountDefaults` pre-fills from, so a derived figure here can never
 * disagree with the one a CAM would have been offered. Nothing else: see the
 * header on why the firm-rule fallback is refused.
 */
export function evaluationTargetFor(meta, startBalance) {
  const stored = positive(meta?.targetProfit);
  if (stored) return { target: stored, source: 'stored' };
  const size = inferStartingBalance(startBalance);
  const standard = size != null ? targetForAccount(meta?.accountType, size) : null;
  if (standard) return { target: standard, source: 'inferred' };
  return { target: null, source: null };
}

/**
 * How far one evaluation row is from its target.
 *
 * @param {object} row a `grouped.evaluations` row (snapshot + `meta`)
 * @param {object[]} dailyImports the client's closes, for the earliest balance
 *   on record when the account carries no stored start. That fallback is what
 *   takes start coverage from 129 of 289 accounts to all 289.
 */
export function evaluationProgressFor(row, dailyImports = []) {
  const storedStart = positive(row?.meta?.startBalance);
  const observedStart = storedStart ? null : firstObservedBalance(row?.accountName, dailyImports);
  const start = storedStart || positive(observedStart);
  const startSource = storedStart ? 'stored' : (start ? 'observed' : null);

  const { target, source: targetSource } = evaluationTargetFor(row?.meta, start);
  const balance = Number(row?.accountBalance || 0);

  const base = { start, startSource, target, targetSource, percent: null };
  if (!target) return { ...base, state: EVALUATION_PROGRESS.NO_TARGET };
  if (!start) return { ...base, state: EVALUATION_PROGRESS.NO_START };
  // A target not above the start cannot be a denominator. Printing 100% would
  // tell a client their challenge is over; printing 0% would tell them it has
  // not begun. The stored number is simply wrong and the cell says so.
  if (target <= start) return { ...base, state: EVALUATION_PROGRESS.TARGET_NOT_ABOVE_START };
  if (balance >= target) return { ...base, state: EVALUATION_PROGRESS.REACHED, percent: 100 };
  const percent = Math.max(0, Math.min(100, Math.round(((balance - start) / (target - start)) * 100)));
  return { ...base, state: EVALUATION_PROGRESS.BELOW, percent };
}

const COUNTABLE = new Set([EVALUATION_PROGRESS.BELOW, EVALUATION_PROGRESS.REACHED]);

/**
 * The evaluations block, or null when the client has no evaluation account at
 * all — absence of a section, not a section full of zeros, which is the rule
 * SimulationReportSection set.
 *
 * It does NOT return null merely because no evaluation filed a close today. A
 * client who holds three challenge accounts and saw none of them report is owed
 * that sentence; 3 of the 50 book clients with evaluations are in that state on
 * their latest close. That is a fact about the client's own accounts, unlike "no
 * account here is classified as simulation", which is a fact about the desk's
 * data entry and belongs in the designer, not on the paper.
 *
 * @param {number} reportedAccountCount every close on this import, so every
 *   count can be printed against its denominator.
 */
export function buildEvaluationSection(client, dailyImport, {
  rows = [],
  totals = null,
  reportedAccountCount = 0,
} = {}) {
  const registry = {
    ...(dailyImport?.accounts || {}),
    ...(client?.accountRegistry || {}),
  };
  const onRecord = Object.values(registry).filter((meta) => isEvaluationType(meta?.accountType)).length;
  if (!onRecord && !rows.length) return null;

  const dailyImports = client?.dailyImports || [];
  const accounts = rows.map((row) => {
    const progress = evaluationProgressFor(row, dailyImports);
    const ran = (row.strategies || []).filter((strategy) => strategyRan(strategy));
    return {
      ...row,
      progress,
      ranStrategies: ran.map((strategy) => strategy.strategyFamily || strategy.strategyName || 'Strategy'),
      /* THE PLATFORM'S OWN REPORTED TRAILING FIGURE, and only when it is room.
       *
       * A negative trailing figure is not a negative buffer, it is an account
       * past its drawdown: App.jsx's own `drawdownLabel` has always rendered
       * exactly that case as BREACHED and a zero as "-". Printing "-$254" under a
       * heading that says "buffer" would be a third reading of the same number on
       * a page the client keeps. Measured on the book: of the 1,360 evaluation
       * rows across every close, 1,050 (77.2%) report room, 184 are past the
       * drawdown and 126 report nothing at all.
       *
       * Never a limit looked up from the rules table — see the header. */
      reportedBuffer: Number(row.trailingMaxDrawdown || 0) > 0
        ? Number(row.trailingMaxDrawdown)
        : null,
      pastDrawdown: Number(row.trailingMaxDrawdown || 0) < 0,
    };
  });

  const traded = accounts.filter((row) => row.ranStrategies.length).length;
  const flat = accounts.filter((row) => Number(row.grossRealizedPnl || 0) === 0).length;
  const reached = accounts.filter((row) => row.progress.state === EVALUATION_PROGRESS.REACHED).length;
  const failed = accounts.filter((row) => row.meta?.status === 'Failed').length;

  return {
    /**
     * THE HEADING COUNTS THE ROWS UNDER IT, and where there are none it says so
     * in words instead of printing a nought.
     *
     * `(n)` is the number of rows the block shows — the same count the chat
     * block has printed since report.js:205 and the same one the subtotal's
     * denominator is read against, so the number is the right one and it stays.
     * The WORD was wrong. A reader takes a figure in a heading for a count of
     * the client's accounts, not of today's rows, so "Evaluations (0)" over a
     * sentence reading "3 evaluation accounts on record" asserted the opposite
     * of its own body at a glance. 19 closes on the book print that pair, 4 of
     * them a client's latest close, and it prints on the PDF.
     */
    label: accounts.length
      ? `Evaluations (${accounts.length})`
      : 'Evaluations (none reported today)',
    /**
     * The words that say what the money is. Currency formatting alone does not
     * carry "this is not yours", so the sentence does, and the column headings
     * repeat it beside every figure.
     *
     * The none-reported branch agrees with its own number: one account is "it",
     * not "none of them". 5 of the 51 clients holding an evaluation account hold
     * exactly one, and 5 of the 19 closes that print this sentence are theirs.
     */
    note: accounts.length
      ? 'These are challenge accounts. The capital in them belongs to the prop firm, not to you — what matters is whether each one reaches its target. Their balances and results are shown separately and are not included in any figure above.'
      : onRecord === 1
        ? '1 evaluation account on record, and it reported no close on this date, so there is nothing to show for it today.'
        : `${onRecord} evaluation accounts on record, and none of them reported a close on this date, so there is nothing to show for them today.`,
    hasRows: accounts.length > 0,
    accounts,
    totals: totals || { grossRealizedPnl: 0, weeklyPnl: 0, aggregateBalance: 0 },
    counts: {
      accounts: accounts.length,
      onRecord,
      /** On record and silent today. 16 of 329 closes on the book. */
      notReported: Math.max(0, onRecord - accounts.length),
      ofAccountsReported: reportedAccountCount,
      traded,
      /** Reported, and no strategy ran: 164 of 203 rows on the book's latest closes. */
      idle: accounts.length - traded,
      flat,
      reached,
      failed,
    },
    /**
     * How empty the progress column is, printed above it.
     *
     * The pattern is bulletBotDeskStats.buildColumnCoverage: a rate drawn from a
     * partly-filled column is stated with its denominator and with how much of
     * the column was filled, because the desk that owns `target_profit` and
     * `start_balance` reads the panel, not the comment.
     */
    coverage: {
      ofAccounts: accounts.length,
      progressShown: accounts.filter((row) => COUNTABLE.has(row.progress.state)).length,
      targetStored: accounts.filter((row) => row.progress.targetSource === 'stored').length,
      targetInferred: accounts.filter((row) => row.progress.targetSource === 'inferred').length,
      targetMissing: accounts.filter((row) => !row.progress.target).length,
      startStored: accounts.filter((row) => row.progress.startSource === 'stored').length,
      startObserved: accounts.filter((row) => row.progress.startSource === 'observed').length,
      /**
       * The rows whose PERCENTAGE rests on a start nobody typed.
       *
       * Narrower than `startObserved` on purpose: the start is a denominator only
       * in the BELOW branch. A row reading "Target reached" compares a balance
       * against a target and the start never enters it, so an inferred start
       * there is not a figure anybody reads. 82 of the 186 bars on the book's
       * latest closes are in this state, and until the cell said so the reader
       * could not tell which.
       */
      percentFromObservedStart: accounts.filter(
        (row) => row.progress.state === EVALUATION_PROGRESS.BELOW && row.progress.startSource === 'observed',
      ).length,
      targetNotAboveStart: accounts.filter(
        (row) => row.progress.state === EVALUATION_PROGRESS.TARGET_NOT_ABOVE_START,
      ).length,
      bufferReported: accounts.filter((row) => row.reportedBuffer !== null).length,
      bufferPastDrawdown: accounts.filter((row) => row.pastDrawdown).length,
    },
  };
}
