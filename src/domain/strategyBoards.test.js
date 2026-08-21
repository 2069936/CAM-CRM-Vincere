// The rules the algorithm boards must never break, on fixtures.
//
// UNGATED ON PURPOSE. This file reads no snapshot, so it runs on CI and on every
// clone. What is here is everything that can be stated without the book: the
// evidence rules the roll-up inherited from buildStrategyEffectiveness, the
// business split, the rank gate, the clustering, and the two wall-clock defects
// (a seven-day window measured against `new Date()`, and an up-arrow printed for
// exactly zero).
//
// The arithmetic against 96 clients and 14 closes is in strategyBoards.book.test.js,
// which IS gated and therefore pins nothing on CI. Anything that can be said here
// belongs here.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EVIDENCE_GATE,
  boardRefusals,
  buildStrategyBoards,
  clusteredMean,
  measuredPnl,
  shiftDay,
} from './strategyBoards';
import { DESK_BUSINESS } from './deskMoney';
import { BUSINESS_KEYS, businessForSegment, SEGMENTS } from './operationsSegments';

/**
 * One client, one account type, and as many closes as asked for.
 *
 * `days` is a list of { date, strategies, pnl }, where `pnl` is what the ACCOUNT
 * made — the figure the coverage line compares the algorithms against.
 */
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

/** `count` closes of one algorithm on `accountCount` accounts, each making `pnl`. */
function bulkClient({ algo = 'RBO', accountType = 'Funded', accountCount = 12, closes = 5, pnl = -100, id = 'c1' } = {}) {
  const accounts = Array.from({ length: accountCount }, (_, i) => `A${i + 1}`);
  const days = Array.from({ length: closes }, (_, d) => ({
    date: `2026-07-${String(10 + d).padStart(2, '0')}`,
    rows: accounts.map((account) => ({
      account,
      pnl,
      strategies: [{ strategyFamily: algo, enabled: true, realized: pnl }],
    })),
  }));
  return makeClient({ id, accountType, accounts, days });
}

const boardFor = (result, key) => result.boards.find((board) => board.key === key) || null;
const rowFor = (result, key, name) => (boardFor(result, key)?.rows || []).find((row) => row.name === name) || null;

describe('what counts as a measurement', () => {
  it('prefers a derived figure, then a reported one, and calls nothing else evidence', () => {
    expect(measuredPnl({ derivedRealized: 80, realized: 5 })).toBe(80);
    expect(measuredPnl({ realized: 30 })).toBe(30);
    expect(measuredPnl({ realized: null })).toBeNull();
    expect(measuredPnl({})).toBeNull();
    // A derived 0 is a measurement, not an absence. `??` on the old path made
    // these two indistinguishable.
    expect(measuredPnl({ derivedRealized: 0, realized: 500 })).toBe(0);
  });

  it('never splits an account day across the algorithms that were running', () => {
    // Two enabled strategies, an account down $776, and an export that said
    // nothing about either of them. The even split would put -$388 on each — a
    // figure nobody measured, on the board the desk ranks algorithms by.
    const client = makeClient({
      days: [{
        date: '2026-07-10',
        rows: [{
          pnl: -776,
          strategies: [
            { strategyFamily: 'RBO', enabled: true, realized: null },
            { strategyFamily: 'IFSP', enabled: true, realized: null },
          ],
        }],
      }],
    });
    const result = buildStrategyBoards([client]);
    const rows = boardFor(result, DESK_BUSINESS.PROP_OTHER).rows;
    expect(rows.map((row) => row.totalPnl)).toEqual([0, 0]);
    expect(rows.every((row) => row.accountDays === 0)).toBe(true);
    expect(rows.every((row) => row.meanPerAccountDay === null)).toBe(true);
    expect(rows.every((row) => row.unmeasuredAccountDays === 1)).toBe(true);
    // The roster is still exact: both algorithms ran on this account.
    expect(rows.every((row) => row.accounts === 1 && row.clients === 1)).toBe(true);
  });

  it('treats an absent Realized column exactly like a grid that reported zero', () => {
    // The same statement — "this export does not say" — used to reach the
    // roll-up two ways: the first contributed 0 and the second an invented share
    // of the account's day, and which branch a row took depended on whether
    // NinjaTrader emitted the column.
    const withNull = makeClient({
      days: [{ date: '2026-07-10', rows: [{ pnl: -500, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: null }] }] }],
    });
    const withZero = makeClient({
      days: [{ date: '2026-07-10', rows: [{ pnl: -500, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: 0 }] }] }],
    });
    expect(rowFor(buildStrategyBoards([withNull]), DESK_BUSINESS.PROP_OTHER, 'RBO').totalPnl)
      .toBe(rowFor(buildStrategyBoards([withZero]), DESK_BUSINESS.PROP_OTHER, 'RBO').totalPnl);
  });

  it('separates a reported flat day from a day nobody reported', () => {
    // 976 of the 1,402 measured observations on the real book are exactly 0. A
    // board that showed only up and down days could not tell those from the days
    // the export said nothing about, and the two mean opposite things.
    const client = makeClient({
      days: [
        { date: '2026-07-10', rows: [{ pnl: 0, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: 0 }] }] },
        { date: '2026-07-11', rows: [{ pnl: -50, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: null }] }] },
      ],
    });
    const row = rowFor(buildStrategyBoards([client]), DESK_BUSINESS.PROP_OTHER, 'RBO');
    expect(row.flatDays).toBe(1);
    expect(row.unmeasuredAccountDays).toBe(1);
    expect(row.accountDays).toBe(1);
  });

  it('is one observation per account-day, not per strategy row', () => {
    // Two instances of the same family enabled on one account on one day are one
    // account-day. Counting them twice prints 341 account-days where the desk has
    // 340, under a column headed "account-days".
    const client = makeClient({
      days: [{
        date: '2026-07-10',
        rows: [{
          pnl: -30,
          strategies: [
            { strategyFamily: 'RBO', strategyName: '0 - RBO-1.8', enabled: true, realized: -10 },
            { strategyFamily: 'RBO', strategyName: '0 - RBO-1.9', enabled: true, realized: -20 },
          ],
        }],
      }],
    });
    const row = rowFor(buildStrategyBoards([client]), DESK_BUSINESS.PROP_OTHER, 'RBO');
    expect(row.accountDays).toBe(1);
    expect(row.totalPnl).toBe(-30);
    expect(row.meanPerAccountDay).toBe(-30);
  });

  it('counts one account name held by two clients as two accounts', () => {
    // 53 of the 631 account names on the real book are held by two clients,
    // accountRegistry is per client, and every other figure on the Operations
    // screen already counts them as two.
    const shared = (id) => makeClient({
      id,
      name: id,
      accounts: ['SAME'],
      days: [{ date: '2026-07-10', rows: [{ pnl: -10, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: -10 }] }] }],
    });
    const row = rowFor(buildStrategyBoards([shared('c1'), shared('c2')]), DESK_BUSINESS.PROP_OTHER, 'RBO');
    expect(row.accounts).toBe(2);
    expect(row.accountDays).toBe(2);
    expect(row.clients).toBe(2);
  });

  it('ignores a strategy that was not enabled', () => {
    const client = makeClient({
      days: [{ date: '2026-07-10', rows: [{ pnl: -10, strategies: [{ strategyFamily: 'RBO', enabled: false, realized: -10 }] }] }],
    });
    expect(buildStrategyBoards([client]).boards).toHaveLength(0);
  });
});

describe('the mean, and what it is a mean of', () => {
  it('divides by REPORTED account-days, flat ones included', () => {
    // Excluding flat days from the denominator flatters every algorithm that
    // mostly sits still, and the old Avg/Day did exactly that: its denominator
    // was winDays + lossDays.
    const client = makeClient({
      days: [
        { date: '2026-07-10', rows: [{ pnl: -300, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: -300 }] }] },
        { date: '2026-07-11', rows: [{ pnl: 0, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: 0 }] }] },
        { date: '2026-07-12', rows: [{ pnl: 0, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: 0 }] }] },
      ],
    });
    const row = rowFor(buildStrategyBoards([client]), DESK_BUSINESS.PROP_OTHER, 'RBO');
    expect(row.accountDays).toBe(3);
    expect(row.meanPerAccountDay).toBe(-100);
    // Not -300, which is what dividing by decided days alone would print.
    expect(row.upDays).toBe(0);
    expect(row.downDays).toBe(1);
    expect(row.flatDays).toBe(2);
  });

  it('takes win rate over decided days and says how many those were', () => {
    const client = makeClient({
      days: [
        { date: '2026-07-10', rows: [{ pnl: 100, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: 100 }] }] },
        { date: '2026-07-11', rows: [{ pnl: -100, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: -100 }] }] },
        { date: '2026-07-12', rows: [{ pnl: 0, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: 0 }] }] },
      ],
    });
    const row = rowFor(buildStrategyBoards([client]), DESK_BUSINESS.PROP_OTHER, 'RBO');
    expect(row.decidedDays).toBe(2);
    expect(row.winRate).toBe(50);
  });

  it('refuses a win rate rather than printing 0% when no day was decided', () => {
    const client = makeClient({
      days: [{ date: '2026-07-10', rows: [{ pnl: 0, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: 0 }] }] }],
    });
    expect(rowFor(buildStrategyBoards([client]), DESK_BUSINESS.PROP_OTHER, 'RBO').winRate).toBeNull();
  });

  it('counts accounts in profit on the account total, not on its days', () => {
    const client = makeClient({
      accounts: ['A1', 'A2'],
      days: [
        {
          date: '2026-07-10',
          rows: [
            { account: 'A1', pnl: 500, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: 500 }] },
            { account: 'A2', pnl: -50, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: -50 }] },
          ],
        },
        {
          date: '2026-07-11',
          rows: [
            // A1 gives most of it back but is still up on the algorithm overall.
            { account: 'A1', pnl: -400, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: -400 }] },
            { account: 'A2', pnl: -50, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: -50 }] },
          ],
        },
      ],
    });
    const row = rowFor(buildStrategyBoards([client]), DESK_BUSINESS.PROP_OTHER, 'RBO');
    expect(row.accountsProfitable).toBe(1);
    expect(row.accountsProfitablePct).toBe(50);
    expect(row.winRate).toBe(25);
  });
});

describe('the interval, clustered on the account', () => {
  it('widens when the spread lives between accounts rather than within them', () => {
    // Both sets have the same twenty observations and the same mean. In the
    // first, each account is consistently itself; in the second, every account
    // sees both values. Treating the days as independent draws would give these
    // the same interval, and the first deserves a wider one.
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
        { date: '2026-07-10', rows: [{ pnl: 10, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: 10 }] }] },
        { date: '2026-07-11', rows: [{ pnl: -30, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: -30 }] }] },
      ],
    });
    const row = rowFor(buildStrategyBoards([client]), DESK_BUSINESS.PROP_OTHER, 'RBO');
    expect(row.ci).toBeNull();
    expect(row.ciRefusal).toMatch(/One account/);
  });

  it('carries the finite-sample correction, so ten clusters is not treated as infinite', () => {
    const observations = Array.from({ length: 10 }, (_, i) => ({
      cluster: `a${i}`,
      value: i % 2 === 0 ? 100 : -100,
    }));
    const stats = clusteredMean(observations);
    // sum of squared cluster deviations = 10 * 100^2 = 100000; n^2 = 100.
    // Uncorrected sd = sqrt(1000) = 31.6228; corrected multiplies by
    // sqrt(10/9) = 1.05409.
    expect(stats.halfWidth / (1.959964 * Math.sqrt(1000))).toBeCloseTo(Math.sqrt(10 / 9), 10);
  });
});

describe('the evidence gate', () => {
  it('is 30 reported account-days AND 10 accounts', () => {
    expect(EVIDENCE_GATE).toEqual({ minAccountDays: 30, minAccounts: 10 });
  });

  it('ranks a row that clears both arms', () => {
    const result = buildStrategyBoards([bulkClient({ accountCount: 10, closes: 3 })]);
    const row = rowFor(result, DESK_BUSINESS.PROP_OTHER, 'RBO');
    expect(row.accountDays).toBe(30);
    expect(row.accounts).toBe(10);
    expect(row.ranked).toBe(true);
    expect(row.rank).toBe(1);
    expect(row.rankRefusal).toBeNull();
  });

  it('refuses a rank on account-days alone, and names the arm that failed', () => {
    // 29 account-days over 29 accounts: plenty of accounts, one day short.
    const result = buildStrategyBoards([bulkClient({ accountCount: 29, closes: 1 })]);
    const row = rowFor(result, DESK_BUSINESS.PROP_OTHER, 'RBO');
    expect(row.accountDays).toBe(29);
    expect(row.ranked).toBe(false);
    expect(row.rank).toBeNull();
    expect(row.rankRefusal).toContain('29 reported account-days');
    expect(row.rankRefusal).not.toContain('accounts, fewer');
  });

  it('refuses a rank on accounts alone, and names that arm', () => {
    // 45 account-days off 9 accounts: one account short, and the days it does
    // have are nine accounts' luck measured five times each.
    const result = buildStrategyBoards([bulkClient({ accountCount: 9, closes: 5 })]);
    const row = rowFor(result, DESK_BUSINESS.PROP_OTHER, 'RBO');
    expect(row.accountDays).toBe(45);
    expect(row.ranked).toBe(false);
    expect(row.rankRefusal).toContain('9 accounts');
    expect(row.rankRefusal).not.toContain('reported account-days, fewer');
  });

  it('lists an unranked row rather than dropping it, with its counts intact', () => {
    // The row that used to sit at #1 on the real board had two account-days.
    const client = makeClient({
      days: [{ date: '2026-07-10', rows: [{ pnl: 864, strategies: [{ strategyFamily: 'ARPD_PF', enabled: true, realized: 864 }] }] }],
    });
    const board = boardFor(buildStrategyBoards([client]), DESK_BUSINESS.PROP_OTHER);
    expect(board.rows).toHaveLength(1);
    expect(board.rankedCount).toBe(0);
    expect(board.unrankedCount).toBe(1);
    expect(board.rows[0].totalPnl).toBe(864);
    expect(board.rows[0].rank).toBeNull();
  });

  it('puts every ranked row above every unranked one, best mean first', () => {
    const result = buildStrategyBoards([
      bulkClient({ id: 'c1', algo: 'GOOD', accountCount: 10, closes: 3, pnl: -10 }),
      bulkClient({ id: 'c2', algo: 'BAD', accountCount: 10, closes: 3, pnl: -900 }),
      bulkClient({ id: 'c3', algo: 'TINY', accountCount: 2, closes: 1, pnl: 5000 }),
    ]);
    const board = boardFor(result, DESK_BUSINESS.PROP_OTHER);
    expect(board.rows.map((row) => row.name)).toEqual(['GOOD', 'BAD', 'TINY']);
    expect(board.rows.map((row) => row.rank)).toEqual([1, 2, null]);
  });
});

describe('one board per business', () => {
  it('routes an account-day by the same function the tiles route money with', () => {
    expect(businessForSegment(SEGMENTS.EVAL_BULLET)).toBe(BUSINESS_KEYS.BULLET);
    expect(businessForSegment(SEGMENTS.CASH)).toBe(BUSINESS_KEYS.CASH);
    expect(businessForSegment(SEGMENTS.FUNDED)).toBe(BUSINESS_KEYS.PROP_OTHER);
    expect(businessForSegment(SEGMENTS.EVAL_STANDARD)).toBe(BUSINESS_KEYS.PROP_OTHER);
    expect(businessForSegment(SEGMENTS.UNCLASSIFIED)).toBe(BUSINESS_KEYS.UNCLASSIFIED);
    expect(businessForSegment(SEGMENTS.IGNORED)).toBeNull();
    expect(businessForSegment(SEGMENTS.ORPHAN)).toBeNull();
    expect(businessForSegment(SEGMENTS.SIMULATION)).toBeNull();
    // An account type this build has never been taught still lands on a board
    // rather than vanishing from every figure on the page.
    expect(businessForSegment('Some Future Type')).toBe(BUSINESS_KEYS.PROP_OTHER);
  });

  it('never puts one algorithm’s cash and prop days in the same row', () => {
    const result = buildStrategyBoards([
      makeClient({ id: 'c1', accountType: 'Funded', days: [{ date: '2026-07-10', rows: [{ pnl: -100, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: -100 }] }] }] }),
      makeClient({ id: 'c2', accountType: 'Cash', days: [{ date: '2026-07-10', rows: [{ pnl: 400, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: 400 }] }] }] }),
    ]);
    expect(rowFor(result, DESK_BUSINESS.PROP_OTHER, 'RBO').totalPnl).toBe(-100);
    expect(rowFor(result, DESK_BUSINESS.CASH, 'RBO').totalPnl).toBe(400);
    // And nowhere is the +300 those two would net to.
    const everyTotal = result.boards.flatMap((board) => board.rows.map((row) => row.totalPnl));
    expect(everyTotal).not.toContain(300);
  });

  it('keeps Bullet-Bot evaluations off the ordinary prop board', () => {
    const result = buildStrategyBoards([
      makeClient({ id: 'c1', accountType: 'Evaluation - Bullet Bot', days: [{ date: '2026-07-10', rows: [{ pnl: -500, strategies: [{ strategyFamily: 'Bullet Bot', enabled: true, realized: -500 }] }] }] }),
      makeClient({ id: 'c2', accountType: 'Funded', days: [{ date: '2026-07-10', rows: [{ pnl: 100, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: 100 }] }] }] }),
    ]);
    expect(boardFor(result, DESK_BUSINESS.BULLET).rows.map((row) => row.name)).toEqual(['Bullet Bot']);
    expect(boardFor(result, DESK_BUSINESS.PROP_OTHER).rows.map((row) => row.name)).toEqual(['RBO']);
  });

  it('counts Ignored and orphan account-days as reconciliation, with no money', () => {
    const ignored = makeClient({
      id: 'c1', accountType: 'Inactive / Ignore',
      days: [{ date: '2026-07-10', rows: [{ pnl: -1020, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: -1020 }] }] }],
    });
    const orphan = {
      id: 'c2', name: 'Orphan', accountRegistry: {},
      dailyImports: [{
        id: 'd', date: '2026-07-10', accounts: {}, flags: [],
        snapshots: [{ accountName: 'GONE', grossRealizedPnl: -50, weeklyPnl: 0, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: -50 }] }],
      }],
    };
    const result = buildStrategyBoards([ignored, orphan]);
    expect(result.boards).toHaveLength(0);
    expect(result.reconciliation.accountDays).toBe(2);
    // No money field on a reconciliation row, deliberately: nothing downstream
    // can add these back into a figure.
    for (const row of result.reconciliation.rows) {
      expect(Object.keys(row).sort()).toEqual(['accountDays', 'accounts', 'segment']);
    }
  });

  it('gives no board and no object a total across businesses', () => {
    const result = buildStrategyBoards([
      makeClient({ id: 'c1', accountType: 'Funded', days: [{ date: '2026-07-10', rows: [{ pnl: -100, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: -100 }] }] }] }),
      makeClient({ id: 'c2', accountType: 'Cash', days: [{ date: '2026-07-10', rows: [{ pnl: 400, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: 400 }] }] }] }),
    ]);
    expect(result.total).toBeUndefined();
    expect(result.totalPnl).toBeUndefined();
    expect(result.rows).toBeUndefined();
    for (const board of result.boards) {
      expect(board.total).toBeUndefined();
      expect(board.totalPnl).toBeUndefined();
    }
    expect(result.crossBoardCoverageRefusal).toMatch(/Each board states its own/);
  });
});

describe('coverage — what the board does not see', () => {
  it('compares the algorithms against what the accounts made on the same days', () => {
    // The account lost 1,000; the algorithms account for 600 of it.
    const client = makeClient({
      days: [{
        date: '2026-07-10',
        rows: [{
          pnl: -1000,
          strategies: [
            { strategyFamily: 'RBO', enabled: true, realized: -400 },
            { strategyFamily: 'OGX', enabled: true, realized: -200 },
          ],
        }],
      }],
    });
    const board = boardFor(buildStrategyBoards([client]), DESK_BUSINESS.PROP_OTHER);
    expect(board.coverage.accountDays).toBe(1);
    expect(board.coverage.accountPnl).toBe(-1000);
    expect(board.coverage.attributedPnl).toBe(-600);
    expect(board.coverage.unattributedPnl).toBe(-400);
    expect(board.coverage.unattributedShare).toBe(40);
  });

  it('refuses a share instead of dividing by zero', () => {
    const client = makeClient({
      days: [{ date: '2026-07-10', rows: [{ pnl: 0, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: -25 }] }] }],
    });
    const board = boardFor(buildStrategyBoards([client]), DESK_BUSINESS.PROP_OTHER);
    expect(board.coverage.unattributedShare).toBeNull();
    expect(board.coverage.shareRefusal).toMatch(/divide by zero/);
  });

  it('keeps each board’s coverage inside that board', () => {
    const result = buildStrategyBoards([
      makeClient({ id: 'c1', accountType: 'Funded', days: [{ date: '2026-07-10', rows: [{ pnl: -1000, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: -400 }] }] }] }),
      makeClient({ id: 'c2', accountType: 'Cash', days: [{ date: '2026-07-10', rows: [{ pnl: -200, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: -100 }] }] }] }),
    ]);
    expect(boardFor(result, DESK_BUSINESS.PROP_OTHER).coverage.accountPnl).toBe(-1000);
    expect(boardFor(result, DESK_BUSINESS.CASH).coverage.accountPnl).toBe(-200);
    expect(result.coverage).toBeUndefined();
  });
});

describe('the date footing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Deliberately far past the last close in these fixtures, which is exactly
    // the real condition: the book ends 2026-07-30 and the screen renders in
    // August.
    vi.setSystemTime(new Date('2026-08-20T12:00:00Z'));
  });
  afterEach(() => { vi.useRealTimers(); });

  it('anchors the seven-day windows to the book, not to the wall clock', () => {
    const client = makeClient({
      days: [
        { date: '2026-07-10', rows: [{ pnl: -100, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: -100 }] }] },
        { date: '2026-07-20', rows: [{ pnl: -300, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: -300 }] }] },
      ],
    });
    const row = rowFor(buildStrategyBoards([client]), DESK_BUSINESS.PROP_OTHER, 'RBO');
    // Against `new Date()` both windows would be empty and this would read 0.
    expect(row.recentPnl).toBe(-300);
    expect(row.recentAccountDays).toBe(1);
    expect(row.priorPnl).toBe(-100);
    expect(row.trend).toBe(-200);
    expect(row.trendDirection).toBe('down');
  });

  it('never calls a trend "up" when it is exactly zero', () => {
    // `trend >= 0 ? up : down` printed an up arrow on every row whose windows
    // were both empty, which under the wall-clock anchor was every row.
    const client = makeClient({
      days: [
        { date: '2026-07-10', rows: [{ pnl: -100, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: -100 }] }] },
        { date: '2026-07-20', rows: [{ pnl: -100, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: -100 }] }] },
      ],
    });
    const row = rowFor(buildStrategyBoards([client]), DESK_BUSINESS.PROP_OTHER, 'RBO');
    expect(row.trend).toBe(0);
    expect(row.trendDirection).toBe('flat');
  });

  it('refuses a trend when neither window measured anything', () => {
    const client = makeClient({
      days: [{ date: '2026-06-01', rows: [{ pnl: -100, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: -100 }] }] }],
    });
    // Anchored 2026-07-20, so the algorithm's only close is outside both windows.
    const row = rowFor(buildStrategyBoards([client], { asOfDate: '2026-07-20' }), DESK_BUSINESS.PROP_OTHER, 'RBO');
    expect(row.trend).toBe(0);
    expect(row.trendRefusal).toMatch(/Neither the seven days to 2026-07-20/);
  });

  it('runs the history to a pinned date and says so', () => {
    const client = makeClient({
      days: [
        { date: '2026-07-10', rows: [{ pnl: -100, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: -100 }] }] },
        { date: '2026-07-20', rows: [{ pnl: -300, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: -300 }] }] },
      ],
    });
    const pinned = buildStrategyBoards([client], { asOfDate: '2026-07-10' });
    expect(rowFor(pinned, DESK_BUSINESS.PROP_OTHER, 'RBO').totalPnl).toBe(-100);
    expect(pinned.basis.anchor).toBe('2026-07-10');
    expect(pinned.basis.closesAfterAnchor).toBe(1);
  });

  it('states how many closes carry a split out of how many the book holds', () => {
    const client = makeClient({
      days: [
        // A close whose only strategy is disabled carries no split at all.
        { date: '2026-07-09', rows: [{ pnl: -10, strategies: [{ strategyFamily: 'RBO', enabled: false, realized: -10 }] }] },
        { date: '2026-07-10', rows: [{ pnl: -100, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: -100 }] }] },
      ],
    });
    const result = buildStrategyBoards([client]);
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

describe('what the panel says it will not produce', () => {
  it('names every refusal and counts the unranked rows honestly', () => {
    const result = buildStrategyBoards([
      bulkClient({ id: 'c1', algo: 'BIG', accountCount: 10, closes: 3 }),
      bulkClient({ id: 'c2', algo: 'TINY', accountCount: 2, closes: 1 }),
    ]);
    const refusals = boardRefusals(result);
    const figures = refusals.map((row) => row.figure);
    expect(figures).toContain('One leaderboard for the desk');
    expect(figures).toContain('A rank ordered by total P&L');
    expect(figures).toContain('A composite effectiveness score');
    expect(figures).toContain('One coverage percentage across every board');
    expect(figures.some((figure) => figure.includes('1 row below the evidence gate'))).toBe(true);
    expect(refusals.every((row) => row.value === null && row.reason.length > 40)).toBe(true);
  });

  it('survives an empty book without inventing a board', () => {
    const result = buildStrategyBoards([]);
    expect(result.boards).toEqual([]);
    expect(result.basis.label).toMatch(/No close on this book/);
    expect(boardRefusals(result)).not.toHaveLength(0);
  });
});
