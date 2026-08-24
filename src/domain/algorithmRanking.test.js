// The rules the algorithm ranking must never break, on fixtures.
//
// UNGATED ON PURPOSE. This file reads no snapshot, so it runs on CI and on every
// clone. What is here is everything that can be stated without the book: what
// counts as a measurement, the mean and its clustered interval, the evidence
// gate, the two wall-clock defects, and — the reason this file was rewritten —
// the two segmentation rules that now decide the whole shape of the screen:
//
//   * An ALGORITHM is segmented by its CONFIGURATION and never by the type of
//     the accounts it ran on. The account type is a property of the account.
//   * MONEY is reported per business and never added across them — for the DESK.
//     A rate is pooled; a dollar is not, and a dollar is not published for an
//     algorithm, for one of its configurations, or for one close of either, in a
//     total OR split per business. The split looked like the careful answer
//     until the deployment table beside it turned out to be its denominator: at
//     a fixed configuration, dollars per business over account-days per account
//     type IS the per-account-type verdict this desk threw out.
//
// The arithmetic against 96 clients and 14 closes is in
// algorithmRanking.book.test.js, which IS gated and therefore pins nothing on
// CI. Anything that can be said here belongs here.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EVIDENCE_GATE,
  algorithmRefusals,
  buildAlgorithmDetail,
  buildStrategyRanking,
  clusteredMean,
  configurationOf,
  measuredPnl,
  measuredSource,
  rankingRefusals,
  shiftDay,
  sizingOf,
} from './algorithmRanking';
import { BUSINESS_KEYS, businessForSegment, SEGMENTS } from './operationsSegments';

/**
 * One strategy row as the importer produces it.
 *
 * `params` is what carries the configuration — profit targets and the stop — and
 * the position sizing beside it. Defaults give every fixture row one identical
 * configuration, so a test that says nothing about configuration is testing the
 * thing it says it is testing.
 */
function strat(algo, {
  realized,
  derivedRealized,
  targets = [100, 200, 300],
  stop = 50,
  sizes = [1, 1, 0],
  version = '1.0',
  instrument = 'MNQ SEP26',
  enabled = true,
  strategyName,
} = {}) {
  const row = {
    strategyFamily: algo,
    strategyVersion: version,
    instrument,
    enabled,
    params: { profitTargets: targets, stopLossTicks: stop, posSizes: sizes },
  };
  if (strategyName) row.strategyName = strategyName;
  if (realized !== undefined) row.realized = realized;
  if (derivedRealized !== undefined) row.derivedRealized = derivedRealized;
  return row;
}

function makeClient({
  id = 'c1',
  name = 'Pedro',
  accountType = 'Funded',
  accounts = ['A1'],
  days = [],
} = {}) {
  const accountRegistry = {};
  for (const accountName of accounts) {
    accountRegistry[accountName] = { accountName, accountType, status: 'Active' };
  }
  return {
    id,
    name,
    accountRegistry,
    dailyImports: days.map(({ date, rows }) => ({
      id: `${id}-${date}`,
      date,
      accounts: {},
      flags: [],
      snapshots: rows.map(({ account = accounts[0], pnl = 0, strategies = [] }) => ({
        accountName: account,
        grossRealizedPnl: pnl,
        weeklyPnl: 0,
        accountBalance: 50000,
        strategies,
      })),
    })),
  };
}

/** `closes` closes of one algorithm on `accountCount` accounts, each making `pnl`. */
function bulkClient({
  algo = 'RBO', accountType = 'Funded', accountCount = 12, closes = 5, pnl = -100, id = 'c1',
  targets, stop, sizes,
} = {}) {
  const accounts = Array.from({ length: accountCount }, (_, i) => `A${i + 1}`);
  const days = Array.from({ length: closes }, (_, d) => ({
    date: `2026-07-${String(10 + d).padStart(2, '0')}`,
    rows: accounts.map((account) => ({
      account,
      pnl,
      strategies: [strat(algo, { realized: pnl, targets, stop, sizes })],
    })),
  }));
  return makeClient({ id, accountType, accounts, days });
}

const rowFor = (result, name) => result.ranking.rows.find((row) => row.name === name) || null;
const businessFor = (result, key) => result.businesses.find((b) => b.key === key) || null;
const configFor = (detail, label) =>
  detail.configurations.find((config) => config.label === label) || null;

describe('what counts as a measurement', () => {
  it('prefers a derived figure, then a reported one, and calls nothing else evidence', () => {
    expect(measuredPnl({ derivedRealized: 80, realized: 5 })).toBe(80);
    expect(measuredPnl({ realized: 30 })).toBe(30);
    expect(measuredPnl({ realized: null })).toBeNull();
    expect(measuredPnl({})).toBeNull();
    // A derived 0 is a measurement, not an absence.
    expect(measuredPnl({ derivedRealized: 0, realized: 500 })).toBe(0);
  });

  it('never splits an account day across the algorithms that were running', () => {
    // Two enabled strategies, an account down $776, and an export that said
    // nothing about either of them. The even split would put -$388 on each — a
    // figure nobody measured, in the ranking the desk reads.
    const client = makeClient({
      days: [{
        date: '2026-07-10',
        rows: [{
          pnl: -776,
          strategies: [strat('RBO', { realized: null }), strat('IFSP', { realized: null })],
        }],
      }],
    });
    const rows = buildStrategyRanking([client]).ranking.rows;
    expect(rows.every((row) => row.accountDays === 0)).toBe(true);
    expect(rows.every((row) => row.meanPerAccountDay === null)).toBe(true);
    expect(rows.every((row) => row.unmeasuredAccountDays === 1)).toBe(true);
    expect(rows.every((row) => /No dollar figure on this population/.test(row.moneyRefusal)))
      .toBe(true);
    // The roster is still exact: both algorithms ran on this account.
    expect(rows.every((row) => row.accounts === 1 && row.clients === 1)).toBe(true);
  });

  it('treats an absent Realized column exactly like a grid that reported zero', () => {
    const withNull = makeClient({
      days: [{ date: '2026-07-10', rows: [{ pnl: -500, strategies: [strat('RBO', { realized: null })] }] }],
    });
    const withZero = makeClient({
      days: [{ date: '2026-07-10', rows: [{ pnl: -500, strategies: [strat('RBO', { realized: 0 })] }] }],
    });
    expect(rowFor(buildStrategyRanking([withNull]), 'RBO').accountDays)
      .not.toBe(rowFor(buildStrategyRanking([withZero]), 'RBO').accountDays);
    // Neither of them takes a share of the account's own -$500.
    expect(JSON.stringify(buildStrategyRanking([withNull]).ranking.rows)).not.toContain('-500');
  });

  it('separates a reported flat day from a day nobody reported', () => {
    const client = makeClient({
      days: [
        { date: '2026-07-10', rows: [{ pnl: 0, strategies: [strat('RBO', { realized: 0 })] }] },
        { date: '2026-07-11', rows: [{ pnl: -50, strategies: [strat('RBO', { realized: null })] }] },
      ],
    });
    const row = rowFor(buildStrategyRanking([client]), 'RBO');
    expect(row.flatDays).toBe(1);
    expect(row.unmeasuredAccountDays).toBe(1);
    expect(row.accountDays).toBe(1);
  });

  it('is one observation per account-day, not per strategy row', () => {
    const client = makeClient({
      days: [{
        date: '2026-07-10',
        rows: [{
          pnl: -30,
          strategies: [
            strat('RBO', { realized: -10, strategyName: '0 - RBO-1.8' }),
            strat('RBO', { realized: -20, strategyName: '0 - RBO-1.9' }),
          ],
        }],
      }],
    });
    const row = rowFor(buildStrategyRanking([client]), 'RBO');
    expect(row.accountDays).toBe(1);
    expect(row.meanPerAccountDay).toBe(-30);
  });

  it('counts one account name held by two clients as two accounts', () => {
    const shared = (id) => makeClient({
      id,
      name: id,
      accounts: ['SAME'],
      days: [{ date: '2026-07-10', rows: [{ pnl: -10, strategies: [strat('RBO', { realized: -10 })] }] }],
    });
    const row = rowFor(buildStrategyRanking([shared('c1'), shared('c2')]), 'RBO');
    expect(row.accounts).toBe(2);
    expect(row.accountDays).toBe(2);
    expect(row.clients).toBe(2);
  });

  it('ignores a strategy that was not enabled', () => {
    const client = makeClient({
      days: [{ date: '2026-07-10', rows: [{ pnl: -10, strategies: [strat('RBO', { realized: -10, enabled: false })] }] }],
    });
    expect(buildStrategyRanking([client]).ranking.rows).toHaveLength(0);
  });
});

describe('the mean, and what it is a mean of', () => {
  it('divides by REPORTED account-days, flat ones included', () => {
    const client = makeClient({
      days: [
        { date: '2026-07-10', rows: [{ pnl: -300, strategies: [strat('RBO', { realized: -300 })] }] },
        { date: '2026-07-11', rows: [{ pnl: 0, strategies: [strat('RBO', { realized: 0 })] }] },
        { date: '2026-07-12', rows: [{ pnl: 0, strategies: [strat('RBO', { realized: 0 })] }] },
      ],
    });
    const row = rowFor(buildStrategyRanking([client]), 'RBO');
    expect(row.accountDays).toBe(3);
    // Not -300, which is what dividing by decided days alone would print.
    expect(row.meanPerAccountDay).toBe(-100);
    expect(row.flatDays).toBe(2);
  });

  it('takes win rate over decided days and says how many those were', () => {
    const client = makeClient({
      days: [
        { date: '2026-07-10', rows: [{ pnl: 100, strategies: [strat('RBO', { realized: 100 })] }] },
        { date: '2026-07-11', rows: [{ pnl: -100, strategies: [strat('RBO', { realized: -100 })] }] },
        { date: '2026-07-12', rows: [{ pnl: 0, strategies: [strat('RBO', { realized: 0 })] }] },
      ],
    });
    const row = rowFor(buildStrategyRanking([client]), 'RBO');
    expect(row.decidedDays).toBe(2);
    expect(row.winRate).toBe(50);
  });

  it('refuses a win rate rather than printing 0% when no day was decided', () => {
    const client = makeClient({
      days: [{ date: '2026-07-10', rows: [{ pnl: 0, strategies: [strat('RBO', { realized: 0 })] }] }],
    });
    expect(rowFor(buildStrategyRanking([client]), 'RBO').winRate).toBeNull();
  });

  it('counts accounts in profit on the account total, not on its days', () => {
    const client = makeClient({
      accounts: ['A1', 'A2'],
      days: [
        {
          date: '2026-07-10',
          rows: [
            { account: 'A1', pnl: 500, strategies: [strat('RBO', { realized: 500 })] },
            { account: 'A2', pnl: -50, strategies: [strat('RBO', { realized: -50 })] },
          ],
        },
        {
          date: '2026-07-11',
          rows: [
            { account: 'A1', pnl: -400, strategies: [strat('RBO', { realized: -400 })] },
            { account: 'A2', pnl: -50, strategies: [strat('RBO', { realized: -50 })] },
          ],
        },
      ],
    });
    const row = rowFor(buildStrategyRanking([client]), 'RBO');
    expect(row.accountsProfitable).toBe(1);
    expect(row.accountsProfitablePct).toBe(50);
    expect(row.winRate).toBe(25);
  });
});

describe('the interval, clustered on the account', () => {
  it('widens when the spread lives between accounts rather than within them', () => {
    const betweenAccounts = [];
    const withinAccounts = [];
    for (let account = 0; account < 10; account += 1) {
      const high = account < 5;
      betweenAccounts.push({ cluster: `a${account}`, value: high ? 100 : -100 });
      betweenAccounts.push({ cluster: `a${account}`, value: high ? 100 : -100 });
      withinAccounts.push({ cluster: `a${account}`, value: 100 });
      withinAccounts.push({ cluster: `a${account}`, value: -100 });
    }
    const between = clusteredMean(betweenAccounts);
    const within = clusteredMean(withinAccounts);
    expect(between.mean).toBe(0);
    expect(within.mean).toBe(0);
    expect(within.halfWidth).toBe(0);
    expect(between.halfWidth).toBeGreaterThan(0);
  });

  it('refuses an interval over a single account', () => {
    const stats = clusteredMean([
      { cluster: 'a1', value: 10 },
      { cluster: 'a1', value: -30 },
    ]);
    expect(stats.mean).toBe(-10);
    expect(stats.halfWidth).toBeNull();
    const client = makeClient({
      days: [
        { date: '2026-07-10', rows: [{ pnl: 10, strategies: [strat('RBO', { realized: 10 })] }] },
        { date: '2026-07-11', rows: [{ pnl: -30, strategies: [strat('RBO', { realized: -30 })] }] },
      ],
    });
    const row = rowFor(buildStrategyRanking([client]), 'RBO');
    expect(row.ci).toBeNull();
    expect(row.ciRefusal).toMatch(/One account/);
  });

  it('carries the finite-sample correction, so ten clusters is not treated as infinite', () => {
    const observations = Array.from({ length: 10 }, (_, i) => ({
      cluster: `a${i}`,
      value: i % 2 === 0 ? 100 : -100,
    }));
    const stats = clusteredMean(observations);
    expect(stats.halfWidth / (1.959964 * Math.sqrt(1000))).toBeCloseTo(Math.sqrt(10 / 9), 10);
  });
});

describe('the evidence gate', () => {
  it('is 30 reported account-days AND 10 accounts', () => {
    expect(EVIDENCE_GATE).toEqual({ minAccountDays: 30, minAccounts: 10 });
  });

  it('ranks a row that clears both arms', () => {
    const row = rowFor(buildStrategyRanking([bulkClient({ accountCount: 10, closes: 3 })]), 'RBO');
    expect(row.accountDays).toBe(30);
    expect(row.accounts).toBe(10);
    expect(row.ranked).toBe(true);
    expect(row.rank).toBe(1);
    expect(row.rankRefusal).toBeNull();
  });

  it('refuses a rank on account-days alone, and names the arm that failed', () => {
    const row = rowFor(buildStrategyRanking([bulkClient({ accountCount: 29, closes: 1 })]), 'RBO');
    expect(row.accountDays).toBe(29);
    expect(row.ranked).toBe(false);
    expect(row.rank).toBeNull();
    expect(row.rankRefusal).toContain('29 reported account-days');
    expect(row.rankRefusal).not.toContain('accounts, fewer');
  });

  it('refuses a rank on accounts alone, and names that arm', () => {
    const row = rowFor(buildStrategyRanking([bulkClient({ accountCount: 9, closes: 5 })]), 'RBO');
    expect(row.accountDays).toBe(45);
    expect(row.ranked).toBe(false);
    expect(row.rankRefusal).toContain('9 accounts');
    expect(row.rankRefusal).not.toContain('reported account-days, fewer');
  });

  it('lists an unranked row rather than dropping it, with its counts intact', () => {
    const client = makeClient({
      days: [{ date: '2026-07-10', rows: [{ pnl: 864, strategies: [strat('ARPD_PF', { realized: 864 })] }] }],
    });
    const result = buildStrategyRanking([client]);
    expect(result.ranking.rows).toHaveLength(1);
    expect(result.ranking.rankedCount).toBe(0);
    expect(result.ranking.unrankedCount).toBe(1);
    expect(result.ranking.rows[0].rank).toBeNull();
    expect(result.ranking.rows[0].meanPerAccountDay).toBe(864);
    expect(result.ranking.rows[0].accountDays).toBe(1);
  });

  it('puts every ranked row above every unranked one, best mean first', () => {
    const result = buildStrategyRanking([
      bulkClient({ id: 'c1', algo: 'GOOD', accountCount: 10, closes: 3, pnl: -10 }),
      bulkClient({ id: 'c2', algo: 'BAD', accountCount: 10, closes: 3, pnl: -900 }),
      bulkClient({ id: 'c3', algo: 'TINY', accountCount: 2, closes: 1, pnl: 5000 }),
    ]);
    expect(result.ranking.rows.map((row) => row.name)).toEqual(['GOOD', 'BAD', 'TINY']);
    expect(result.ranking.rows.map((row) => row.rank)).toEqual([1, 2, null]);
  });
});

// ---------------------------------------------------------------------------
// THE SEGMENTATION RULE. One rank per algorithm; the account type is context.
// ---------------------------------------------------------------------------

describe('one rank per algorithm, whatever the accounts are called', () => {
  /** The exact shape the desk manager rejected: one algorithm, one version, one
   * sizing, one contract, the same closes, split across two account types. */
  const oneAlgoTwoTypes = () => [
    makeClient({
      id: 'prop',
      name: 'Prop client',
      accountType: 'Funded',
      accounts: ['P1'],
      days: [
        { date: '2026-07-10', rows: [{ account: 'P1', pnl: -100, strategies: [strat('SUBJECT', { realized: -100 })] }] },
        { date: '2026-07-11', rows: [{ account: 'P1', pnl: -100, strategies: [strat('SUBJECT', { realized: -100 })] }] },
      ],
    }),
    makeClient({
      id: 'cash',
      name: 'Cash client',
      accountType: 'Cash',
      accounts: ['C1'],
      days: [
        { date: '2026-07-10', rows: [{ account: 'C1', pnl: 400, strategies: [strat('SUBJECT', { realized: 400 })] }] },
        { date: '2026-07-11', rows: [{ account: 'C1', pnl: 400, strategies: [strat('SUBJECT', { realized: 400 })] }] },
      ],
    }),
  ];

  it('gives one algorithm one row and one mean across every account type', () => {
    // The rejected build gave this algorithm two rows: -$100 a day on prop and
    // +$400 a day on cash, presented as two behaviours. It is one code path on
    // one contract at one sizing; the pooled answer is +$150.
    const result = buildStrategyRanking(oneAlgoTwoTypes());
    expect(result.ranking.rows).toHaveLength(1);
    const row = result.ranking.rows[0];
    expect(row.accountDays).toBe(4);
    expect(row.accounts).toBe(2);
    expect(row.meanPerAccountDay).toBe(150);
    // And there is exactly one place a rank can come from.
    expect(result.boards).toBeUndefined();
  });

  it('routes the money to a business for the DESK, and to no algorithm', () => {
    // The money is still split — -$200 of prop movement and +$800 of real client
    // money, never added into +$600 — and it is still split by the same function
    // the tiles use. What changed is WHOSE it is: it belongs to the desk, over
    // every algorithm at once, and no row of the ranking is scoped to one of
    // these figures.
    const result = buildStrategyRanking(oneAlgoTwoTypes());
    expect(result.businesses.map((row) => [row.key, row.coverage.attributedPnl])).toEqual([
      [BUSINESS_KEYS.PROP_OTHER, -200],
      [BUSINESS_KEYS.CASH, 800],
    ]);
    expect(JSON.stringify(result.businesses)).not.toContain('600');
    expect(result.ranking.rows[0].exposure).toBeUndefined();
  });

  it('carries no dollar on a row, at any level, in a total or split by business', () => {
    // The key is the defect, not the number. `totalPnl` was the obvious half: a
    // field holding one dollar figure for an algorithm across the desk is a
    // field the next caller sums, which is how deskMoney's deleted `total` came
    // back the first time. `exposure` was the half that looked correct — the
    // same dollars split per business, never added — until the deployment table
    // beside it turned out to be its denominator. -$200 over 2 prop
    // account-days and +$800 over 2 cash ones is -$100 and +$400 a day, which is
    // the per-account-type verdict, restored by one division.
    const result = buildStrategyRanking(oneAlgoTwoTypes());
    expect(result.total).toBeUndefined();
    expect(result.totalPnl).toBeUndefined();
    expect(result.ranking.totalPnl).toBeUndefined();
    for (const row of result.ranking.rows) {
      expect(row.totalPnl).toBeUndefined();
      expect(row.total).toBeUndefined();
      expect(row.exposure).toBeUndefined();
      expect(row.moneyRefusal).toMatch(/not one total, and not one per business either/);
    }
    // And the two rates that division produced are on nothing here.
    const flat = JSON.stringify(result.ranking);
    expect(flat).not.toContain('-100');
    expect(flat).not.toContain('400');
  });

  /**
   * Every key on this module that has ever held a dollar, plus the two generic
   * names a future one would be given. Named rather than inferred: a guard that
   * looked for "any number that looks like money" would pass the day somebody
   * called it `net`.
   */
  const MONEY_KEYS = [
    'total', 'totalPnl', 'pnl', 'net', 'measuredPnl', 'derivedPnl', 'reportedPnl',
    'accountPnl', 'attributedPnl', 'unattributedPnl',
  ];

  /** Every object reachable from `node`, with the path that reached it. */
  function objectsIn(node, path = 'root', seen = []) {
    if (!node || typeof node !== 'object') return seen;
    if (Array.isArray(node)) {
      node.forEach((item, index) => objectsIn(item, `${path}[${index}]`, seen));
      return seen;
    }
    seen.push({ path, node });
    for (const [key, value] of Object.entries(node)) objectsIn(value, `${path}.${key}`, seen);
    return seen;
  }

  const moneyOn = (node) => MONEY_KEYS.filter((key) => typeof node[key] === 'number');

  it('lets no object it publishes pair a BUSINESS with a dollar', () => {
    // THE RULE, stated as a shape rather than as a number: nothing that names a
    // bucket of accounts may also carry money. The desk's own per-business
    // figures are exempt by construction — they hang off `businesses[].coverage`,
    // whose denominator is every algorithm at once — and the test below pins
    // that they are still there, so this one cannot be satisfied by deleting the
    // separation instead of relocating it.
    const clients = oneAlgoTwoTypes();
    const offenders = [];
    for (const source of [
      { name: 'ranking', value: buildStrategyRanking(clients) },
      { name: 'detail', value: buildAlgorithmDetail(clients, { algorithm: 'SUBJECT' }) },
    ]) {
      for (const { path, node } of objectsIn(source.value, source.name)) {
        const money = moneyOn(node);
        if (!money.length) continue;
        // A row that names ONE account may state what that account made: it is
        // a fact about the account, not a reading of its type.
        const bucketed = 'business' in node || ('segment' in node && !('accountKey' in node));
        if (bucketed) offenders.push(`${path}: ${money.join(', ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the desk’s money split per business, so the separation is relocated and not deleted', () => {
    // The other half of the rule, and the reason the guard above is not just
    // "delete every dollar": prop dollars and cash dollars must never be added,
    // so the desk still states each business's own money, over every algorithm.
    const result = buildStrategyRanking(oneAlgoTwoTypes());
    expect(result.businesses.map((row) => row.key))
      .toEqual([BUSINESS_KEYS.PROP_OTHER, BUSINESS_KEYS.CASH]);
    for (const business of result.businesses) {
      expect(typeof business.coverage.accountPnl).toBe('number');
      expect(typeof business.coverage.attributedPnl).toBe('number');
      expect(typeof business.coverage.unattributedPnl).toBe('number');
    }
    expect(result.moneyIsPerBusiness).toMatch(/stated for the DESK/);
    expect(result.moneyIsPerBusiness).toMatch(/not stated per algorithm and not per configuration/);
  });

  it('reports where it is deployed in counts, with no money on the row', () => {
    const row = buildStrategyRanking(oneAlgoTwoTypes()).ranking.rows[0];
    expect(row.deployment.map((entry) => [entry.segment, entry.accountDays, entry.accounts]))
      .toEqual([[SEGMENTS.CASH, 2, 1], [SEGMENTS.FUNDED, 2, 1]]);
    // No money key of any name. A P&L column here is a verdict on an account
    // type, which is the whole thing this rework removed.
    for (const entry of row.deployment) {
      expect(Object.keys(entry).sort()).toEqual([
        'accountDays', 'accounts', 'business', 'businessLabel', 'clients', 'segment', 'share',
      ]);
    }
  });

  it('routes an account-day by the same function the tiles route money with', () => {
    expect(businessForSegment(SEGMENTS.EVAL_BULLET)).toBe(BUSINESS_KEYS.BULLET);
    expect(businessForSegment(SEGMENTS.CASH)).toBe(BUSINESS_KEYS.CASH);
    expect(businessForSegment(SEGMENTS.FUNDED)).toBe(BUSINESS_KEYS.PROP_OTHER);
    expect(businessForSegment(SEGMENTS.EVAL_STANDARD)).toBe(BUSINESS_KEYS.PROP_OTHER);
    expect(businessForSegment(SEGMENTS.UNCLASSIFIED)).toBe(BUSINESS_KEYS.UNCLASSIFIED);
    expect(businessForSegment(SEGMENTS.IGNORED)).toBeNull();
    expect(businessForSegment(SEGMENTS.ORPHAN)).toBeNull();
    expect(businessForSegment(SEGMENTS.SIMULATION)).toBeNull();
    expect(businessForSegment('Some Future Type')).toBe(BUSINESS_KEYS.PROP_OTHER);
  });

  it('ranks Bullet Bot as a peer algorithm, not as an account type', () => {
    // "Evaluation - Bullet Bot" is an ACCOUNT TYPE that shares its name with an
    // algorithm, and the board named after it made "OGX on the Bullet Bot board"
    // read as OGX being a Bullet Bot strategy. Bullet Bot is one row here, and
    // an algorithm running on a bullet-bot-typed account is that algorithm's row.
    const result = buildStrategyRanking([
      makeClient({
        id: 'bb', accountType: 'Evaluation - Bullet Bot', accounts: ['B1'],
        days: [{ date: '2026-07-10', rows: [{ account: 'B1', pnl: -500, strategies: [strat('OGX', { realized: -500 })] }] }],
      }),
      makeClient({
        id: 'bb2', name: 'Two', accountType: 'Evaluation - Bullet Bot', accounts: ['B2'],
        days: [{ date: '2026-07-10', rows: [{ account: 'B2', pnl: -60, strategies: [strat('Bullet Bot', { realized: -60 })] }] }],
      }),
    ]);
    expect(result.ranking.rows.map((row) => row.name).sort()).toEqual(['Bullet Bot', 'OGX']);
    const ogx = rowFor(result, 'OGX');
    expect(ogx.meanPerAccountDay).toBe(-500);
    expect(ogx.deployment.map((entry) => entry.segment)).toEqual([SEGMENTS.EVAL_BULLET]);
  });

  it('counts Ignored and orphan account-days as reconciliation, with no money', () => {
    const ignored = makeClient({
      id: 'c1', accountType: 'Inactive / Ignore',
      days: [{ date: '2026-07-10', rows: [{ pnl: -1020, strategies: [strat('RBO', { realized: -1020 })] }] }],
    });
    const orphan = {
      id: 'c2', name: 'Orphan', accountRegistry: {},
      dailyImports: [{
        id: 'd', date: '2026-07-10', accounts: {}, flags: [],
        snapshots: [{ accountName: 'GONE', grossRealizedPnl: -50, strategies: [strat('RBO', { realized: -50 })] }],
      }],
    };
    const result = buildStrategyRanking([ignored, orphan]);
    expect(result.ranking.rows).toEqual([]);
    expect(result.reconciliation.accountDays).toBe(2);
    for (const row of result.reconciliation.rows) {
      expect(Object.keys(row).sort()).toEqual(['accountDays', 'accounts', 'segment']);
    }
  });
});

describe('coverage — what the ranking does not see, per business', () => {
  it('compares the algorithms against what the accounts made on the same days', () => {
    const client = makeClient({
      days: [{
        date: '2026-07-10',
        rows: [{
          pnl: -1000,
          strategies: [strat('RBO', { realized: -400 }), strat('OGX', { realized: -200 })],
        }],
      }],
    });
    const business = businessFor(buildStrategyRanking([client]), BUSINESS_KEYS.PROP_OTHER);
    expect(business.coverage.accountDays).toBe(1);
    expect(business.coverage.accountPnl).toBe(-1000);
    expect(business.coverage.attributedPnl).toBe(-600);
    expect(business.coverage.unattributedPnl).toBe(-400);
    expect(business.coverage.unattributedShare).toBe(40);
  });

  it('refuses a share instead of dividing by zero', () => {
    const client = makeClient({
      days: [{ date: '2026-07-10', rows: [{ pnl: 0, strategies: [strat('RBO', { realized: -25 })] }] }],
    });
    const business = businessFor(buildStrategyRanking([client]), BUSINESS_KEYS.PROP_OTHER);
    expect(business.coverage.unattributedShare).toBeNull();
    expect(business.coverage.shareRefusal).toMatch(/divide by zero/);
  });

  it('keeps each business’s coverage inside that business and publishes no total', () => {
    const result = buildStrategyRanking([
      makeClient({ id: 'c1', accountType: 'Funded', days: [{ date: '2026-07-10', rows: [{ pnl: -1000, strategies: [strat('RBO', { realized: -400 })] }] }] }),
      makeClient({ id: 'c2', accountType: 'Cash', days: [{ date: '2026-07-10', rows: [{ pnl: -200, strategies: [strat('RBO', { realized: -100 })] }] }] }),
    ]);
    expect(businessFor(result, BUSINESS_KEYS.PROP_OTHER).coverage.accountPnl).toBe(-1000);
    expect(businessFor(result, BUSINESS_KEYS.CASH).coverage.accountPnl).toBe(-200);
    expect(result.coverage).toBeUndefined();
    expect(result.crossBusinessCoverageRefusal).toMatch(/Each business states its own/);
  });
});

describe('the date footing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T12:00:00Z'));
  });
  afterEach(() => { vi.useRealTimers(); });

  it('anchors the seven-day windows to the book, not to the wall clock', () => {
    const client = makeClient({
      accounts: ['A1', 'A2'],
      days: [
        { date: '2026-07-10', rows: [
          { account: 'A1', pnl: -100, strategies: [strat('RBO', { realized: -100 })] },
          { account: 'A2', pnl: -100, strategies: [strat('RBO', { realized: -100 })] },
        ] },
        { date: '2026-07-20', rows: [{ account: 'A1', pnl: -300, strategies: [strat('RBO', { realized: -300 })] }] },
      ],
    });
    const row = rowFor(buildStrategyRanking([client]), 'RBO');
    // Against `new Date()` both windows would be empty and this would read null.
    expect(row.recentMeanPerAccountDay).toBe(-300);
    expect(row.recentAccountDays).toBe(1);
    expect(row.priorMeanPerAccountDay).toBe(-100);
    expect(row.priorAccountDays).toBe(2);
  });

  it('takes the trend as a difference of MEANS, not of window totals', () => {
    // Both windows lost $100 per account-day. The prior window had one account
    // and the recent one three, so a difference of SUMS reads -$200 and prints a
    // down arrow on an algorithm that did not change — the deployment-size
    // defect that made total P&L rank the board upside down, one column left.
    const client = makeClient({
      accounts: ['A1', 'A2', 'A3'],
      days: [
        { date: '2026-07-10', rows: [{ account: 'A1', pnl: -100, strategies: [strat('RBO', { realized: -100 })] }] },
        { date: '2026-07-20', rows: [
          { account: 'A1', pnl: -100, strategies: [strat('RBO', { realized: -100 })] },
          { account: 'A2', pnl: -100, strategies: [strat('RBO', { realized: -100 })] },
          { account: 'A3', pnl: -100, strategies: [strat('RBO', { realized: -100 })] },
        ] },
      ],
    });
    const row = rowFor(buildStrategyRanking([client]), 'RBO');
    expect(row.recentAccountDays).toBe(3);
    expect(row.priorAccountDays).toBe(1);
    expect(row.trend).toBe(0);
    expect(row.trendDirection).toBe('flat');
  });

  it('never calls a trend "up" when it is exactly zero', () => {
    const client = makeClient({
      days: [
        { date: '2026-07-10', rows: [{ pnl: -100, strategies: [strat('RBO', { realized: -100 })] }] },
        { date: '2026-07-20', rows: [{ pnl: -100, strategies: [strat('RBO', { realized: -100 })] }] },
      ],
    });
    const row = rowFor(buildStrategyRanking([client]), 'RBO');
    expect(row.trend).toBe(0);
    expect(row.trendDirection).toBe('flat');
  });

  it('refuses a trend when either window measured nothing', () => {
    const client = makeClient({
      days: [{ date: '2026-06-01', rows: [{ pnl: -100, strategies: [strat('RBO', { realized: -100 })] }] }],
    });
    const row = rowFor(buildStrategyRanking([client], { asOfDate: '2026-07-20' }), 'RBO');
    expect(row.trend).toBeNull();
    expect(row.trendDirection).toBe('unknown');
    expect(row.trendRefusal).toMatch(/Neither the seven days to 2026-07-20/);

    // And the half-empty case, which reading a missing window as zero would
    // print as a large move.
    const half = makeClient({
      days: [{ date: '2026-07-20', rows: [{ pnl: -100, strategies: [strat('RBO', { realized: -100 })] }] }],
    });
    const halfRow = rowFor(buildStrategyRanking([half], { asOfDate: '2026-07-20' }), 'RBO');
    expect(halfRow.trend).toBeNull();
    expect(halfRow.trendRefusal).toMatch(/Only one of the two seven-day windows/);
  });

  it('runs the history to a pinned date and says so', () => {
    const client = makeClient({
      days: [
        { date: '2026-07-10', rows: [{ pnl: -100, strategies: [strat('RBO', { realized: -100 })] }] },
        { date: '2026-07-20', rows: [{ pnl: -300, strategies: [strat('RBO', { realized: -300 })] }] },
      ],
    });
    const pinned = buildStrategyRanking([client], { asOfDate: '2026-07-10' });
    expect(rowFor(pinned, 'RBO').meanPerAccountDay).toBe(-100);
    expect(rowFor(pinned, 'RBO').accountDays).toBe(1);
    expect(pinned.basis.anchor).toBe('2026-07-10');
    expect(pinned.basis.closesAfterAnchor).toBe(1);
  });

  it('states how many closes carry a split out of how many the book holds', () => {
    const client = makeClient({
      days: [
        { date: '2026-07-09', rows: [{ pnl: -10, strategies: [strat('RBO', { realized: -10, enabled: false })] }] },
        { date: '2026-07-10', rows: [{ pnl: -100, strategies: [strat('RBO', { realized: -100 })] }] },
      ],
    });
    const result = buildStrategyRanking([client]);
    expect(result.basis.closeCount).toBe(1);
    expect(result.basis.closesToAnchor).toBe(2);
    expect(result.basis.label).toContain('1 of 2 closes');
    expect(result.basis.label).toContain('seven-day windows end 2026-07-10');
  });

  it('shifts a day without touching the local timezone', () => {
    expect(shiftDay('2026-07-30', -6)).toBe('2026-07-24');
    expect(shiftDay('2026-03-09', -1)).toBe('2026-03-08');
    expect(shiftDay('', -1)).toBe('');
  });
});

describe('what the ranking says it will not produce', () => {
  it('names every refusal and counts the unranked rows honestly', () => {
    const result = buildStrategyRanking([
      bulkClient({ id: 'c1', algo: 'BIG', accountCount: 10, closes: 3 }),
      bulkClient({ id: 'c2', algo: 'TINY', accountCount: 2, closes: 1 }),
    ]);
    const refusals = rankingRefusals(result);
    const figures = refusals.map((row) => row.figure);
    expect(figures).toContain('A separate ranking per account type');
    expect(figures).toContain('A rank ordered by total P&L');
    expect(figures).toContain('Any dollar on a ranking row — one total, or one per business');
    expect(figures).toContain('A composite effectiveness score');
    expect(figures).toContain('A comparison between two algorithms on different contracts');
    expect(figures).toContain('One coverage percentage across every business');
    expect(figures.some((figure) => figure.includes('1 row below the evidence gate'))).toBe(true);
    expect(refusals.every((row) => row.value === null && row.reason.length > 40)).toBe(true);
  });

  it('survives an empty book without inventing a ranking', () => {
    const result = buildStrategyRanking([]);
    expect(result.ranking.rows).toEqual([]);
    expect(result.businesses).toEqual([]);
    expect(result.basis.label).toMatch(/No close on this book/);
    expect(rankingRefusals(result)).not.toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// THE ALGORITHM DETAIL VIEW, SEGMENTED BY CONFIGURATION.
//
// The four things this view can get wrong in a way nobody would catch:
//
//   1. Segmenting by a property of the ACCOUNT again, so one algorithm reads as
//      two behaviours because two samples of it landed on different account
//      types.
//   2. Measuring the algorithm a second time, so the detail and the row it was
//      opened from disagree and the desk cannot tell which to believe.
//   3. Reading a verdict off a configuration that four account-days measured.
//   4. Folding position sizing into the configuration's identity, which reports
//      a client on a higher risk setting as running a different version — or
//      hiding it, which lets a mean blend two risk levels silently.
// ---------------------------------------------------------------------------

describe('the configuration a strategy row is running', () => {
  it('is the version plus the profit targets and the stop', () => {
    const config = configurationOf(strat('OGX', { version: '2.4', targets: [220, 395, 495], stop: 200 }));
    expect(config.label).toBe('v2.4 · PT 220/395/495 · SL 200');
    expect(config.profitTargets).toEqual([220, 395, 495]);
    expect(config.stopLossTicks).toBe(200);
    expect(config.stated).toBe(true);
  });

  it('is NOT the position sizing — that is the risk level', () => {
    // strategyConfigDrift.js has drawn this line since it was written: of 127
    // config-and-risk combinations on a real book, 17 were only risk. Folding
    // sizing in reports a client on a higher setting as a different version.
    const one = configurationOf(strat('OGX', { sizes: [1, 1, 0] }));
    const other = configurationOf(strat('OGX', { sizes: [3, 2, 1] }));
    expect(one.key).toBe(other.key);
    expect(sizingOf(strat('OGX', { sizes: [3, 2, 1] }))).toBe('3/2/1');
  });

  it('is not the account type, the instrument or the client', () => {
    // The instrument is reported beside a configuration and is never part of its
    // identity: two contracts of one root — MNQ SEP26 and MNQ 09-26 — are the
    // same run written two ways by the export.
    expect(configurationOf(strat('OGX', { instrument: 'MNQ SEP26' })).key)
      .toBe(configurationOf(strat('OGX', { instrument: 'MNQ 09-26' })).key);
  });

  it('separates two versions of the same parameter set', () => {
    expect(configurationOf(strat('OGX', { version: '2.4' })).key)
      .not.toBe(configurationOf(strat('OGX', { version: '3.0' })).key);
  });

  it('falls back to the desk’s own key when the export carries the raw string', () => {
    const config = configurationOf({
      strategyVersion: '1.1',
      parametersRaw: '400/450/500/300/2 (ProfitTargetTicks1/ProfitTargetTicks2/ProfitTargetTicks3/StopLossTicks/PosSize)',
    });
    expect(config.stated).toBe(true);
    expect(config.label).toBe('v1.1 · PT 400/450/500 · SL 300');
  });

  it('holds a row nobody can read apart rather than merging it into one that was read', () => {
    const config = configurationOf({ strategyVersion: '1.1' });
    expect(config.stated).toBe(false);
    expect(config.label).toMatch(/configuration not stated/);
    expect(config.key).not.toBe(configurationOf(strat('OGX')).key);
  });
});

describe('opening one algorithm', () => {
  /**
   * The shape the desk manager described: ONE algorithm on ONE version at ONE
   * sizing, running two different parameter sets, spread across two account
   * types. The configuration is what differs; the account type is not.
   */
  function detailFixture() {
    const wide = Array.from({ length: 10 }, (_, i) => `W${i + 1}`);
    return [
      // Ten accounts x four closes of the main configuration on funded prop.
      makeClient({
        id: 'prop', name: 'Prop client', accountType: 'Funded', accounts: wide,
        days: Array.from({ length: 4 }, (_, d) => ({
          date: `2026-07-1${d}`,
          rows: wide.map((account) => ({ account, pnl: -50, strategies: [strat('SUBJECT', { realized: -50 })] })),
        })),
      }),
      // The SAME configuration on cash. Different account type, same run.
      makeClient({
        id: 'cash', name: 'Cash client', accountType: 'Cash', accounts: ['C1'],
        days: [
          { date: '2026-07-10', rows: [{ account: 'C1', pnl: 900, strategies: [strat('SUBJECT', { realized: 900 })] }] },
          { date: '2026-07-11', rows: [{ account: 'C1', pnl: 100, strategies: [strat('SUBJECT', { realized: 100 })] }] },
        ],
      }),
      // A different configuration of the same algorithm, on very little.
      makeClient({
        id: 'other', name: 'Other client', accountType: 'Funded', accounts: ['O1'],
        days: [
          { date: '2026-07-12', rows: [{ account: 'O1', pnl: -20, strategies: [strat('SUBJECT', { realized: -20, targets: [30, 60, 90], stop: 181 })] }] },
        ],
      }),
    ];
  }

  it('segments by configuration and not by account type', () => {
    const detail = buildAlgorithmDetail(detailFixture(), { algorithm: 'SUBJECT' });
    expect(detail.configurationCount).toBe(2);
    expect(detail.configurations.map((config) => config.label)).toEqual([
      'v1.0 · PT 100/200/300 · SL 50',
      'v1.0 · PT 30/60/90 · SL 181',
    ]);
    // The main configuration pools its funded and its cash account-days into ONE
    // measurement. Split by account type it would read -$50 a day and +$500 a
    // day, which is the pair of figures the desk manager rejected.
    const main = configFor(detail, 'v1.0 · PT 100/200/300 · SL 50');
    expect(main.accountDays).toBe(42);
    expect(main.meanPerAccountDay).toBe(-23.81);
    expect(main.deployment.map((entry) => [entry.segment, entry.accountDays]))
      .toEqual([[SEGMENTS.FUNDED, 40], [SEGMENTS.CASH, 2]]);
    // Nothing on the object is a mean or a P&L per account type.
    for (const entry of main.deployment) {
      expect(entry.meanPerAccountDay).toBeUndefined();
      expect(entry.totalPnl).toBeUndefined();
    }
  });

  it('orders configurations by evidence, never by mean', () => {
    // The second configuration reads -$20 a day against the first's -$23.81, so
    // a sort by mean would put a one-account-day configuration on top and hand
    // it the reading position.
    const detail = buildAlgorithmDetail(detailFixture(), { algorithm: 'SUBJECT' });
    expect(detail.configurations.map((config) => config.accountDays)).toEqual([42, 1]);
    expect(detail.configurations[1].meanPerAccountDay)
      .toBeGreaterThan(detail.configurations[0].meanPerAccountDay);
  });

  it('refuses to read a configuration below the evidence gate, and says which arm failed', () => {
    const detail = buildAlgorithmDetail(detailFixture(), { algorithm: 'SUBJECT' });
    const thin = configFor(detail, 'v1.0 · PT 30/60/90 · SL 181');
    expect(thin.sufficient).toBe(false);
    expect(thin.evidenceRefusal).toMatch(/1 reported account-day, fewer than the 30/);
    expect(thin.evidenceRefusal).toMatch(/1 account, fewer than the 10/);
    // Listed with its counts, never dropped and never quietly read.
    expect(thin.accountDays).toBe(1);
    expect(detail.readableConfigurations).toBe(1);
    expect(detail.comparisonRefusal).toMatch(/1 of the 2 configurations/);
    expect(detail.comparisonNote).toBeNull();
  });

  it('offers a comparison only when two configurations both clear the gate', () => {
    const clients = [
      bulkClient({ id: 'a', algo: 'SUBJECT', accountCount: 10, closes: 3, pnl: -10 }),
      bulkClient({ id: 'b', algo: 'SUBJECT', accountCount: 10, closes: 3, pnl: -900, targets: [1, 2, 3], stop: 9 }),
    ];
    const detail = buildAlgorithmDetail(clients, { algorithm: 'SUBJECT' });
    expect(detail.readableConfigurations).toBe(2);
    expect(detail.comparisonRefusal).toBeNull();
    // And it still names no winner: the note says to read the intervals.
    expect(detail.comparisonNote).toMatch(/Compare the intervals, not/);
    expect(detail.best).toBeUndefined();
    expect(detail.winner).toBeUndefined();
  });

  it('hands back the ranking’s own row rather than measuring it again', () => {
    const clients = detailFixture();
    const ranking = buildStrategyRanking(clients);
    const detail = buildAlgorithmDetail(clients, { algorithm: 'SUBJECT' });
    const row = rowFor(ranking, 'SUBJECT');
    // Field by field. A detail view that recomputed the mean would pass a spot
    // check on a fixture and drift on the book.
    expect(detail.overall.meanPerAccountDay).toBe(row.meanPerAccountDay);
    expect(detail.overall.ci).toEqual(row.ci);
    expect(detail.overall.accountDays).toBe(row.accountDays);
    expect(detail.overall.accounts).toBe(row.accounts);
    expect(detail.overall.trend).toBe(row.trend);
    expect(detail.overall.deployment).toEqual(row.deployment);
    expect(detail.moneyRefusal).toBe(row.moneyRefusal);
    expect(detail.rank).toBe(row.rank);
    expect(detail.ranked).toBe(row.ranked);
    expect(detail.rankRefusal).toBe(row.rankRefusal);
  });

  it('gives a configuration no money either, which is where it mattered most', () => {
    // A configuration is the level the desk manager's objection was actually
    // about: at a FIXED configuration, the account type is the only thing left
    // varying, so a dollar per business here divided by the account-days per
    // account type below it is precisely "this configuration is better on cash".
    const detail = buildAlgorithmDetail(detailFixture(), { algorithm: 'SUBJECT' });
    expect(detail.configurations.length).toBeGreaterThan(0);
    for (const config of detail.configurations) {
      expect(config.exposure).toBeUndefined();
      expect(config.totalPnl).toBeUndefined();
      expect(config.moneyRefusal).toMatch(/No dollar figure on this population/);
      // The counts stay. That is the deployment table's bargain, unchanged.
      expect(config.deployment.every((entry) => entry.accountDays > 0)).toBe(true);
    }
    expect(detail.totalPnl).toBeUndefined();
    expect(detail.exposure).toBeUndefined();
  });

  it('names the sizing beside a configuration and warns when one blends two', () => {
    const clients = [
      makeClient({
        id: 'mix', accounts: ['M1', 'M2'],
        days: [
          { date: '2026-07-10', rows: [
            { account: 'M1', pnl: -10, strategies: [strat('SUBJECT', { realized: -10, sizes: [1, 1, 0] })] },
            { account: 'M2', pnl: -90, strategies: [strat('SUBJECT', { realized: -90, sizes: [3, 2, 1] })] },
          ] },
        ],
      }),
    ];
    const config = buildAlgorithmDetail(clients, { algorithm: 'SUBJECT' }).configurations[0];
    expect(config.sizing).toEqual([
      { name: '1/1/0', accountDays: 1 },
      { name: '3/2/1', accountDays: 1 },
    ]);
    expect(config.sizingCaveat).toMatch(/Run at 2 position sizings/);
    expect(config.sizingCaveat).toMatch(/scales the P&L/);
    // One sizing, no caveat — a caveat on every configuration is a caveat nobody
    // reads.
    const single = buildAlgorithmDetail([bulkClient({ algo: 'SUBJECT', accountCount: 2, closes: 1 })], { algorithm: 'SUBJECT' });
    expect(single.configurations[0].sizingCaveat).toBeNull();
  });

  it('counts an account-day that ran two configurations under each, and says so', () => {
    const clients = [makeClient({
      id: 'both', accounts: ['A1'],
      days: [{ date: '2026-07-10', rows: [{ pnl: -30, strategies: [
        strat('SUBJECT', { realized: -10, targets: [1, 2, 3], stop: 4 }),
        strat('SUBJECT', { realized: -20, targets: [5, 6, 7], stop: 8 }),
      ] }] }],
    })];
    const detail = buildAlgorithmDetail(clients, { algorithm: 'SUBJECT' });
    // One account-day for the algorithm; one for each configuration.
    expect(detail.overall.accountDays).toBe(1);
    expect(detail.configurations.map((config) => config.accountDays)).toEqual([1, 1]);
    expect(detail.splitAccountDays).toBe(1);
  });

  it('says so instead of rendering an empty page for an algorithm nobody ran', () => {
    const detail = buildAlgorithmDetail(detailFixture(), { algorithm: 'NOPE' });
    expect(detail.found).toBe(false);
    expect(detail.configurations).toEqual([]);
    expect(detail.knownAlgorithms).toContain('SUBJECT');
  });
});

describe('the clients and accounts running it', () => {
  const rosterFixture = () => [
    bulkClient({ id: 'prop', algo: 'SUBJECT', accountCount: 10, closes: 4, pnl: -50 }),
    makeClient({
      id: 'dark', name: 'Unmeasured client', accounts: ['D1'],
      days: [{ date: '2026-07-10', rows: [{ account: 'D1', pnl: 700, strategies: [strat('SUBJECT', { realized: null })] }] }],
    }),
  ];

  it('names the accounts and what the algorithm made on each', () => {
    const detail = buildAlgorithmDetail([bulkClient({ id: 'prop', algo: 'SUBJECT', accountCount: 10, closes: 4, pnl: -50 })], { algorithm: 'SUBJECT' });
    expect(detail.accountRows).toHaveLength(10);
    expect(detail.accountRows).toHaveLength(detail.overall.accounts);
    expect(detail.clientRows).toHaveLength(1);
    expect(detail.clientRows[0].measuredPnl).toBe(-2000);
    expect(detail.clientRows[0].measuredAccountDays).toBe(40);
    // The client rows and the account rows are the same money seen twice. A join
    // that copied one seat onto two rows would double one side here.
    const byClient = detail.clientRows.reduce((n, row) => n + (row.measuredPnl || 0), 0);
    const byAccount = detail.accountRows.reduce((n, row) => n + (row.measuredPnl || 0), 0);
    expect(byClient).toBeCloseTo(-2000, 6);
    expect(byAccount).toBeCloseTo(byClient, 6);
  });

  it('carries the account type on the ACCOUNT row, where it says which account this is', () => {
    const detail = buildAlgorithmDetail([bulkClient({ id: 'prop', algo: 'SUBJECT', accountCount: 10, closes: 4, accountType: 'Cash' })], { algorithm: 'SUBJECT' });
    expect(detail.accountRows.every((row) => row.segment === SEGMENTS.CASH)).toBe(true);
    // And not on the client row, which can span types.
    expect(detail.clientRows[0].segment).toBeUndefined();
  });

  it('refuses money for a client whose account-days nothing measured', () => {
    const detail = buildAlgorithmDetail(rosterFixture(), { algorithm: 'SUBJECT' });
    const dark = detail.clientRows.find((row) => row.clientName === 'Unmeasured client');
    expect(dark.attributable).toBe(false);
    // null, not 0. A zero here is a claim the export never made.
    expect(dark.measuredPnl).toBe(null);
    expect(dark.derivedPnl).toBe(null);
    expect(dark.unmeasuredAccountDays).toBe(1);
    expect(dark.refusal).toMatch(/neither the fills nor the Strategies grid said what it made/);
    // And the account's own $700 is nowhere near the algorithm's figures.
    expect(JSON.stringify(detail.clientRows)).not.toContain('700');
  });

  it('states the unmeasured account-days beside a client it can only partly answer', () => {
    const clients = [
      bulkClient({ id: 'prop', algo: 'SUBJECT', accountCount: 10, closes: 4, pnl: -50 }),
      makeClient({
        id: 'half', name: 'Half client', accounts: ['H1'],
        days: [
          { date: '2026-07-10', rows: [{ account: 'H1', pnl: -120, strategies: [strat('SUBJECT', { realized: -120 })] }] },
          { date: '2026-07-11', rows: [{ account: 'H1', pnl: 900, strategies: [strat('SUBJECT', { realized: null })] }] },
        ],
      }),
    ];
    const half = buildAlgorithmDetail(clients, { algorithm: 'SUBJECT' }).clientRows
      .find((row) => row.clientName === 'Half client');
    expect(half.attributable).toBe(true);
    expect(half.measuredPnl).toBe(-120);
    expect(half.unmeasuredAccountDays).toBe(1);
    expect(half.caveat).toMatch(/1 further account-day ran this with nothing measuring it/);
    expect(half.measuredPnl).not.toBe(780);
  });

  it('sorts the rows best first, because the reader is choosing what to deploy', () => {
    const clients = [
      bulkClient({ id: 'prop', algo: 'SUBJECT', accountCount: 10, closes: 4, pnl: -50 }),
      makeClient({ id: 'good', name: 'Good', accounts: ['G1'], days: [
        { date: '2026-07-10', rows: [{ account: 'G1', pnl: 400, strategies: [strat('SUBJECT', { realized: 400 })] }] },
      ] }),
      makeClient({ id: 'dark', name: 'Dark', accounts: ['K1'], days: [
        { date: '2026-07-10', rows: [{ account: 'K1', pnl: 5, strategies: [strat('SUBJECT', { realized: null })] }] },
      ] }),
    ];
    const rows = buildAlgorithmDetail(clients, { algorithm: 'SUBJECT' }).clientRows;
    expect(rows.map((row) => row.clientName)).toEqual(['Good', 'Pedro', 'Dark']);
    expect(rows[rows.length - 1].attributable).toBe(false);
  });
});

describe('derived and reported, kept apart end to end', () => {
  it('reads a derived figure as derived and a grid figure as reported', () => {
    expect(measuredSource({ derivedRealized: -12, realized: 0 })).toBe('derived');
    expect(measuredSource({ realized: 0 })).toBe('reported');
    expect(measuredSource({})).toBe(null);
    expect(measuredSource(null)).toBe(null);
    expect(measuredPnl({ derivedRealized: -12, realized: 5 })).toBe(-12);
  });

  it('does not call a flat derived day reported just because zero equals zero', () => {
    const clients = [makeClient({
      id: 'z', accounts: ['A1'], days: [
        { date: '2026-07-10', rows: [{ account: 'A1', pnl: 0, strategies: [strat('SUBJECT', { derivedRealized: 0 })] }] },
      ],
    })];
    const seat = buildAlgorithmDetail(clients, { algorithm: 'SUBJECT' }).accountRows[0];
    expect(seat.daysDerived).toBe(1);
    expect(seat.daysReported).toBe(0);
    expect(seat.measuredAccountDays).toBe(1);
  });

  it('splits one account-day’s money by source and never blends the two', () => {
    const clients = [makeClient({
      id: 'mix', accounts: ['A1'], days: [
        { date: '2026-07-10', rows: [{ account: 'A1', pnl: -30, strategies: [
          strat('SUBJECT', { derivedRealized: -20, version: '1.1' }),
          strat('SUBJECT', { realized: -10, version: '1.1' }),
        ] }] },
      ],
    })];
    const seat = buildAlgorithmDetail(clients, { algorithm: 'SUBJECT' }).accountRows[0];
    expect(seat.derivedPnl).toBe(-20);
    expect(seat.reportedPnl).toBe(-10);
    expect(seat.measuredPnl).toBe(-30);
    expect(seat.daysMixed).toBe(1);
    expect(seat.daysDerived).toBe(0);
    expect(seat.daysReported).toBe(0);
  });
});

describe('the chart of recent closes', () => {
  const seenOnce = () => [
    bulkClient({ id: 'other', algo: 'OTHER', accountCount: 2, closes: 5, pnl: -10 }),
    makeClient({ id: 'sub', name: 'Sub', accounts: ['S1'], days: [
      { date: '2026-07-12', rows: [{ account: 'S1', pnl: -80, strategies: [strat('SUBJECT', { realized: -80 })] }] },
    ] }),
  ];

  it('runs over the book’s closes, so one close out of five looks like one', () => {
    const detail = buildAlgorithmDetail(seenOnce(), { algorithm: 'SUBJECT' });
    expect(detail.series).toHaveLength(5);
    expect(detail.measuredCloses).toBe(1);
    expect(detail.series.map((point) => point.date)).toEqual([
      '2026-07-10', '2026-07-11', '2026-07-12', '2026-07-13', '2026-07-14',
    ]);
    // Same series on the configuration block below it.
    expect(detail.configurations[0].series).toHaveLength(5);
    expect(detail.configurations[0].measuredCloses).toBe(1);
  });

  it('draws a close nobody measured as a gap, never as a zero', () => {
    const detail = buildAlgorithmDetail(seenOnce(), { algorithm: 'SUBJECT' });
    const [first, , measured] = detail.series;
    expect(first.accountDays).toBe(0);
    expect(first.mean).toBe(null);
    expect(measured.accountDays).toBe(1);
    expect(measured.mean).toBe(-80);
  });

  it('states a rate and a count per close, and no total on the day', () => {
    // A close is whichever accounts ran that day, so a close's summed P&L adds a
    // cash dollar to a prop dollar. It was printed under a column headed "Total
    // on the day" carrying the tooltip that promised the opposite, and it got
    // the sign wrong: on this fixture the two account-days of 2026-07-10 are
    // -$100 of prop movement and +$40 of real client money, and the column read
    // -$60 — a loss, on the day the cash account gained.
    const clients = [
      makeClient({
        id: 'prop', accounts: ['A1'], days: [
          { date: '2026-07-10', rows: [{ account: 'A1', pnl: -100, strategies: [strat('SUBJECT', { realized: -100 })] }] },
        ],
      }),
      makeClient({
        id: 'cash', name: 'Cash', accountType: 'Cash', accounts: ['C1'], days: [
          { date: '2026-07-10', rows: [{ account: 'C1', pnl: 40, strategies: [strat('SUBJECT', { realized: 40 })] }] },
        ],
      }),
    ];
    const detail = buildAlgorithmDetail(clients, { algorithm: 'SUBJECT' });
    for (const series of [detail.series, detail.configurations[0].series]) {
      for (const point of series) {
        expect(Object.keys(point).sort()).toEqual(['accountDays', 'date', 'mean']);
      }
    }
    expect(JSON.stringify(detail.series)).not.toContain('-60');
    // The mean is a rate over the same two account-days and is kept: a tick pays
    // both accounts the same, which is the whole reason this page pools at all.
    expect(detail.series[0].mean).toBe(-30);
    expect(detail.series[0].accountDays).toBe(2);
  });

  it('reports each close in the unit the ranking is in, with its account-days', () => {
    const clients = [makeClient({ id: 'two', name: 'Two', accounts: ['A1', 'A2'], days: [
      { date: '2026-07-10', rows: [
        { account: 'A1', pnl: -100, strategies: [strat('SUBJECT', { realized: -100 })] },
        { account: 'A2', pnl: 40, strategies: [strat('SUBJECT', { realized: 40 })] },
      ] },
    ] })];
    const point = buildAlgorithmDetail(clients, { algorithm: 'SUBJECT' }).series[0];
    expect(point.accountDays).toBe(2);
    expect(point.mean).toBe(-30);
    expect(point.pnl).toBeUndefined();
  });

  it('refuses a configuration’s chart outright when no close measured it', () => {
    const clients = [makeClient({ id: 'dark', name: 'Dark', accounts: ['D1'], days: [
      { date: '2026-07-10', rows: [{ account: 'D1', pnl: 300, strategies: [strat('SUBJECT', { realized: null })] }] },
    ] })];
    const detail = buildAlgorithmDetail(clients, { algorithm: 'SUBJECT' });
    expect(detail.measuredCloses).toBe(0);
    expect(detail.configurations[0].seriesRefusal).toMatch(/nothing to chart/);
  });

  it('ends on the book’s last close, not on the wall clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-01-01T00:00:00Z'));
    try {
      const detail = buildAlgorithmDetail(seenOnce(), { algorithm: 'SUBJECT' });
      expect(detail.basis.anchor).toBe('2026-07-14');
      expect(detail.series[detail.series.length - 1].date).toBe('2026-07-14');
      // The half a series-only assertion would miss: anchored on the wall clock
      // the seven-day window ends in 2027 and reads nothing on every row.
      expect(detail.overall.recentAccountDays).toBe(1);
      expect(detail.overall.recentMeanPerAccountDay).toBe(-80);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops at a pinned close and does not chart what came after it', () => {
    const detail = buildAlgorithmDetail(seenOnce(), { algorithm: 'SUBJECT', asOfDate: '2026-07-12' });
    expect(detail.series.map((point) => point.date)).toEqual([
      '2026-07-10', '2026-07-11', '2026-07-12',
    ]);
  });
});

describe('what the algorithm view says it will not produce', () => {
  it('leads with the account-type refusal and names every other one', () => {
    const clients = [
      bulkClient({ id: 'prop', algo: 'SUBJECT', accountCount: 10, closes: 4, pnl: -50 }),
      makeClient({ id: 'cash', name: 'Cash', accountType: 'Cash', accounts: ['C1'], days: [
        { date: '2026-07-10', rows: [{ account: 'C1', pnl: 900, strategies: [strat('SUBJECT', { realized: 900 })] }] },
      ] }),
    ];
    const detail = buildAlgorithmDetail(clients, { algorithm: 'SUBJECT' });
    const refusals = algorithmRefusals(detail);
    const figures = refusals.map((row) => row.figure);
    expect(figures[0]).toBe('A performance figure per account type for SUBJECT');
    expect(figures).toContain('Any dollar for SUBJECT itself — one total, or one per business');
    expect(figures).toContain('A verdict on a configuration below the evidence gate');
    expect(figures).toContain('A line fitted through the closes');
    expect(figures).toContain('What a client made where no split is attributable');
    expect(refusals.every((row) => row.value === null && row.reason.length > 40)).toBe(true);
    expect(refusals[0].reason).toMatch(/property of the ACCOUNT/);
  });

  it('leaves the ranking build untouched when no detail was asked for', () => {
    // `withDetail` exists for this view and must not change what the ranking
    // publishes: a roster leaking onto every row would put every account name in
    // the book into the Operations screen's props.
    const row = rowFor(buildStrategyRanking([bulkClient({ algo: 'SUBJECT' })]), 'SUBJECT');
    expect(row.roster).toBeUndefined();
    expect(row.series).toBeUndefined();
    expect(row.configurations).toBeUndefined();
    expect(row.byDate).toBeUndefined();
  });
});
