import { ACCOUNT_STATUSES, ACCOUNT_TYPES } from './reconcile';

/* ------------------------------------------------------------------------- *
 * Put a date on a classification at the moment it is made.
 *
 * THE PROBLEM THIS EXISTS FOR. `trading_accounts.status` is written from one
 * <select> that saves `{status}` and nothing else. On the real book that leaves
 * 48 accounts marked Failed of which 1 carries a date_failed, so 47 of them
 * cannot be placed in time at all: no "how long did it last", no cohort, no
 * average days to fail that is a mean over more than n = 1. The classification
 * was made, the moment it was made was thrown away, and it cannot be recovered
 * afterwards because nothing else records it.
 *
 * The fix is not another screen asking someone to also fill a date. It is that
 * the date is not a separate decision. Marking an account Failed IS the claim
 * that it failed, and the only day anyone can honestly stamp that claim with is
 * the day it was made.
 *
 * PASSING IS A TYPE CHANGE, NOT A STATUS. This desk's model has no 'Passed'
 * status and should not grow one: an evaluation that passes becomes a Funded
 * account, which is what `accountType` already says, and `date_funded` is
 * already the column for when. So the two decisions a CAM actually makes map
 * onto fields that exist:
 *
 *   "did it pass?"  -> accountType becomes Funded, date_funded is today
 *   "did it fail?"  -> status becomes Failed,      date_failed is today
 *
 * NEVER OVERWRITES. The same rule the account-type defaults already follow: a
 * date someone typed, or a date carried over from an import, is evidence and
 * this is a guess. It only fills a field that is empty. That also makes it safe
 * to re-run over a patch that was already stamped.
 *
 * NEVER CLEARS EITHER. Moving an account off Failed does not erase date_failed.
 * It failed on that day whether or not it was later revived, and the lifecycle
 * module reads the two as independent facts on purpose.
 * ------------------------------------------------------------------------- */

/** A date this row can be placed in time by, once it is claimed. */
const TERMINAL_MARKS = [
  {
    field: 'status',
    value: ACCOUNT_STATUSES.FAILED,
    stamps: 'dateFailed',
  },
  {
    field: 'accountType',
    value: ACCOUNT_TYPES.FUNDED,
    stamps: 'dateFunded',
  },
];

function isEmpty(value) {
  return value == null || value === '';
}

/**
 * Augment an account patch with the date its classification was made.
 *
 * @param patch    what the caller is about to save.
 * @param existing the account's current stored metadata, so a date already on
 *                 record is left alone.
 * @param today    'YYYY-MM-DD'. Passed in rather than read from the clock, so
 *                 the caller owns the timezone this desk closes in.
 * @returns the patch, with a date added only where one was claimed and missing.
 */
export function stampAccountOutcome(patch, existing = {}, today = '') {
  if (!patch || typeof patch !== 'object') return patch;
  const stamp = String(today || '').trim();
  if (!stamp) return patch;

  let augmented = null;
  for (const mark of TERMINAL_MARKS) {
    // Only when this patch is what makes the claim. A patch that touches
    // something else on an already-Failed account is not a new classification
    // and must not be dated today.
    if (!(mark.field in patch)) continue;
    if (patch[mark.field] !== mark.value) continue;
    if (!isEmpty(patch[mark.stamps])) continue;
    if (!isEmpty(existing?.[mark.stamps])) continue;
    augmented = augmented || { ...patch };
    augmented[mark.stamps] = stamp;
  }
  return augmented || patch;
}

/**
 * The two questions worth putting in front of a CAM, and what answering yes
 * writes. Kept next to the stamping rule so the prompt and the write cannot
 * describe different things.
 */
export const OUTCOME_PROMPTS = {
  TARGET_REACHED: {
    question: 'Did this account pass?',
    confirmLabel: 'Passed, mark it Funded',
    patch: { accountType: ACCOUNT_TYPES.FUNDED },
  },
  WENT_MISSING: {
    question: 'Did this account fail?',
    confirmLabel: 'Failed, mark it Failed',
    patch: { status: ACCOUNT_STATUSES.FAILED },
  },
};
