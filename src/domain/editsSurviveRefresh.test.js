// A refresh must never cost the user an edit, and must never cost them a table.
//
// WHAT THIS FILE PINS, AND WHY IT IS NOT persistEdit.test.js
//
// persistEdit.test.js pins the case where a background refresh FAILS: the edit
// stays, the save is not reported as failed, the user is told the view is
// stale. Everything here is the other case — the refresh that SUCCEEDS — which
// turned out to be the dangerous one, because success took the quiet path:
// refreshInBackground ended in setState(nextState), so a refresh that worked
// perfectly replaced the screen with a snapshot read before the user's next
// click, and neither an alert nor a stale notice was raised about it. The old
// code at least emptied the screen into a loading state while it did this. The
// pass that removed the loading state made the same data loss silent.
//
// Three defects, three reproductions, all of them found by driving the real
// modules rather than by reading them:
//
//   D1  Upload a day; resolve a flag while the refresh is in flight; the
//       refresh lands carrying the pre-write snapshot and the flag reads Open
//       again.
//   D2  "Import all 5 closes" fired five detached full reloads. They landed out
//       of order, the last to land won, and it was not the last to be written:
//       four closes disappeared off the screen.
//   D3  Every refresh wiped orders and executions — loadSupabaseCrmState
//       defaults includeTradeHistory=false, so buildCrmStateFromTables rebuilds
//       every day with orders:[] executions:[] — and nothing put them back. The
//       manager Refresh button, opening a workspace and every upload each
//       dropped ~24,000 rows off the screen until the browser was reloaded.
//
// Synthetic throughout, so CI pins all of it: see src/localSnapshotGate.test.js
// for why a guard that only runs where the book exists is not a guard.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  flagUpdate: { error: null, data: null },
  importUpdate: { error: null, data: null },
}));

// PostgREST stand-in, so the real write helpers run. The reproductions are
// about what happens AFTER a successful write, and a fake write that resolved
// without going through updateSupabaseOperationalFlag would not be one.
vi.mock('../lib/supabaseClient', () => ({
  isSupabaseConfigured: true,
  supabase: {
    from(table) {
      const builder = {
        select() { return builder; },
        update() { return builder; },
        eq() { return builder; },
        maybeSingle() {
          return Promise.resolve(table === 'operational_flags' ? db.flagUpdate : db.importUpdate);
        },
      };
      return builder;
    },
  },
}));

const { persistEdit, refreshFailedMessage, saveFailedMessage } = await import('./persistEdit.js');
const { updateSupabaseOperationalFlag, updateSupabaseDailyImportStatus } = await import('./supabaseStore.js');
const { buildCrmStateFromTables } = await import('./supabaseStore.js');
const {
  appendDailyImport,
  resolveFlagInImport,
  updateImportStatus,
  removeDailyImport,
} = await import('./crmStateStore.js');
const { carryTradeHistoryForward, mergeRefreshedDays } = await import('./refreshMerge.js');
const { createCoalescingRefresh } = await import('./backgroundRefresh.js');

/** A stand-in for React's setState: updater form, synchronous, inspectable. */
function store(initial) {
  let value = initial;
  return {
    setState: (updater) => { value = typeof updater === 'function' ? updater(value) : updater; },
    get current() { return value; },
  };
}

/**
 * The exact body of saveEdit in App.jsx, minus the console line and with the
 * alert collected instead of thrown at a window. If these two diverge the
 * source-text guards in appSaveWiring.test.js are what catch it.
 */
function makeSaveEdit(setState, alerts, notices) {
  return function saveEdit({ what, apply = null, rollback = null, write, reconcile = null, onSaved = null, refresh = null }) {
    return persistEdit({
      setState,
      apply,
      rollback,
      write,
      reconcile,
      onSaved,
      onSaveFailed: (error, { rolledBack, applied }) => {
        alerts.push(saveFailedMessage(what, error, { rolledBack, applied }));
      },
      refresh,
      onRefreshFailed: (error) => {
        notices.push({ status: 'stale', message: refreshFailedMessage(what, error) });
      },
    });
  };
}

const FLAG_ID = '11112222-3333-4444-8555-666677778888';
const YESTERDAY = '2026-08-19';
const TODAY = '2026-08-20';

/** One CAM, three clients, one closed day carrying one open flag. */
function desk() {
  return {
    accountManager: { id: 'cam-1', name: 'Priya' },
    camProfiles: [{ id: 'cam-1', name: 'Priya', clientIds: ['a', 'b', 'c'], clientOrder: ['a', 'b', 'c'] }],
    clients: [
      {
        id: 'a',
        name: 'Craig',
        accountRegistry: {},
        activityLog: [],
        tasks: [],
        dailyImports: [{
          id: 'imp-1',
          uuid: 'e5f6a7b8-1111-4222-8333-444455556666',
          date: YESTERDAY,
          status: 'Needs review',
          snapshots: [],
          strategies: [],
          orders: [],
          executions: [],
          flags: [{ id: FLAG_ID, type: 'Drawdown breach', message: 'APEX-4471 below trailing limit', status: 'Open' }],
        }],
      },
      { id: 'b', name: 'Dana', accountRegistry: {}, activityLog: [], tasks: [], dailyImports: [] },
      { id: 'c', name: 'Ola', accountRegistry: {}, activityLog: [], tasks: [], dailyImports: [] },
    ],
    selectedClientId: 'a',
  };
}

const uploadedDay = (date, extra = {}) => ({
  id: `a-${date}`,
  date,
  status: 'Needs review',
  accounts: {},
  snapshots: [],
  strategies: [],
  orders: [],
  executions: [],
  flags: [],
  ...extra,
});

const craig = (state) => state.clients.find((client) => client.id === 'a');
const dayOf = (state, date) => craig(state).dailyImports.find((day) => day.date === date);
const flagOf = (state) => dayOf(state, YESTERDAY).flags[0];
const datesOn = (state) => craig(state).dailyImports.map((day) => day.date);

const tick = () => new Promise((resolve) => { setTimeout(resolve, 5); });

beforeEach(() => {
  db.flagUpdate = { error: null, data: { id: FLAG_ID, status: 'Resolved' } };
  db.importUpdate = { error: null, data: { id: 'imp-1', status: 'Closed' } };
});

describe('D1: a background refresh that succeeds while the user is still working', () => {
  /**
   * Sets up the reported sequence and hands back the lever that lands the
   * refresh, so each test can decide what the refresh's reads saw.
   */
  async function uploadWithPendingRefresh(state, { date = TODAY, day = uploadedDay(date) } = {}) {
    const s = store(state);
    const alerts = [];
    const notices = [];
    const saveEdit = makeSaveEdit(s.setState, alerts, notices);
    let land;
    await saveEdit({
      what: 'the daily import',
      apply: (current) => appendDailyImport(current, 'a', day),
      write: () => Promise.resolve({ id: 'server-uuid' }),
      refresh: () => new Promise((resolve) => { land = resolve; })
        .then((snapshot) => {
          s.setState((current) => mergeRefreshedDays(current, snapshot, [{ clientId: 'a', date }]));
          return snapshot;
        }),
    });
    // persistEdit starts the refresh a microtask after the write resolves; the
    // whole point of these tests is what happens while it is still out.
    await tick();
    return { s, alerts, notices, saveEdit, land: (snapshot) => land(snapshot) };
  }

  it('keeps a flag resolved when the refresh lands carrying the snapshot it read before the click', async () => {
    // The desk manager's original symptom, made silent. The refresh's reads went
    // out before the flag was written, so what comes back says Open — and the
    // old code assigned it over the top of a screen that said Resolved.
    const { s, alerts, notices, saveEdit, land } = await uploadWithPendingRefresh(desk());
    const snapshotAtRefreshStart = desk();

    await saveEdit({
      what: 'the flag',
      apply: (current) => resolveFlagInImport(current, 'a', 'imp-1', FLAG_ID, 'Resolved'),
      rollback: (current) => resolveFlagInImport(current, 'a', 'imp-1', FLAG_ID, 'Open'),
      write: () => updateSupabaseOperationalFlag(FLAG_ID, 'Resolved'),
    });
    expect(flagOf(s.current).status).toBe('Resolved');

    land(snapshotAtRefreshStart);
    await tick();

    expect(flagOf(s.current).status).toBe('Resolved');
    expect(alerts).toEqual([]);
    expect(notices).toEqual([]);
  });

  it('keeps the uploaded day itself when the refresh lands without it', async () => {
    // Same landing, other half of the loss: the snapshot predates the upload's
    // own write, so a whole-state replacement took the day off the screen that
    // had just reported it saved.
    const { s, land } = await uploadWithPendingRefresh(desk());
    expect(datesOn(s.current)).toEqual([YESTERDAY, TODAY]);

    land(desk());
    await tick();

    expect(datesOn(s.current)).toEqual([YESTERDAY, TODAY]);
  });

  it('does not reopen a day the user closed while the refresh was in flight', async () => {
    // The refresh DID see the upload this time — the realistic case, since the
    // read starts after the write returns. It saw it as "Needs review", because
    // the close happened afterwards. The server owns the day's identity; the
    // screen owns its status.
    const { s, saveEdit, land } = await uploadWithPendingRefresh(desk());
    const snapshot = appendDailyImport(desk(), 'a', uploadedDay(TODAY, { uuid: 'server-uuid' }));

    await saveEdit({
      what: 'the close',
      apply: (current) => updateImportStatus(current, 'a', `a-${TODAY}`, 'Closed'),
      rollback: (current) => updateImportStatus(current, 'a', `a-${TODAY}`, 'Needs review'),
      write: () => updateSupabaseDailyImportStatus(`a-${TODAY}`, 'Closed'),
    });
    expect(dayOf(s.current, TODAY).status).toBe('Closed');

    land(snapshot);
    await tick();

    expect(dayOf(s.current, TODAY).status).toBe('Closed');
    // And the reason the refresh was allowed to run at all still arrives.
    expect(dayOf(s.current, TODAY).uuid).toBe('server-uuid');
  });

  it('keeps a flag resolved on the refreshed day itself, matched by the id the write carried through', async () => {
    // Flag ids are client-generated uuids written through unchanged (mapFlag in
    // dailyImportPersistence.js), so the refreshed row for a flag resolved
    // mid-flight is findable exactly, not by guessing at its text.
    const fresh = '99998888-7777-4666-8555-444433332222';
    const raised = { id: fresh, type: 'Missing account', message: 'TOPSTEP-9 absent', status: 'Open' };
    const { s, saveEdit, land } = await uploadWithPendingRefresh(desk(), {
      day: uploadedDay(TODAY, { flags: [raised] }),
    });
    const snapshot = appendDailyImport(desk(), 'a', uploadedDay(TODAY, {
      uuid: 'server-uuid',
      flags: [{ ...raised }],
    }));

    await saveEdit({
      what: 'the flag',
      apply: (current) => resolveFlagInImport(current, 'a', `a-${TODAY}`, fresh, 'Resolved'),
      rollback: (current) => resolveFlagInImport(current, 'a', `a-${TODAY}`, fresh, 'Open'),
      write: () => updateSupabaseOperationalFlag(fresh, 'Resolved'),
    });

    land(snapshot);
    await tick();

    const flags = dayOf(s.current, TODAY).flags;
    expect(flags).toHaveLength(1);
    expect(flags[0].status).toBe('Resolved');
  });

  it('does not resurrect a day the user undid while the refresh was in flight', async () => {
    // An undo removes the close. The refresh read before it and still holds the
    // row; folding that back in would be the same defect wearing a delete.
    const { s, land } = await uploadWithPendingRefresh(desk());
    s.setState((current) => removeDailyImport(current, 'a', `a-${TODAY}`));

    land(appendDailyImport(desk(), 'a', uploadedDay(TODAY, { uuid: 'server-uuid' })));
    await tick();

    expect(datesOn(s.current)).toEqual([YESTERDAY]);
  });

  it('leaves every day the refresh was not asked about exactly as it found it', async () => {
    // The scope IS the fix. A refresh asked for one day that rewrites the other
    // 534 is a whole-state replacement with a narrower name.
    const { s, land } = await uploadWithPendingRefresh(desk());
    const before = dayOf(s.current, YESTERDAY);

    land(appendDailyImport(desk(), 'a', uploadedDay(TODAY, { uuid: 'server-uuid' })));
    await tick();

    expect(dayOf(s.current, YESTERDAY)).toBe(before);
  });
});

describe('D2: "Import all 5 closes"', () => {
  /**
   * Five closes through one coalescing gate, each refresh reading the server as
   * it stood when THAT run started. `loads` records what each run was asked
   * about, so the request cost is assertable and not just described.
   */
  async function importFive() {
    const s = store(desk());
    const alerts = [];
    const notices = [];
    const saveEdit = makeSaveEdit(s.setState, alerts, notices);
    const stored = [];
    const loads = [];

    const gate = createCoalescingRefresh({
      run: async (targets) => {
        // Read at run start, exactly as a real load's first request would be.
        const snapshot = stored.reduce(
          (state, date) => appendDailyImport(state, 'a', uploadedDay(date, { uuid: `server-${date}` })),
          desk(),
        );
        loads.push(targets.map((target) => target.date));
        await tick();
        s.setState((current) => mergeRefreshedDays(current, snapshot, targets));
        return snapshot;
      },
    });

    const days = ['2026-08-21', '2026-08-22', '2026-08-23', '2026-08-24', '2026-08-25'];
    for (const date of days) {
      await saveEdit({
        what: 'the daily import',
        apply: (current) => appendDailyImport(current, 'a', uploadedDay(date)),
        write: () => { stored.push(date); return Promise.resolve({ id: `server-${date}` }); },
        refresh: () => gate.request({ clientId: 'a', date }),
      });
    }
    while (!gate.isIdle()) await tick();
    return { s, alerts, notices, loads, days };
  }

  it('leaves all five closes on screen, whatever each refresh happened to read', async () => {
    // Five detached full reloads, each carrying a different moment, each ending
    // in setState(nextState): the last to land won and four closes vanished.
    const { s, alerts, notices, days } = await importFive();
    expect(datesOn(s.current)).toEqual([YESTERDAY, ...days]);
    expect(alerts).toEqual([]);
    expect(notices).toEqual([]);
  });

  it('costs two loads for five closes, not five', async () => {
    // One run in flight, everything that arrived during it batched into a
    // single trailing run. At 41 requests a load that is 82 instead of 205.
    const { loads } = await importFive();
    expect(loads).toHaveLength(2);
    expect(loads[0]).toEqual(['2026-08-21']);
    expect(loads[1]).toEqual(['2026-08-22', '2026-08-23', '2026-08-24', '2026-08-25']);
  });

  it('gives the trailing run every day that queued against it', async () => {
    // The batch is what makes one run enough. A trailing run that carried only
    // the last requester would leave three closes unreconciled and would be a
    // quieter version of the same bug.
    const { loads, days } = await importFive();
    expect(loads.flat()).toEqual(days);
  });
});

describe('the coalescing gate itself', () => {
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };

  it('never has two runs in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const gate = createCoalescingRefresh({
      run: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await tick();
        inFlight -= 1;
      },
    });
    await Promise.all([1, 2, 3, 4, 5].map((n) => gate.request(n)));
    expect(peak).toBe(1);
  });

  it('settles a caller only with a run that carried its own target', async () => {
    // The reason requests queue rather than joining the run already out: that
    // run read before this target existed, so reporting it as this edit's
    // refresh would be a false statement about what the screen now holds.
    const seen = [];
    const first = deferred();
    let calls = 0;
    const gate = createCoalescingRefresh({
      run: (targets) => {
        calls += 1;
        seen.push(targets);
        return calls === 1 ? first.promise : Promise.resolve('second');
      },
    });
    const a = gate.request('a');
    const b = gate.request('b');
    let bDone = false;
    b.then(() => { bDone = true; });

    await tick();
    // b's target went out after the first run's reads did, so nothing the first
    // run brings back can be reported as b's refresh.
    expect(seen).toEqual([['a']]);
    expect(bDone).toBe(false);

    first.resolve('first');
    await expect(a).resolves.toBe('first');
    await expect(b).resolves.toBe('second');
    expect(seen).toEqual([['a'], ['b']]);
  });

  it('rejects only the callers whose own run failed', async () => {
    const first = deferred();
    let calls = 0;
    const gate = createCoalescingRefresh({
      run: () => { calls += 1; return calls === 1 ? first.promise : Promise.resolve('ok'); },
    });
    const a = gate.request('a');
    const b = gate.request('b');
    first.reject(new Error('429 Too Many Requests'));
    await expect(a).rejects.toThrow('429');
    await expect(b).resolves.toBe('ok');
  });

  it('starts a fresh run once it has gone idle', async () => {
    let calls = 0;
    const gate = createCoalescingRefresh({ run: () => { calls += 1; return Promise.resolve(); } });
    await gate.request('a');
    await gate.request('b');
    expect(calls).toBe(2);
    expect(gate.isIdle()).toBe(true);
  });

  it('refuses to exist without a run function', () => {
    expect(() => createCoalescingRefresh({})).toThrow(/run function/);
  });
});

describe('D3: trade history across a refresh', () => {
  const ACCOUNT_UUID = '0e1d2c3b-4a59-4687-8765-432100000001';
  const IMPORT_UUID = '0e1d2c3b-4a59-4687-8765-432100000002';

  /**
   * Real table rows through the real buildCrmStateFromTables, because the wipe
   * is not something the app does — it is what a load without orders and
   * executions RETURNS, and a fixture that hand-wrote empty arrays would be
   * asserting my own belief about that rather than the code's behaviour.
   */
  function tables({ withFills = true } = {}) {
    return {
      cam_profiles: [{ id: 'cam-uuid-1', legacy_key: 'cam-1', name: 'Priya' }],
      clients: [{ id: 'client-uuid-1', legacy_key: 'a', name: 'Craig', status: 'Active' }],
      client_assignments: [{ cam_profile_id: 'cam-uuid-1', client_id: 'client-uuid-1' }],
      trading_accounts: [{
        id: ACCOUNT_UUID,
        client_id: 'client-uuid-1',
        account_name: 'APEX-4471',
        account_type: 'Funded',
        simulation_mode: 'live',
      }],
      daily_imports: [{
        id: IMPORT_UUID,
        client_id: 'client-uuid-1',
        legacy_key: 'imp-1',
        trading_date: YESTERDAY,
        status: 'Needs review',
      }],
      account_snapshots: [{
        id: 'snap-1',
        daily_import_id: IMPORT_UUID,
        trading_account_id: ACCOUNT_UUID,
        account_name: 'APEX-4471',
        gross_realized_pnl: 420,
      }],
      orders: withFills ? [
        { id: 'o1', daily_import_id: IMPORT_UUID, trading_account_id: ACCOUNT_UUID, external_order_id: 'ORD-1', state: 'Filled' },
        { id: 'o2', daily_import_id: IMPORT_UUID, trading_account_id: ACCOUNT_UUID, external_order_id: 'ORD-2', state: 'Filled' },
      ] : [],
      executions: withFills ? [
        { id: 'e1', daily_import_id: IMPORT_UUID, trading_account_id: ACCOUNT_UUID, external_execution_id: 'EX-1', quantity: 2 },
      ] : [],
    };
  }

  const onlyDay = (state) => state.clients[0].dailyImports[0];

  it('a refresh really does come back with no orders and no executions', async () => {
    // The premise, asserted rather than assumed. loadSupabaseCrmState defaults
    // includeTradeHistory=false and every day is rebuilt without fills, so any
    // shape that ASSIGNS that result is a wipe.
    const loaded = buildCrmStateFromTables(tables({ withFills: true }));
    const refreshed = buildCrmStateFromTables(tables({ withFills: false }));
    expect(onlyDay(loaded).orders).toHaveLength(2);
    expect(onlyDay(loaded).executions).toHaveLength(1);
    expect(onlyDay(refreshed).orders).toEqual([]);
    expect(onlyDay(refreshed).executions).toEqual([]);
  });

  it('carries the fills already in memory across the refresh', async () => {
    // The regression, in one line: the pass kept the wipe and removed the
    // recovery, so the manager Refresh button dropped ~24,000 rows and nothing
    // fetched them again short of a browser reload.
    const loaded = buildCrmStateFromTables(tables({ withFills: true }));
    const refreshed = buildCrmStateFromTables(tables({ withFills: false }));

    const { state } = carryTradeHistoryForward(loaded, refreshed);

    expect(onlyDay(state).orders.map((order) => order.id)).toEqual(['ORD-1', 'ORD-2']);
    expect(onlyDay(state).executions.map((execution) => execution.id)).toEqual(['EX-1']);
  });

  it('keeps what the refresh DID fetch while carrying the fills', async () => {
    // Carrying history forward must not carry the rest of the old day with it.
    // The snapshot the refresh rebuilt is the fresher one.
    const loaded = buildCrmStateFromTables(tables({ withFills: true }));
    const moved = tables({ withFills: false });
    moved.account_snapshots[0].gross_realized_pnl = 999;

    const { state } = carryTradeHistoryForward(loaded, buildCrmStateFromTables(moved));

    expect(onlyDay(state).snapshots[0].grossRealizedPnl).toBe(999);
    expect(onlyDay(state).orders).toHaveLength(2);
  });

  it('reports nothing missing when every day is already known', async () => {
    // The trap the previous shape fell into pointed the other way: calling
    // hydrateTradeHistory again on every refresh is the request burst the
    // bounded gate was introduced to end.
    const loaded = buildCrmStateFromTables(tables({ withFills: true }));
    const { missingImportIds } = carryTradeHistoryForward(loaded, buildCrmStateFromTables(tables({ withFills: false })));
    expect(missingImportIds).toEqual([]);
  });

  it('does not call a day that simply traded nothing a day whose history was lost', async () => {
    // A flat day, and a day whose every account is simulated, both hold zero
    // live orders honestly. Treating "no fills" as "fills lost" would re-fetch
    // 24,000 rows on every refresh forever.
    const flat = tables({ withFills: false });
    const loaded = buildCrmStateFromTables(flat);
    const { missingImportIds, state } = carryTradeHistoryForward(loaded, buildCrmStateFromTables(flat));
    expect(missingImportIds).toEqual([]);
    expect(onlyDay(state).orders).toEqual([]);
  });

  it('names a day this session has never seen, so its fills can be fetched once', async () => {
    // Another CAM's upload. There is nothing in memory to carry, and this is
    // the only case that earns a re-fetch.
    const loaded = buildCrmStateFromTables(tables({ withFills: true }));
    const withNewDay = tables({ withFills: false });
    withNewDay.daily_imports.push({
      id: 'new-day-uuid',
      client_id: 'client-uuid-1',
      legacy_key: 'imp-2',
      trading_date: TODAY,
      status: 'Needs review',
    });

    const { missingImportIds } = carryTradeHistoryForward(loaded, buildCrmStateFromTables(withNewDay));

    expect(missingImportIds).toEqual(['new-day-uuid']);
  });

  it('carries the simulated and undetermined halves too, not only the live one', async () => {
    // splitSimulationRows puts a simulated account's fills on simulation.orders
    // and simulation.executions. Restoring only the live arrays would leave a
    // prop desk's screen half-wiped and look like a much stranger bug.
    const withSim = tables({ withFills: true });
    withSim.trading_accounts.push({
      id: 'sim-account-uuid',
      client_id: 'client-uuid-1',
      account_name: 'SIM-1',
      account_type: 'Simulation',
      simulation_mode: 'simulation',
    });
    withSim.orders.push({
      id: 'o3', daily_import_id: IMPORT_UUID, trading_account_id: 'sim-account-uuid', external_order_id: 'ORD-SIM', state: 'Filled',
    });
    const loaded = buildCrmStateFromTables(withSim);
    expect(onlyDay(loaded).simulation.orders).toHaveLength(1);

    const stripped = { ...withSim, orders: [], executions: [] };
    const { state } = carryTradeHistoryForward(loaded, buildCrmStateFromTables(stripped));

    expect(onlyDay(state).simulation.orders.map((order) => order.id)).toEqual(['ORD-SIM']);
    expect(onlyDay(state).orders.map((order) => order.id)).toEqual(['ORD-1', 'ORD-2']);
  });

  it('carries the fills of the day a background refresh folds in', async () => {
    // The upload path pays this too: the day the refresh returns was loaded
    // without fills, but the upload that produced it holds its own. Swapping in
    // the refreshed copy without them would wipe the trades the user just
    // imported, on the one screen they are certain to be looking at.
    const local = appendDailyImport(desk(), 'a', uploadedDay(TODAY, {
      orders: [{ id: 'ORD-9' }],
      executions: [{ id: 'EX-9' }],
    }));
    const refreshed = appendDailyImport(desk(), 'a', uploadedDay(TODAY, { uuid: 'server-uuid' }));

    const merged = mergeRefreshedDays(local, refreshed, [{ clientId: 'a', date: TODAY }]);

    expect(dayOf(merged, TODAY).uuid).toBe('server-uuid');
    expect(dayOf(merged, TODAY).orders.map((order) => order.id)).toEqual(['ORD-9']);
    expect(dayOf(merged, TODAY).executions.map((execution) => execution.id)).toEqual(['EX-9']);
  });
});
