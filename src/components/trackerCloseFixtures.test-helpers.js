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

/* THE NINE VERDICTS ON ONE CLOSE, for the chip tone and the verdict order. The
 * four accounts above plus five more, each reaching one verdict by the rule
 * that decides it (capture 20:31 UTC, tolerance the larger of $5 and 2%,
 * staleness horizon 25 minutes):
 *   ACC 05 tracker reset: realized fell to zero and the reset was seen, close $300.
 *   ACC 06 stale reading: last sampled 91 minutes before the capture.
 *   ACC 07 after the close: the first reading came 14 minutes after the capture.
 *   ACC 08 no tracker figure: a reading with no realized figure.
 *   ACC 09 settled at the close: realized $100 plus open $50 meets the close $150. */
export function allVerdictsClose() {
  const readings = [
    ...READINGS,
    reading({ id: 5, accountName: 'ACC 05', realizedPnl: 0, unrealizedPnl: 0, totalPnl: 0, resetSeen: true }),
    reading({ id: 6, accountName: 'ACC 06', realizedPnl: 80, unrealizedPnl: 0, totalPnl: 80, sampledAt: '2026-10-07T19:00:00.000Z', readingSince: '2026-10-07T18:50:00.000Z' }),
    reading({ id: 7, accountName: 'ACC 07', source: 'none', connectionName: null, connected: null, realizedPnl: null, unrealizedPnl: null, totalPnl: null, strategyCount: null, enabledStrategyCount: null, runState: null, sampledAt: null, readingSince: null, nextSampledAt: '2026-10-07T20:45:00.000Z' }),
    reading({ id: 8, accountName: 'ACC 08', realizedPnl: null, unrealizedPnl: null, totalPnl: null }),
    reading({ id: 9, accountName: 'ACC 09', realizedPnl: 100, unrealizedPnl: 50, totalPnl: 150 }),
  ];
  const close = dailyImport({
    sourceSummary: { pnl_sources: { realized: 8 } },
    snapshots: [
      ...dailyImport().snapshots,
      snapshot('snap-5', 'ACC 05', 300),
      snapshot('snap-6', 'ACC 06', 80),
      snapshot('snap-7', 'ACC 07', 20),
      snapshot('snap-8', 'ACC 08', 15),
      snapshot('snap-9', 'ACC 09', 150),
    ],
  });
  return { readings, dailyImport: close, answer: { available: true, readings, settings: SETTINGS } };
}

/** Verdict to chip tone, the house rule: a question is amber, agreement green, nothing to compare muted. Never red. */
export const VERDICT_TONES = Object.freeze({
  differs: 'warning',
  tracker_reset: 'warning',
  tracker_only: 'warning',
  close_only: 'warning',
  stale_reading: 'warning',
  matches: 'success',
  settled_at_close: 'success',
  after_close: 'muted',
  tracker_no_figure: 'muted',
});

/* A CLIENT WHOSE VPS DOES NOT SAMPLE: today's close lists its accounts and
 * every row pinned for that close is source 'none' with no later reading, the
 * shape of a machine on an agent before 1.2.0. Fictional names. */
export function noTrackerClient({ id, uuid = null, name, accounts = ['NT 01', 'NT 02'] }) {
  const importUuid = `imp-${id}`;
  const client = {
    id,
    ...(uuid ? { uuid } : {}),
    name,
    dailyImports: [dailyImport({
      id: `di-${id}`,
      uuid: importUuid,
      clientId: id,
      sourceSummary: { pnl_sources: { realized: accounts.length } },
      snapshots: accounts.map((accountName, index) => snapshot(`snap-${id}-${index}`, accountName, 25 * (index + 1))),
    })],
  };
  const readings = accounts.map((accountName, index) => reading({
    id: `${id}-${index}`,
    clientId: uuid || id,
    dailyImportId: importUuid,
    accountName,
    source: 'none',
    connectionName: null,
    connected: null,
    realizedPnl: null,
    unrealizedPnl: null,
    totalPnl: null,
    strategyCount: null,
    enabledStrategyCount: null,
    runState: null,
    sampledAt: null,
    readingSince: null,
    nextSampledAt: null,
  }));
  return { client, readings };
}
