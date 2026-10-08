import { describe, expect, it } from 'vitest';
import { buildAlgorithmRollCall, rollCallChatLine, signedDollars } from './algorithmRollCall';
import { NO_CONNECTION_WORD } from './accountPill';

/* ------------------------------------------------------------------------- *
 * THE ROLL CALL PER ALGORITHM, FOR THE TEAM CHAT.
 *
 * Pedro's words: the CAMs tell each other in the chat how each algorithm is
 * doing ("URGO -300", "how did BulletBot leave you?") and spot the odd one
 * out. One row per algorithm the viewer's clients run in the current cycle:
 * my instances one by one with the desk band, and a line ready to paste.
 *
 * EVERYTHING THAT COMPARES IS algorithmLiveComparison's: the cycle, the band,
 * the "differs" word. This module only groups, ranges and phrases. Nothing is
 * sorted by P&L: the rows go differing first, then by how many instances,
 * then by name.
 * ------------------------------------------------------------------------- */

const CYCLE = '2026-10-08T14:10:00.000Z';
const NOW = new Date('2026-10-08T14:13:00.000Z');
const UUID = '4b0e5c8f-8c3f-4b2a-9d2e-1b2c3d4e5f60';
const SETTINGS = {
  minCohortAccounts: 5, minCohortClients: 3, differsAtSpread: 3, minSpreadDollars: 50, cycleSeconds: 600, fallback: false,
};

// Northwind has a legacy key and a uuid; the rows carry the uuid. Maple Ridge
// has only an id, the way the fixtures of the overview tests do.
const CLIENTS = [
  { id: 'act-1700000000-northwind', uuid: UUID, name: 'Northwind' },
  { id: 'c-maple', name: 'Maple Ridge' },
];

function row(overrides = {}) {
  return {
    clientId: UUID,
    accountName: 'ACC 01',
    strategyId: '1',
    strategyName: 'URGO 1.3',
    algorithm: 'URGO',
    instrument: 'MNQ 12-26',
    instrumentRoot: 'MNQ',
    realizedPnl: -300,
    unrealizedPnl: -10,
    restartedAt: null,
    sampledAt: '2026-10-08T14:10:02.000Z',
    cycleStart: CYCLE,
    marketPosition: null,
    positionQuantity: null,
    tradesThisRun: null,
    ...overrides,
  };
}

function bullet(overrides = {}) {
  return row({ algorithm: 'BulletBot', strategyName: 'BulletBot 2.0', ...overrides });
}

function cohort(overrides = {}) {
  return {
    algorithm: 'URGO', instrumentRoot: 'MNQ', status: 'compared',
    nAccounts: 12, nClients: 8, median: -300, spread: 20, nFlat: 0, ...overrides,
  };
}

/* Three URGO accounts in line with the desk, and four BulletBot accounts of
 * which one differs: the two lines Pedro wrote down, built from readings. */
const URGO_ROWS = [
  row({ accountName: 'ACC 01', realizedPnl: -300, unrealizedPnl: -10 }),
  row({ accountName: 'ACC 02', realizedPnl: -300, unrealizedPnl: 0, clientId: 'c-maple' }),
  row({ accountName: 'ACC 03', realizedPnl: -295, unrealizedPnl: 0, clientId: 'c-maple' }),
];
const BULLET_ROWS = [
  bullet({ accountName: 'ACC 01', strategyId: '2', realizedPnl: -100, unrealizedPnl: -40, marketPosition: 'long', positionQuantity: 2, tradesThisRun: 3 }),
  bullet({ accountName: 'ACC 04', strategyId: '3', realizedPnl: -20, unrealizedPnl: 0, marketPosition: 'long', positionQuantity: 1, tradesThisRun: 1 }),
  bullet({ accountName: 'ACC 02', strategyId: '4', clientId: 'c-maple', realizedPnl: 10, unrealizedPnl: 0, marketPosition: 'long', positionQuantity: 1, tradesThisRun: 2 }),
  bullet({ accountName: 'ACC 03', strategyId: '5', clientId: 'c-maple', realizedPnl: 50, unrealizedPnl: 10, marketPosition: 'short', positionQuantity: 1, tradesThisRun: 1 }),
];
const COHORTS = [
  cohort(),
  cohort({ algorithm: 'BulletBot', median: 20, spread: 10 }),
];

function live({ rows = [...URGO_ROWS, ...BULLET_ROWS], cohorts = COHORTS, settings = SETTINGS, desk = {}, available = true } = {}) {
  return {
    available,
    reason: available ? undefined : 'not_deployed',
    desk: { available: true, cycleStart: CYCLE, filling: false, scope: 'rest_of_desk', cohorts, ...desk },
    rows,
    settings,
  };
}

const TRACKER = {
  available: true,
  staleSeconds: 1500,
  samplesByClientId: new Map([
    [UUID, [
      { accountName: 'ACC 01', connectionName: 'Bluesky', connected: true, status: 'Connected' },
      { accountName: 'ACC 04', connectionName: '', connected: true, status: 'Connected' },
    ]],
    ['c-maple', [
      { accountName: 'ACC 02', connectionName: 'Live', connected: true, status: 'Connected' },
    ]],
  ]),
};

function roll(overrides = {}) {
  return buildAlgorithmRollCall({ live: live(), clients: CLIENTS, tracker: TRACKER, now: NOW, ...overrides });
}

describe('signedDollars', () => {
  it('prints whole dollars with the sign and no currency symbol, the way the chat reads them', () => {
    expect(signedDollars(-310)).toBe('-310');
    expect(signedDollars(60)).toBe('+60');
    expect(signedDollars(0)).toBe('0');
    expect(signedDollars(-0.4)).toBe('0');
    expect(signedDollars(1234.6)).toBe('+1,235');
    expect(signedDollars(-1234.4)).toBe('-1,234');
    expect(signedDollars(null)).toBe('not measured');
    expect(signedDollars(undefined)).toBe('not measured');
  });
});

describe('one row per algorithm the viewer runs', () => {
  it('groups my instances by algorithm and root, and leaves out an algorithm only the desk runs', () => {
    const view = roll({ live: live({ cohorts: [...COHORTS, cohort({ algorithm: 'OGX_PF', instrumentRoot: 'NQ' })] }) });
    expect(view.state).toBe('ready');
    expect(view.cycleStart).toBe(CYCLE);
    expect(view.rows.map((r) => r.heading)).toEqual(['BulletBot MNQ', 'URGO MNQ']);
    expect(view.rows.find((r) => r.algorithm === 'URGO')).toMatchObject({
      algorithm: 'URGO', instrumentRoot: 'MNQ', chatName: 'URGO', count: 3, countWords: '3 accounts',
    });
    expect(view.rows.find((r) => r.algorithm === 'BulletBot').count).toBe(4);
  });

  it('counts instances, not rows: two strategies of one algorithm on one account are one instance', () => {
    const view = roll({
      live: live({
        rows: [
          row({ strategyId: '1', strategyName: 'URGO a', realizedPnl: -150, unrealizedPnl: 0 }),
          row({ strategyId: '2', strategyName: 'URGO b', realizedPnl: -150, unrealizedPnl: 0 }),
        ],
        cohorts: [cohort()],
      }),
    });
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({ count: 1, countWords: '1 account' });
    expect(view.rows[0].instances[0]).toMatchObject({ accountName: 'ACC 01', value: -300 });
  });

  it('is the viewer\'s own range, min to max of realized plus open, in whole signed dollars', () => {
    const view = roll();
    const urgo = view.rows.find((r) => r.algorithm === 'URGO');
    expect(urgo.range).toEqual({ min: -310, max: -295 });
    expect(urgo.rangeWords).toBe('-310 to -295');
    const bullet = view.rows.find((r) => r.algorithm === 'BulletBot');
    expect(bullet.range).toEqual({ min: -140, max: 60 });
    expect(bullet.rangeWords).toBe('-140 to +60');
  });

  it('prints one figure when there is one account, and "not measured" when nothing was measured', () => {
    const one = roll({ live: live({ rows: [row()], cohorts: [cohort()] }) });
    expect(one.rows[0].rangeWords).toBe('-310');
    const none = roll({ live: live({ rows: [row({ realizedPnl: null }), row({ accountName: 'ACC 02', unrealizedPnl: null })], cohorts: [cohort()] }) });
    expect(none.rows[0].range).toEqual({ min: null, max: null });
    expect(none.rows[0].rangeWords).toBe('not measured');
  });

  it('leaves an unmeasured instance out of the range and keeps the measured ones', () => {
    const view = roll({ live: live({ rows: [row(), row({ accountName: 'ACC 02', realizedPnl: null })], cohorts: [cohort()] }) });
    expect(view.rows[0]).toMatchObject({ count: 2, range: { min: -310, max: -310 }, rangeWords: '-310' });
  });
});

describe('the desk beside the row, and the status word', () => {
  it('carries the desk median, spread and sample size from the comparison, with a sentence', () => {
    const urgo = roll().rows.find((r) => r.algorithm === 'URGO');
    expect(urgo.desk).toMatchObject({ status: 'compared', median: -300, spread: 20, nAccounts: 12, nClients: 8 });
    expect(urgo.deskWords).toBe('Desk median -$300 over 12 accounts from 8 clients, spread $20.');
  });

  it('in line with the desk when every compared instance sits inside the band', () => {
    const urgo = roll().rows.find((r) => r.algorithm === 'URGO');
    expect(urgo).toMatchObject({ comparedCount: 3, differsCount: 0, status: 'in_line', statusWords: 'in line with the desk' });
  });

  it('"1 differs from the desk" when one does, "2 differ" when two do, from the comparison\'s own verdict', () => {
    const bulletRow = roll().rows.find((r) => r.algorithm === 'BulletBot');
    expect(bulletRow).toMatchObject({ comparedCount: 4, differsCount: 1, status: 'differs', statusWords: '1 differs from the desk' });
    // ACC 01 at -140 against a median of +20 with a usual spread of $50: 3.2 times, over the 3 threshold.
    expect(bulletRow.instances.filter((i) => i.differs).map((i) => i.accountName)).toEqual(['ACC 01']);
    const two = roll({
      live: live({
        rows: [...BULLET_ROWS.slice(0, 3), bullet({ accountName: 'ACC 03', strategyId: '5', clientId: 'c-maple', realizedPnl: 400, unrealizedPnl: 0 })],
        cohorts: [COHORTS[1]],
      }),
    });
    expect(two.rows[0]).toMatchObject({ differsCount: 2, statusWords: '2 differ from the desk' });
  });

  it('"desk not comparable yet" when the cohort is thin or absent, and nothing differs then', () => {
    const thin = roll({ live: live({ rows: URGO_ROWS, cohorts: [cohort({ status: 'thin', nAccounts: null, nClients: null, median: null, spread: null, nFlat: null })] }) });
    expect(thin.rows[0]).toMatchObject({ comparedCount: 0, differsCount: 0, status: 'not_comparable', statusWords: 'desk not comparable yet' });
    expect(thin.rows[0].deskWords).toBe('Desk not comparable yet.');
    expect(thin.rows[0].instances.every((i) => i.differs === false)).toBe(true);
    const absent = roll({ live: live({ rows: URGO_ROWS, cohorts: [] }) });
    expect(absent.rows[0]).toMatchObject({ status: 'not_comparable', statusWords: 'desk not comparable yet' });
  });

  it('a restarted or unmeasured instance is never compared, so a row of them is not comparable', () => {
    const view = roll({ live: live({ rows: [row({ restartedAt: '2026-10-08T13:40:00.000Z' }), row({ accountName: 'ACC 02', realizedPnl: null })], cohorts: [cohort()] }) });
    expect(view.rows[0]).toMatchObject({ count: 2, comparedCount: 0, status: 'not_comparable' });
    expect(view.rows[0].instances.map((i) => i.status).sort()).toEqual(['restarted', 'unmeasured']);
  });
});

describe('the sort: differing first, then by count, then by name, never by value', () => {
  it('puts the algorithm with a differing instance first although it has fewer accounts', () => {
    const view = roll({
      live: live({
        rows: [
          ...URGO_ROWS,
          // Two OGX accounts, one of them far from the desk.
          row({ algorithm: 'OGX_PF', strategyId: '7', accountName: 'ACC 01', realizedPnl: -1200, unrealizedPnl: 0 }),
          row({ algorithm: 'OGX_PF', strategyId: '8', accountName: 'ACC 02', clientId: 'c-maple', realizedPnl: -500, unrealizedPnl: 0 }),
          // One ALPHA account, in line.
          row({ algorithm: 'ALPHA', strategyId: '9', accountName: 'ACC 01', realizedPnl: 5, unrealizedPnl: 0 }),
        ],
        cohorts: [
          cohort(),
          cohort({ algorithm: 'OGX_PF', median: -500, spread: 100 }),
          cohort({ algorithm: 'ALPHA', median: 0, spread: 20 }),
        ],
      }),
    });
    expect(view.rows.map((r) => `${r.algorithm} ${r.count} ${r.status}`)).toEqual([
      'OGX_PF 2 differs',
      'URGO 3 in_line',
      'ALPHA 1 in_line',
    ]);
  });

  it('breaks a tie on count by name, whatever the money says', () => {
    const view = roll({
      live: live({
        rows: [
          row({ algorithm: 'ZETA', strategyId: '1', realizedPnl: 900, unrealizedPnl: 0 }),
          row({ algorithm: 'ALPHA', strategyId: '2', realizedPnl: -900, unrealizedPnl: 0 }),
          row({ algorithm: 'MID', strategyId: '3', realizedPnl: 0, unrealizedPnl: 0 }),
        ],
        cohorts: [],
      }),
    });
    expect(view.rows.map((r) => r.algorithm)).toEqual(['ALPHA', 'MID', 'ZETA']);
  });
});

describe('the instances, one by one', () => {
  it('names the client by uuid or by id, the account, the connection from the tracker, and the three figures', () => {
    const urgo = roll().rows.find((r) => r.algorithm === 'URGO');
    // The comparison's order: compared rows by distance in the spread, then by client and account.
    expect(urgo.instances.map((i) => `${i.clientName} / ${i.accountName}`)).toEqual([
      'Northwind / ACC 01', 'Maple Ridge / ACC 03', 'Maple Ridge / ACC 02',
    ]);
    expect(urgo.instances[0]).toMatchObject({
      clientId: UUID, clientName: 'Northwind', accountName: 'ACC 01',
      connectionName: 'Bluesky', connectionWord: 'Bluesky', hasConnection: true,
      realized: -300, unrealized: -10, value: -310, status: 'compared', differs: false,
    });
    expect(urgo.instances[2]).toMatchObject({ clientName: 'Maple Ridge', connectionName: 'Live', realized: -300, unrealized: 0, value: -300 });
  });

  it('finds the connection by the client\'s uuid first and by its id second, and says when there is none', () => {
    // ACC 04's sample carries an empty connection name; ACC 03 has no sample at all.
    const bullet = roll().rows.find((r) => r.algorithm === 'BulletBot');
    const byName = Object.fromEntries(bullet.instances.map((i) => [i.accountName, i]));
    expect(byName['ACC 04']).toMatchObject({ connectionName: null, connectionWord: NO_CONNECTION_WORD, hasConnection: false });
    expect(byName['ACC 03']).toMatchObject({ connectionName: null, connectionWord: NO_CONNECTION_WORD, hasConnection: false });
    // A tracker keyed by the legacy id still resolves for a client that has a uuid.
    const keyedById = {
      ...TRACKER,
      samplesByClientId: new Map([[CLIENTS[0].id, [{ accountName: 'ACC 01', connectionName: 'Rithmic' }]]]),
    };
    const view = roll({ tracker: keyedById });
    expect(view.rows.find((r) => r.algorithm === 'URGO').instances[0].connectionName).toBe('Rithmic');
    // And no tracker at all is the ordinary "no connection name".
    expect(roll({ tracker: null }).rows[0].instances.every((i) => i.connectionWord === NO_CONNECTION_WORD)).toBe(true);
  });

  it('carries the position and the trades when the reading has them, in short words', () => {
    const bullet = roll().rows.find((r) => r.algorithm === 'BulletBot');
    const first = bullet.instances.find((i) => i.accountName === 'ACC 01');
    expect(first.position).toEqual({ direction: 'long', quantity: 2, trades: 3, words: 'long 2', tradesWords: '3 trades this run' });
    expect(first.positionWords).toBe('long 2');
    expect(first.tradesWords).toBe('3 trades this run');
    const short = bullet.instances.find((i) => i.accountName === 'ACC 03');
    expect(short.positionWords).toBe('short 1');
    expect(short.tradesWords).toBe('1 trade this run');
  });

  it('prints nothing for a position that was not read: null stays null, never flat', () => {
    const urgo = roll().rows.find((r) => r.algorithm === 'URGO');
    for (const instance of urgo.instances) {
      expect(instance.position).toEqual({ direction: null, quantity: null, trades: null, words: null, tradesWords: null });
      expect(instance.positionWords).toBeNull();
      expect(instance.tradesWords).toBeNull();
    }
    expect(urgo.positions).toEqual({ long: 0, short: 0, flat: 0, known: 0 });
  });

  it('counts the directions over the instances for the row', () => {
    const bulletRow = roll().rows.find((r) => r.algorithm === 'BulletBot');
    expect(bulletRow.positions).toEqual({ long: 3, short: 1, flat: 0, known: 4 });
    const flat = roll({ live: live({ rows: [bullet({ marketPosition: 'flat', positionQuantity: 0, tradesThisRun: 0 })], cohorts: [COHORTS[1]] }) });
    expect(flat.rows[0].positions).toEqual({ long: 0, short: 0, flat: 1, known: 1 });
    expect(flat.rows[0].instances[0].positionWords).toBe('flat');
  });
});

describe('the line for the chat', () => {
  it('reads exactly as Pedro wrote it, for an algorithm in line and for one with a position and a differing instance', () => {
    const rows = roll().rows;
    expect(rows.find((r) => r.algorithm === 'URGO').chatLine).toBe('URGO: 3 accounts, -310 to -295, in line with the desk.');
    expect(rows.find((r) => r.algorithm === 'BulletBot').chatLine).toBe('BulletBot: 4 accounts, long on 3, short on 1, -140 to +60, 1 differs from the desk.');
  });

  it('never names a client', () => {
    for (const row of roll().rows) {
      expect(row.chatLine).not.toContain('Northwind');
      expect(row.chatLine).not.toContain('Maple Ridge');
      expect(row.chatLine).not.toContain(UUID);
    }
  });

  it('says desk not comparable yet, one account in the singular, flat on N, and not measured', () => {
    const thin = roll({ live: live({ rows: [row()], cohorts: [] }) });
    expect(thin.rows[0].chatLine).toBe('URGO: 1 account, -310, desk not comparable yet.');
    const flat = roll({ live: live({ rows: [bullet({ marketPosition: 'flat', positionQuantity: 0, tradesThisRun: 0, realizedPnl: -20, unrealizedPnl: 0 }), bullet({ accountName: 'ACC 02', strategyId: '2', marketPosition: 'long', positionQuantity: 1, realizedPnl: 30, unrealizedPnl: 0 })], cohorts: [COHORTS[1]] }) });
    expect(flat.rows[0].chatLine).toBe('BulletBot: 2 accounts, long on 1, flat on 1, -20 to +30, in line with the desk.');
    const none = roll({ live: live({ rows: [row({ realizedPnl: null })], cohorts: [cohort()] }) });
    expect(none.rows[0].chatLine).toBe('URGO: 1 account, not measured, desk not comparable yet.');
  });

  it('names the root only when the algorithm runs on more than one root', () => {
    const view = roll({
      live: live({
        rows: [row(), row({ accountName: 'ACC 02', strategyId: '2', instrument: 'NQ 12-26', instrumentRoot: 'NQ' })],
        cohorts: [cohort(), cohort({ instrumentRoot: 'NQ' })],
      }),
    });
    expect(view.rows.map((r) => r.chatName).sort()).toEqual(['URGO MNQ', 'URGO NQ']);
    expect(view.rows.find((r) => r.instrumentRoot === 'NQ').chatLine).toBe('URGO NQ: 1 account, -310, in line with the desk.');
  });

  it('is the same text rollCallChatLine builds from the row, so the button and the row cannot drift', () => {
    for (const row of roll().rows) expect(rollCallChatLine(row)).toBe(row.chatLine);
  });

  it('has no verdict word and no dash used as punctuation, in any sentence it produces', () => {
    const views = [
      roll(),
      roll({ live: live({ rows: [row()], cohorts: [] }) }),
      roll({ live: live({ rows: [row({ realizedPnl: null }), row({ accountName: 'R', restartedAt: '2026-10-08T13:40:00.000Z' })], cohorts: [cohort()] }) }),
    ];
    for (const view of views) {
      const text = view.rows.flatMap((r) => [r.heading, r.countWords, r.rangeWords, r.deskWords, r.statusWords, r.chatLine,
        ...r.instances.flatMap((i) => [i.connectionWord, i.positionWords, i.tradesWords])]).filter(Boolean).join(' ');
      expect(text).not.toMatch(/\s[-–—]\s|[–—]/);
      for (const word of ['wrong', 'worse', 'underperform', 'outlier', 'below', 'bad ']) {
        expect(text.toLowerCase(), word).not.toContain(word);
      }
    }
  });
});

describe('the states before ready', () => {
  it('carries the comparison state and no rows when there is nothing to roll call', () => {
    expect(roll({ live: null })).toMatchObject({ state: 'unread', rows: [] });
    expect(roll({ live: { available: false, reason: 'not_configured' } })).toMatchObject({ state: 'not_configured', rows: [] });
    expect(roll({ live: live({ available: false }) })).toMatchObject({ state: 'not_deployed', rows: [] });
    expect(roll({ live: live({ rows: [], desk: { cycleStart: null } }) })).toMatchObject({ state: 'no_readings', rows: [] });
    expect(roll({ live: live({ desk: { cycleStart: null } }) })).toMatchObject({ state: 'no_complete_cycle', rows: [] });
    expect(roll({ live: live({ desk: { filling: true } }) })).toMatchObject({ state: 'cycle_filling', rows: [], cycleStart: CYCLE });
    // Ready with nothing of mine in the cycle is ready with no rows, and says so by its state.
    const empty = roll({ live: live({ rows: [] }) });
    expect(empty).toMatchObject({ state: 'ready', rows: [] });
  });

  it('hands the cycle age and the settings through, for the stale note', () => {
    const view = roll();
    expect(view.cycleAgeSeconds).toBe(180);
    expect(view.settings.cycleSeconds).toBe(600);
  });
});
