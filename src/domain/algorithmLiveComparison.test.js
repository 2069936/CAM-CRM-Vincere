import { describe, expect, it } from 'vitest';
import {
  DIFFERS_WORD,
  buildAlgorithmLiveComparison,
  configIndexFromOutliers,
  previousReviewNote,
  reviewNotePrefix,
  reviewNoteText,
} from './algorithmLiveComparison';
import { buildDeskConfigOutliers } from './deskConfigOutliers';

const CYCLE = '2026-10-06T14:10:00.000Z';
const OLDER = '2026-10-06T14:00:00.000Z';
const NOW = new Date('2026-10-06T14:13:00Z');
const SETTINGS = { minCohortAccounts: 5, minCohortClients: 3, differsAtSpread: 3, minSpreadDollars: 50 };
const CLIENTS = [
  { id: 'c-ash', name: 'Ash' },
  { id: 'c-birch', name: 'Birch' },
  { id: 'c-cedar', name: 'Cedar' },
];

function row(overrides = {}) {
  return {
    clientId: 'c-ash',
    accountName: 'ACC-1',
    strategyId: '1',
    strategyName: '0 - OGX-PF-2.4',
    algorithm: 'OGX_PF',
    instrumentRoot: 'MNQ',
    instrument: 'MNQ 12-26',
    realizedPnl: -400,
    unrealizedPnl: -100,
    restartedAt: null,
    sampledAt: '2026-10-06T14:10:02.000Z',
    cycleStart: CYCLE,
    ...overrides,
  };
}

function cohort(overrides = {}) {
  return {
    algorithm: 'OGX_PF',
    instrumentRoot: 'MNQ',
    status: 'compared',
    nAccounts: 12,
    nClients: 8,
    median: -500,
    spread: 100,
    nFlat: 0,
    ...overrides,
  };
}

function desk(cohorts = [cohort()], extra = {}) {
  return { available: true, cycleStart: CYCLE, filling: false, scope: 'rest_of_desk', cohorts, ...extra };
}

function build(input) {
  return buildAlgorithmLiveComparison({ settings: SETTINGS, clients: CLIENTS, now: NOW, ...input });
}

function onlyAccount(result) {
  return result.algorithms.flatMap((entry) => entry.accounts)[0];
}

describe('the state machine', () => {
  it('not_deployed when the migration is missing, whatever the rows say', () => {
    expect(build({ desk: { available: false }, rows: [row()] }).state).toBe('not_deployed');
  });

  it('no_readings when nobody has sent anything and there is no cycle', () => {
    expect(build({ desk: { available: true, cycleStart: null }, rows: [] }).state).toBe('no_readings');
  });

  it('no_complete_cycle when there are readings but no cycle to compare yet', () => {
    expect(build({ desk: { available: true, cycleStart: null }, rows: [row()] }).state).toBe('no_complete_cycle');
  });

  it('cycle_filling while the newest cycle is still coming in, and compares nothing', () => {
    const result = build({ desk: desk([], { filling: true }), rows: [row()] });
    expect(result.state).toBe('cycle_filling');
    expect(result.algorithms).toEqual([]);
    expect(result.toVerify).toEqual([]);
  });

  it('ready otherwise, with the cycle and its age', () => {
    const result = build({ desk: desk(), rows: [row()] });
    expect(result.state).toBe('ready');
    expect(result.cycleStart).toBe(CYCLE);
    expect(result.cycleAgeSeconds).toBe(180);
    expect(result.scope).toBe('rest_of_desk');
  });
});

describe('an account against its cohort', () => {
  it('compares an account in the desk cycle and states the distance in the usual spread', () => {
    const account = onlyAccount(build({ desk: desk(), rows: [row({ realizedPnl: -1100, unrealizedPnl: -100 })] }));
    expect(account).toMatchObject({
      status: 'compared', value: -1200, realized: -1100, unrealized: -100, distance: -700, spread: 7, differs: true,
    });
  });

  it('sums the instances of one account and keeps two accounts of one client apart', () => {
    const result = build({
      desk: desk(),
      rows: [
        row({ strategyId: '1', realizedPnl: -300, unrealizedPnl: 0 }),
        row({ strategyId: '2', realizedPnl: -200, unrealizedPnl: 0 }),
        row({ accountName: 'ACC-2', strategyId: '3', realizedPnl: -100, unrealizedPnl: 0 }),
      ],
    });
    const accounts = result.algorithms[0].accounts;
    expect(accounts).toHaveLength(2);
    expect(accounts.find((a) => a.accountName === 'ACC-1')).toMatchObject({ value: -500, distance: 0 });
    expect(accounts.find((a) => a.accountName === 'ACC-1').instances).toHaveLength(2);
    expect(accounts.find((a) => a.accountName === 'ACC-2')).toMatchObject({ value: -100 });
  });

  it('a part not measured reads unmeasured with NO value, never 0', () => {
    for (const part of [{ realizedPnl: null }, { unrealizedPnl: null }, { realizedPnl: undefined }]) {
      const account = onlyAccount(build({ desk: desk(), rows: [row(part), row({ strategyId: '2' })] }));
      expect(account.status).toBe('unmeasured');
      expect(account.value).toBeNull();
      expect(account.realized).toBeNull();
      expect(account.distance).toBeNull();
      expect(account.differs).toBe(false);
    }
  });

  it('a restarted instance shows its value and its restart, and is never compared or listed', () => {
    const result = build({
      desk: desk(),
      rows: [row({ realizedPnl: -5000, restartedAt: '2026-10-06T13:40:00Z' })],
    });
    const account = onlyAccount(result);
    expect(account).toMatchObject({ status: 'restarted', value: -5100, differs: false, distance: null });
    expect(account.restartedAt).toBe('2026-10-06T13:40:00.000Z');
    expect(result.toVerify).toEqual([]);
  });

  it('a reading with no cycle is off_cycle, one from an older cycle is not_in_cycle, and neither is compared', () => {
    const result = build({
      desk: desk(),
      rows: [
        row({ accountName: 'OFF', cycleStart: null, sampledAt: '2026-10-06T14:14:00Z', realizedPnl: -9000 }),
        row({ accountName: 'OLD', cycleStart: OLDER, sampledAt: '2026-10-06T14:00:02Z', realizedPnl: -9000 }),
      ],
    });
    const byName = Object.fromEntries(result.algorithms[0].accounts.map((a) => [a.accountName, a]));
    expect(byName.OFF.status).toBe('off_cycle');
    expect(byName.OLD.status).toBe('not_in_cycle');
    expect(byName.OLD.sampledAt).toBe('2026-10-06T14:00:02.000Z');
    expect(result.toVerify).toEqual([]);
    expect(result.notInCycle.map((a) => a.accountName)).toEqual(['OFF', 'OLD']);
  });

  it('uses the minimum spread when the cohort agrees to the cent: no Infinity, no NaN', () => {
    const account = onlyAccount(build({
      desk: desk([cohort({ spread: 0 })]),
      rows: [row({ realizedPnl: -560, unrealizedPnl: 0 })],
    }));
    expect(account.spread).toBe(1.2);
    expect(Number.isFinite(account.spread)).toBe(true);
    expect(account.differs).toBe(false);

    const exact = onlyAccount(build({ desk: desk([cohort({ spread: 0 })]), rows: [row({ realizedPnl: -400 })] }));
    expect(exact.spread).toBe(0);
  });

  it('the differs threshold is the setting', () => {
    const rows = [row({ realizedPnl: -800, unrealizedPnl: 0 })];
    expect(onlyAccount(build({ desk: desk(), rows })).differs).toBe(true);
    expect(onlyAccount(build({ desk: desk(), rows, settings: { ...SETTINGS, differsAtSpread: 4 } })).differs).toBe(false);
  });
});

describe('thin cohorts and the refusal to rank them', () => {
  it('a thin cohort is listed with the value and is never in toVerify, however far off', () => {
    const result = build({
      desk: desk([cohort({ status: 'thin', nAccounts: null, nClients: null, median: null, spread: null, nFlat: null })]),
      rows: [row({ realizedPnl: -100000 })],
    });
    expect(result.algorithms[0].desk.status).toBe('thin');
    expect(onlyAccount(result)).toMatchObject({ status: 'cohort_thin', value: -100100, differs: false, spread: null });
    expect(result.toVerify).toEqual([]);
  });

  it('a cohort absent from the desk answer is thin too, never compared against nothing', () => {
    const result = build({ desk: desk([]), rows: [row({ realizedPnl: -100000 })] });
    expect(result.algorithms[0].desk.status).toBe('absent');
    expect(onlyAccount(result).status).toBe('cohort_thin');
    expect(result.toVerify).toEqual([]);
  });

  it('a "compared" cohort that arrives without its numbers is treated as thin', () => {
    const result = build({ desk: desk([cohort({ median: null })]), rows: [row({ realizedPnl: -9000 })] });
    expect(onlyAccount(result).status).toBe('cohort_thin');
  });
});

describe('ordering', () => {
  it('toVerify is sorted by spread, never by value', () => {
    const result = build({
      desk: desk([cohort({ spread: 100 }), cohort({ algorithm: 'ALPHA', median: 0, spread: 1000 })]),
      rows: [
        // Ash: 700 off a spread of 100 is 7 spreads.
        row({ clientId: 'c-ash', realizedPnl: -1200, unrealizedPnl: 0 }),
        // Birch: 5000 off a spread of 1000 is 5 spreads, a bigger dollar gap.
        row({ clientId: 'c-birch', algorithm: 'ALPHA', strategyName: '1 - ALPHA-1.2', realizedPnl: -5000, unrealizedPnl: 0 }),
        // Cedar: 400 off is 4 spreads.
        row({ clientId: 'c-cedar', realizedPnl: -100, unrealizedPnl: 0 }),
      ],
    });
    expect(result.toVerify.map((a) => a.clientName)).toEqual(['Ash', 'Birch', 'Cedar']);
    expect(result.toVerify.map((a) => a.spread)).toEqual([7, 5, 4]);
  });

  it('inside an algorithm, compared rows first by spread, then the rest by client and account', () => {
    const result = build({
      desk: desk(),
      rows: [
        row({ clientId: 'c-cedar', accountName: 'Z', realizedPnl: -450, unrealizedPnl: 0 }),
        row({ clientId: 'c-ash', accountName: 'B', cycleStart: null }),
        row({ clientId: 'c-birch', accountName: 'Y', realizedPnl: -900, unrealizedPnl: 0 }),
        row({ clientId: 'c-ash', accountName: 'A', realizedPnl: null }),
      ],
    });
    expect(result.algorithms[0].accounts.map((a) => a.accountName)).toEqual(['Y', 'Z', 'A', 'B']);
  });

  it('algorithms are alphabetical, then by root, and say where else they run', () => {
    const result = build({
      desk: desk([cohort({ instrumentRoot: 'NQ' }), cohort(), cohort({ algorithm: 'ALPHA' })]),
      rows: [],
    });
    expect(result.algorithms.map((a) => `${a.algorithm} ${a.instrumentRoot}`))
      .toEqual(['ALPHA MNQ', 'OGX_PF MNQ', 'OGX_PF NQ']);
    expect(result.algorithms[1].alsoOn).toEqual(['NQ']);
    expect(result.algorithms[2].alsoOn).toEqual(['MNQ']);
    expect(result.algorithms[0].alsoOn).toEqual([]);
  });
});

describe('what a median of 0 means', () => {
  it('mostlyUntraded when the median is 0 and half or more of the cohort is flat', () => {
    const result = build({ desk: desk([cohort({ median: 0, spread: 0, nFlat: 6, nAccounts: 12 })]), rows: [] });
    expect(result.algorithms[0].desk.mostlyUntraded).toBe(true);
    const traded = build({ desk: desk([cohort({ median: 0, spread: 0, nFlat: 5, nAccounts: 12 })]), rows: [] });
    expect(traded.algorithms[0].desk.mostlyUntraded).toBe(false);
  });
});

describe('the words', () => {
  it('the only verdict word is "differs"', () => {
    expect(DIFFERS_WORD).toBe('differs');
    const result = build({ desk: desk(), rows: [row({ realizedPnl: -5000 })] });
    const text = JSON.stringify(result).toLowerCase();
    for (const word of ['wrong', 'worse', 'below', 'underperform', 'bad', 'outlier']) {
      expect(text).not.toContain(word);
    }
  });
});

describe('the configuration beside the number', () => {
  it('passes configFor through with its date, keyed on client, account, algorithm and root', () => {
    const calls = [];
    const configFor = (...args) => {
      calls.push(args);
      return { date: '2026-10-05', scope: 'book', differing: [], sizing: [] };
    };
    const account = onlyAccount(build({ desk: desk(), rows: [row()], configFor }));
    expect(calls).toEqual([['c-ash', 'ACC-1', 'OGX_PF', 'MNQ']]);
    expect(account.config.date).toBe('2026-10-05');
  });

  function closeOn(date, rows) {
    return { date, strategies: rows };
  }
  function strategy(accountName, params) {
    return {
      accountName,
      strategyName: '0 - OGX-PF-2.4',
      strategyFamily: 'OGX_PF',
      strategyVersion: '2.4',
      instrument: 'MNQ 12-26',
      dataSeries: '1 Minute',
      params,
    };
  }

  it('reads the real outliers result: what differs, what is sizing, and who had no close', () => {
    const clients = [
      { id: 'c1', name: 'One', dailyImports: [closeOn('2026-10-05', [strategy('A1', { PosSize1: '4', StopLoss: '20' })])] },
      { id: 'c2', name: 'Two', dailyImports: [closeOn('2026-10-05', [strategy('A2', { PosSize1: '2', StopLoss: '20' })])] },
      { id: 'c3', name: 'Three', dailyImports: [closeOn('2026-10-05', [strategy('A3', { PosSize1: '2', StopLoss: '20' })])] },
      { id: 'c4', name: 'Four', dailyImports: [closeOn('2026-10-05', [strategy('A4', { PosSize1: '2', StopLoss: '20' })])] },
    ];
    const outliers = buildDeskConfigOutliers(clients, {
      date: '2026-10-05',
      parametersOf: (s) => s.params,
    });
    const configFor = configIndexFromOutliers(outliers, { scope: 'book' });
    const one = configFor('c1', 'A1', 'OGX_PF', 'MNQ');
    expect(one).toMatchObject({ date: '2026-10-05', scope: 'book', measured: true, differing: [] });
    expect(one.sizing).toEqual([
      { field: 'PosSize1', state: 'different', account: '4', consensus: '2', countText: '3 of 4 accounts' },
    ]);
    expect(configFor('c2', 'A2', 'OGX_PF', 'MNQ')).toMatchObject({ differing: [], sizing: [] });
    expect(configFor('c9', 'A9', 'OGX_PF', 'MNQ')).toEqual({ date: '2026-10-05', scope: 'book', reason: 'no_close' });
    expect(configFor('c1', 'A1', 'ALPHA', 'MNQ')).toEqual({ date: '2026-10-05', scope: 'book', reason: 'not_on_close' });
  });

  it('gives nothing at all when there is no day to read', () => {
    expect(configIndexFromOutliers({ date: '', reason: 'no-date', groups: [] })('c1', 'A1', 'X', 'MNQ')).toBeNull();
  });
});

describe('the feedback note', () => {
  const account = {
    algorithm: 'OGX_PF', instrumentRoot: 'MNQ', accountName: 'ACC-1', value: -1200,
  };
  const deskFigure = { status: 'compared', median: -500, nAccounts: 12, nClients: 8 };

  it('writes the prefix, the cycle, both figures and the counts, then the note', () => {
    const text = reviewNoteText({ account, desk: deskFigure, cycleStart: '2026-10-06T14:10:00', note: ' sizing is 4 ' });
    expect(text.startsWith(reviewNotePrefix(account))).toBe(true);
    expect(text).toBe('[algorithm live] OGX_PF MNQ, ACC-1, cycle 14:10: -$1,200 against desk median -$500 (12 accounts, 8 clients). sizing is 4');
  });

  it('finds the newest earlier Review note for the same account, algorithm and root only', () => {
    const client = {
      activityLog: [
        { type: 'Review', text: `${reviewNotePrefix(account)} cycle 10:10: old`, createdAt: '2026-10-01T10:00:00Z' },
        { type: 'Review', text: `${reviewNotePrefix(account)} cycle 11:10: newer`, createdAt: '2026-10-03T10:00:00Z' },
        { type: 'Note', text: `${reviewNotePrefix(account)} cycle 12:10: not a review`, createdAt: '2026-10-04T10:00:00Z' },
        { type: 'Review', text: `${reviewNotePrefix({ ...account, instrumentRoot: 'NQ' })} other root`, createdAt: '2026-10-05T10:00:00Z' },
        { type: 'Review', text: `${reviewNotePrefix({ ...account, accountName: 'ACC-10' })} other account`, createdAt: '2026-10-05T10:00:00Z' },
      ],
    };
    expect(previousReviewNote(client, account).text).toContain('newer');
    expect(previousReviewNote({ activityLog: [] }, account)).toBeNull();
  });
});
