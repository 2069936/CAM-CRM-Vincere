// What the desk holds, and how much of its movement can actually be named.
//
// The capital tiles today are a stock figure with no drill-down: buildSegmentTotals
// accumulates `row.balance` and SegmentBreakdown never renders it. This module is
// the detail behind that number — composition, the movements the data supports,
// and an explicit list of the figures it refuses to produce.
//
// The refusals are the point. On the real book (public/local-snapshot.json,
// 3,100 account_snapshots over 21 closes) exactly ONE capital movement is
// nameable with confidence: a $98,219.80 same-client account-to-account transfer
// on 2026-07-21. Everything else that does not reconcile is a three-figure
// residual with no corroborating signal, and a ledger that booked those as
// withdrawals would be inventing eleven money movements out of noise.
//
// There is no deposit, withdrawal, funding-fee or transfer amount field anywhere
// in the 19 tables. "What came in" is not recorded, so it is returned as null and
// said so, never as 0.

import { EXCLUDED_FROM_TOTAL, SEGMENTS, segmentForAccount } from './operationsSegments';

/**
 * What kind of money a segment's balances are, which decides whether a balance
 * may be called capital at all.
 *
 * The desk's own review of this screen: prop-firm account balances ARE NOT REAL
 * MONEY. They are a plan size the prop firm simulates, and 195 accounts on this
 * book carry exactly 50,000 because that is the product, not because anyone
 * deposited it. Of the $32,244,234.16 this module used to publish as "capital
 * held", $30,287,682.82 — 93.93% — was that plan size. Real money is at most
 * $1,956,551.34.
 *
 * So a balance is capital only when it is CLIENT_CASH. Everywhere else the
 * figure is still computed and still shown, under a name that cannot be printed
 * as capital by mistake, with the refusal next to it.
 */
export const MONEY_KINDS = {
  CLIENT_CASH: 'client-cash',
  PROP_PLAN_SIZE: 'prop-plan-size',
  UNCLASSIFIED: 'unclassified',
  SIMULATED: 'simulated',
  UNKNOWN: 'unknown',
};

const CAPITAL_REFUSALS = {
  [MONEY_KINDS.PROP_PLAN_SIZE]: 'Not capital. A prop account balance is the plan size the firm '
    + 'simulates — no client and no desk ever deposited it — so it is reported as plan size, and '
    + 'the movement below is what this segment actually did.',
  [MONEY_KINDS.UNCLASSIFIED]: 'Not capital. Nobody has classified these accounts, and on this '
    + 'book 67 of the 68 that carry a balance also carry a prop-firm connection, so this is prop '
    + 'plan size under a label that has not been set yet.',
  [MONEY_KINDS.SIMULATED]: 'Not capital, and not money. These accounts trade simulated funds.',
  [MONEY_KINDS.UNKNOWN]: 'Not reported as capital. Nothing here establishes whether these '
    + 'balances are client money or a simulated plan size.',
};

export function moneyKindFor(segment) {
  if (segment === SEGMENTS.CASH) return MONEY_KINDS.CLIENT_CASH;
  if (segment === SEGMENTS.SIMULATION) return MONEY_KINDS.SIMULATED;
  if (segment === SEGMENTS.UNCLASSIFIED) return MONEY_KINDS.UNCLASSIFIED;
  if (segment === SEGMENTS.IGNORED
    || segment === SEGMENTS.ORPHAN
    || segment === SEGMENTS.UNDETERMINED) return MONEY_KINDS.UNKNOWN;
  // Everything else on this book is a prop pool: the two evaluation kinds,
  // Funded, and any account type segmentFor() has not been taught.
  return MONEY_KINDS.PROP_PLAN_SIZE;
}

/** The word a UI puts above the column, so the number is never bare. */
export const MONEY_KIND_LABELS = {
  [MONEY_KINDS.CLIENT_CASH]: 'Capital held',
  [MONEY_KINDS.PROP_PLAN_SIZE]: 'Plan size (not capital)',
  [MONEY_KINDS.UNCLASSIFIED]: 'Balance observed (unclassified)',
  [MONEY_KINDS.SIMULATED]: 'Simulated balance (not money)',
  [MONEY_KINDS.UNKNOWN]: 'Balance observed',
};

/**
 * Field separator for the account key.
 *
 * Not '/'. Account names on this book carry punctuation of their own
 * (`DJ89861-74!Ggdbkfh!Becggbe`) and client ids are free text, so a printable
 * separator can collide; '/' additionally has the history described in
 * strategyConfigDrift.js, where splitting on it produced a silent wrong answer
 * three times. U+0001 cannot occur in either field.
 */
const KEY = '\u0001';

/**
 * The account key is client + name, never the name alone.
 *
 * 101 of the 764 account names on the real book belong to more than one client —
 * `CCDAKCEHCAFDGB52196` is Kai Pine's Bullet Bot evaluation AND Oakley Larch's
 * unassigned account, both carrying a balance of 52,520.24 on 2026-07-22.
 * Keying a balance series on the account name alone merges the two books and
 * manufactures a movement on every day only one of them reported.
 */
function accountKey(clientId, accountName) {
  return `${clientId}${KEY}${accountName}`;
}

function day(value) {
  return String(value || '').slice(0, 10);
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/** Monday of the ISO week, as YYYY-MM-DD. */
function weekStart(date) {
  const at = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return date;
  at.setUTCDate(at.getUTCDate() - ((at.getUTCDay() + 6) % 7));
  return at.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return Number.POSITIVE_INFINITY;
  return Math.round((b - a) / 86400000);
}

/**
 * What the balance should have moved by between two closes.
 *
 * NOT `gross_realized_pnl`. Gross is a DAILY figure — it decreased between
 * consecutive closes on 722 of 2,339 pairs and is negative on 930 of 3,100
 * snapshots, so it is not a running total — but it is gross of commissions, and
 * the balance moves by net. On account 1071787 every single residual of
 * `dBal - gross` is an exact multiple of 3.76: -30.08, -3.76, -15.04, -18.80,
 * -33.84, -37.60, -41.36. That is round-turn commission per contract, not money
 * leaving the desk.
 *
 * `weekly_pnl` is the net accumulator and it reconciles: on the 2,237 July pairs
 * `dBal == gross` matched 1,656 (74.0%) while `dBal == weekly delta` matched
 * 2,075 (92.8%); inside three calendar days it reaches 98.1%. Using gross would
 * have raised a phantom movement on essentially every commissioned trading day —
 * roughly 580 of them on this book alone.
 *
 * It resets on Monday, so a pair that crosses an ISO week compares against the
 * new week's accumulator outright.
 */
function expectedDelta(previous, current) {
  return weekStart(previous.date) === weekStart(current.date)
    ? current.weekly - previous.weekly
    : current.weekly;
}

const CENT = 0.01;
const ZERO = 0.005;

/**
 * Builds one balance series per account from the client-shaped state.
 *
 * Reads dailyImports, the same source every other surface reads, so this cannot
 * drift from what the tiles show.
 */
function collectAccounts(clients, bound) {
  const accounts = new Map();
  const closes = new Set();

  for (const client of clients || []) {
    const clientId = client?.id ?? client?.uuid ?? '';
    const clientName = client?.name || clientId;
    const registry = client?.accountRegistry || {};

    for (const [accountName, meta] of Object.entries(registry)) {
      accounts.set(accountKey(clientId, accountName), {
        key: accountKey(clientId, accountName),
        clientId,
        clientName,
        accountName,
        meta,
        segment: segmentForAccount(meta, accountName),
        series: [],
      });
    }

    for (const entry of client?.dailyImports || []) {
      const date = day(entry?.date);
      if (!date) continue;
      if (bound && date > bound) continue;
      closes.add(date);

      // Simulated and undetermined closes are read here too, so their balances
      // appear as their own segment blocks rather than as 11 accounts that "have
      // no balance". They land in SEGMENTS.SIMULATION / SEGMENTS.UNDETERMINED,
      // both of which EXCLUDED_FROM_TOTAL keeps out of `desk` — the sim capital
      // is shown and never rolled into the $32,244,234.16 held figure.
      const snapshotsOfEveryNature = [
        ...(entry?.snapshots || []),
        ...(entry?.simulation?.snapshots || []),
        ...(entry?.simulation?.undetermined?.snapshots || []),
      ];
      for (const snapshot of snapshotsOfEveryNature) {
        const accountName = snapshot?.accountName || '';
        const key = accountKey(clientId, accountName);
        if (!accounts.has(key)) {
          // A close for an account the registry does not carry. 33 of the 3,100
          // snapshots on the real book are in this state, holding $1,682,305.73
          // between them. They are segmented as ORPHAN and counted, never
          // dropped: a snapshot with no account behind it means a row was
          // deleted or renamed under the closes, which is worth seeing.
          //
          // None of the 33 is a simulation account — every one carries a real
          // prop-firm connection (Legends / Lucid / BluSky / MFF) and a balance
          // between 29,482.31 and 146,061.92, none at 100,000 and none with the
          // Sim signature of tmd = 0 on six figures. segmentForAccount is still
          // used rather than a hard ORPHAN so that an unregistered Sim101 close
          // is labelled simulated instead of being filed as lost real capital.
          const orphanMeta = snapshot?.meta && Object.keys(snapshot.meta).length ? snapshot.meta : null;
          accounts.set(key, {
            key,
            clientId,
            clientName,
            accountName,
            meta: orphanMeta,
            segment: segmentForAccount(orphanMeta, accountName),
            series: [],
          });
        }
        accounts.get(key).series.push({
          date,
          balance: Number(snapshot?.accountBalance || 0),
          gross: Number(snapshot?.grossRealizedPnl || 0),
          weekly: Number(snapshot?.weeklyPnl || 0),
        });
      }
    }
  }

  for (const account of accounts.values()) {
    account.series.sort((a, b) => a.date.localeCompare(b.date));
  }
  return { accounts: [...accounts.values()], closes: [...closes].sort() };
}

/**
 * Closes whose weekly accumulator cannot be trusted at all, found from the data.
 *
 * The snapshot opens with a seed block, 2026-06-25 to 07-01: 17 accounts a day,
 * six clients, and closes stamped Saturday 06-27 and Sunday 06-28 when the
 * markets were shut. Not one of its 102 pairs reconciles under any identity
 * tested — 0 of 17 on every one of its dates — while every July close runs
 * between 93.3% and 100%. Attributing movements there would have invented ~102
 * of them out of demo rows.
 *
 * Detected rather than hardcoded to a date: a stale cutoff is exactly the class
 * of bug this codebase keeps paying for, and the next bad import will not land
 * on 2026-06-25.
 */
function distrustedCloses(accounts, { maxGapDays, minCloseCohort, minCloseReconciliation }) {
  const perClose = new Map();
  for (const account of accounts) {
    for (let index = 1; index < account.series.length; index += 1) {
      const previous = account.series[index - 1];
      const current = account.series[index];
      if (daysBetween(previous.date, current.date) > maxGapDays) continue;
      const row = perClose.get(current.date) || { date: current.date, pairs: 0, reconciled: 0 };
      row.pairs += 1;
      const moved = current.balance - previous.balance;
      if (Math.abs(moved - expectedDelta(previous, current)) < CENT) row.reconciled += 1;
      perClose.set(current.date, row);
    }
  }

  const distrusted = new Map();
  for (const row of perClose.values()) {
    // A thin close is not evidence of anything. Two accounts disagreeing is not
    // a broken import, so it is left alone rather than declared untrustworthy.
    if (row.pairs < minCloseCohort) continue;
    if (row.reconciled / row.pairs >= minCloseReconciliation) continue;
    distrusted.set(row.date, {
      date: row.date,
      pairs: row.pairs,
      reconciled: row.reconciled,
      share: row.reconciled / row.pairs,
    });
  }
  return { perClose, distrusted };
}

export const PAIR_SKIPPED = {
  GAP: 'gap',
  CLOSE_DISTRUSTED: 'closeDistrusted',
  ACCUMULATOR_BLANKED: 'accumulatorBlanked',
  STALE_ROW: 'staleRow',
};

/**
 * What the gap between gross P&L and the balance move is, on a pair that
 * otherwise reconciles.
 *
 * The gap IS commission on some accounts and the shape is unmistakable: on
 * account 1071787 every one of its twelve gaps is an exact multiple of 3.76 —
 * 3.76, 15.04, 18.80, 30.08, 33.84, 37.60, 41.36 — a round turn per contract.
 *
 * But it is not one thing across the book. Of the 900 reconciled close-pairs
 * that reported a non-zero gross: 397 show a cost, 491 show exactly zero (gross
 * already equals the balance move, so no commission is visible in the data at
 * all for those accounts), and 12 run the wrong way — nine of those are a
 * reported gross against a balance that did not move (gross -1,029.00 with the
 * balance frozen on 2026-07-24). Summing all 900 gives 6,903.14, a number that
 * is a cost, a zero and an import artefact added together and means nothing.
 * Only 31 of the 397 costs are multiples of 3.76, so even the rate is not one
 * rate. Each kind is therefore counted on its own and the single total refused.
 */
function gapKindOf(gross, moved) {
  if (Math.abs(moved) < ZERO) return 'balanceFrozen';
  const gap = round2(gross - moved);
  if (Math.abs(gap) < CENT) return 'exact';
  return gap > 0 ? 'cost' : 'against';
}

/**
 * Every consecutive pair of closes for one account, classified.
 *
 * Returns reconciled pairs (trading, explained), unexplained pairs (a balance
 * change the accumulator does not account for), and the pairs that were not
 * comparable at all with the reason. The last group is reported, not hidden: on
 * the real book it is 197 gap-straddling pairs, 24 blanked accumulators and 3
 * stale rows, and a manager reading "11 unexplained" deserves to know 224 more
 * were never looked at.
 */
function classifyPairs(account, distrusted, maxGapDays) {
  const reconciled = [];
  const unexplained = [];
  const skipped = [];

  for (let index = 1; index < account.series.length; index += 1) {
    const previous = account.series[index - 1];
    const current = account.series[index];
    const context = { from: previous.date, to: current.date };

    if (daysBetween(previous.date, current.date) > maxGapDays) {
      // Not a day-over-day comparison. Across a 9- or 15-day hole the weekly
      // accumulator has restarted an unknown number of times and whatever the
      // balance did in between is unobserved.
      skipped.push({ ...context, reason: PAIR_SKIPPED.GAP });
      continue;
    }
    if (distrusted.has(current.date) || distrusted.has(previous.date)) {
      skipped.push({ ...context, reason: PAIR_SKIPPED.CLOSE_DISTRUSTED });
      continue;
    }

    const moved = round2(current.balance - previous.balance);
    const sameWeek = weekStart(previous.date) === weekStart(current.date);

    // The accumulator dropped to exactly 0 in the middle of a week it was
    // already running in. That is the importer blanking the column, not a week
    // that suddenly earned nothing: 22 accounts on 2026-07-24 and 2 on 07-30.
    // Note the guard is `previous.weekly !== 0` — on Monday a 0 is the honest
    // value, and treating it as blanked would have thrown away the one real
    // movement on the book (2837222 drained to zero on Tuesday 2026-07-21 with
    // weekly legitimately 0 on both sides).
    if (sameWeek && current.weekly === 0 && previous.weekly !== 0) {
      skipped.push({ ...context, reason: PAIR_SKIPPED.ACCUMULATOR_BLANKED });
      continue;
    }

    // The earlier close repeats an older row verbatim from a different ISO week,
    // so its accumulator belongs to that other week and the delta is meaningless.
    // 3 pairs on the real book, all of them accounts whose 2026-07-22 row is a
    // byte-for-byte copy of their 2026-07-13 row.
    const staleSource = account.series.slice(0, index - 1).some((older) => (
      older.balance === previous.balance
      && older.weekly === previous.weekly
      && older.gross === previous.gross
      && weekStart(older.date) !== weekStart(previous.date)
    ));
    if (staleSource && previous.weekly !== 0) {
      skipped.push({ ...context, reason: PAIR_SKIPPED.STALE_ROW });
      continue;
    }

    const expected = round2(expectedDelta(previous, current));
    const residual = round2(moved - expected);

    if (Math.abs(residual) < CENT) {
      reconciled.push({
        ...context,
        moved,
        netPnl: expected,
        gross: round2(current.gross),
        // Gross minus what reached the balance, classified rather than summed.
        // See gapKind: on this book the gap is a per-contract commission on some
        // accounts, exactly zero on more of them, and occasionally the wrong
        // sign, so one total would be three different things added together.
        gap: current.gross === 0 ? null : round2(current.gross - moved),
        gapKind: gapKindOf(current.gross, moved),
      });
      continue;
    }

    if (Math.abs(moved) < ZERO) {
      // The accumulator moved and the balance did not. Nothing to explain — a
      // balance that did not change cannot be a capital movement — so this is a
      // stale balance column, not a candidate.
      skipped.push({ ...context, reason: PAIR_SKIPPED.STALE_ROW });
      continue;
    }

    unexplained.push({
      ...context,
      balanceBefore: round2(previous.balance),
      balanceAfter: round2(current.balance),
      moved,
      explainedByTrading: expected,
      // Signed: positive means the balance rose by more than trading accounts
      // for, negative means it fell by more.
      amount: residual,
      direction: residual > 0 ? 'in' : 'out',
    });
  }

  return { reconciled, unexplained, skipped };
}

/**
 * Unexplained movements that offset each other to the cent, same client, same
 * close.
 *
 * This is the only classification this module is willing to make, and it is
 * made because the evidence is arithmetic rather than inferred: on 2026-07-21
 * Ellis Pine's cash account 2837222 went 98,219.80 -> 0.00 and their cash
 * account 9199785 gained exactly 98,219.80 on the same close. An account
 * emptied into another account of the same client is a consolidation, and no
 * trading loss produces a matching gain somewhere else to the cent.
 *
 * Same client is required. An offsetting-pair scan without it returns two more
 * matches on this book and both are coincidence — a ±1,536.28 on 2026-07-22
 * between unrelated clients, where 1,536.28 is a routine bullet-bot daily P&L
 * that appears across dozens of accounts that week.
 */
function pairTransfers(unexplained) {
  const transfers = [];
  const consumed = new Set();

  for (let i = 0; i < unexplained.length; i += 1) {
    if (consumed.has(i)) continue;
    for (let j = i + 1; j < unexplained.length; j += 1) {
      if (consumed.has(j)) continue;
      const a = unexplained[i];
      const b = unexplained[j];
      if (a.to !== b.to) continue;
      if (a.clientId !== b.clientId) continue;
      if (Math.abs(a.amount + b.amount) > CENT) continue;
      const out = a.amount < 0 ? a : b;
      const into = a.amount < 0 ? b : a;
      transfers.push({
        date: a.to,
        amount: round2(Math.abs(a.amount)),
        clientId: a.clientId,
        clientName: a.clientName,
        from: { accountName: out.accountName, segment: out.segment, balanceAfter: out.balanceAfter },
        to: { accountName: into.accountName, segment: into.segment, balanceAfter: into.balanceAfter },
        // Derived from two balances that cancel, not read from a transfer
        // record. There is no such record anywhere in the schema.
        evidence: 'offsetting-balances',
      });
      consumed.add(i);
      consumed.add(j);
      break;
    }
  }
  return { transfers, consumed };
}

function emptyGap() {
  return {
    pairs: 0,
    accounts: 0,
    // Deliberately four buckets and no total. See gapKindOf.
    cost: { pairs: 0, amount: 0 },
    exact: { pairs: 0, amount: 0 },
    against: { pairs: 0, amount: 0 },
    balanceFrozen: { pairs: 0, amount: 0 },
    total: null,
  };
}

function roundGap(gap) {
  for (const kind of ['cost', 'exact', 'against', 'balanceFrozen']) {
    gap[kind].amount = round2(gap[kind].amount);
  }
  return gap;
}

function emptyBlock(segment) {
  const moneyKind = moneyKindFor(segment);
  return {
    segment,
    countedInTotal: !EXCLUDED_FROM_TOTAL.has(segment),
    moneyKind,
    held: {
      moneyKind,
      // The raw sum of last-observed balances. Named for what it is — an
      // observation — so that reading it does not imply it is money.
      balanceObserved: 0,
      // Filled in at the finalisation step, and ONLY for client cash. Every
      // other segment gets null here and its reason in capitalRefusal.
      capital: null,
      planSize: null,
      capitalRefusal: moneyKind === MONEY_KINDS.CLIENT_CASH ? null : CAPITAL_REFUSALS[moneyKind],
      accounts: 0,
      accountsWithoutBalance: 0,
      atLatestClose: { balanceObserved: 0, capital: null, accounts: 0 },
      asOfDates: [],
      staleness: { current: 0, withinThreeDays: 0, withinSevenDays: 0, older: 0 },
    },
    composition: { byStatus: [], bySegment: [], largest: [] },
    movement: {
      tradingPnl: null,
      // Only the desk roll-up fills this: one entry per segment, never netted.
      tradingPnlBySegment: [],
      grossToBalanceGap: null,
      transfers: [],
      unexplained: [],
      unexplainedTotals: { in: 0, out: 0, accounts: 0 },
      payouts: null,
      moneyIn: null,
      funded: null,
    },
    coverage: {
      accountsWithSeries: 0,
      accountsWithComparablePairs: 0,
      accountsNotComparable: 0,
      pairsCompared: 0,
      pairsReconciled: 0,
      pairsSkipped: { gap: 0, closeDistrusted: 0, accumulatorBlanked: 0, staleRow: 0 },
    },
    timeline: [],
  };
}

/**
 * The capital detail behind one tile.
 *
 * `clients` is the CRM state's client array. `segment` selects one of SEGMENTS;
 * omitted, every segment is returned and `desk` holds the roll-up.
 */
export function buildCapitalDetail(clients = [], {
  asOfDate = '',
  segment = null,
  maxGapDays = 3,
  minCloseCohort = 8,
  minCloseReconciliation = 0.5,
  largestCount = 6,
} = {}) {
  const bound = day(asOfDate);
  const { accounts, closes } = collectAccounts(clients, bound);
  const latestClose = closes.length ? closes[closes.length - 1] : null;
  const { perClose, distrusted } = distrustedCloses(accounts, {
    maxGapDays, minCloseCohort, minCloseReconciliation,
  });

  const blocks = new Map();
  const blockFor = (name) => {
    if (!blocks.has(name)) blocks.set(name, emptyBlock(name));
    return blocks.get(name);
  };

  const allUnexplained = [];
  const timelines = new Map();
  const timelineFor = (name, date) => {
    if (!timelines.has(name)) timelines.set(name, new Map());
    const perDate = timelines.get(name);
    if (!perDate.has(date)) {
      perDate.set(date, {
        date,
        accounts: 0,
        balanceObserved: 0,
        netPnl: 0,
        netPnlAccounts: 0,
        unexplainedAmount: 0,
        unexplainedAccounts: 0,
        trusted: !distrusted.has(date),
      });
    }
    return perDate.get(date);
  };

  const heldRows = [];

  for (const account of accounts) {
    const block = blockFor(account.segment);
    const last = account.series[account.series.length - 1] || null;

    if (!last) {
      // No close has ever carried this account. It contributes no balance and it
      // is NOT counted as zero — 44 accounts on the real book are in this state
      // and a zero for each would understate nothing and overstate the account
      // count of every figure that follows.
      block.held.accountsWithoutBalance += 1;
      continue;
    }

    block.held.accounts += 1;
    block.held.balanceObserved += last.balance;
    const staleDays = latestClose ? daysBetween(last.date, latestClose) : 0;
    if (staleDays <= 0) {
      block.held.staleness.current += 1;
      block.held.atLatestClose.accounts += 1;
      block.held.atLatestClose.balanceObserved += last.balance;
    } else if (staleDays <= 3) block.held.staleness.withinThreeDays += 1;
    else if (staleDays <= 7) block.held.staleness.withinSevenDays += 1;
    else block.held.staleness.older += 1;

    heldRows.push({
      segment: account.segment,
      accountName: account.accountName,
      clientName: account.clientName,
      balance: round2(last.balance),
      asOf: last.date,
      staleDays,
      status: account.meta?.status || '',
      accountType: account.meta?.accountType || '',
    });

    for (const point of account.series) {
      const cell = timelineFor(account.segment, point.date);
      cell.accounts += 1;
      cell.balanceObserved += point.balance;
    }

    const { reconciled, unexplained, skipped } = classifyPairs(account, distrusted, maxGapDays);
    block.coverage.accountsWithSeries += 1;
    if (reconciled.length + unexplained.length > 0) block.coverage.accountsWithComparablePairs += 1;
    else block.coverage.accountsNotComparable += 1;
    block.coverage.pairsCompared += reconciled.length + unexplained.length;
    block.coverage.pairsReconciled += reconciled.length;
    for (const item of skipped) block.coverage.pairsSkipped[item.reason] += 1;

    for (const pair of reconciled) {
      const cell = timelineFor(account.segment, pair.to);
      cell.netPnl += pair.netPnl;
      cell.netPnlAccounts += 1;
      if (!block.movement.tradingPnl) {
        block.movement.tradingPnl = { net: 0, accounts: 0, pairs: 0, from: pair.from, to: pair.to };
      }
      const pnl = block.movement.tradingPnl;
      pnl.net += pair.netPnl;
      pnl.pairs += 1;
      if (pair.from < pnl.from) pnl.from = pair.from;
      if (pair.to > pnl.to) pnl.to = pair.to;

      if (pair.gap !== null) {
        if (!block.movement.grossToBalanceGap) block.movement.grossToBalanceGap = emptyGap();
        const gapRow = block.movement.grossToBalanceGap;
        gapRow.pairs += 1;
        gapRow[pair.gapKind].pairs += 1;
        gapRow[pair.gapKind].amount += pair.gap;
      }
    }
    if (reconciled.length) block.movement.tradingPnl.accounts += 1;
    if (reconciled.some((pair) => pair.gap !== null)) block.movement.grossToBalanceGap.accounts += 1;

    for (const pair of unexplained) {
      allUnexplained.push({
        ...pair,
        key: account.key,
        segment: account.segment,
        accountName: account.accountName,
        clientId: account.clientId,
        clientName: account.clientName,
        accountType: account.meta?.accountType || '',
        status: account.meta?.status || '',
      });
    }
  }

  const { transfers, consumed } = pairTransfers(allUnexplained);
  allUnexplained.forEach((item, index) => {
    if (consumed.has(index)) {
      const block = blockFor(item.segment);
      const already = block.movement.transfers.some((row) => (
        row.date === item.to && Math.abs(row.amount - Math.abs(item.amount)) < CENT
      ));
      if (!already) {
        const match = transfers.find((row) => row.date === item.to
          && Math.abs(row.amount - Math.abs(item.amount)) < CENT);
        if (match) block.movement.transfers.push(match);
      }
      return;
    }
    const block = blockFor(item.segment);
    block.movement.unexplained.push(item);
    if (item.amount > 0) block.movement.unexplainedTotals.in += item.amount;
    else block.movement.unexplainedTotals.out += item.amount;
    const cell = timelineFor(item.segment, item.to);
    cell.unexplainedAmount += item.amount;
    cell.unexplainedAccounts += 1;
  });

  // Payouts. Authoritative where a human entered one, "unrecorded" everywhere
  // else — never 0.
  //
  // On the real book that distinction is the whole answer. payout_events holds
  // 11 approved payouts worth $30,200 across 5 accounts, and all 5 belong to
  // clients carrying deleted_at, which buildCrmStateFromTables filters out of
  // the state before anything renders. So of the 601 accounts a manager can
  // actually see, the number with a recorded payout is ZERO — not because
  // nobody was paid, but because no payout was ever written down against an
  // account still in view. A tile reading "$0 paid out" would be a lie in the
  // most expensive direction.
  for (const account of accounts) {
    const block = blockFor(account.segment);
    if (!block.movement.payouts) {
      block.movement.payouts = {
        recorded: null,
        accountsWithHistory: 0,
        accountsWithoutHistory: 0,
        accountsUnresolved: 0,
        eventsInsideWindow: 0,
        pending: null,
      };
    }
    const payouts = block.movement.payouts;
    if (!account.meta) {
      // A snapshot with no account row behind it. There is nothing that could
      // hold a payout history, so it is not counted as an account missing one.
      payouts.accountsUnresolved += 1;
      continue;
    }
    const history = (account.meta.payoutHistory || [])
      .filter((event) => !bound || day(event?.date) <= bound);
    if (!history.length) {
      payouts.accountsWithoutHistory += 1;
      continue;
    }
    payouts.accountsWithHistory += 1;
    for (const event of history) {
      const amount = Number(event?.amount || 0);
      const date = day(event?.date);
      const approved = String(event?.state || '').toLowerCase().includes('approved');
      if (!approved) {
        // Requested is not paid. Counted separately so a pending request never
        // lands inside a figure headed "paid out".
        payouts.pending = payouts.pending || { amount: 0, events: 0 };
        payouts.pending.amount += amount;
        payouts.pending.events += 1;
        continue;
      }
      payouts.recorded = payouts.recorded || {
        amount: 0, events: 0, accounts: 0, firstDate: date, lastDate: date,
      };
      payouts.recorded.amount += amount;
      payouts.recorded.events += 1;
      if (date < payouts.recorded.firstDate) payouts.recorded.firstDate = date;
      if (date > payouts.recorded.lastDate) payouts.recorded.lastDate = date;
      if (closes.length && date >= closes[0] && date <= (latestClose || date)) {
        payouts.eventsInsideWindow += 1;
      }
    }
    if (payouts.recorded) payouts.recorded.accounts += 1;
  }

  // Funding: counted where a human recorded a date, never given an amount.
  //
  // `amount` is null by construction, not by accident. The only per-account
  // opening figure is start_balance, and on a prop account that is the plan
  // size the firm simulates (195 accounts hold exactly 50,000), not money the
  // desk put in; on cash accounts, where it would mean a deposit, 0 of 53 carry
  // one. All 7 date_funded values on the book belong to soft-deleted clients,
  // so in the state the CRM renders this count is 0 of 601 — which the UI must
  // say as "no funding date recorded", never as "nothing was funded".
  for (const account of accounts) {
    const block = blockFor(account.segment);
    if (!block.movement.funded) {
      block.movement.funded = {
        accountsWithFundedDate: 0,
        accounts: 0,
        firstDate: null,
        lastDate: null,
        amount: null,
      };
    }
    const funded = block.movement.funded;
    if (!account.meta) continue;
    funded.accounts += 1;
    const date = day(account.meta.dateFunded);
    if (!date) continue;
    if (bound && date > bound) continue;
    funded.accountsWithFundedDate += 1;
    if (!funded.firstDate || date < funded.firstDate) funded.firstDate = date;
    if (!funded.lastDate || date > funded.lastDate) funded.lastDate = date;
  }

  // Composition and rounding.
  for (const block of blocks.values()) {
    const rows = heldRows.filter((row) => row.segment === block.segment);
    const byStatus = new Map();
    const byDate = new Map();
    for (const row of rows) {
      const status = row.status || 'No status';
      const statusRow = byStatus.get(status) || { status, accounts: 0, balance: 0 };
      statusRow.accounts += 1;
      statusRow.balance += row.balance;
      byStatus.set(status, statusRow);

      const dateRow = byDate.get(row.asOf) || { date: row.asOf, accounts: 0, balance: 0 };
      dateRow.accounts += 1;
      dateRow.balance += row.balance;
      byDate.set(row.asOf, dateRow);
    }
    // `balance`, not `capital`. These rows are a sum of observed balances; only
    // the client-cash block is entitled to call that capital, and it does so
    // once, on held.capital, where the refusal for every other kind sits beside
    // it. A column named `capital` on every block is how a plan size gets
    // printed as money by a renderer that never asked what kind it was.
    block.composition.byStatus = [...byStatus.values()]
      .map((row) => ({ ...row, balance: round2(row.balance) }))
      .sort((a, b) => b.balance - a.balance);
    block.held.asOfDates = [...byDate.values()]
      .map((row) => ({ ...row, balance: round2(row.balance) }))
      .sort((a, b) => b.date.localeCompare(a.date));
    block.composition.largest = rows
      .slice()
      .sort((a, b) => b.balance - a.balance)
      .slice(0, largestCount);

    block.held.balanceObserved = round2(block.held.balanceObserved);
    block.held.atLatestClose.balanceObserved = round2(block.held.atLatestClose.balanceObserved);
    // The one place a balance becomes capital, and it is one segment kind wide.
    const isCash = block.moneyKind === MONEY_KINDS.CLIENT_CASH;
    block.held.capital = isCash ? block.held.balanceObserved : null;
    block.held.atLatestClose.capital = isCash
      ? block.held.atLatestClose.balanceObserved
      : null;
    block.held.planSize = block.moneyKind === MONEY_KINDS.PROP_PLAN_SIZE
      ? block.held.balanceObserved
      : null;
    block.movement.unexplainedTotals.in = round2(block.movement.unexplainedTotals.in);
    block.movement.unexplainedTotals.out = round2(block.movement.unexplainedTotals.out);
    block.movement.unexplainedTotals.accounts = new Set(
      block.movement.unexplained.map((row) => row.key),
    ).size;
    block.movement.unexplained.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
    if (block.movement.tradingPnl) {
      block.movement.tradingPnl.net = round2(block.movement.tradingPnl.net);
      // Which share of the segment this P&L actually covers. On the real book
      // the Unclassified segment's figure rests on 2 accounts of 74 — true for
      // those two, worthless as a segment total, and the only way a reader can
      // tell is if the number is on the screen next to it.
      block.movement.tradingPnl.coverageShare = block.held.accounts
        ? block.movement.tradingPnl.accounts / block.held.accounts
        : null;
    }
    if (block.movement.grossToBalanceGap) roundGap(block.movement.grossToBalanceGap);
    if (block.movement.payouts?.recorded) {
      block.movement.payouts.recorded.amount = round2(block.movement.payouts.recorded.amount);
    }

    const perDate = timelines.get(block.segment) || new Map();
    let running = 0;
    block.timeline = [...perDate.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((cell) => {
        running += cell.netPnl;
        return {
          ...cell,
          balanceObserved: round2(cell.balanceObserved),
          netPnl: round2(cell.netPnl),
          unexplainedAmount: round2(cell.unexplainedAmount),
          cumulativeNetPnl: round2(running),
          // Coverage is on the row because the capital line is only comparable
          // between two closes that saw the same accounts. On this book
          // 2026-07-13 carried 438 snapshots and 2026-07-14 carried 75; a chart
          // without this reads as a collapse in capital that never happened.
          coverage: block.held.accounts ? cell.accounts / block.held.accounts : null,
        };
      });
  }

  const segments = [...blocks.values()]
    .sort((a, b) => b.held.balanceObserved - a.held.balanceObserved);
  const counted = segments.filter((block) => block.countedInTotal);
  const desk = rollUp(counted, timelines, distrusted);
  // THERE IS NO shareOfDesk, AND THERE IS NO DESK CAPITAL TO BE A SHARE OF.
  //
  // It used to read `block.held.capital / desk.held.capital * 100`, so the cash
  // segment was reported as "5.89% of the desk" — 5.89% of a total that was
  // 93.93% simulated plan size. There is no defensible whole here: the cash
  // block is client money, the prop blocks are a product the firm sells, and a
  // percentage of the two added together describes nothing. What replaces it is
  // the composition list below, where every row carries its own money kind.
  //
  // The desk's composition is its segments, not its account statuses. A cash
  // account and a bullet-bot evaluation are different businesses, which is the
  // premise operationsSegments.js was written on.
  desk.composition.bySegment = counted
    .map((block) => ({
      segment: block.segment,
      accounts: block.held.accounts,
      // Each row carries its own kind and its own refusal, and no row is a share
      // of any other. A renderer must read moneyKind before it prints balance.
      moneyKind: block.moneyKind,
      balance: block.held.balanceObserved,
      capital: block.held.capital,
      capitalRefusal: block.held.capitalRefusal,
      // What this segment DID, which is the figure a prop pool is entitled to.
      netPnl: block.movement.tradingPnl ? block.movement.tradingPnl.net : null,
      netPnlAccounts: block.movement.tradingPnl ? block.movement.tradingPnl.accounts : 0,
      accountsWithoutBalance: block.held.accountsWithoutBalance,
    }))
    .sort((a, b) => b.balance - a.balance);

  return {
    asOfDate: latestClose,
    requestedAsOf: bound || null,
    closes,
    segment: segment || null,
    selected: segment ? (segments.find((block) => block.segment === segment) || emptyBlock(segment)) : desk,
    segments,
    excluded: segments.filter((block) => !block.countedInTotal),
    desk,
    reconciliationByClose: [...perClose.values()]
      .map((row) => ({ ...row, share: row.pairs ? row.reconciled / row.pairs : null }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    distrustedCloses: [...distrusted.values()].sort((a, b) => a.date.localeCompare(b.date)),
    declined: declinedFigures(desk, closes),
  };
}

/**
 * The desk, WITH NO DESK MONEY IN IT.
 *
 * This function used to add every counted segment's balance into one figure and
 * hand it to a tile headed "Capital held": $32,244,234.16 over 584 accounts, of
 * which $30,287,682.82 was prop plan size and at most $1,956,551.34 was money
 * anyone could withdraw. It also added the segments' trading P&L into one net,
 * which is a cash desk's result added to a prop desk's — the arithmetic that
 * printed the tile green on 2026-07-21 while the prop desk lost $5,505.46.
 *
 * What survives here is everything that is a COUNT (accounts, staleness,
 * coverage, close-pairs), the per-segment composition where each row carries its
 * own money kind, and the per-account movement lists, which are individual
 * observations rather than sums. Every cross-kind money field is null and says
 * why, so the panel prints a sentence where it used to print a number.
 */
function rollUp(blocks, timelines, distrusted) {
  const desk = emptyBlock('Desk');
  desk.countedInTotal = true;
  desk.moneyKind = MONEY_KINDS.UNKNOWN;
  desk.held.moneyKind = MONEY_KINDS.UNKNOWN;
  desk.held.capitalRefusal = 'The desk holds two kinds of money that must not be added: real '
    + 'client cash, and a plan size the prop firm simulates. There is no defensible total, so no '
    + 'total is produced — see the per-segment rows, each with its own kind.';
  const dates = new Map();

  for (const block of blocks) {
    desk.held.accounts += block.held.accounts;
    desk.held.accountsWithoutBalance += block.held.accountsWithoutBalance;
    desk.held.atLatestClose.accounts += block.held.atLatestClose.accounts;
    for (const key of Object.keys(desk.held.staleness)) {
      desk.held.staleness[key] += block.held.staleness[key];
    }
    for (const row of block.held.asOfDates) {
      // Accounts per close, never dollars per close. The dollars on one date are
      // cash and plan size added together.
      const cell = dates.get(row.date) || { date: row.date, accounts: 0 };
      cell.accounts += row.accounts;
      dates.set(row.date, cell);
    }
    for (const key of Object.keys(desk.coverage.pairsSkipped)) {
      desk.coverage.pairsSkipped[key] += block.coverage.pairsSkipped[key];
    }
    desk.coverage.accountsWithSeries += block.coverage.accountsWithSeries;
    desk.coverage.accountsWithComparablePairs += block.coverage.accountsWithComparablePairs;
    desk.coverage.accountsNotComparable += block.coverage.accountsNotComparable;
    desk.coverage.pairsCompared += block.coverage.pairsCompared;
    desk.coverage.pairsReconciled += block.coverage.pairsReconciled;

    if (block.movement.tradingPnl) {
      // Listed per segment, never netted into one. `desk.movement.tradingPnl`
      // stays null on purpose: adding the cash desk's result to the prop desk's
      // is the arithmetic this whole review was about.
      desk.movement.tradingPnlBySegment.push({
        segment: block.segment,
        moneyKind: block.moneyKind,
        net: block.movement.tradingPnl.net,
        accounts: block.movement.tradingPnl.accounts,
        pairs: block.movement.tradingPnl.pairs,
        from: block.movement.tradingPnl.from,
        to: block.movement.tradingPnl.to,
        coverageShare: block.movement.tradingPnl.coverageShare,
      });
    }
    if (block.movement.grossToBalanceGap) {
      const gap = desk.movement.grossToBalanceGap || emptyGap();
      gap.pairs += block.movement.grossToBalanceGap.pairs;
      gap.accounts += block.movement.grossToBalanceGap.accounts;
      for (const kind of ['cost', 'exact', 'against', 'balanceFrozen']) {
        gap[kind].pairs += block.movement.grossToBalanceGap[kind].pairs;
        gap[kind].amount += block.movement.grossToBalanceGap[kind].amount;
      }
      desk.movement.grossToBalanceGap = gap;
    }
    if (block.movement.payouts) {
      const payouts = desk.movement.payouts || {
        recorded: null, accountsWithHistory: 0, accountsWithoutHistory: 0,
        accountsUnresolved: 0, eventsInsideWindow: 0, pending: null,
      };
      payouts.accountsWithHistory += block.movement.payouts.accountsWithHistory;
      payouts.accountsWithoutHistory += block.movement.payouts.accountsWithoutHistory;
      payouts.accountsUnresolved += block.movement.payouts.accountsUnresolved;
      payouts.eventsInsideWindow += block.movement.payouts.eventsInsideWindow;
      if (block.movement.payouts.recorded) {
        const recorded = payouts.recorded || {
          amount: 0, events: 0, accounts: 0,
          firstDate: block.movement.payouts.recorded.firstDate,
          lastDate: block.movement.payouts.recorded.lastDate,
        };
        recorded.amount += block.movement.payouts.recorded.amount;
        recorded.events += block.movement.payouts.recorded.events;
        recorded.accounts += block.movement.payouts.recorded.accounts;
        if (block.movement.payouts.recorded.firstDate < recorded.firstDate) {
          recorded.firstDate = block.movement.payouts.recorded.firstDate;
        }
        if (block.movement.payouts.recorded.lastDate > recorded.lastDate) {
          recorded.lastDate = block.movement.payouts.recorded.lastDate;
        }
        payouts.recorded = recorded;
      }
      if (block.movement.payouts.pending) {
        const pending = payouts.pending || { amount: 0, events: 0 };
        pending.amount += block.movement.payouts.pending.amount;
        pending.events += block.movement.payouts.pending.events;
        payouts.pending = pending;
      }
      desk.movement.payouts = payouts;
    }
    if (block.movement.funded) {
      const funded = desk.movement.funded || {
        accountsWithFundedDate: 0, accounts: 0, firstDate: null, lastDate: null, amount: null,
      };
      funded.accountsWithFundedDate += block.movement.funded.accountsWithFundedDate;
      funded.accounts += block.movement.funded.accounts;
      if (block.movement.funded.firstDate
        && (!funded.firstDate || block.movement.funded.firstDate < funded.firstDate)) {
        funded.firstDate = block.movement.funded.firstDate;
      }
      if (block.movement.funded.lastDate
        && (!funded.lastDate || block.movement.funded.lastDate > funded.lastDate)) {
        funded.lastDate = block.movement.funded.lastDate;
      }
      desk.movement.funded = funded;
    }

    for (const transfer of block.movement.transfers) {
      const already = desk.movement.transfers.some((row) => row.date === transfer.date
        && Math.abs(row.amount - transfer.amount) < CENT
        && row.from.accountName === transfer.from.accountName);
      if (!already) desk.movement.transfers.push(transfer);
    }
    desk.movement.unexplained.push(...block.movement.unexplained);
  }

  desk.held.asOfDates = [...dates.values()].sort((a, b) => b.date.localeCompare(a.date));
  desk.movement.unexplained.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  desk.movement.unexplainedTotals = {
    // A count, which is the only part of this that is comparable across kinds.
    // `in` and `out` are per segment; at desk level they would be a cash
    // withdrawal added to a prop plan-size adjustment.
    in: null,
    out: null,
    accounts: new Set(desk.movement.unexplained.map((row) => row.key)).size,
  };
  desk.movement.tradingPnlBySegment.sort((a, b) => a.net - b.net);
  if (desk.movement.grossToBalanceGap) roundGap(desk.movement.grossToBalanceGap);
  if (desk.movement.payouts?.recorded) {
    desk.movement.payouts.recorded.amount = round2(desk.movement.payouts.recorded.amount);
  }

  const counted = new Set(blocks.map((block) => block.segment));
  const merged = new Map();
  for (const [name, perDate] of timelines) {
    if (!counted.has(name)) continue;
    for (const cell of perDate.values()) {
      // Counts only. The money columns of these cells are deliberately not
      // accumulated: one date's balances and P&L across segments are client cash
      // and prop plan size added together.
      const row = merged.get(cell.date) || {
        date: cell.date, accounts: 0, netPnlAccounts: 0, unexplainedAccounts: 0,
        trusted: !distrusted.has(cell.date),
      };
      row.accounts += cell.accounts;
      row.netPnlAccounts += cell.netPnlAccounts;
      row.unexplainedAccounts += cell.unexplainedAccounts;
      merged.set(cell.date, row);
    }
  }
  desk.timeline = [...merged.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((cell) => ({
      date: cell.date,
      accounts: cell.accounts,
      netPnlAccounts: cell.netPnlAccounts,
      unexplainedAccounts: cell.unexplainedAccounts,
      trusted: cell.trusted,
      // Nulled, not omitted, so a renderer reaching for them finds an explicit
      // refusal rather than undefined. Each of these adds client cash to a
      // simulated plan size across the segments that reported on the date.
      balanceObserved: null,
      netPnl: null,
      cumulativeNetPnl: null,
      unexplainedAmount: null,
      coverage: desk.held.accounts ? cell.accounts / desk.held.accounts : null,
    }));
  desk.timelineRefusal = 'One line for the desk would add the cash desk\u2019s result to the prop '
    + 'desk\u2019s. Open a segment to see its own line.';

  return desk;
}

/**
 * The figures this module will not produce, with the reason, so the UI states
 * them instead of rendering a 0.
 *
 * Every one of these was checked against the real book before being refused.
 */
function declinedFigures(desk, closes) {
  const window = closes.length
    ? `${closes[0]} to ${closes[closes.length - 1]}`
    : 'the observed closes';
  const payouts = desk.movement.payouts;
  const withHistory = payouts?.accountsWithHistory ?? 0;
  const withoutHistory = payouts?.accountsWithoutHistory ?? 0;
  const gap = desk.movement.grossToBalanceGap;
  const rows = [
    {
      figure: 'One capital figure for the desk',
      value: null,
      reason: 'The desk holds two kinds of money. Cash accounts are real client money; a prop '
        + 'account balance is the plan size the firm simulates, which nobody deposited and nobody '
        + 'can withdraw. This module used to add them into $32,244,234.16 of "capital held", '
        + '93.93% of which was that plan size. Each segment now reports its own kind, and the '
        + 'rows are never summed.',
    },
    {
      figure: 'Money in — deposits, withdrawals, funding fees',
      value: null,
      reason: 'No deposit, withdrawal, funding-fee or transfer amount exists in any of the 19 '
        + 'tables. The only money fields on the whole schema are clients.subscription_price, '
        + 'trading_accounts.start_balance, account_snapshots.account_balance, payout_events.amount '
        + 'and instrument prices. What came in was never recorded, so it cannot be reported as 0.',
    },
    {
      figure: 'Capital funded, in dollars',
      value: null,
      reason: 'start_balance is the plan size the prop firm simulates, not desk money — 195 '
        + 'accounts carry exactly 50,000 — and 0 of the 53 cash accounts, where it would mean a '
        + 'real deposit, have one at all. '
        + `${desk.movement.funded?.accountsWithFundedDate ?? 0} of `
        + `${desk.movement.funded?.accounts ?? 0} accounts in view carry a funding date, so even `
        + 'the count of funding events is not reportable.',
    },
    {
      figure: 'Payouts paid, and payouts over time',
      value: null,
      reason: withHistory
        ? `${withHistory} account${withHistory === 1 ? '' : 's'} carry a recorded payout and `
          + `${withoutHistory} do not. The recorded ones are authoritative — a human entered them — `
          + `but ${payouts.eventsInsideWindow} of them fall inside ${window}, so payouts cannot be `
          + 'placed on this timeline or cross-checked against a balance drop.'
        : `Not one of the ${withoutHistory} accounts in view has a payout recorded against it. `
          + 'payout_events does hold 11 approved payouts worth $30,200, but all 5 of its accounts '
          + 'belong to clients carrying deleted_at, which the CRM state filters out before '
          + 'anything renders. The payout history of every account on screen is unrecorded — '
          + 'which is not the same as nobody having been paid.',
    },
    {
      figure: 'What the unexplained movements are',
      value: null,
      reason: `${desk.movement.unexplained.length} balance change`
        + `${desk.movement.unexplained.length === 1 ? '' : 's'} across `
        + `${desk.movement.unexplainedTotals.accounts} account`
        + `${desk.movement.unexplainedTotals.accounts === 1 ? '' : 's'} do not reconcile against `
        + 'the weekly accumulator. None carries a second signal — no payout row, no offsetting '
        + 'account, no status change on the same date — so a withdrawal cannot be told apart from '
        + 'a trading loss the accumulator missed. They are listed, never labelled.',
    },
    {
      figure: 'A single as-of date for held capital',
      value: null,
      reason: "Held capital is each account's last observed balance, and those land on "
        + `${desk.held.asOfDates.length} different closes. `
        + `${desk.held.accounts - desk.held.atLatestClose.accounts} of ${desk.held.accounts} `
        + 'accounts did not report on the latest close, so their balance is carried forward, not '
        + 'refreshed.',
    },
  ];

  if (gap) {
    rows.push({
      figure: 'Commissions paid',
      value: null,
      reason: `Of ${gap.pairs} close-pairs that reported a gross P&L, ${gap.cost.pairs} show the `
        + `balance moving less than gross (a cost), ${gap.exact.pairs} show gross and the balance `
        + `agreeing exactly — no commission is visible in the data at all for those — and `
        + `${gap.against.pairs + gap.balanceFrozen.pairs} run the wrong way or sit against a `
        + 'frozen balance. One total would be three different things added together, so the four '
        + 'kinds are counted separately and the sum refused.',
    });
  }
  return rows;
}

export { accountKey, weekStart, expectedDelta };
