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
import { ACCOUNT_NATURES, classifyAccountNature } from './simulationAccounts';

export const SEGMENTS = {
  EVAL_STANDARD: 'Evaluations - standard',
  EVAL_BULLET: 'Evaluations - Bullet Bot',
  FUNDED: 'Funded',
  CASH: 'Cash',
  UNCLASSIFIED: 'Unclassified',
  IGNORED: 'Ignored',
  ORPHAN: 'No account on record',
  // Not money. The label says so on every surface that renders a segment name,
  // because a currency-formatted figure alone reads as dollars.
  SIMULATION: 'Simulated (not real money)',
  UNDETERMINED: 'Nature undetermined',
};

/**
 * Ignored and orphan snapshots are counted, not silently dropped.
 *
 * Excluding them without saying so replaces one wrong total with another and
 * hides the data problem. An orphan snapshot means an account was deleted or
 * renamed while its closes stayed behind, which is worth seeing.
 *
 * SIMULATION and UNDETERMINED are here for a different reason: they are counted
 * and shown, but they are not the desk's money. The 11 simulation accounts in
 * the real exports hold $1,099,590 between them — 4.7% of the 427-account,
 * $23,604,729.21 desk balance — and letting that into the headline would be the
 * exact defect this feature exists to prevent. Anything added to SEGMENTS that
 * is not real desk capital MUST be added here in the same commit.
 */
export const EXCLUDED_FROM_TOTAL = new Set([
  SEGMENTS.IGNORED,
  SEGMENTS.ORPHAN,
  SEGMENTS.SIMULATION,
  SEGMENTS.UNDETERMINED,
]);

export function segmentFor(meta) {
  if (!meta) return SEGMENTS.ORPHAN;
  const type = String(meta.accountType || '').trim();
  if (type === ACCOUNT_TYPES.SIMULATION) return SEGMENTS.SIMULATION;
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

/**
 * Segment an account by what its money IS before segmenting it by what it is
 * FOR.
 *
 * The second line of defence. `reconcile.js` already routes simulated rows into
 * their own container, so nothing simulated should ever reach a segment total —
 * but an account whose stored type is still 'Unassigned' while its name is
 * Sim101 would land in Unclassified, which IS counted in the desk total
 * (51 accounts / $3,010,573.30 on the real book). Eleven Sim101s would have
 * added $1,099,590 to it. Take the account name wherever it is available.
 */
export function segmentForAccount(meta, accountName = '') {
  const name = accountName || meta?.accountName || '';
  // Nature is decided BEFORE the orphan check on purpose: a Sim101 close whose
  // registry row was never created is simulated capital, not "capital belonging
  // to an account we lost". Both are excluded from the total, but only one of
  // the two labels is true.
  const nature = classifyAccountNature(meta || {}, { accountName: name }).nature;
  if (nature === ACCOUNT_NATURES.SIMULATION) return SEGMENTS.SIMULATION;
  if (nature === ACCOUNT_NATURES.UNDETERMINED) return SEGMENTS.UNDETERMINED;
  if (!meta) return SEGMENTS.ORPHAN;
  return segmentFor(meta);
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
    const sim = entry?.dailyImport?.simulation;
    // `dailyImport.snapshots` is live-money-only by construction (reconcile.js
    // and buildCrmStateFromTables both split before anyone reads it). The
    // simulated and undetermined closes are appended explicitly so they are
    // COUNTED and visible as their own rows — dropping them would hide the sim
    // engagement the desk is being paid to run — while EXCLUDED_FROM_TOTAL keeps
    // them out of `total`.
    const rows = [
      ...(entry?.dailyImport?.snapshots || []),
      ...(sim?.snapshots || []),
      ...(sim?.undetermined?.snapshots || []),
    ];
    for (const snapshot of rows) {
      const row = add(segmentForAccount(registry[snapshot.accountName], snapshot.accountName));
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
    // Surfaced by name rather than left for a caller to find inside `excluded`
    // by string-matching a label. A tile that has to guess which excluded row is
    // the simulated one is a tile that will eventually add it back in.
    simulated: rows.get(SEGMENTS.SIMULATION) || emptyRow(SEGMENTS.SIMULATION),
    undetermined: rows.get(SEGMENTS.UNDETERMINED) || emptyRow(SEGMENTS.UNDETERMINED),
    // Denominator for every count above: how many account closes were read in
    // total, real and simulated together.
    accountsSeen: segments.reduce((sum, row) => sum + row.accounts, 0),
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

  return {
    prop: pick(propSegments),
    cash: pick([SEGMENTS.CASH]),
    // Returned alongside, never added to either. A caller that wants one number
    // for "the desk" adds prop + cash; simulation is here so it can be shown, in
    // its own tile, with its own label.
    simulation: pick([SEGMENTS.SIMULATION]),
    undetermined: pick([SEGMENTS.UNDETERMINED]),
  };
}
