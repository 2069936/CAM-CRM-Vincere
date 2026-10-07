import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadLogAlgoHistory, logAlgoFamilyFromRow } from './supabaseStore';

/* A fake PostgREST client: the function answers `rpc`, the table answers
 * `from().select()`. What the database does with these two calls is proved in
 * supabase/step_59_log_algo_history_by_family.test.js against a real cluster;
 * this file covers the branches a cluster cannot produce, PostgREST's own
 * PGRST202 among them. */
function fakeClient({ rpc, table }) {
  const asked = { rpc: [], from: [] };
  return {
    asked,
    rpc(name) { asked.rpc.push(name); return Promise.resolve(rpc); },
    from(name) {
      asked.from.push(name);
      return { select: () => Promise.resolve(table ?? { data: [], error: null }) };
    },
  };
}

const RAW_ROWS = [
  { log_date: '2026-10-01', account_name: 'A', family: 'OGX', direction: 'Long', realized_pnl: 100, round_trips: 2 },
  { log_date: '2026-10-02', account_name: 'B', family: 'OGX', direction: 'Short', realized_pnl: -40.5, round_trips: 1 },
];

describe('loadLogAlgoHistory', () => {
  it('reads the step 59 aggregate and never touches the rows when the function answers', async () => {
    const client = fakeClient({ rpc: { data: [
      { family: 'OGX', status: 'shown', total_pnl: 59.5, long_pnl: 100, short_pnl: -40.5, mixed_pnl: 0, round_trips: 3, accounts: 2, days: 2 },
      { family: 'Thin', status: 'withheld', total_pnl: null, long_pnl: null, short_pnl: null, mixed_pnl: null, round_trips: null, accounts: null, days: null },
    ], error: null } });
    const families = await loadLogAlgoHistory({ client });
    expect(client.asked).toEqual({ rpc: ['log_algo_history_by_family'], from: [] });
    expect(families).toEqual([
      { family: 'OGX', withheld: false, totalPnl: 59.5, roundTrips: 3, byDirection: { Long: 100, Short: -40.5, Mixed: 0 }, accounts: 2, days: 2 },
      { family: 'Thin', withheld: true, totalPnl: null, roundTrips: null, byDirection: { Long: null, Short: null, Mixed: null }, accounts: null, days: null },
    ]);
  });

  it('falls back to the rows, aggregated as before, when step 59 has not run', async () => {
    for (const error of [
      { code: 'PGRST202', message: 'Could not find the function public.log_algo_history_by_family without parameters in the schema cache' },
      { code: '42883', message: 'function public.log_algo_history_by_family() does not exist' },
    ]) {
      const client = fakeClient({ rpc: { data: null, error }, table: { data: RAW_ROWS, error: null } });
      const families = await loadLogAlgoHistory({ client });
      expect(client.asked.from, error.code).toEqual(['log_algo_history']);
      expect(families).toEqual([
        { family: 'OGX', withheld: false, totalPnl: 59.5, roundTrips: 3, byDirection: { Long: 100, Short: -40.5, Mixed: 0 }, accounts: 2, days: 2 },
      ]);
    }
  });

  it('THROWS on any other failure, so a refused read is never shown as an empty desk', async () => {
    const denied = { code: '42501', message: 'permission denied for function log_algo_history_by_family' };
    await expect(loadLogAlgoHistory({ client: fakeClient({ rpc: { data: null, error: denied } }) }))
      .rejects.toThrow(/log_algo_history_by_family: permission denied/);
    const fallbackFails = fakeClient({
      rpc: { data: null, error: { code: 'PGRST202', message: 'missing' } },
      table: { data: null, error: { code: '42501', message: 'permission denied for table log_algo_history' } },
    });
    await expect(loadLogAlgoHistory({ client: fallbackFails })).rejects.toThrow(/permission denied for table/);
  });

  it('answers nothing without a database', async () => {
    expect(await loadLogAlgoHistory({ client: null })).toEqual([]);
  });
});

describe('logAlgoFamilyFromRow', () => {
  it('keeps a withheld family\'s figures null even if a number arrived beside the status', () => {
    expect(logAlgoFamilyFromRow({ family: 'X', status: 'withheld', total_pnl: 5, accounts: 1 })).toMatchObject({
      withheld: true, totalPnl: null, accounts: null,
    });
  });
});

describe('the App.jsx effect that loads it', () => {
  /* A source-text check, the method appSaveWiring.test.js explains: the effect
   * lives inside a 17,000-line component no test renders. What it pins is the
   * reason step 59 touched the browser at all: the answer depends on who is
   * signed in, so the load must follow the session and start empty. With `[]`
   * deps it ran once, as anon, and a Manager's full history outlived a sign out
   * into the next CAM's session in the same tab. */
  const APP = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');
  const start = APP.indexOf('const [logAlgoHistory, setLogAlgoHistory] = useState([]);');
  const effect = APP.slice(start, APP.indexOf('}, [', start) + 60);

  it('empties the slice, waits for a session, and reruns when the user changes', () => {
    expect(start).toBeGreaterThan(-1);
    expect(effect).toContain('setLogAlgoHistory([]);');
    expect(effect).toMatch(/if \(!isSupabaseConfigured \|\| !session\?\.id\) return;/);
    expect(effect).toContain('}, [session?.id, session?.role, session?.camProfileId]);');
    expect(effect.indexOf('setLogAlgoHistory([]);')).toBeLessThan(effect.indexOf('loadLogAlgoHistory()'));
  });
});
