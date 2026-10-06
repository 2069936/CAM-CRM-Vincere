import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadSupabaseAlgorithmLive,
  resetAlgorithmLiveSettingsCache,
} from './supabaseStore';

/* A fake PostgREST client that answers each of the three reads the way the real
 * database would in a given state, and records what was asked. */
function fakeClient({ settings, desk, samples } = {}) {
  const asked = { from: [], rpc: [], inFilter: null, limit: null };
  const answer = (value, fallback) => Promise.resolve(value ?? fallback);
  return {
    asked,
    from(table) {
      asked.from.push(table);
      const source = { algorithm_live_settings: settings, algorithm_live_samples: samples }[table];
      const fallbackData = {
        algorithm_live_settings: { data: [{ min_cohort_accounts: 6, min_cohort_clients: 3, differs_at_spread: '3.0', min_spread_dollars: 50, cycle_tolerance_seconds: 90 }], error: null },
        account_tracker_settings: { data: [{ sample_interval_seconds: 900 }], error: null },
        algorithm_live_samples: { data: [], error: null },
      }[table];
      const chain = {
        select() { return chain; },
        in(column, values) { asked.inFilter = { column, values }; return chain; },
        limit(n) { if (table === 'algorithm_live_samples') asked.limit = n; return answer(source, fallbackData); },
      };
      return chain;
    },
    rpc(name, args) {
      asked.rpc.push({ name, args });
      return answer(desk, { data: [], error: null });
    },
  };
}

const MISSING = [
  { code: 'PGRST205', message: "Could not find the table 'public.algorithm_live_samples' in the schema cache" },
  { code: '42P01', message: 'relation "public.algorithm_live_samples" does not exist' },
  { code: 'PGRST202', message: 'Could not find the function public.algorithm_live_desk without parameters' },
  { code: '42883', message: 'function public.algorithm_live_desk() does not exist' },
];

describe('loadSupabaseAlgorithmLive', () => {
  beforeEach(() => resetAlgorithmLiveSettingsCache());

  it('answers available:false for every way step 57 can be missing', async () => {
    for (const error of MISSING) {
      for (const where of ['settings', 'desk', 'samples']) {
        resetAlgorithmLiveSettingsCache();
        const client = fakeClient({ [where]: { data: null, error } });
        const result = await loadSupabaseAlgorithmLive({ clientIds: ['c1'], client });
        expect(result, `${error.code} on ${where}`).toEqual({ available: false, reason: 'not_deployed' });
      }
    }
  });

  it('THROWS on any other failure, so the panel never shows zeros for a read that failed', async () => {
    const error = { code: '57014', message: 'canceling statement due to statement timeout' };
    await expect(loadSupabaseAlgorithmLive({ clientIds: ['c1'], client: fakeClient({ desk: { data: null, error } }) }))
      .rejects.toThrow(/statement timeout/);
    await expect(loadSupabaseAlgorithmLive({ clientIds: ['c1'], client: fakeClient({ samples: { data: null, error } }) }))
      .rejects.toThrow(/statement timeout/);
  });

  it('falls back on the settings, and says so, when only the settings read fails', async () => {
    const client = fakeClient({ settings: { data: null, error: { code: '500', message: 'boom' } } });
    const result = await loadSupabaseAlgorithmLive({ clientIds: ['c1'], client });
    expect(result.available).toBe(true);
    expect(result.settings).toBeNull();
  });

  it('asks the desk function with no arguments and scopes the rows to the book', async () => {
    const client = fakeClient();
    await loadSupabaseAlgorithmLive({ clientIds: ['c2', 'c1', 'c1'], client });
    expect(client.asked.rpc).toEqual([{ name: 'algorithm_live_desk', args: undefined }]);
    expect(client.asked.inFilter).toEqual({ column: 'client_id', values: ['c2', 'c1'] });
    expect(client.asked.limit).toBe(3000);
  });

  it('maps the desk rows, the marker row and the samples, with null kept null', async () => {
    const client = fakeClient({
      desk: {
        data: [
          { algorithm: 'OGX_PF', instrument_root: 'MNQ', cycle_start: '2026-10-06T14:10:00+00:00', scope: 'rest_of_desk', status: 'compared', n_accounts: 12, n_clients: 8, median: '-500', spread: '100', n_flat: 0 },
          { algorithm: 'ALPHA', instrument_root: 'NQ', cycle_start: '2026-10-06T14:10:00+00:00', scope: 'rest_of_desk', status: 'thin', n_accounts: null, n_clients: null, median: null, spread: null, n_flat: null },
        ],
        error: null,
      },
      samples: {
        data: [{ client_id: 'c1', account_name: 'A', strategy_id: '1', strategy_name: '0 - OGX-PF-2.4', algorithm: 'OGX_PF', instrument: 'MNQ 12-26', instrument_root: 'MNQ', realized_pnl: null, unrealized_pnl: '', restarted_at: null, sampled_at: '2026-10-06T14:10:02+00:00', cycle_start: null }],
        error: null,
      },
    });
    const result = await loadSupabaseAlgorithmLive({ clientIds: ['c1'], client });
    expect(result.desk).toMatchObject({ available: true, cycleStart: '2026-10-06T14:10:00+00:00', scope: 'rest_of_desk', filling: false });
    expect(result.desk.cohorts[0]).toMatchObject({ status: 'compared', median: -500, spread: 100, nAccounts: 12 });
    expect(result.desk.cohorts[1]).toMatchObject({ status: 'thin', median: null, nAccounts: null });
    expect(result.rows[0]).toMatchObject({ realizedPnl: null, unrealizedPnl: null, cycleStart: null });
    expect(result.settings).toMatchObject({ minCohortAccounts: 6, differsAtSpread: 3, cycleSeconds: 900, fallback: false });
  });

  it('reads a filling marker as filling, and no rows as no cycle', async () => {
    const filling = await loadSupabaseAlgorithmLive({
      clientIds: ['c1'],
      client: fakeClient({ desk: { data: [{ algorithm: null, instrument_root: null, cycle_start: '2026-10-06T14:20:00+00:00', scope: 'desk', status: 'filling' }], error: null } }),
    });
    expect(filling.desk).toMatchObject({ filling: true, cohorts: [], scope: 'desk' });
    const empty = await loadSupabaseAlgorithmLive({ clientIds: ['c1'], client: fakeClient() });
    expect(empty.desk).toMatchObject({ cycleStart: null, cohorts: [] });
  });

  it('reads the settings once per session', async () => {
    const first = fakeClient();
    await loadSupabaseAlgorithmLive({ clientIds: ['c1'], client: first });
    const second = fakeClient();
    await loadSupabaseAlgorithmLive({ clientIds: ['c1'], client: second });
    expect(first.asked.from).toContain('algorithm_live_settings');
    expect(second.asked.from).not.toContain('algorithm_live_settings');
  });

  it('answers available:false when there is no database at all', async () => {
    expect(await loadSupabaseAlgorithmLive({ client: null })).toEqual({ available: false, reason: 'not_configured' });
  });
});
