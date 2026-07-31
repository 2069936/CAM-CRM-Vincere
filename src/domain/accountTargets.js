// Infer an account's starting balance from its current balance, and assign the
// standard profit target for its size and type.
//
// Prop accounts start at one of a few standard sizes (50k / 100k / 150k) and a
// live balance stays within roughly 20% of that size, so the starting size can
// be inferred from the current balance. Cash (live) accounts have no standard
// size and no target — only their cash balance matters.

import { ACCOUNT_TYPES, isCashType } from './reconcile';

export const STANDARD_ACCOUNT_SIZES = [50000, 100000, 150000];

// How far a live balance can drift from its starting size and still be inferred.
const INFER_BAND = 0.2;

// Absolute target balance per starting size. Standard = Funded + normal
// Evaluation; Bullet Bot evaluations pass at a lower target. Only sizes with a
// known rule are listed; anything else returns null (set it manually).
const TARGET_TABLE = {
  standard: { 50000: 54100, 100000: 107300, 150000: 159000 },
  bulletBot: { 50000: 53000 },
};

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

// The absolute target balance for an account of this type and starting size.
// Cash accounts have no target. Sizes/types without a known rule return null.
export function targetForAccount(accountType, startingBalance) {
  if (isCashType(accountType)) return null;
  const table = accountType === ACCOUNT_TYPES.EVALUATION_BULLET ? 'bulletBot' : 'standard';
  return TARGET_TABLE[table][Number(startingBalance)] ?? null;
}

// Suggested defaults to pre-fill when an account first appears in an import.
// Cash accounts get neither (balance is all that matters). Returns only the
// fields we can infer; a null field means "leave for the user to set".
export function suggestAccountDefaults(accountType, currentBalance) {
  if (isCashType(accountType)) {
    return { startingBalance: null, target: null };
  }
  const startingBalance = inferStartingBalance(currentBalance);
  const target = startingBalance != null ? targetForAccount(accountType, startingBalance) : null;
  return { startingBalance, target };
}
