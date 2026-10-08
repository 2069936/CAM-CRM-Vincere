/* Fictional book for the tracker against the close tests: Northwind, four
 * accounts on the 2026-10-07 close. ACC 01 differs by $140 (and one algorithm
 * moved), ACC 02 matches inside the tolerance, ACC 03 was only in the tracker,
 * ACC 04 only in the close. No figure here is a real client's. */
export const UUID = '4b0e5c8f-8c3f-4b2a-9d2e-1b2c3d4e5f60';
export const CLIENT = { id: 'act-1700000000-northwind', uuid: UUID, name: 'Northwind' };
export const CAPTURED = '2026-10-07T20:31:00.000Z';
export const DATE = '2026-10-07';
export const SETTINGS = { toleranceDollars: 5, toleranceRatio: 0.02, staleSeconds: 1500, graceSeconds: 120, fallback: false };

export function reading(over = {}) {
  return {
    id: 1,
    dailyImportId: 'imp-1',
    clientId: UUID,
    tradingDate: DATE,
    accountName: 'ACC 01',
    source: 'crm_history',
    connectionName: 'Bluesky',
    connected: true,
    status: 'Connected',
    realizedPnl: 340,
    unrealizedPnl: 12.5,
    totalPnl: 352.5,
    strategyCount: 1,
    enabledStrategyCount: 1,
    runState: 'running',
    sampledAt: '2026-10-07T20:30:00.000Z',
    readingSince: '2026-10-07T20:20:00.000Z',
    resetSeen: false,
    nextSampledAt: null,
    strategies: [],
    closeBatchId: 'batch-1',
    closeCapturedAt: CAPTURED,
    closeTimeBasis: 'captured',
    graceSeconds: 120,
    staleSeconds: 1500,
    comparedAt: '2026-10-07T20:31:05.000Z',
    ...over,
  };
}

export const READINGS = [
  reading({
    strategies: [{ strategyId: '100', strategyName: 'OGX-PF-2.4', algorithm: 'OGX_PF', instrument: 'MNQ 12-26', realizedPnl: 340, unrealizedPnl: 12.5, restartedAt: null, sampledAt: '2026-10-07T20:30:02.000Z' }],
  }),
  reading({ id: 2, accountName: 'ACC 02', realizedPnl: 120.5, unrealizedPnl: -3, totalPnl: 117.5 }),
  reading({ id: 3, accountName: 'ACC 03', realizedPnl: -40, unrealizedPnl: -1, totalPnl: -41 }),
  reading({ id: 4, accountName: 'ACC 04', source: 'none', connectionName: null, connected: null, realizedPnl: null, unrealizedPnl: null, totalPnl: null, strategyCount: null, enabledStrategyCount: null, runState: null, sampledAt: null, readingSince: null }),
];

export function snapshot(id, accountName, realized, strategies = []) {
  return { id, accountName, connection: 'Bluesky', grossRealizedPnl: realized, unrealizedPnl: 0, strategies };
}

export function dailyImport(over = {}) {
  return {
    id: 'di-1',
    uuid: 'imp-1',
    clientId: CLIENT.id,
    date: DATE,
    status: 'Needs review',
    sourceSummary: { pnl_sources: { realized: 3, gross_fallback: 1 } },
    snapshots: [
      snapshot('snap-1', 'ACC 01', 200, [{ id: 'ss-1', strategyName: 'OGX-PF-2.4', instrument: 'MNQ 12-26', realized: 200, unrealized: 0, enabled: false, ran: true }]),
      snapshot('snap-2', 'ACC 02', 118),
      snapshot('snap-4', 'ACC 04', 55),
    ],
    strategies: [],
    simulation: {},
    flags: [],
    snapshotsLoaded: true,
    detailLoaded: true,
    ...over,
  };
}

export const ANSWER = { available: true, readings: READINGS, settings: SETTINGS };

export function history(extra = []) {
  const run = (accountName, realizedPnl, firstSampledAt, lastSampledAt) => ({
    clientId: UUID, accountName, realizedPnl, totalPnl: realizedPnl, firstSampledAt, lastSampledAt, samples: 3,
  });
  return {
    available: true,
    rows: [
      run('ACC 01', 100, '2026-10-07T14:00:00.000Z', '2026-10-07T18:00:00.000Z'),
      run('ACC 01', 340, '2026-10-07T18:10:00.000Z', '2026-10-07T20:30:00.000Z'),
      run('ACC 02', 120.5, '2026-10-07T14:00:00.000Z', '2026-10-07T20:30:00.000Z'),
      ...extra,
    ],
  };
}
