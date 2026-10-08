import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_LIVE_SAMPLE_HISTORY_COLUMNS,
  TRACKER_CLOSE_READING_COLUMNS,
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

  it('scopes to the book and to runs still alive since the instant, in run order, bounded', async () => {
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
    expect(client.asked.order.account_live_sample_history).toEqual([{ column: 'first_sampled_at', ascending: true }]);
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
});
