import { describe, expect, it } from 'vitest';
import { buildAccountLiveDetail, strategiesForAccount } from './accountLiveDetail';

/* ------------------------------------------------------------------------- *
 * CLICK AN ACCOUNT TO SEE WHAT IT IS RUNNING.
 *
 * Pedro's words: this client has these connections, under them these accounts,
 * and these accounts have done this. The account totals come from the account
 * sample; the rows under them come from algorithm_live_samples for that client
 * and account; and each row is held against the desk figure by the same rule
 * AlgorithmLivePanel uses, from algorithmLiveComparison.js. Nothing here
 * invents a statistic: "differs" is the domain's word and the domain's band.
 * ------------------------------------------------------------------------- */

const CYCLE = '2026-10-08T14:10:00.000Z';
const NOW = new Date('2026-10-08T14:13:00.000Z');
const UUID = '4b0e5c8f-8c3f-4b2a-9d2e-1b2c3d4e5f60';
const CLIENT = { id: 'act-1700000000-northwind', uuid: UUID, name: 'Northwind' };
const SETTINGS = {
  minCohortAccounts: 5, minCohortClients: 3, differsAtSpread: 3, minSpreadDollars: 50, cycleSeconds: 600, fallback: false,
};

function sample(overrides = {}) {
  return {
    accountName: 'ACC 01',
    connectionName: 'Live',
    connected: true,
    status: 'Connected',
    realizedPnl: -950,
    unrealizedPnl: -50,
    totalPnl: -1000,
    strategyCount: 3,
    enabledStrategyCount: 2,
    runState: 'running',
    sampledAt: '2026-10-08T14:10:02.000Z',
    ...overrides,
  };
}

function row(overrides = {}) {
  return {
    clientId: UUID,
    accountName: 'ACC 01',
    strategyId: '1',
    strategyName: '0 - OGX-PF-2.4',
    algorithm: 'OGX_PF',
    instrument: 'MNQ 12-26',
    instrumentRoot: 'MNQ',
    realizedPnl: -950,
    unrealizedPnl: -50,
    restartedAt: null,
    sampledAt: '2026-10-08T14:10:02.000Z',
    cycleStart: CYCLE,
    ...overrides,
  };
}

function cohort(overrides = {}) {
  return {
    algorithm: 'OGX_PF', instrumentRoot: 'MNQ', status: 'compared',
    nAccounts: 12, nClients: 8, median: -500, spread: 100, nFlat: 0, ...overrides,
  };
}

function strategies({ rows = [row()], cohorts = [cohort()], desk = {}, settings = SETTINGS, available = true } = {}) {
  return {
    available,
    reason: available ? undefined : 'not_deployed',
    desk: { available: true, cycleStart: CYCLE, filling: false, scope: 'desk', cohorts, ...desk },
    rows,
    settings,
  };
}

function detail(overrides = {}) {
  return buildAccountLiveDetail({
    client: CLIENT,
    accountName: 'ACC 01',
    sample: sample(),
    strategies: strategies(),
    now: NOW,
    ...overrides,
  });
}

describe('the account totals, from the account sample', () => {
  it('carries the connection and the money as the sample measured it', () => {
    const view = detail();
    expect(view.connectionName).toBe('Live');
    expect(view.connectionWord).toBe('Live');
    expect(view.totals).toMatchObject({
      realized: -950,
      unrealized: -50,
      total: -1000,
      strategyCount: 3,
      enabledStrategyCount: 2,
      sampledAt: '2026-10-08T14:10:02.000Z',
    });
    expect(view.totals.strategiesWords).toBe('2 of 3 strategies enabled');
  });

  it('keeps a null figure null, never zero', () => {
    const view = detail({ sample: sample({ realizedPnl: null, unrealizedPnl: null, totalPnl: null, strategyCount: null, enabledStrategyCount: null, runState: 'unmeasured' }) });
    expect(view.totals).toMatchObject({ realized: null, unrealized: null, total: null, strategyCount: null, enabledStrategyCount: null });
    expect(view.totals.strategiesWords).toBe('No strategy data in this sample');
  });

  it('says none loaded when the VPS measured an empty account', () => {
    expect(detail({ sample: sample({ strategyCount: 0, enabledStrategyCount: 0, runState: 'no_strategies' }) }).totals.strategiesWords)
      .toBe('No strategies loaded');
  });

  it('says there is no account sample when there is none, and still lists the strategies', () => {
    const view = detail({ sample: null });
    expect(view.connectionWord).toBe('No connection name');
    expect(view.totals).toBeNull();
    expect(view.strategies.length).toBe(1);
  });
});

describe('one row per strategy instance, held against the desk', () => {
  it('lists algorithm, instrument and the three figures', () => {
    const view = detail();
    expect(view.strategiesState).toBe('ready');
    expect(view.strategies).toHaveLength(1);
    expect(view.strategies[0]).toMatchObject({
      strategyName: '0 - OGX-PF-2.4',
      algorithm: 'OGX_PF',
      instrument: 'MNQ 12-26',
      instrumentRoot: 'MNQ',
      realized: -950,
      unrealized: -50,
      total: -1000,
      restartedAt: null,
      restartNote: null,
    });
  });

  it('marks an instance that differs from the desk, with the sentence the comparison produces', () => {
    /* -1000 against a median of -500 with a usual spread of 100: five times the
     * spread, over the threshold of three. The word is "differs", a question. */
    const view = detail();
    const [strategy] = view.strategies;
    expect(strategy.comparison).toMatchObject({ status: 'compared', differs: true, distance: -500, spread: 5 });
    expect(strategy.comparison.sentence).toBe('Differs from the desk by $500, 5 times the usual spread.');
    expect(view.differsCount).toBe(1);
    expect(view.differsWords).toBe('1 algorithm differs from the desk');
  });

  it('says within the usual spread when the desk agrees', () => {
    const view = detail({ strategies: strategies({ rows: [row({ realizedPnl: -550, unrealizedPnl: 0 })] }) });
    expect(view.strategies[0].comparison).toMatchObject({ status: 'compared', differs: false, spread: 0.5 });
    expect(view.strategies[0].comparison.sentence).toBe('Within the usual spread of the desk (0.5 times).');
    expect(view.differsCount).toBe(0);
    expect(view.differsWords).toBeNull();
  });

  it('shows nothing amber when the desk cohort is below its floor', () => {
    const thin = detail({ strategies: strategies({ cohorts: [cohort({ status: 'thin', nAccounts: null, nClients: null, median: null, spread: null, nFlat: null })] }) });
    expect(thin.strategies[0].comparison).toMatchObject({ status: 'cohort_thin', differs: false });
    expect(thin.strategies[0].comparison.sentence).toBe('Not compared: the desk figure for this algorithm is too thin.');
    expect(thin.differsCount).toBe(0);
    // And when the desk has no row for the algorithm at all.
    const absent = detail({ strategies: strategies({ cohorts: [] }) });
    expect(absent.strategies[0].comparison.differs).toBe(false);
    expect(absent.differsCount).toBe(0);
  });

  it('tolerates a doubled figure only as far as the desk spread does, and says which', () => {
    /* Pedro's nuance: clients run the same algorithm at different risk levels,
     * which roughly doubles the money, so 2x alone is not a difference. The
     * domain rule is 3 times max(desk spread, $50) around the median: a desk
     * whose accounts are themselves sized differently has a wide spread and a
     * doubled account sits inside it; a desk that agrees to the dollar does
     * not. The rule is kept as it is, and the PR says what it tolerates. */
    const doubled = [row({ realizedPnl: -1000, unrealizedPnl: 0 })];
    const wideDesk = detail({ strategies: strategies({ rows: doubled, cohorts: [cohort({ spread: 300 })] }) });
    expect(wideDesk.strategies[0].comparison).toMatchObject({ differs: false, spread: 1.7 });
    const tightDesk = detail({ strategies: strategies({ rows: doubled, cohorts: [cohort({ spread: 100 })] }) });
    expect(tightDesk.strategies[0].comparison).toMatchObject({ differs: true, spread: 5 });
  });

  it('notes a restart and does not compare the restarted instance', () => {
    const view = detail({ strategies: strategies({ rows: [row({ restartedAt: '2026-10-08T13:40:00.000Z' })] }) });
    expect(view.strategies[0].comparison).toMatchObject({ status: 'restarted', differs: false });
    expect(view.strategies[0].restartNote).toMatch(/^Restarted at \d\d:\d\d, so this figure counts only since then\.$/);
    expect(view.differsCount).toBe(0);
  });

  it('keeps an unmeasured instance at not measured, never zero', () => {
    const view = detail({ strategies: strategies({ rows: [row({ realizedPnl: null })] }) });
    expect(view.strategies[0]).toMatchObject({ realized: null, unrealized: -50, total: null });
    expect(view.strategies[0].comparison).toMatchObject({ status: 'unmeasured', differs: false });
    expect(view.strategies[0].comparison.sentence).toBe('Not measured, not zero.');
  });

  it('does not compare a reading from outside the desk cycle', () => {
    const view = detail({ strategies: strategies({ rows: [row({ cycleStart: '2026-10-08T14:00:00.000Z', sampledAt: '2026-10-08T14:00:03.000Z' })] }) });
    expect(view.strategies[0].comparison).toMatchObject({ status: 'not_in_cycle', differs: false });
    expect(view.strategies[0].comparison.sentence).toMatch(/^Last read at \d\d:\d\d, outside the \d\d:\d\d cycle\. Not compared\.$/);
  });

  it('counts algorithms that differ, not rows: two instances of one algorithm on one root are one question', () => {
    const view = detail({
      strategies: strategies({
        rows: [
          row({ strategyId: '1', strategyName: '0 - OGX-PF-2.4', realizedPnl: -600, unrealizedPnl: 0 }),
          row({ strategyId: '2', strategyName: '1 - OGX-PF-2.4', realizedPnl: -600, unrealizedPnl: 0 }),
          row({ strategyId: '3', strategyName: 'ALPHA', algorithm: 'ALPHA', instrument: 'NQ 12-26', instrumentRoot: 'NQ', realizedPnl: 5, unrealizedPnl: 0 }),
        ],
        cohorts: [cohort(), cohort({ algorithm: 'ALPHA', instrumentRoot: 'NQ', median: 0, spread: 20 })],
      }),
    });
    // The account's OGX_PF on MNQ is -1200 against -500: the account value is the
    // sum of its instances, and both instances carry the same answer.
    expect(view.strategies.filter((s) => s.algorithm === 'OGX_PF').map((s) => s.comparison.differs)).toEqual([true, true]);
    expect(view.strategies.find((s) => s.algorithm === 'ALPHA').comparison.differs).toBe(false);
    expect(view.differsCount).toBe(1);
    expect(view.differsWords).toBe('1 algorithm differs from the desk');
  });

  it('sorts the rows by algorithm, then instrument, then strategy name', () => {
    const view = detail({
      strategies: strategies({
        rows: [
          row({ strategyId: '3', algorithm: 'ZETA', instrument: 'MNQ 12-26', strategyName: 'z' }),
          row({ strategyId: '2', algorithm: 'ALPHA', instrument: 'NQ 12-26', instrumentRoot: 'NQ', strategyName: 'b' }),
          row({ strategyId: '1', algorithm: 'ALPHA', instrument: 'MNQ 12-26', strategyName: 'a' }),
        ],
      }),
    });
    expect(view.strategies.map((s) => `${s.algorithm} ${s.instrument} ${s.strategyName}`))
      .toEqual(['ALPHA MNQ 12-26 a', 'ALPHA NQ 12-26 b', 'ZETA MNQ 12-26 z']);
  });
});

describe('whose rows these are', () => {
  it('keeps only this account, and matches the client by uuid when its id is the legacy key', () => {
    /* The bug that shipped twice: rows carry the uuid, the app names the client
     * by its legacy key. Both have to resolve, and another account's rows and
     * another client's rows have to be left out. */
    const rows = [
      row(),
      row({ strategyId: '2', accountName: 'ACC 02', strategyName: 'other account' }),
      row({ strategyId: '3', clientId: 'some-other-uuid', strategyName: 'other client' }),
    ];
    expect(strategiesForAccount(rows, CLIENT, 'ACC 01').map((r) => r.strategyName)).toEqual(['0 - OGX-PF-2.4']);
    // A client without a uuid resolves by id, the way the fixtures do.
    const plain = { id: 'c-plain', name: 'Plain' };
    expect(strategiesForAccount([row({ clientId: 'c-plain' })], plain, 'ACC 01')).toHaveLength(1);
    // And the detail itself applies the same filter.
    const view = detail({ strategies: strategies({ rows }) });
    expect(view.strategies.map((s) => s.strategyName)).toEqual(['0 - OGX-PF-2.4']);
  });

  it('names the three states the strategies read can be in, besides ready', () => {
    expect(detail({ strategies: null }).strategiesState).toBe('unread');
    expect(detail({ strategies: strategies({ available: false }) }).strategiesState).toBe('not_deployed');
    expect(detail({ strategies: strategies({ rows: [] }) }).strategiesState).toBe('empty');
    expect(detail({ strategies: strategies({ rows: [] }) }).strategies).toEqual([]);
    expect(detail({ strategies: strategies({ rows: [] }) }).differsCount).toBe(0);
  });

  it('never prints a dash in any sentence it produces', () => {
    const views = [
      detail(),
      detail({ strategies: strategies({ rows: [row({ restartedAt: '2026-10-08T13:40:00.000Z' })] }) }),
      detail({ strategies: strategies({ rows: [row({ realizedPnl: null })] }) }),
      detail({ strategies: strategies({ cohorts: [] }) }),
      detail({ sample: sample({ strategyCount: null, enabledStrategyCount: null }) }),
    ];
    for (const view of views) {
      const text = [view.totals?.strategiesWords, view.differsWords, ...view.strategies.flatMap((s) => [s.comparison.sentence, s.restartNote])]
        .filter(Boolean).join(' ');
      expect(text).not.toMatch(/[\u2013\u2014]| - /);
    }
  });
});
