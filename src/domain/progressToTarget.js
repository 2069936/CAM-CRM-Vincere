// The rows the report's "Progress to target" table can honestly draw.
//
// WHY THIS LEFT App.jsx. It was eleven lines of arithmetic inside the JSX, and
// two of them were wrong in a way nothing could assert:
//
//   const start = Number(row.meta?.startBalance || 0);
//   const pct = need > 0 ? ... : 0;
//
// `startBalance` is blank on 78 of the 233 rows the table draws on the book's
// latest closes, and with the start at zero the percentage becomes
// `balance / target`, which for a prop account sitting untouched at its opening
// balance is 90-something. 70 of those 78 rows printed 90% or more. An account
// that has not made a dollar read as nearly funded, and it reached clients:
// SIMPLIFIED_REPORT_CONFIG sets showProgressToTarget true, so the one-click
// preset ships it.
//
// The other half was `: 0` — a target at or below the start printed 0%, which is
// a claim about the account rather than about the record.
//
// So: a start is stored, or taken from the earliest close on record
// (propFirmRules.firstObservedBalance, which is the closest thing to an opening
// size this CRM holds), or absent — and absent prints a sentence, not a number.
// Eligibility is deliberately UNCHANGED: a row needs a stored Target $, exactly
// as before, because widening it would add rows to a section every client who
// already has it on would see change shape.
//
// `targetProfit` IS AN ABSOLUTE BALANCE here, the same unit evaluationReport.js
// is arranged around and the same unit App.jsx has always compared against. Do
// not reach for `resolveAccountLimits().targetProfit`: on the 94 book accounts
// with nothing stored it returns a profit AMOUNT under 10,000 in a field of the
// same name, and every one of those accounts' balances already exceeds it.

import { firstObservedBalance } from './propFirmRules.js';

const positive = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Why a row has no percentage, or that it has one. */
export const PROGRESS_STATE = {
  MEASURED: 'measured',
  /** No stored start and no close on record to take one from. */
  NO_START: 'no-start',
  /** A target at or below the account's own starting balance. */
  TARGET_NOT_ABOVE_START: 'target-not-above-start',
};

/**
 * One row per funded or evaluation account with a stored target, in the order
 * App.jsx draws them.
 *
 * @param {object} report a buildDailyReportSummary result
 * @param {object[]} dailyImports the client's closes, for the start fallback
 */
export function buildProgressToTargetRows(report, dailyImports = []) {
  const rows = [...(report?.grouped?.funded || []), ...(report?.grouped?.evaluations || [])];
  return rows
    .filter((row) => positive(row.meta?.targetProfit))
    .map((row) => {
      const start = positive(row.meta?.startBalance)
        ?? positive(firstObservedBalance(row.accountName, dailyImports));
      const target = Number(row.meta.targetProfit);
      const balance = Number(row.accountBalance || 0);
      const need = start != null ? target - start : null;
      const measurable = need != null && need > 0;
      return {
        row,
        accountName: row.accountName,
        label: row.meta?.alias || row.accountName,
        start,
        startSource: positive(row.meta?.startBalance) ? 'stored' : (start != null ? 'observed' : null),
        target,
        balance,
        percent: measurable
          ? Math.max(0, Math.min(100, Math.round(((balance - start) / need) * 100)))
          : null,
        state: measurable
          ? PROGRESS_STATE.MEASURED
          : (start == null ? PROGRESS_STATE.NO_START : PROGRESS_STATE.TARGET_NOT_ABOVE_START),
      };
    });
}
