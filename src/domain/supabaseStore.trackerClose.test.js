import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* THE WRITE PATH OF "ADD FLAG", driven against a stand-in for the client module
 * the way paymentStatusWrite.test.js does, because insertSupabaseOperationalFlag
 * takes no client of its own. `configured` stays false for every other test in
 * this file: the loaders below inject their own client, and the first insert
 * test expects no database at all. The stand-in answers the uuid lookups with
 * fixed uuids and records every insert, so the row can be read back. */
const db = vi.hoisted(() => {
  const state = {
    configured: false,
    clientUuid: '7a1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d',
    importUuid: 'b2c3d4e5-f601-4234-a567-89abcdef0123',
    generatedId: 'c3d4e5f6-0718-4293-b4a5-6789abcdef01',
    tradingAccount: null,
    calls: [],
    inserts: [],
  };
  function answer(call) {
    switch (call.table) {
      case 'clients': return { data: { id: state.clientUuid }, error: null };
      case 'daily_imports': return { data: { id: state.importUuid }, error: null };
      case 'trading_accounts': return { data: state.tradingAccount, error: null };
      case 'operational_flags': return {
        data: {
          ...call.inserted,
          id: call.inserted?.id || state.generatedId,
          trading_accounts: state.tradingAccount ? { account_name: state.tradingAccount.account_name } : null,
        },
        error: null,
      };
      default: return { data: null, error: { message: `unexpected table ${call.table}` } };
    }
  }
  state.supabase = {
    from(table) {
      const call = { table, filters: [], select: null, inserted: null };
      state.calls.push(call);
      const chain = {
        select(columns) { call.select = columns; return chain; },
        eq(column, value) { call.filters.push({ op: 'eq', column, value }); return chain; },
        ilike(column, value) { call.filters.push({ op: 'ilike', column, value }); return chain; },
        insert(row) { call.inserted = row; state.inserts.push({ table, row }); return chain; },
        maybeSingle() { return Promise.resolve(answer(call)); },
        single() { return Promise.resolve(answer(call)); },
      };
      return chain;
    },
  };
  return state;
});

vi.mock('../lib/supabaseClient', () => ({
  get isSupabaseConfigured() { return db.configured; },
  get supabase() { return db.configured ? db.supabase : null; },
}));

import {
  ACCOUNT_LIVE_SAMPLE_HISTORY_COLUMNS,
  TRACKER_CLOSE_READING_COLUMNS,
  insertSupabaseOperationalFlag,
  isMissingTrackerCloseReadings,
  loadSupabaseAccountLiveSampleHistory,
  loadSupabaseTrackerCloseReadings,
  mapTrackerCloseReading,
  mapTrackerCloseSettings,
} from './supabaseStore';

/* A fake PostgREST client that answers each read the way the real database
 * would in a given state, and records what was asked. Every builder method
 * returns the chain and the chain is thenable, so the loaders can order, filter
 * and limit in any sequence. */
function fakeClient({ settings, readings, history } = {}) {
  const asked = { from: [], filters: {}, order: {}, limit: {}, select: {} };
  const answers = {
    account_tracker_settings: settings ?? {
      data: [{
        stale_sample_seconds: 1500, pre_close_grace_seconds: 120, close_match_tolerance_dollars: '5.00',
        close_match_tolerance_ratio: '0.0200', max_strategies_per_account: 50, history_retention_days: 5,
      }],
      error: null,
    },
    tracker_close_readings: readings ?? { data: [], error: null },
    account_live_sample_history: history ?? { data: [], error: null },
  };
  return {
    asked,
    from(table) {
      asked.from.push(table);
      asked.filters[table] = asked.filters[table] || [];
      asked.order[table] = asked.order[table] || [];
      const chain = {
        select(columns) { asked.select[table] = columns; return chain; },
        in(column, values) { asked.filters[table].push({ op: 'in', column, values }); return chain; },
        eq(column, value) { asked.filters[table].push({ op: 'eq', column, value }); return chain; },
        gte(column, value) { asked.filters[table].push({ op: 'gte', column, value }); return chain; },
        order(column, options) { asked.order[table].push({ column, ...options }); return chain; },
        limit(n) { asked.limit[table] = n; return chain; },
        then(resolve, reject) { return Promise.resolve(answers[table]).then(resolve, reject); },
      };
      return chain;
    },
  };
}

const MISSING = [
  { code: 'PGRST205', message: "Could not find the table 'public.tracker_close_readings' in the schema cache" },
  { code: '42P01', message: 'relation "public.account_live_sample_history" does not exist' },
  // The code alone decides: a 42P01 whose message names none of our tables.
  { code: '42P01', message: 'relation "public.a_view_over_them" does not exist' },
  { code: '42703', message: 'column account_tracker_settings.pre_close_grace_seconds does not exist' },
  // Postgres's own wording when the reference is unqualified names no table.
  { code: '42703', message: 'column "pre_close_grace_seconds" does not exist' },
  { code: 'PGRST204', message: "Could not find the 'pre_close_grace_seconds' column of 'account_tracker_settings' in the schema cache" },
  // The code alone decides here too: a PGRST205 with no message at all.
  { code: 'PGRST205', message: '' },
];

const ROW = {
  id: 7,
  daily_import_id: 'imp-1',
  client_id: 'c1',
  device_id: 'dev-1',
  trading_date: '2026-10-07',
  account_name: 'ACC 01',
  source: 'crm_history',
  connection_name: 'Northwind',
  connected: true,
  status: 'Connected',
  realized_pnl: '120.5',
  unrealized_pnl: '0',
  total_pnl: '120.5',
  strategy_count: 2,
  enabled_strategy_count: 2,
  run_state: 'running',
  sampled_at: '2026-10-07T20:30:00+00:00',
  reading_since: '2026-10-07T20:20:00+00:00',
  reset_seen: false,
  next_sampled_at: '2026-10-07T20:40:00+00:00',
  strategies: [{ strategyId: '100', strategyName: '0 - OGX-PF-2.4', instrument: 'MNQ 12-26', realizedPnl: 120.5 }],
  close_batch_id: 'batch-1',
  close_captured_at: '2026-10-07T20:31:00+00:00',
  close_time_basis: 'captured',
  grace_seconds: 120,
  stale_seconds: 1500,
  compared_at: '2026-10-07T20:31:05+00:00',
};

describe('isMissingTrackerCloseReadings', () => {
  it('recognises every way step 66 can be missing, and nothing else', () => {
    for (const error of MISSING) expect(isMissingTrackerCloseReadings(error), error.code).toBe(true);
    expect(isMissingTrackerCloseReadings({ code: '57014', message: 'canceling statement due to statement timeout' })).toBe(false);
    expect(isMissingTrackerCloseReadings({ code: '500', message: 'relation tracker_close_readings is locked' })).toBe(false);
    expect(isMissingTrackerCloseReadings({ message: 'relation "tracker_close_readings" does not exist' })).toBe(true);
    expect(isMissingTrackerCloseReadings(null)).toBe(false);
  });
});

describe('loadSupabaseTrackerCloseReadings', () => {
  it('answers available:false for every way step 66 can be missing, on either read', async () => {
    for (const error of MISSING) {
      for (const where of ['settings', 'readings']) {
        const client = fakeClient({ [where]: { data: null, error } });
        const result = await loadSupabaseTrackerCloseReadings({ clientIds: ['c1'], client });
        expect(result, `${error.code} on ${where}`).toEqual({ available: false, reason: 'not_deployed' });
      }
    }
  });

  it('answers available:false when there is no database at all', async () => {
    expect(await loadSupabaseTrackerCloseReadings({ client: null })).toEqual({ available: false, reason: 'not_configured' });
  });

  it('THROWS on any other failure of the readings, so the panel never shows zeros for a read that failed', async () => {
    const error = { code: '57014', message: 'canceling statement due to statement timeout' };
    await expect(loadSupabaseTrackerCloseReadings({ clientIds: ['c1'], client: fakeClient({ readings: { data: null, error } }) }))
      .rejects.toThrow(/statement timeout/);
  });

  it('a failed settings read alone leaves settings null and the readings intact', async () => {
    const client = fakeClient({ settings: { data: null, error: { code: '500', message: 'boom' } }, readings: { data: [ROW], error: null } });
    const result = await loadSupabaseTrackerCloseReadings({ clientIds: ['c1'], client });
    expect(result.available).toBe(true);
    expect(result.settings).toBeNull();
    expect(result.readings).toHaveLength(1);
  });

  it('scopes to the book and to the named closes, newest day first, bounded', async () => {
    const client = fakeClient();
    await loadSupabaseTrackerCloseReadings({ clientIds: ['c2', 'c1', 'c1'], importIds: ['i1', 'i1', 'i2'], client });
    expect(client.asked.select.tracker_close_readings).toBe(TRACKER_CLOSE_READING_COLUMNS);
    expect(client.asked.filters.tracker_close_readings).toEqual([
      { op: 'in', column: 'client_id', values: ['c2', 'c1'] },
      { op: 'in', column: 'daily_import_id', values: ['i1', 'i2'] },
    ]);
    expect(client.asked.order.tracker_close_readings).toEqual([
      { column: 'trading_date', ascending: false },
      { column: 'account_name', ascending: true },
    ]);
    expect(client.asked.limit.tracker_close_readings).toBe(5000);
    expect(client.asked.limit.account_tracker_settings).toBe(1);
  });

  it('narrows to one trading day for the overview, and only when asked', async () => {
    const client = fakeClient();
    await loadSupabaseTrackerCloseReadings({ clientIds: ['c1'], tradingDate: '2026-10-08', client });
    expect(client.asked.filters.tracker_close_readings).toEqual([
      { op: 'in', column: 'client_id', values: ['c1'] },
      { op: 'eq', column: 'trading_date', value: '2026-10-08' },
    ]);
    const blank = fakeClient();
    await loadSupabaseTrackerCloseReadings({ clientIds: ['c1'], tradingDate: '  ', client: blank });
    expect(blank.asked.filters.tracker_close_readings).toEqual([{ op: 'in', column: 'client_id', values: ['c1'] }]);
  });

  it('a Manager (no clientIds) reads the whole desk with no client filter', async () => {
    const client = fakeClient();
    await loadSupabaseTrackerCloseReadings({ client });
    expect(client.asked.filters.tracker_close_readings).toEqual([]);
  });

  it('an empty scope asks for no rows and is still available', async () => {
    const client = fakeClient();
    const result = await loadSupabaseTrackerCloseReadings({ clientIds: [], client });
    expect(result).toMatchObject({ available: true, readings: [] });
    expect(client.asked.from).not.toContain('tracker_close_readings');
  });

  it('maps a row to camelCase with numerics as numbers and null kept null', async () => {
    const none = {
      ...ROW, id: 8, account_name: 'ACC 02', source: 'none', connection_name: null, connected: null, status: null,
      realized_pnl: null, unrealized_pnl: '', total_pnl: null, strategy_count: null, enabled_strategy_count: null,
      run_state: null, sampled_at: null, reading_since: null, next_sampled_at: null, strategies: [],
    };
    const client = fakeClient({ readings: { data: [ROW, none, { client_id: null, account_name: 'ghost' }], error: null } });
    const result = await loadSupabaseTrackerCloseReadings({ clientIds: ['c1'], client });
    expect(result.readings).toHaveLength(2);
    expect(result.readings[0]).toEqual({
      id: 7,
      dailyImportId: 'imp-1',
      clientId: 'c1',
      deviceId: 'dev-1',
      tradingDate: '2026-10-07',
      accountName: 'ACC 01',
      source: 'crm_history',
      connectionName: 'Northwind',
      connected: true,
      status: 'Connected',
      realizedPnl: 120.5,
      unrealizedPnl: 0,
      totalPnl: 120.5,
      strategyCount: 2,
      enabledStrategyCount: 2,
      runState: 'running',
      sampledAt: '2026-10-07T20:30:00+00:00',
      readingSince: '2026-10-07T20:20:00+00:00',
      resetSeen: false,
      nextSampledAt: '2026-10-07T20:40:00+00:00',
      strategies: ROW.strategies,
      closeBatchId: 'batch-1',
      closeCapturedAt: '2026-10-07T20:31:00+00:00',
      closeTimeBasis: 'captured',
      graceSeconds: 120,
      staleSeconds: 1500,
      comparedAt: '2026-10-07T20:31:05+00:00',
    });
    expect(result.readings[1]).toMatchObject({
      source: 'none', connected: null, realizedPnl: null, unrealizedPnl: null, totalPnl: null,
      strategyCount: null, runState: null, sampledAt: null, nextSampledAt: null, strategies: [],
    });
    expect(result.settings).toEqual({
      toleranceDollars: 5, toleranceRatio: 0.02, staleSeconds: 1500, graceSeconds: 120,
      maxStrategiesPerAccount: 50, historyRetentionDays: 5, fallback: false,
    });
  });

  it('the mappers stand on their own: a scheduled basis, a bad numeric, a missing settings row', () => {
    expect(mapTrackerCloseReading({ ...ROW, close_time_basis: 'scheduled', realized_pnl: 'NaN' }))
      .toMatchObject({ closeTimeBasis: 'scheduled', realizedPnl: null });
    expect(mapTrackerCloseReading({ ...ROW, close_time_basis: 'elsewhere', strategies: 'not a list' }))
      .toMatchObject({ closeTimeBasis: 'captured', strategies: [] });
    expect(mapTrackerCloseSettings(null)).toBeNull();
    expect(mapTrackerCloseSettings({ stale_sample_seconds: 0, close_match_tolerance_dollars: '-1', pre_close_grace_seconds: 0 }))
      .toMatchObject({ staleSeconds: 1500, toleranceDollars: 5, graceSeconds: 0, toleranceRatio: 0.02 });
  });
});

describe('loadSupabaseAccountLiveSampleHistory', () => {
  it('answers available:false when the table is missing, and not_configured without a database', async () => {
    const client = fakeClient({ history: { data: null, error: MISSING[1] } });
    expect(await loadSupabaseAccountLiveSampleHistory({ clientIds: ['c1'], client })).toEqual({ available: false, reason: 'not_deployed' });
    expect(await loadSupabaseAccountLiveSampleHistory({ client: null })).toEqual({ available: false, reason: 'not_configured' });
  });

  it('THROWS on any other failure', async () => {
    const client = fakeClient({ history: { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } } });
    await expect(loadSupabaseAccountLiveSampleHistory({ clientIds: ['c1'], client })).rejects.toThrow(/statement timeout/);
  });

  it('scopes to the book and to runs still alive since the instant, newest first at the database, bounded', async () => {
    const client = fakeClient({
      history: {
        data: [{
          id: 1, client_id: 'c1', device_id: 'dev-1', account_name: 'ACC 01', connection_name: 'Northwind', connected: true,
          status: 'Connected', realized_pnl: '100', unrealized_pnl: '0', total_pnl: '100', strategy_count: 2,
          enabled_strategy_count: 2, run_state: 'running', first_sampled_at: '2026-10-07T20:10:00+00:00',
          last_sampled_at: '2026-10-07T20:10:00+00:00', samples: 1,
        }, { client_id: null }],
        error: null,
      },
    });
    const result = await loadSupabaseAccountLiveSampleHistory({ clientIds: ['c1'], since: new Date('2026-10-07T04:00:00Z'), client });
    expect(client.asked.select.account_live_sample_history).toBe(ACCOUNT_LIVE_SAMPLE_HISTORY_COLUMNS);
    expect(client.asked.filters.account_live_sample_history).toEqual([
      { op: 'in', column: 'client_id', values: ['c1'] },
      { op: 'gte', column: 'last_sampled_at', value: '2026-10-07T04:00:00.000Z' },
    ]);
    // Newest first, so a day past the bound loses its OLDEST runs, never its newest.
    expect(client.asked.order.account_live_sample_history).toEqual([{ column: 'first_sampled_at', ascending: false }]);
    expect(client.asked.limit.account_live_sample_history).toBe(5000);
    expect(result.rows).toEqual([{
      id: 1, clientId: 'c1', deviceId: 'dev-1', accountName: 'ACC 01', connectionName: 'Northwind', connected: true,
      status: 'Connected', realizedPnl: 100, unrealizedPnl: 0, totalPnl: 100, strategyCount: 2, enabledStrategyCount: 2,
      runState: 'running', firstSampledAt: '2026-10-07T20:10:00+00:00', lastSampledAt: '2026-10-07T20:10:00+00:00', samples: 1,
    }]);
  });

  it('an empty scope asks for nothing', async () => {
    const client = fakeClient();
    expect(await loadSupabaseAccountLiveSampleHistory({ clientIds: [], client })).toEqual({ available: true, rows: [] });
    expect(client.asked.from).toEqual([]);
  });

  /* A database that does what it is asked: orders and bounds the table the
   * way PostgREST would. 5,003 runs today, over the 5,000 bound. Ascending at
   * the database, the bound cut the three NEWEST runs, which are the ones
   * "Disconnected since" and the day's trail read first. Newest first, the cut
   * falls on the three oldest, and the rows still come back oldest first, the
   * order every caller walks them in. */
  it('past the bound keeps the newest runs and still hands them back oldest first', async () => {
    const base = Date.parse('2026-10-07T04:00:00Z');
    const table = Array.from({ length: 5003 }, (_, index) => ({
      id: index + 1, client_id: 'c1', device_id: 'dev-1', account_name: `ACC ${String(index % 40).padStart(2, '0')}`,
      connected: index % 2 === 0, run_state: 'running',
      first_sampled_at: new Date(base + index * 5_000).toISOString(), last_sampled_at: new Date(base + index * 5_000 + 4_000).toISOString(), samples: 1,
    }));
    const shuffled = [...table].reverse();
    const asked = [];
    const client = {
      from() {
        let rows = shuffled;
        const chain = {
          select() { return chain; },
          in() { return chain; },
          gte() { return chain; },
          order(column, { ascending = true } = {}) {
            asked.push({ column, ascending });
            rows = [...rows].sort((left, right) => (ascending ? 1 : -1) * left[column].localeCompare(right[column]));
            return chain;
          },
          limit(n) { rows = rows.slice(0, n); return chain; },
          then(resolve, reject) { return Promise.resolve({ data: rows, error: null }).then(resolve, reject); },
        };
        return chain;
      },
    };
    const result = await loadSupabaseAccountLiveSampleHistory({ clientIds: ['c1'], since: new Date(base), client });
    expect(asked).toEqual([{ column: 'first_sampled_at', ascending: false }]);
    expect(result.rows).toHaveLength(5000);
    // The newest run is in; the three oldest are the ones left out.
    expect(result.rows.at(-1).id).toBe(5003);
    expect(result.rows[0].id).toBe(4);
    // Oldest first, as the callers walk them.
    const starts = result.rows.map((row) => Date.parse(row.firstSampledAt));
    expect(starts.every((value, index) => index === 0 || starts[index - 1] <= value)).toBe(true);
  });
});

describe('insertSupabaseOperationalFlag', () => {
  it('writes nothing without a database, and refuses a flag with no message before any request', async () => {
    expect(await insertSupabaseOperationalFlag('c1', 'imp-1', { id: 'f', message: 'x' })).toBeNull();
    expect(await insertSupabaseOperationalFlag('c1', 'imp-1', { id: 'f', message: '' })).toBeNull();
  });
});

describe('insertSupabaseOperationalFlag, against a database', () => {
  /* The row the panel's "Add flag" hands PostgREST. The id is the browser's
   * uuid when it has one, so the optimistic row and the stored row are the same
   * flag; the client and the close are resolved to their uuids through the
   * lookups, never pasted; the type, severity and status are the queue's. */
  const FLAG_ID = '0f3b6c2e-5d1a-4e7b-9c3d-2a1b4c5d6e7f';
  const ACCOUNT_ID = 'd4e5f6a7-1829-4ab3-9c5d-7e8f9a0b1c2d';
  const MESSAGE = 'Tracker and close differ on ACC 01 by $140';
  const flagOf = (over = {}) => ({
    id: FLAG_ID, type: 'Tracker differs from the close', severity: 'Warning', status: 'Open', accountName: 'ACC 01', message: MESSAGE, ...over,
  });
  const lookups = () => db.calls
    .filter((call) => call.table === 'clients' || call.table === 'daily_imports')
    .map((call) => [call.table, call.filters[0].column, call.filters[0].value]);

  beforeEach(() => {
    db.configured = true;
    db.tradingAccount = null;
    db.calls = [];
    db.inserts = [];
  });
  afterEach(() => { db.configured = false; });

  it('inserts one row with the browser uuid as its id, the client and the close resolved to their uuids, and hands back the flag with its account name', async () => {
    db.tradingAccount = { id: ACCOUNT_ID, account_name: 'ACC 01' };
    const stored = await insertSupabaseOperationalFlag('c1', 'imp-1', flagOf());
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0].table).toBe('operational_flags');
    expect(db.inserts[0].row).toEqual({
      id: FLAG_ID,
      daily_import_id: db.importUuid,
      client_id: db.clientUuid,
      trading_account_id: ACCOUNT_ID,
      type: 'Tracker differs from the close',
      severity: 'Warning',
      message: MESSAGE,
      status: 'Open',
      resolved_at: null,
    });
    // The legacy keys were asked for and the uuids came back: the row carries what the lookups answered.
    expect(lookups()).toEqual(expect.arrayContaining([['clients', 'legacy_key', 'c1'], ['daily_imports', 'legacy_key', 'imp-1']]));
    const account = db.calls.find((call) => call.table === 'trading_accounts');
    expect(account.filters).toEqual([{ op: 'eq', column: 'client_id', value: db.clientUuid }, { op: 'ilike', column: 'account_name', value: 'ACC 01' }]);
    expect(db.calls.find((call) => call.table === 'operational_flags').select).toBe('*, trading_accounts(account_name)');
    expect(stored).toEqual({
      id: FLAG_ID, type: 'Tracker differs from the close', severity: 'Warning', accountName: 'ACC 01', message: MESSAGE, status: 'Open', resolvedAt: '',
    });
  });

  it('leaves the id to the database when the flag id is not a uuid, defaults the severity and the status, and keeps the account name from the flag', async () => {
    const stored = await insertSupabaseOperationalFlag(db.clientUuid, 'imp-1', flagOf({ id: 'flag-local-7', severity: undefined, status: undefined }));
    expect(db.inserts).toHaveLength(1);
    const { row } = db.inserts[0];
    expect('id' in row).toBe(false);
    expect(row).toEqual({
      daily_import_id: db.importUuid,
      client_id: db.clientUuid,
      trading_account_id: null,
      type: 'Tracker differs from the close',
      severity: 'Warning',
      message: MESSAGE,
      status: 'Open',
      resolved_at: null,
    });
    // A client already named by uuid is looked up by id, the close still by its legacy key.
    expect(lookups()).toEqual(expect.arrayContaining([['clients', 'id', db.clientUuid], ['daily_imports', 'legacy_key', 'imp-1']]));
    expect(stored.id).toBe(db.generatedId);
    expect(stored.accountName).toBe('ACC 01');
    expect(stored).toMatchObject({ type: 'Tracker differs from the close', severity: 'Warning', status: 'Open', message: MESSAGE, resolvedAt: '' });
  });
});
