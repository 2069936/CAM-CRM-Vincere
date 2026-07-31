// Splits the Operations totals by what kind of account produced them.
//
// The headline tiles summed every snapshot together. On a real book that meant
// one number of -172,980 that quietly contained -25,468 of cash accounts, -656
// of accounts explicitly marked Inactive / Ignore, and -6,150 of snapshots whose
// account no longer resolves at all. A cash account and a prop evaluation are
// not the same business, and adding them produces a figure that answers no
// question anyone asks.
//
// It also hid the shape of the loss: Bullet Bot evaluations alone were -96,905
// of that total, 56% of the day, which is invisible in a single tile.

import { ACCOUNT_TYPES, isCashType } from './reconcile';

export const SEGMENTS = {
  EVAL_STANDARD: 'Evaluations - standard',
  EVAL_BULLET: 'Evaluations - Bullet Bot',
  FUNDED: 'Funded',
  CASH: 'Cash',
  UNCLASSIFIED: 'Unclassified',
  IGNORED: 'Ignored',
  ORPHAN: 'No account on record',
};

/**
 * Ignored and orphan snapshots are counted, not silently dropped.
 *
 * Excluding them without saying so replaces one wrong total with another and
 * hides the data problem. An orphan snapshot means an account was deleted or
 * renamed while its closes stayed behind, which is worth seeing.
 */
export const EXCLUDED_FROM_TOTAL = new Set([SEGMENTS.IGNORED, SEGMENTS.ORPHAN]);

export function segmentFor(meta) {
  if (!meta) return SEGMENTS.ORPHAN;
  const type = String(meta.accountType || '').trim();
  if (!type || type === ACCOUNT_TYPES.UNASSIGNED) return SEGMENTS.UNCLASSIFIED;
  if (type === ACCOUNT_TYPES.IGNORE) return SEGMENTS.IGNORED;
  if (isCashType(type)) return SEGMENTS.CASH;
  if (type === ACCOUNT_TYPES.EVALUATION_BULLET) return SEGMENTS.EVAL_BULLET;
  if (type === ACCOUNT_TYPES.EVALUATION_STANDARD) return SEGMENTS.EVAL_STANDARD;
  if (type === ACCOUNT_TYPES.FUNDED) return SEGMENTS.FUNDED;
  // A type nobody has taught this function about is reported under its own name
  // rather than folded into Unclassified, which would hide a new account type
  // behind a label that means the opposite.
  return type;
}

function emptyRow(segment) {
  return {
    segment,
    accounts: 0,
    dailyPnl: 0,
    weeklyPnl: 0,
    balance: 0,
    countedInTotal: !EXCLUDED_FROM_TOTAL.has(segment),
  };
}

/**
 * Per-segment totals for one close.
 *
 * `imports` is the same shape latestImports produces: one entry per client,
 * holding the client and the daily import being read.
 */
export function buildSegmentTotals(imports = []) {
  const rows = new Map();
  const add = (segment) => {
    if (!rows.has(segment)) rows.set(segment, emptyRow(segment));
    return rows.get(segment);
  };

  for (const entry of imports) {
    const registry = entry?.client?.accountRegistry || {};
    for (const snapshot of entry?.dailyImport?.snapshots || []) {
      const row = add(segmentFor(registry[snapshot.accountName]));
      row.accounts += 1;
      row.dailyPnl += Number(snapshot.grossRealizedPnl || 0);
      row.weeklyPnl += Number(snapshot.weeklyPnl || 0);
      row.balance += Number(snapshot.accountBalance || 0);
    }
  }

  const segments = [...rows.values()].sort((a, b) => a.dailyPnl - b.dailyPnl);
  const counted = segments.filter((row) => row.countedInTotal);

  return {
    segments,
    // The figure that belongs on a tile: trading accounts only.
    total: {
      accounts: counted.reduce((sum, row) => sum + row.accounts, 0),
      dailyPnl: counted.reduce((sum, row) => sum + row.dailyPnl, 0),
      weeklyPnl: counted.reduce((sum, row) => sum + row.weeklyPnl, 0),
      balance: counted.reduce((sum, row) => sum + row.balance, 0),
    },
    excluded: segments.filter((row) => !row.countedInTotal),
  };
}

/** Prop and cash rolled up, because that is the split the desk reports on. */
export function rollUpByBusiness(totals) {
  const propSegments = [SEGMENTS.EVAL_STANDARD, SEGMENTS.EVAL_BULLET, SEGMENTS.FUNDED];
  const pick = (names) => (totals?.segments || [])
    .filter((row) => names.includes(row.segment))
    .reduce((acc, row) => ({
      accounts: acc.accounts + row.accounts,
      dailyPnl: acc.dailyPnl + row.dailyPnl,
      weeklyPnl: acc.weeklyPnl + row.weeklyPnl,
      balance: acc.balance + row.balance,
    }), { accounts: 0, dailyPnl: 0, weeklyPnl: 0, balance: 0 });

  return { prop: pick(propSegments), cash: pick([SEGMENTS.CASH]) };
}
