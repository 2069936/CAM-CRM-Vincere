// The algorithm leaderboards: one board per business, ranked by what an
// algorithm makes on an account-day, not by how widely it is deployed.
//
// WHY THIS FILE EXISTS. The Strategy Effectiveness Leaderboard sorted by total
// P&L. Every algorithm on this book loses, so total P&L ranked deployment size
// upside down: Spearman(total, account-days) = -0.807. The biggest deployment
// sorted LAST (Bullet Bot, 340 account-days over 117 accounts, -$32,220) and a
// two-observation algorithm sorted FIRST (ARPD_PF, 2 account-days, +$864). A
// desk manager reading that board top-down was reading a list of what the desk
// runs least, labelled "most effective".
//
// It was also not one business. Of the -$92,669.75 headline the board printed,
// 30.0% was not prop money at all - cash -$23,113.00, Ignored -$2,630.50,
// Unclassified -$2,082.00 - and the Bullet-Bot evaluations, a different business
// that passes or fails inside three days, were 27.8% of it and were ranked
// beside the ordinary algorithms.
//
// WHAT IT REFUSES TO PRODUCE:
//
//   * No composite score. There was a 0-10 one, min-max normalised against the
//     largest deployment, so the scale itself moved when the desk added
//     accounts.
//   * No rank without evidence. Fewer than 30 reported account-days or fewer
//     than 10 accounts and the row is listed with its counts and no rank. On
//     this book that unranks the row that used to sit at #1.
//   * No board total, and no figure that spans two boards. Cash is real client
//     money and a prop result is movement on a simulated plan size; Bullet Bot
//     is its own business. Each board states its own coverage rather than one
//     percentage over all of them.
//   * No sort by total P&L. It is on the board as an exposure column and the
//     rows are not ordered by it.
//
// THE STATISTICS. The mean is per REPORTED account-day and the interval around
// it is clustered on the account, because the same account contributes many
// days and those days are not independent draws. A non-overlapping-interval
// eyeball test would call only 32 of the 105 algorithm pairs on this book
// distinguishable; that test is over-conservative for exactly this comparison -
// a bootstrap interval on the DIFFERENCE of two means separates 77 of the 105
// (73%). Ranking is defensible with the gate on, and the intervals are printed
// so a reader can see which neighbours are close.

import { businessForSegment, segmentForAccount, BUSINESS_KEYS } from './operationsSegments';
import { DESK_BUSINESS_ORDER, bookCloses, deskBusinessColumns } from './deskMoney';

/**
 * The evidence a row needs before it is given a rank.
 *
 * Both arms are needed and neither is enough. 30 account-days off one account is
 * one account's luck measured thirty times; 10 accounts seen twice each is not a
 * measurement of anything. On this book the gate unranks 6 of the 15 rows the
 * old single board carried, including the rows that used to sit at #1, #2, #4,
 * #5 and #7.
 */
export const EVIDENCE_GATE = { minAccountDays: 30, minAccounts: 10 };

/** Two-sided 95%. Named rather than inlined so the interval's meaning is legible. */
const Z_95 = 1.959964;

const BOARD_NOTES = {
  [BUSINESS_KEYS.BULLET]: 'Prop evaluations run by the bullet bot - pass or fail inside days. '
    + 'Never ranked against the ordinary algorithms and never added to them.',
  [BUSINESS_KEYS.PROP_OTHER]: 'Funded and standard-evaluation prop accounts, plus any account '
    + 'type this build has not been taught, so a new type is ranked here rather than dropped.',
  [BUSINESS_KEYS.CASH]: 'Real client money. A dollar on this board is a dollar; a dollar on a '
    + 'prop board is movement against a plan size the firm simulates.',
  [BUSINESS_KEYS.UNCLASSIFIED]: 'Account-days on accounts nobody has classified yet. A '
    + 'classification backlog, not a business: rows here are never compared with a board above.',
};

const BOARD_KINDS = {
  [BUSINESS_KEYS.BULLET]: 'prop',
  [BUSINESS_KEYS.PROP_OTHER]: 'prop',
  [BUSINESS_KEYS.CASH]: 'cash',
  [BUSINESS_KEYS.UNCLASSIFIED]: 'backlog',
};

const CROSS_BOARD_REFUSAL = 'One coverage percentage across every board would add a cash desk’s '
  + 'real client money to a prop desk’s movement on a simulated plan size, and fold Bullet Bot '
  + 'into the ordinary algorithms on the way. Each board states its own instead.';

const TOTAL_PNL_NOTE = 'Total P&L is exposure, not performance: it grows with how widely an '
  + 'algorithm is deployed. The rows are not ordered by it - sorting by it is what ranked the '
  + 'desk’s largest deployment last.';

function day(value) {
  return String(value || '').slice(0, 10);
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/** `date` shifted by whole days, in the same YYYY-MM-DD form. UTC, so no DST edge. */
export function shiftDay(date, days) {
  const parsed = Date.parse(`${day(date)}T00:00:00Z`);
  if (Number.isNaN(parsed)) return '';
  return new Date(parsed + days * 86400000).toISOString().slice(0, 10);
}

/**
 * The measured P&L of one strategy row, or null when nothing measured it.
 *
 * Order of preference, best evidence first, and THERE IS NO THIRD SOURCE. This
 * used to fall through to the account's whole day divided evenly across whatever
 * was enabled, which its own comment called a fabrication. What it produced was
 * the same state rolling up two different ways: a grid that reported 0 for every
 * strategy on a day the account moved contributed 0, while a grid with no
 * Realized column at all - the same statement, "this export does not say" -
 * contributed an invented share instead. Which branch a row took depended on
 * whether NinjaTrader emitted a column, which is not a fact about the strategy.
 */
export function measuredPnl(strategy) {
  if (!strategy) return null;
  if (strategy.derivedRealized != null) return Number(strategy.derivedRealized);
  if (strategy.realized != null) return Number(strategy.realized);
  return null;
}

/**
 * The mean of the observations with a 95% interval clustered on the account.
 *
 * Account-days off one account are not independent draws: an account that is
 * flat for eleven straight days contributes eleven observations that all say the
 * same thing. Treating them as eleven independent draws shrinks the interval by
 * roughly sqrt(11) and would let a row look separated from its neighbour on
 * evidence it does not have. The cluster-robust variance sums each account's
 * total deviation first and only then squares it, so an account that is
 * consistently flat widens nothing.
 *
 * `halfWidth` is null below two clusters: a variance over one account is not an
 * interval, it is a single observation with an arithmetic decoration.
 */
export function clusteredMean(observations) {
  const n = observations.length;
  if (!n) return null;
  const mean = observations.reduce((sum, o) => sum + o.value, 0) / n;
  const byCluster = new Map();
  for (const o of observations) {
    byCluster.set(o.cluster, (byCluster.get(o.cluster) || 0) + (o.value - mean));
  }
  const clusters = byCluster.size;
  if (clusters < 2) return { mean, clusters, n, halfWidth: null, low: null, high: null };
  let sumSquares = 0;
  for (const deviation of byCluster.values()) sumSquares += deviation * deviation;
  // The G/(G-1) finite-sample correction. With ten clusters the uncorrected
  // interval is 5% too narrow, and ten clusters is exactly what the gate lets
  // through.
  const variance = (clusters / (clusters - 1)) * (sumSquares / (n * n));
  const halfWidth = Z_95 * Math.sqrt(variance);
  return { mean, clusters, n, halfWidth, low: mean - halfWidth, high: mean + halfWidth };
}

/**
 * Every (algorithm, account, close) the book measured, tagged with its business.
 *
 * ONE OBSERVATION PER ACCOUNT-DAY, not per strategy row. Two instances of the
 * same family enabled on one account on one day are one account-day and their
 * P&L is added; counting them twice prints 341 account-days where the desk has
 * 340, under a column headed "account-days".
 *
 * THE ACCOUNT IS (client, account name), not the name alone. 53 of the 631
 * account names in this book are held by two different clients, `accountRegistry`
 * is per client, and every other figure on the Operations screen already counts
 * those as two accounts. Counting them as one here undercounted Bullet Bot's
 * accounts by three and made its account-days and its accounts disagree.
 */
function collectObservations(clients, { throughDate }) {
  // key: `${business} ${algo}` -> row accumulator
  const rows = new Map();
  // Per board: the account-days it covers and what the ACCOUNTS made on them,
  // so each board can say how much of its own money no algorithm claims.
  const coverage = new Map();
  const clientsSeen = new Set();
  const dates = new Set();
  // Account-days that carry no measured algorithm at all, per board. They are in
  // no total, no mean and no interval, so they are counted separately.
  const unmeasured = new Map();
  // Closes that landed outside the four businesses - Ignored, orphan, simulated,
  // undetermined. Counted, never money.
  const reconciliation = new Map();

  for (const client of clients || []) {
    const registry = client?.accountRegistry || {};
    const clientKey = client?.id ?? client?.name ?? '';
    for (const dailyImport of client?.dailyImports || []) {
      const date = day(dailyImport?.date);
      if (!date) continue;
      if (throughDate && date > throughDate) continue;
      for (const snapshot of dailyImport?.snapshots || []) {
        // Fold this account-day's enabled strategies into one figure per family.
        const perFamily = new Map();
        for (const strategy of snapshot.strategies || []) {
          if (!strategy?.enabled) continue;
          const algo = strategy.strategyFamily || strategy.strategyName || 'Unknown';
          const pnl = measuredPnl(strategy);
          const entry = perFamily.get(algo) || { pnl: 0, measured: false };
          if (pnl != null) {
            entry.pnl += pnl;
            entry.measured = true;
          }
          perFamily.set(algo, entry);
        }
        // An account-day with nothing enabled is not this panel's subject. It is
        // not counted anywhere here, including in the reconciliation line, whose
        // denominator has to be the same population as the boards' or it reads
        // as a bigger exclusion than it is.
        if (!perFamily.size) continue;

        const segment = segmentForAccount(registry[snapshot.accountName], snapshot.accountName);
        const business = businessForSegment(segment);
        if (!business) {
          const seen = reconciliation.get(segment)
            || { segment, accountDays: 0, accounts: new Set() };
          seen.accountDays += 1;
          seen.accounts.add(`${clientKey} ${snapshot.accountName}`);
          reconciliation.set(segment, seen);
          continue;
        }
        const accountKey = `${clientKey} ${snapshot.accountName}`;

        dates.add(date);
        clientsSeen.add(clientKey);
        let measuredHere = false;
        for (const [algo, entry] of perFamily) {
          const key = `${business} ${algo}`;
          const row = rows.get(key) || {
            business,
            name: algo,
            observations: [],
            accounts: new Map(),
            clients: new Set(),
            unmeasuredAccountDays: 0,
            upDays: 0,
            downDays: 0,
            flatDays: 0,
            byDate: [],
          };
          // The roster is exact even where the P&L is not: this algorithm ran on
          // this account, and that was never in doubt.
          row.clients.add(clientKey);
          if (!row.accounts.has(accountKey)) row.accounts.set(accountKey, 0);
          if (entry.measured) {
            measuredHere = true;
            row.observations.push({ cluster: accountKey, value: entry.pnl });
            row.accounts.set(accountKey, row.accounts.get(accountKey) + entry.pnl);
            row.byDate.push({ date, pnl: entry.pnl });
            if (entry.pnl > 0) row.upDays += 1;
            else if (entry.pnl < 0) row.downDays += 1;
            else row.flatDays += 1;
          } else {
            row.unmeasuredAccountDays += 1;
          }
          rows.set(key, row);
        }

        const cover = coverage.get(business)
          || { accountDays: 0, accountPnl: 0, attributedPnl: 0 };
        if (measuredHere) {
          cover.accountDays += 1;
          cover.accountPnl += Number(snapshot.grossRealizedPnl || 0);
          for (const entry of perFamily.values()) {
            if (entry.measured) cover.attributedPnl += entry.pnl;
          }
          coverage.set(business, cover);
        } else {
          unmeasured.set(business, (unmeasured.get(business) || 0) + 1);
        }
      }
    }
  }

  return { rows, coverage, unmeasured, reconciliation, clientsSeen, dates };
}

function buildCoverage(cover, unmeasuredDays) {
  const accountDays = cover?.accountDays || 0;
  const accountPnl = round2(cover?.accountPnl || 0);
  const attributedPnl = round2(cover?.attributedPnl || 0);
  const unattributedPnl = round2(accountPnl - attributedPnl);
  return {
    accountDays,
    // What the ACCOUNTS on this board made over the very account-days the board
    // ranks. The comparison the board owes its reader: an algorithm's total
    // reads as the account's day unless the gap is stated.
    accountPnl,
    attributedPnl,
    unattributedPnl,
    unattributedShare: accountPnl === 0 ? null : round2((unattributedPnl / accountPnl) * 100),
    shareRefusal: accountPnl === 0
      ? 'The accounts on this board netted exactly zero over the days it covers, so an '
        + 'unattributed share would divide by zero.'
      : null,
    unmeasuredAccountDays: unmeasuredDays || 0,
  };
}

function finishRow(row) {
  const stats = clusteredMean(row.observations);
  const accountDays = row.observations.length;
  const accounts = row.accounts.size;
  const decided = row.upDays + row.downDays;
  const profitable = [...row.accounts.values()].filter((pnl) => pnl > 0).length;

  const reasons = [];
  if (accountDays < EVIDENCE_GATE.minAccountDays) {
    reasons.push(`${accountDays} reported account-day${accountDays === 1 ? '' : 's'}, `
      + `fewer than the ${EVIDENCE_GATE.minAccountDays} this board ranks on`);
  }
  if (accounts < EVIDENCE_GATE.minAccounts) {
    reasons.push(`${accounts} account${accounts === 1 ? '' : 's'}, fewer than the `
      + `${EVIDENCE_GATE.minAccounts} this board ranks on`);
  }

  return {
    name: row.name,
    business: row.business,
    // The figure the board is ordered by. Per REPORTED account-day, so the 976
    // account-days on this book that measured exactly 0 are in the denominator:
    // a flat day is a day the algorithm ran and made nothing, and dropping it
    // from the denominator flatters every algorithm that mostly sits still.
    meanPerAccountDay: accountDays ? round2(stats.mean) : null,
    ci: stats && stats.halfWidth != null
      ? {
        low: round2(stats.low),
        high: round2(stats.high),
        halfWidth: round2(stats.halfWidth),
        clusters: stats.clusters,
      }
      : null,
    ciRefusal: !accountDays
      ? 'Nothing measured this algorithm on this board.'
      : (stats && stats.halfWidth == null
        ? 'One account. An interval needs at least two so the spread between accounts can show.'
        : null),
    accountDays,
    accounts,
    clients: row.clients.size,
    // Three counts, all three printed. 976 of the 1,402 measured observations on
    // this book are exactly 0, and a board that showed only up and down days
    // could not tell a flat day from a day nobody reported.
    upDays: row.upDays,
    downDays: row.downDays,
    flatDays: row.flatDays,
    // Account-days this algorithm ran on where neither the fills nor the grid
    // said what it made. In no figure above.
    unmeasuredAccountDays: row.unmeasuredAccountDays,
    // Over DECIDED days only, and labelled that way wherever it is printed. The
    // flat count sits beside it so the denominator is visible.
    winRate: decided ? Math.round((row.upDays / decided) * 100) : null,
    decidedDays: decided,
    accountsProfitable: profitable,
    accountsProfitablePct: accounts ? Math.round((profitable / accounts) * 100) : null,
    // Exposure, never a sort key. See TOTAL_PNL_NOTE.
    totalPnl: round2(row.observations.reduce((sum, o) => sum + o.value, 0)),
    byDate: row.byDate,
    ranked: reasons.length === 0,
    rankRefusal: reasons.length ? `Not ranked: ${reasons.join('; ')}.` : null,
    rank: null,
  };
}

function windowSum(byDate, from, to) {
  let sum = 0;
  let days = 0;
  for (const entry of byDate) {
    if (entry.date >= from && entry.date <= to) {
      sum += entry.pnl;
      days += 1;
    }
  }
  return { sum: round2(sum), days };
}

/**
 * The boards.
 *
 * `asOfDate` pins the board the way it pins the tiles: the history runs to that
 * close and the seven-day windows end on it. With nothing pinned the anchor is
 * the book's newest close - NOT `new Date()`, which is what the old board used.
 * On 2026-08-20 over a book whose last close is 2026-07-30 that made "Last 7d"
 * and "Trend" read $0.00 for all fifteen rows, and an arrow printed up on every
 * one of them because the arrow tested `>= 0`.
 */
export function buildStrategyBoards(clients = [], { asOfDate = '' } = {}) {
  const list = clients || [];
  const book = bookCloses(list);
  const anchor = day(asOfDate) || book.latest || '';
  const { rows, coverage, unmeasured, reconciliation, clientsSeen, dates } =
    collectObservations(list, { throughDate: anchor });

  const recentFrom = anchor ? shiftDay(anchor, -6) : '';
  const priorFrom = anchor ? shiftDay(anchor, -13) : '';
  const priorTo = anchor ? shiftDay(anchor, -7) : '';

  const grouped = new Map();
  for (const row of rows.values()) {
    const finished = finishRow(row);
    const recent = anchor ? windowSum(row.byDate, recentFrom, anchor) : { sum: 0, days: 0 };
    const prior = anchor ? windowSum(row.byDate, priorFrom, priorTo) : { sum: 0, days: 0 };
    finished.recentPnl = recent.sum;
    finished.recentAccountDays = recent.days;
    finished.priorPnl = prior.sum;
    finished.priorAccountDays = prior.days;
    finished.trend = round2(recent.sum - prior.sum);
    // Three states, never two. `trend >= 0 ? up : down` printed an up arrow on
    // every row whose windows were both empty, which under the wall-clock anchor
    // was every row on the board.
    finished.trendDirection = finished.trend > 0 ? 'up' : finished.trend < 0 ? 'down' : 'flat';
    // A trend across two windows neither of which measured anything is not a
    // trend, and 0 is not "unchanged" when nothing was observed either side.
    finished.trendRefusal = recent.days === 0 && prior.days === 0
      ? `Neither the seven days to ${anchor} nor the seven before them measured this algorithm.`
      : null;
    delete finished.byDate;
    if (!grouped.has(finished.business)) grouped.set(finished.business, []);
    grouped.get(finished.business).push(finished);
  }

  const labels = new Map(deskBusinessColumns().map((column) => [column.key, column]));

  const boards = DESK_BUSINESS_ORDER.map((key) => {
    const boardRows = grouped.get(key) || [];
    // Ranked first, best mean first. Unranked after, most evidence first, so the
    // reader can see which rows are closest to earning a rank.
    const ranked = boardRows.filter((row) => row.ranked)
      .sort((a, b) => b.meanPerAccountDay - a.meanPerAccountDay);
    ranked.forEach((row, index) => { row.rank = index + 1; });
    const unranked = boardRows.filter((row) => !row.ranked)
      .sort((a, b) => b.accountDays - a.accountDays || a.name.localeCompare(b.name));
    return {
      key,
      label: labels.get(key)?.label || key,
      shortLabel: labels.get(key)?.shortLabel || key,
      kind: BOARD_KINDS[key],
      note: BOARD_NOTES[key],
      rows: [...ranked, ...unranked],
      rankedCount: ranked.length,
      unrankedCount: unranked.length,
      coverage: buildCoverage(coverage.get(key), unmeasured.get(key)),
      totalPnlNote: TOTAL_PNL_NOTE,
    };
  }).filter((board) => board.rows.length > 0);

  const closes = [...dates].sort();
  // Closes in the book up to the anchor, whether or not they carry an algorithm
  // split. The denominator: "13 closes" alone reads as the whole range, and the
  // range 2026-07-13 to 2026-07-30 holds 14.
  const closesToAnchor = book.closes.filter((date) => !anchor || date <= anchor);
  const reconciliationRows = [...reconciliation.values()]
    .map((entry) => ({
      segment: entry.segment,
      accountDays: entry.accountDays,
      accounts: entry.accounts.size,
    }))
    .sort((a, b) => b.accountDays - a.accountDays);

  return {
    basis: {
      anchor,
      requested: day(asOfDate) || null,
      firstClose: closes[0] || null,
      lastClose: closes[closes.length - 1] || null,
      // Closes that carry at least one algorithm split, and how many closes the
      // book holds up to the anchor. Both, always: the first alone reads as the
      // whole range.
      closeCount: closes.length,
      closesToAnchor: closesToAnchor.length,
      latestCloseInBook: book.latest,
      closesAfterAnchor: book.closes.filter((date) => anchor && date > anchor).length,
      clients: clientsSeen.size,
      clientsInScope: list.length,
      label: closes.length
        ? `Every close from ${closes[0]} to ${closes[closes.length - 1]} that carries an algorithm`
          + ` split · ${closes.length} of ${closesToAnchor.length} closes`
          + ` · ${clientsSeen.size} of ${list.length} clients`
          + ` · seven-day windows end ${anchor}`
        : 'No close on this book carries an algorithm split.',
    },
    boards,
    // Never added, never compared across. Stated on the object so a caller
    // rendering two boards side by side has the sentence to hand.
    boardsDoNotCompare: 'These boards are not one leaderboard split in three. A cash dollar is '
      + 'real client money, a prop dollar is movement against a plan size the firm simulates, '
      + 'and Bullet Bot passes or fails inside days. A row on one board is never ranked, '
      + 'compared or added against a row on another.',
    crossBoardCoverageRefusal: CROSS_BOARD_REFUSAL,
    reconciliation: {
      rows: reconciliationRows,
      accountDays: reconciliationRows.reduce((sum, row) => sum + row.accountDays, 0),
      note: 'Closes on accounts marked Inactive / Ignore, with no account on record, or not real '
        + 'money. On no board, in no total - counted here so the exclusion is visible.',
    },
    gate: {
      ...EVIDENCE_GATE,
      note: `A row needs ${EVIDENCE_GATE.minAccountDays} reported account-days AND `
        + `${EVIDENCE_GATE.minAccounts} accounts before it is given a rank. Below either it is `
        + 'listed with its counts and no position.',
    },
  };
}

/**
 * The figures these boards will not produce, and why, in the shape the capital
 * panel's refusal list already uses.
 *
 * Written here rather than in the component: every one of them is a statement
 * about the arithmetic, and a refusal that lives in the markup is one that
 * survives a rewrite of the markup and nothing else.
 */
export function boardRefusals(result) {
  const boards = result?.boards || [];
  const unranked = boards.reduce((sum, board) => sum + board.unrankedCount, 0);
  const ranked = boards.reduce((sum, board) => sum + board.rankedCount, 0);
  return [
    {
      figure: 'One leaderboard for the desk',
      value: null,
      reason: 'There was one, over every account the desk holds. 30.0% of the P&L it ranked '
        + 'algorithms by was not prop money — cash, accounts marked Inactive / Ignore, and '
        + 'accounts nobody has classified — and the Bullet-Bot evaluations, which pass or fail '
        + 'inside three days, were 27.8% of it and sat in the same list as the ordinary '
        + `algorithms. There are ${boards.length} boards now and no figure spans two of them.`,
    },
    {
      figure: 'A rank ordered by total P&L',
      value: null,
      reason: 'Total P&L grows with deployment, and on a book where every algorithm loses it '
        + 'ranks deployment upside down: Spearman(total, account-days) = -0.807, the desk’s '
        + 'largest deployment sorted last and a two-observation algorithm sorted first. The '
        + 'column is still here, as exposure, and nothing is sorted by it.',
    },
    {
      figure: 'A composite effectiveness score',
      value: null,
      reason: 'The old one was 0-10, min-max normalised against the largest absolute total on '
        + 'the board, so the scale moved when the desk added accounts and a score could not be '
        + 'compared with the same score last week. Three measured columns that disagree with each '
        + 'other are more use than one number that hides the disagreement.',
    },
    {
      figure: `A rank for the ${unranked} row${unranked === 1 ? '' : 's'} below the evidence gate`,
      value: null,
      reason: `${ranked} row${ranked === 1 ? ' carries' : 's carry'} the `
        + `${EVIDENCE_GATE.minAccountDays} reported account-days and ${EVIDENCE_GATE.minAccounts} `
        + 'accounts a position on these boards is worth; the rest are listed with their counts and '
        + 'no position. A mean over two account-days is a number, not a measurement, and it used '
        + 'to be printed at the top of the page.',
    },
    {
      figure: 'One coverage percentage across every board',
      value: null,
      reason: CROSS_BOARD_REFUSAL,
    },
    {
      figure: 'What the unattributed money on each board belongs to',
      value: null,
      reason: 'The gap between what an account made and what its algorithms account for is not '
        + 'assigned. It used to be: the account’s day was divided evenly across whatever was '
        + 'enabled, which put a figure nobody measured on the board the desk ranks algorithms by. '
        + 'Each board now states the size of its own gap and stops there.',
    },
  ];
}
