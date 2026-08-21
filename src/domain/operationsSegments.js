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

/**
 * The businesses the desk runs, as keys. Re-exported by deskMoney.js as
 * DESK_BUSINESS so there is one set of strings, not two that agree today.
 */
export const BUSINESS_KEYS = {
  BULLET: 'bulletBot',
  PROP_OTHER: 'propOther',
  CASH: 'cash',
  UNCLASSIFIED: 'unclassified',
};

/**
 * Which business a segment belongs to, or null when it belongs to none.
 *
 * THE ONLY DEFINITION. rollUpByBusiness sums segment rows with it and
 * strategyBoards routes account-days with it, so a board and the tile above it
 * cannot disagree about where a Funded account's money goes. When this was two
 * filters written twice, the second one was free to drift.
 *
 * `propOther` is defined by exclusion — anything counted that is not cash, not
 * unclassified and not Bullet Bot — so an account type nobody has taught
 * segmentFor() about lands in a reported row instead of silently vanishing from
 * every figure on the page.
 *
 * null means Ignored, orphan, simulated or undetermined: counted somewhere as a
 * reconciliation line, never rolled into a business.
 */
export function businessForSegment(segment) {
  if (EXCLUDED_FROM_TOTAL.has(segment)) return null;
  if (segment === SEGMENTS.EVAL_BULLET) return BUSINESS_KEYS.BULLET;
  if (segment === SEGMENTS.CASH) return BUSINESS_KEYS.CASH;
  if (segment === SEGMENTS.UNCLASSIFIED) return BUSINESS_KEYS.UNCLASSIFIED;
  return BUSINESS_KEYS.PROP_OTHER;
}

function emptyRow(segment) {
  return {
    segment,
    accounts: 0,
    // Distinct clients contributing to this row. Never added across rows: one
    // client holds cash AND bullet-bot evaluations, so the column sums to more
    // than the desk has clients.
    clients: 0,
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
  const clientsPerSegment = new Map();
  const add = (segment) => {
    if (!rows.has(segment)) rows.set(segment, emptyRow(segment));
    if (!clientsPerSegment.has(segment)) clientsPerSegment.set(segment, new Set());
    return rows.get(segment);
  };

  for (const entry of imports) {
    const registry = entry?.client?.accountRegistry || {};
    const clientId = entry?.client?.id ?? entry?.client?.name ?? '';
    const sim = entry?.dailyImport?.simulation;
    // `dailyImport.snapshots` is live-money-only by construction (reconcile.js
    // and buildCrmStateFromTables both split before anyone reads it). The
    // simulated and undetermined closes are appended explicitly so they are
    // COUNTED and visible as their own rows — dropping them would hide the sim
    // engagement the desk is being paid to run — while EXCLUDED_FROM_TOTAL keeps
    // them out of the businesses deskMoney reports.
    const rows = [
      ...(entry?.dailyImport?.snapshots || []),
      ...(sim?.snapshots || []),
      ...(sim?.undetermined?.snapshots || []),
    ];
    for (const snapshot of rows) {
      const segment = segmentForAccount(registry[snapshot.accountName], snapshot.accountName);
      const row = add(segment);
      clientsPerSegment.get(segment).add(clientId);
      row.accounts += 1;
      row.dailyPnl += Number(snapshot.grossRealizedPnl || 0);
      row.weeklyPnl += Number(snapshot.weeklyPnl || 0);
      row.balance += Number(snapshot.accountBalance || 0);
    }
  }

  for (const [segment, ids] of clientsPerSegment) rows.get(segment).clients = ids.size;

  const segments = [...rows.values()].sort((a, b) => a.dailyPnl - b.dailyPnl);

  return {
    segments,
    // Plumbing, so that a roll-up of several segments can count the clients
    // behind them by union rather than by adding counts. One client holds cash
    // and Bullet Bot evaluations at once; adding the two counts would report
    // more clients than the desk has.
    clientIdsBySegment: clientsPerSegment,
    // THERE IS NO `total` HERE, AND ADDING ONE BACK IS THE DEFECT.
    //
    // There used to be: `total` summed every counted segment into one figure and
    // the headline tile printed it. On the real book that read -$169,926.90,
    // which is a cash desk's real client money added to a prop desk's simulated
    // plan-size result, with Bullet Bot netted against the ordinary algorithms
    // inside it. Twice in fourteen days the sign was wrong — 2026-07-21 read
    // +$605.79 green while the prop desk had lost $5,505.46 — and on nine of
    // thirteen non-zero days Bullet Bot and the rest of prop moved in opposite
    // directions.
    //
    // deskMoney.js is the only thing that should group these rows, and it groups
    // them into four that never add. A caller wanting one number for "the desk"
    // must not find one here.
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

/**
 * The businesses the desk actually runs, rolled up so that none of them adds to
 * another.
 *
 * THERE IS NO `prop` KEY AND THERE MUST NOT BE ONE. It was here, covering
 * Evaluations-standard + Bullet Bot + Funded, and it hid the largest single fact
 * on the screen: on the 2026-07-13 close "prop -$5,070.50" was Bullet Bot
 * +$14,861.50 netted against the ordinary algorithms -$19,932.00, and the two
 * carried opposite signs on 9 of the 13 non-zero days in the book. Bullet Bot is
 * a different business — high risk, pass or fail inside three days — and on the
 * 2026-07-30 close it is 71.0% of everything prop did.
 *
 * Documenting "do not fold Bullet Bot into prop" instead of removing the key
 * would not have held: a key named `prop` gets summed by the next caller who
 * needs a number, which is exactly how the deleted `total` came back the first
 * time.
 *
 * `propOther` is defined by exclusion — every counted segment that is not cash,
 * not unclassified and not Bullet Bot — so an account type nobody has taught
 * segmentFor() about lands in a reported row instead of silently vanishing from
 * every figure on the page.
 */
export function rollUpByBusiness(totals) {
  const rows = totals?.segments || [];
  const clientIds = totals?.clientIdsBySegment || new Map();
  const sum = (matching) => {
    const rolled = matching.reduce((acc, row) => ({
      accounts: acc.accounts + row.accounts,
      dailyPnl: acc.dailyPnl + row.dailyPnl,
      weeklyPnl: acc.weeklyPnl + row.weeklyPnl,
      balance: acc.balance + row.balance,
      segments: [...acc.segments, row.segment],
    }), { accounts: 0, dailyPnl: 0, weeklyPnl: 0, balance: 0, segments: [] });
    const union = new Set();
    for (const row of matching) for (const id of clientIds.get(row.segment) || []) union.add(id);
    return { ...rolled, clients: union.size };
  };
  const pick = (names) => sum(rows.filter((row) => names.includes(row.segment)));
  // Through businessForSegment rather than a second filter written here, so the
  // leaderboards below the tiles route an account-day the same way the tile
  // routes its money.
  const inBusiness = (key) => sum(rows.filter((row) => businessForSegment(row.segment) === key));

  return {
    bulletBot: inBusiness(BUSINESS_KEYS.BULLET),
    propOther: inBusiness(BUSINESS_KEYS.PROP_OTHER),
    cash: inBusiness(BUSINESS_KEYS.CASH),
    // Its own row, never folded into prop and never into cash. 51 accounts and
    // -$4,894.44 on the real book is a classification backlog, not a result.
    unclassified: inBusiness(BUSINESS_KEYS.UNCLASSIFIED),
    // Returned alongside, never added to any of the above. Simulation is here so
    // it can be shown, in its own place, with its own label.
    simulation: pick([SEGMENTS.SIMULATION]),
    undetermined: pick([SEGMENTS.UNDETERMINED]),
    ignored: pick([SEGMENTS.IGNORED]),
    orphan: pick([SEGMENTS.ORPHAN]),
  };
}
