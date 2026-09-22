// A reclassification is retroactive, and a stored summary must not undo that.
//
// THE RULE THIS PROTECTS. `buildCrmStateFromTables` recomputes the
// live/simulated/cash/prop split from each account's CURRENT record on every
// load, deliberately, so that a CAM correcting a misclassification fixes every
// close the client ever had rather than only the ones imported afterwards. The
// comment in that function names the incident: the 2026-08-06 close that
// reported Craig's day as $0.
//
// Step 48 stores the per-close money, which freezes the classification it was
// written under. Two things stop that from re-creating the bug, and this file
// pins both: a save that moves an account's type or simulation mode rebuilds
// the client's summaries from the record as it now is, and every stored row
// names the accounts it counted so a row the rebuild missed is refused rather
// than believed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ tables: {}, rpc: [], updates: [] }));

vi.mock('../lib/supabaseClient', () => {
  function builder(table, columns, { head = false, exact = false } = {}) {
    const filters = [];
    let range = null;
    let single = false;
    let update = null;
    const self = {
      eq(column, value) { filters.push((row) => row[column] === value); return self; },
      ilike(column, value) {
        filters.push((row) => String(row[column] ?? '').toLowerCase() === String(value).toLowerCase());
        return self;
      },
      in(column, values) {
        const set = new Set(values);
        filters.push((row) => set.has(row[column]));
        return self;
      },
      or() { return self; },
      order() { return self; },
      range(from, to) { range = [from, to]; return self; },
      maybeSingle() { single = true; return self; },
      single() { single = true; return self; },
      select() { return self; },
      update(patch) { update = patch; return self; },
      then(resolve, reject) {
        return new Promise((done) => {
          setTimeout(() => {
            const all = (db.tables[table] || []).filter((row) => filters.every((test) => test(row)));
            if (update) {
              db.updates.push({ table, patch: update });
              for (const row of all) Object.assign(row, update);
              done({ data: all[0] || null, error: null });
              return;
            }
            if (head && exact) {
              done({ count: all.length, data: null, error: null });
              return;
            }
            const slice = range ? all.slice(range[0], range[1] + 1) : all;
            done(single ? { data: slice[0] || null, error: null } : { data: slice, error: null });
          }, 0);
        }).then(resolve, reject);
      },
    };
    return self;
  }

  return {
    isSupabaseConfigured: true,
    supabase: {
      from(table) {
        return {
          select: (columns, options) => builder(table, columns, {
            head: Boolean(options?.head), exact: options?.count === 'exact',
          }),
          update: (patch) => builder(table).update(patch),
        };
      },
      rpc(name, args) {
        db.rpc.push({ name, args });
        return Promise.resolve({ data: args.p_rows?.length || 0, error: null });
      },
    },
  };
});

const {
  patchReclassifies,
  rebuildSupabaseCloseSummariesForClient,
  updateSupabaseTradingAccount,
} = await import('./supabaseStore.js');

/** One client, two accounts, three closes, each account reporting on each. */
function makeBook() {
  return {
    clients: [{ id: 'client-uuid', legacy_key: 'c1', name: 'Client', status: 'Active' }],
    trading_accounts: [
      {
        id: 'acct-cash', client_id: 'client-uuid', account_name: 'CASH-1',
        account_type: 'Cash', status: 'Active', simulation_mode: null,
      },
      {
        id: 'acct-fund', client_id: 'client-uuid', account_name: 'FUND-1',
        account_type: 'Funded', status: 'Active', simulation_mode: null,
      },
    ],
    daily_imports: [
      { id: 'imp-1', client_id: 'client-uuid', trading_date: '2026-09-20' },
      { id: 'imp-2', client_id: 'client-uuid', trading_date: '2026-09-21' },
      { id: 'imp-3', client_id: 'client-uuid', trading_date: '2026-09-22' },
    ],
    account_snapshots: ['imp-1', 'imp-2', 'imp-3'].flatMap((importId, index) => ([
      {
        id: `s-${importId}-cash`, daily_import_id: importId, trading_account_id: 'acct-cash',
        account_name: 'CASH-1', gross_realized_pnl: 10 + index, weekly_pnl: 20, account_balance: 1000,
      },
      {
        id: `s-${importId}-fund`, daily_import_id: importId, trading_account_id: 'acct-fund',
        account_name: 'FUND-1', gross_realized_pnl: -4, weekly_pnl: -8, account_balance: 50000,
      },
    ])),
  };
}

beforeEach(() => {
  db.tables = makeBook();
  db.rpc = [];
  db.updates = [];
});

afterEach(() => {
  db.tables = {};
});

describe('rebuilding a client\'s stored summaries', () => {
  it('writes one row per segment for every close the client has', async () => {
    const written = await rebuildSupabaseCloseSummariesForClient('c1');

    expect(db.rpc).toHaveLength(1);
    expect(db.rpc[0].name).toBe('replace_close_summaries');
    // Every close named in one call, so the delete and the insert cover the
    // whole client rather than leaving a gap between two round trips.
    expect(db.rpc[0].args.p_daily_import_ids.sort()).toEqual(['imp-1', 'imp-2', 'imp-3']);
    expect(written).toBe(6);
    const rows = db.rpc[0].args.p_rows;
    expect(new Set(rows.map((row) => row.segment))).toEqual(new Set(['Cash', 'Funded']));
    const cash = rows.find((row) => row.daily_import_id === 'imp-1' && row.segment === 'Cash');
    expect(cash).toMatchObject({
      client_id: 'client-uuid',
      trading_date: '2026-09-20',
      accounts: 1,
      daily_pnl: 10,
      counted_in_total: true,
      account_names: ['CASH-1'],
    });
  });

  it('moves every close when an account is reclassified, not only the newest', async () => {
    // THE WHOLE POINT. A CAM who marks an account as simulated is saying it was
    // never the desk's money, and the correction has to reach the closes that
    // already reported it as cash.
    db.tables.trading_accounts[0].account_type = 'Simulation';
    await rebuildSupabaseCloseSummariesForClient('c1');

    const rows = db.rpc[0].args.p_rows;
    const simulated = rows.filter((row) => row.segment === 'Simulated (not real money)');
    expect(simulated).toHaveLength(3);
    for (const row of simulated) {
      expect(row.counted_in_total).toBe(false);
      expect(row.account_names).toEqual(['CASH-1']);
    }
    expect(rows.filter((row) => row.segment === 'Cash')).toHaveLength(0);
  });

  it('follows the CAM\'s explicit override, not only the account type', async () => {
    // simulationMode is the human determination and it overrides the automatic
    // signals — see classifyAccountNature. A rebuild that only read
    // account_type would ignore the one field a CAM sets to say "this is not
    // real money" about an account whose type nobody has corrected.
    db.tables.trading_accounts[1].simulation_mode = 'simulation';
    await rebuildSupabaseCloseSummariesForClient('c1');

    const rows = db.rpc[0].args.p_rows;
    expect(rows.filter((row) => row.segment === 'Funded')).toHaveLength(0);
    expect(rows.filter((row) => row.segment === 'Simulated (not real money)')).toHaveLength(3);
  });

  it('writes nothing for a client with no closes', async () => {
    db.tables.daily_imports = [];
    expect(await rebuildSupabaseCloseSummariesForClient('c1')).toBe(0);
    expect(db.rpc).toHaveLength(0);
  });
});

describe('the save that triggers it', () => {
  it('names the two fields that move an account between segments', () => {
    expect(patchReclassifies({ accountType: 'Funded' })).toBe(true);
    expect(patchReclassifies({ simulationMode: 'simulation' })).toBe(true);
    // Everything else on the account card is metadata. Rebuilding a client's
    // whole history because somebody fixed a typo in an alias would be three
    // round trips for nothing, on the save path, on a starved instance.
    expect(patchReclassifies({ alias: 'Lucid - 1001' })).toBe(false);
    expect(patchReclassifies({ notes: 'called', riskLevel: 'High' })).toBe(false);
    expect(patchReclassifies({})).toBe(false);
  });

  it('rebuilds after a reclassification and not after an ordinary edit', async () => {
    await updateSupabaseTradingAccount('c1', 'CASH-1', { accountType: 'Inactive / Ignore' });
    expect(db.rpc.map((call) => call.name)).toEqual(['replace_close_summaries']);
    // And the rebuild reads the record as it NOW is: the update landed first.
    const rows = db.rpc[0].args.p_rows;
    expect(rows.filter((row) => row.segment === 'Ignored')).toHaveLength(3);

    db.rpc = [];
    await updateSupabaseTradingAccount('c1', 'CASH-1', { notes: 'called the client' });
    expect(db.rpc).toHaveLength(0);
  });

  it('still saves the classification when the rebuild cannot be written', async () => {
    // A database where step 48 has not run, or an RPC that failed. The
    // classification IS saved and must not be reported to the CAM as a failed
    // save; the stored rows that did not move are refused on the way back in
    // by the account names each one carries.
    const { supabase } = await import('../lib/supabaseClient');
    const realRpc = supabase.rpc;
    supabase.rpc = () => Promise.resolve({
      data: null,
      error: { code: '42P01', message: 'relation "close_summaries" does not exist' },
    });
    try {
      const saved = await updateSupabaseTradingAccount('c1', 'FUND-1', { accountType: 'Cash' });
      expect(saved.account_type).toBe('Cash');
    } finally {
      supabase.rpc = realRpc;
    }
  });
});
