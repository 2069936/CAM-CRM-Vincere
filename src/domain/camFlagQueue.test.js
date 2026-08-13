import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  buildCamFlagQueue,
  createCamFlagResolver,
  flagActivityEntry,
  flagGroupActivityEntry,
  flagResolutionPlan,
  isFlagOpen,
} from './camFlagQueue';
import { buildCrmStateFromTables } from './supabaseStore';
import { resolveFlagInImport } from './crmStateStore';

const TODAY = '2026-08-11';

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

function flag(id, overrides = {}) {
  return {
    id,
    type: 'Strategy disabled',
    severity: 'Warning',
    accountName: 'ACC-1',
    message: 'Strategy Bullet 3.2 is disabled on ACC-1',
    status: 'Open',
    resolvedAt: '',
    ...overrides,
  };
}

/**
 * One client, three closes. The same problem is open on the two older ones and
 * gone from the newest; a second, different problem is open only on the newest.
 * This is the shape of the real book: 1,102 of the 1,952 open rows have no twin
 * on the latest close at all.
 */
function bookWithStrandedFlag() {
  return [
    {
      id: 'client-1',
      name: 'Harper Juniper',
      dailyImports: [
        { id: 'imp-0715', date: '2026-07-15', flags: [flag('f-0715')] },
        { id: 'imp-0721', date: '2026-07-21', flags: [flag('f-0721')] },
        {
          id: 'imp-0730',
          date: '2026-07-30',
          flags: [flag('f-0730-other', { type: 'Missing account', message: 'ACC-9 has no upload' })],
        },
      ],
    },
  ];
}

/* ── The defect ───────────────────────────────────────────────────────────── */

describe('a resolution names the flag it means, not the day on screen', () => {
  it('sends each occurrence its own import id and its own flag id', () => {
    const queue = buildCamFlagQueue(bookWithStrandedFlag(), { today: TODAY });
    const stranded = queue.groups
      .flatMap((group) => group.rows)
      .find((row) => row.type === 'Strategy disabled');

    expect(stranded.occurrences).toHaveLength(2);
    expect(flagResolutionPlan(stranded, 'Resolved')).toEqual([
      { clientId: 'client-1', importId: 'imp-0715', flagId: 'f-0715', status: 'Resolved' },
      { clientId: 'client-1', importId: 'imp-0721', flagId: 'f-0721', status: 'Resolved' },
    ]);

    // The day a CAM would be standing on. Nothing in the plan refers to it,
    // which is the entire point: handleResolveFlag would have sent imp-0730 (or
    // returned without doing anything, because on the real book the date picker
    // opens on a day with no import at all).
    const plan = flagResolutionPlan(stranded, 'Resolved');
    expect(plan.some((call) => call.importId === 'imp-0730')).toBe(false);
    expect(plan.some((call) => call.flagId === 'f-0730-other')).toBe(false);
  });

  it('resolveFlagInImport patches the row named by the plan and nothing else', () => {
    const clients = bookWithStrandedFlag();
    const queue = buildCamFlagQueue(clients, { today: TODAY });
    const stranded = queue.groups
      .flatMap((group) => group.rows)
      .find((row) => row.type === 'Strategy disabled');

    let state = { clients };
    for (const call of flagResolutionPlan(stranded, 'Resolved')) {
      state = resolveFlagInImport(state, call.clientId, call.importId, call.flagId, call.status);
    }

    const byImport = Object.fromEntries(
      state.clients[0].dailyImports.map((entry) => [entry.id, entry.flags[0]]),
    );
    expect(byImport['imp-0715'].status).toBe('Resolved');
    expect(byImport['imp-0721'].status).toBe('Resolved');
    expect(byImport['imp-0715'].resolvedAt).toBeTruthy();
    // Untouched: it is a different problem on a different close.
    expect(byImport['imp-0730'].status).toBe('Open');
  });

  it('resolves nothing when handed the wrong import — the silent failure this replaces', () => {
    // resolveFlagInImport walks client → import → flag and no-ops if the import
    // id does not match. That no-op is invisible in the UI, which is why the ids
    // travel with the row instead of being read off the screen.
    const clients = bookWithStrandedFlag();
    const state = resolveFlagInImport({ clients }, 'client-1', 'imp-0730', 'f-0715', 'Resolved');
    expect(state.clients[0].dailyImports[0].flags[0].status).toBe('Open');
  });
});

/* ── Building the queue ───────────────────────────────────────────────────── */

describe('buildCamFlagQueue', () => {
  it('collapses one problem across closes into one row, keeping every record', () => {
    const queue = buildCamFlagQueue(bookWithStrandedFlag(), { today: TODAY });
    expect(queue.totals.rows).toBe(2);
    expect(queue.totals.occurrences).toBe(3);
    // 2 problems, 3 database rows. Reporting the second as the first is what put
    // 1,952 on a header reading 253.
    expect(queue.totals.behindLatestClose).toBe(1);
    expect(queue.totals.onLatestClose).toBe(1);
  });

  it('treats repeats of one key inside a single close as one problem, resolving every row', () => {
    // Devon North's 2026-07-23 close really does carry six identical "Strategy
    // disabled" rows with no account name, and 51 imports in the book repeat a
    // key like that (132 rows in all). Six buttons a CAM cannot tell apart are
    // one problem, and closing it has to close all six uuids.
    const clients = [
      {
        id: 'client-6',
        name: 'Devon North',
        dailyImports: [
          {
            id: 'imp-i',
            date: '2026-07-23',
            flags: [flag('f-i1', { accountName: '' }), flag('f-i2', { accountName: '' }), flag('f-i3', { accountName: '' })],
          },
        ],
      },
    ];
    const queue = buildCamFlagQueue(clients, { today: TODAY });
    expect(queue.totals.rows).toBe(1);
    expect(queue.totals.occurrences).toBe(3);
    expect(flagResolutionPlan(queue.groups[0].rows[0]).map((call) => call.flagId))
      .toEqual(['f-i1', 'f-i2', 'f-i3']);
  });

  it('ages a flag from the close it first appeared on, not from its own row', () => {
    const queue = buildCamFlagQueue(bookWithStrandedFlag(), { today: TODAY });
    const rows = Object.fromEntries(
      queue.groups.flatMap((group) => group.rows).map((row) => [row.type, row]),
    );
    // 2026-07-15 → 2026-08-11 is 27 days. Dating it by the row it sits on would
    // read 21 (its last copy) or 0 (a flag rewritten into today's import).
    expect(rows['Strategy disabled'].ageDays).toBe(27);
    expect(rows['Strategy disabled'].firstSeen).toBe('2026-07-15');
    expect(rows['Strategy disabled'].lastSeen).toBe('2026-07-21');
    expect(rows['Missing account'].ageDays).toBe(12);
  });

  it('reports an undatable flag as not measured, never as zero days old', () => {
    const clients = [
      {
        id: 'client-2',
        name: 'Gray Elm',
        dailyImports: [
          { id: 'imp-a', date: 'not-a-date', flags: [flag('f-a')] },
          { id: 'imp-b', date: '2026-07-30', flags: [flag('f-b', { accountName: 'ACC-2' })] },
        ],
      },
    ];
    const queue = buildCamFlagQueue(clients, { today: TODAY });
    const undated = queue.groups
      .flatMap((group) => group.rows)
      .find((row) => row.accountName === 'ACC-1');
    expect(undated.ageDays).toBeNull();
    expect(undated.ageDays).not.toBe(0);
    expect(undated.bucket).toBe('unknown');
    expect(queue.buckets.find((bucket) => bucket.key === 'unknown').rows).toBe(1);
  });

  it('leaves Resolved and Acknowledged out and treats a missing status as open', () => {
    expect(isFlagOpen({ status: 'Resolved' })).toBe(false);
    expect(isFlagOpen({ status: 'Acknowledged' })).toBe(false);
    expect(isFlagOpen({})).toBe(true);
    expect(isFlagOpen({ status: 'Needs review' })).toBe(true);

    const clients = [
      {
        id: 'client-3',
        name: 'Indigo Cedar',
        dailyImports: [
          {
            id: 'imp-c',
            date: '2026-07-30',
            flags: [
              flag('f-open'),
              flag('f-done', { accountName: 'ACC-2', status: 'Resolved', resolvedAt: '2026-08-06T10:00:00Z' }),
            ],
          },
        ],
      },
    ];
    const queue = buildCamFlagQueue(clients, { today: TODAY });
    expect(queue.totals.rows).toBe(1);
    // Closed rows are not work, but they are the receipt: nothing is deleted.
    expect(queue.totals.recentlyClosed).toBe(1);
    expect(queue.recentlyClosed[0].status).toBe('Resolved');
  });

  it('reads a row at its worst severity across closes', () => {
    const clients = [
      {
        id: 'client-4',
        name: 'Jordan Larch',
        dailyImports: [
          { id: 'imp-d', date: '2026-07-20', flags: [flag('f-d', { severity: 'Warning' })] },
          { id: 'imp-e', date: '2026-07-30', flags: [flag('f-e', { severity: 'Critical' })] },
        ],
      },
    ];
    const [row] = buildCamFlagQueue(clients, { today: TODAY }).groups[0].rows;
    expect(row.severity).toBe('Critical');
    expect(row.occurrences).toHaveLength(2);
  });

  it('ignores closes after the date it is anchored to', () => {
    const queue = buildCamFlagQueue(bookWithStrandedFlag(), { today: '2026-07-16' });
    expect(queue.totals.rows).toBe(1);
    expect(queue.latestClose).toBe('2026-07-15');
    expect(queue.groups[0].rows[0].onLatestClose).toBe(true);
  });

  it('puts the oldest run first, with unmeasured ages last', () => {
    const clients = [
      {
        id: 'client-5',
        name: 'Oakley Pine',
        dailyImports: [
          { id: 'imp-f', date: '2026-07-10', flags: [flag('f-f', { type: 'Old' })] },
          {
            id: 'imp-g',
            date: '2026-07-30',
            flags: [flag('f-g', { type: 'New', accountName: 'ACC-3' })],
          },
          { id: 'imp-h', date: 'unknown', flags: [flag('f-h', { type: 'Undated', accountName: 'ACC-4' })] },
        ],
      },
    ];
    const queue = buildCamFlagQueue(clients, { today: TODAY });
    expect(queue.groups.map((group) => group.type)).toEqual(['Old', 'New', 'Undated']);
    expect(queue.groups[2].oldestDays).toBeNull();
  });
});

/* ── The write path ───────────────────────────────────────────────────────── */

describe('createCamFlagResolver', () => {
  it('patches state, updates the one flag and audits it as a CAM action', async () => {
    const updateFlag = vi.fn(() => Promise.resolve({ id: 'f-0715', status: 'Resolved' }));
    const audit = vi.fn();
    const patchState = vi.fn((state) => state);
    let seen = null;
    const setState = vi.fn((updater) => { seen = updater({ clients: [] }); });

    const resolve = createCamFlagResolver({ setState, patchState, updateFlag, audit });
    await resolve('client-1', 'imp-0715', 'f-0715', 'Resolved');

    expect(patchState).toHaveBeenCalledWith({ clients: [] }, 'client-1', 'imp-0715', 'f-0715', 'Resolved');
    expect(seen).toEqual({ clients: [] });
    expect(updateFlag).toHaveBeenCalledWith('f-0715', 'Resolved');
    expect(audit).toHaveBeenCalledWith({
      entityType: 'operational_flag',
      entityId: 'f-0715',
      action: 'flag.resolve',
      afterData: {
        clientId: 'client-1',
        importId: 'imp-0715',
        flagId: 'f-0715',
        status: 'Resolved',
        // The manager's closure writes source: "manager". Only the source tells
        // the trail apart afterwards.
        source: 'cam-overview',
      },
    });
  });

  it('audits an acknowledgement under its own action', async () => {
    const audit = vi.fn();
    const resolve = createCamFlagResolver({
      updateFlag: () => Promise.resolve(null),
      audit,
    });
    await resolve('client-1', 'imp-0715', 'f-0715', 'Acknowledged');
    expect(audit.mock.calls[0][0].action).toBe('flag.acknowledge');
  });

  it('refuses a resolution missing any of the three ids instead of failing silently', () => {
    const updateFlag = vi.fn();
    const onError = vi.fn();
    const resolve = createCamFlagResolver({ updateFlag, onError });
    resolve(null, 'imp-0715', 'f-0715');
    expect(updateFlag).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
    expect(String(onError.mock.calls[0][0].message)).toContain('needs a client, an import and a flag');
  });

  it('reports a rejected write rather than leaving the row looking closed', async () => {
    const onError = vi.fn();
    const resolve = createCamFlagResolver({
      updateFlag: () => Promise.reject(new Error('This flag has not been saved yet. Reload the page and try again.')),
      onError,
    });
    await resolve('client-1', 'imp-0715', 'not-a-uuid');
    expect(onError).toHaveBeenCalled();
    expect(String(onError.mock.calls[0][0].message)).toContain('has not been saved yet');
  });
});

describe('activity entries', () => {
  it('names the flag and the close it was raised on', () => {
    const [row] = buildCamFlagQueue(bookWithStrandedFlag(), { today: TODAY })
      .groups.flatMap((group) => group.rows)
      .filter((entry) => entry.type === 'Strategy disabled');
    const entry = flagActivityEntry(row, 'Resolved', { now: '2026-08-11T09:00:00Z' });
    expect(entry.text).toBe(
      'Flag resolved: [Strategy disabled] Strategy Bullet 3.2 is disabled on ACC-1 (raised 2026-07-15)',
    );
    expect(entry.type).toBe('Alert');
    expect(entry.accountName).toBe('ACC-1');
  });

  it('writes one line for a whole group, not one per row', () => {
    const group = buildCamFlagQueue(bookWithStrandedFlag(), { today: TODAY }).groups[0];
    const entry = flagGroupActivityEntry(group, 'Acknowledged', { now: '2026-08-11T09:00:00Z' });
    expect(entry.text).toBe(
      'Bulk acknowledged 1 flag [Strategy disabled] raised 2026-07-15 → 2026-07-21',
    );
  });

  it('has nothing to log for a status that is not a triage decision', () => {
    expect(flagActivityEntry({ type: 'x', message: 'y' }, 'Open')).toBeNull();
    expect(flagGroupActivityEntry(null, 'Resolved')).toBeNull();
  });
});

/* ── The real book ────────────────────────────────────────────────────────── */

describe('the real book (public/local-snapshot.json, closes 2026-06-25 → 2026-07-30)', () => {
  const snapshot = JSON.parse(
    readFileSync(new URL('../../public/local-snapshot.json', import.meta.url), 'utf8'),
  );
  const state = buildCrmStateFromTables(snapshot.tables);
  const clientById = Object.fromEntries(state.clients.map((client) => [client.id, client]));
  const camClients = (name) => {
    const cam = state.camProfiles.find((profile) => profile.name === name);
    return (cam.clientIds || []).map((id) => clientById[id]).filter(Boolean);
  };

  it('accounts for every open flag record a CAM holds, and no more', () => {
    let rows = 0;
    let records = 0;
    for (const cam of state.camProfiles) {
      const queue = buildCamFlagQueue(camClients(cam.name), { today: TODAY });
      rows += queue.totals.rows;
      records += queue.totals.occurrences;
    }
    // 1,952 open rows on visible clients with a known import, counted straight
    // from the state the app loads. The queue shows them as 1,055 problems.
    const openFromState = state.clients.reduce(
      (total, client) => total + (client.dailyImports || []).reduce(
        (sum, entry) => sum + (entry.flags || []).filter(isFlagOpen).length,
        0,
      ),
      0,
    );
    expect(openFromState).toBe(1952);
    expect(records).toBe(1952);
    expect(rows).toBe(1055);
  });

  it('shows the two CAMs whose entire flag workload is behind the latest close', () => {
    // Ellis Glen and Oakley Ash have zero open flags on any client's latest
    // close, so every existing view shows them nothing to act on while their
    // "Critical flags" tile reads 134 and 55.
    const ellis = buildCamFlagQueue(camClients('Ellis Glen'), { today: TODAY });
    expect(ellis.totals.onLatestClose).toBe(0);
    expect(ellis.totals.rows).toBe(149);
    expect(ellis.totals.occurrences).toBe(315);
    expect(ellis.totals.critical).toBe(59);
    expect(ellis.totals.groups).toBe(51);

    const oakley = buildCamFlagQueue(camClients('Oakley Ash'), { today: TODAY });
    expect(oakley.totals.onLatestClose).toBe(0);
    expect(oakley.totals.rows).toBe(250);
    expect(oakley.totals.occurrences).toBe(269);
  });

  it('collapses Marlow Cedar 908 records into 242 problems', () => {
    const queue = buildCamFlagQueue(camClients('Marlow Cedar'), { today: TODAY });
    expect(queue.totals.occurrences).toBe(908);
    expect(queue.totals.rows).toBe(242);
    expect(queue.totals.onLatestClose).toBe(145);
    expect(queue.totals.behindLatestClose).toBe(97);
    expect(queue.latestClose).toBe('2026-07-30');
  });

  it('every flag id it would send is a uuid, so the store guard passes', () => {
    // supabaseStore rejects a non-uuid before the request because composite ids
    // like `Strategy disabled-FTDFYL1001-za9s0gd` failed silently in Postgres.
    // Nothing here relaxes that guard, so the queue must only ever offer ids
    // that satisfy it.
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let checked = 0;
    for (const cam of state.camProfiles) {
      const queue = buildCamFlagQueue(camClients(cam.name), { today: TODAY });
      for (const group of queue.groups) {
        for (const row of group.rows) {
          for (const call of flagResolutionPlan(row)) {
            expect(call.flagId).toMatch(uuid);
            expect(call.importId).toBeTruthy();
            expect(call.clientId).toBe(row.clientId);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBe(1952);
  });

  it('every (client, import, flag) it would send exists in the state it was built from', () => {
    // The queue is the only place these three ids are put together, so a
    // mismatch here is a resolution that would no-op in local state and patch a
    // row in Postgres that the CAM never looked at.
    const queue = buildCamFlagQueue(camClients('Ellis Glen'), { today: TODAY });
    let verified = 0;
    for (const group of queue.groups) {
      for (const row of group.rows) {
        for (const call of flagResolutionPlan(row)) {
          const client = clientById[call.clientId];
          const entry = (client.dailyImports || []).find((di) => di.id === call.importId);
          expect(entry).toBeTruthy();
          expect((entry.flags || []).some((f) => f.id === call.flagId)).toBe(true);
          verified += 1;
        }
      }
    }
    expect(verified).toBe(315);
  });

  it('ages read against the snapshot, not against a bucket that looks like a property of the book', () => {
    const queue = buildCamFlagQueue(camClients('Ellis Glen'), { today: TODAY });
    // Every row is 14+ days old only because the export stops on 2026-07-30 and
    // "today" is 2026-08-11: 12 days of staleness on top of the real ages.
    expect(queue.latestClose).toBe('2026-07-30');
    expect(queue.buckets.find((bucket) => bucket.key === 'rotten').rows).toBe(149);
    expect(queue.buckets.find((bucket) => bucket.key === 'today').rows).toBe(0);
    expect(queue.totals.oldestDays).toBe(27);

    // Anchored on the last trading day instead, the same 149 problems spread
    // across two buckets and the oldest reads 15 days, not 27. Same book, same
    // rows; only the anchor moved.
    const onLastClose = buildCamFlagQueue(camClients('Ellis Glen'), { today: '2026-07-30' });
    expect(onLastClose.totals.rows).toBe(149);
    expect(onLastClose.buckets.find((bucket) => bucket.key === 'stale').rows).toBe(63);
    expect(onLastClose.buckets.find((bucket) => bucket.key === 'rotten').rows).toBe(86);
    expect(onLastClose.totals.oldestDays).toBe(15);
  });
  it('dates the "recently closed" window instead of reporting an empty one as a fact', () => {
    // The panel's closing line used to read "0 flags were closed in the last 7
    // days". True, and misleading: "today" is 2026-08-11, the book stops on
    // 2026-07-30, and 2,970 flags were closed in the seven days up to that
    // close. A bare 0 there reads as "nobody works this queue".
    const queue = buildCamFlagQueue(state.clients, { today: TODAY });
    expect(queue.totals.recentlyClosed).toBe(0);
    expect(queue.closedWindow).toEqual({ from: '2026-08-04', to: TODAY });
    // The two facts that let a reader tell an empty window from an idle desk.
    expect(queue.closedTotal).toBe(4601);
    expect(queue.lastClosedOn).toBe('2026-07-30');

    // Anchored on the last close instead, the same window is far from empty.
    const onLastClose = buildCamFlagQueue(state.clients, { today: '2026-07-30' });
    expect(onLastClose.closedWindow).toEqual({ from: '2026-07-23', to: '2026-07-30' });
    expect(onLastClose.totals.recentlyClosed).toBe(2970);
  });
});

describe('createCamFlagResolver — a write that fails must not look like one that worked', () => {
  function bookWithOneOpenFlag() {
    return {
      clients: [{
        id: 'c1',
        name: 'Client One',
        dailyImports: [{
          id: 'di-1',
          date: '2026-07-30',
          flags: [{ id: 'f1', type: 'Drawdown breached', severity: 'Critical', accountName: 'A1', message: 'over', status: 'Open' }],
        }],
      }],
    };
  }

  it('puts the row back when Supabase rejects', async () => {
    let live = bookWithOneOpenFlag();
    const errors = [];
    const resolve = createCamFlagResolver({
      setState: (fn) => { live = fn(live); },
      updateFlag: () => Promise.reject(new Error('network')),
      onError: (error) => errors.push(error.message),
    });

    await resolve('c1', 'di-1', 'f1', 'Resolved');

    // Optimistic patch, then rollback. Without the rollback the flag reads
    // Resolved locally and Open in Postgres: the row leaves the queue, the CAM
    // moves on, and it is back on the next load with nothing to say why.
    expect(live.clients[0].dailyImports[0].flags[0].status).toBe('Open');
    expect(errors).toEqual(['network']);
    // The queue can still see it.
    expect(buildCamFlagQueue(live.clients, { today: TODAY }).totals.rows).toBe(1);
  });

  it('leaves the row closed when the write succeeds', async () => {
    let live = bookWithOneOpenFlag();
    const audited = [];
    const resolve = createCamFlagResolver({
      setState: (fn) => { live = fn(live); },
      updateFlag: () => Promise.resolve({ ok: true }),
      audit: (entry) => audited.push(entry),
    });

    await resolve('c1', 'di-1', 'f1', 'Resolved');

    expect(live.clients[0].dailyImports[0].flags[0].status).toBe('Resolved');
    expect(buildCamFlagQueue(live.clients, { today: TODAY }).totals.rows).toBe(0);
    expect(audited[0].afterData).toMatchObject({ clientId: 'c1', importId: 'di-1', flagId: 'f1' });
  });
});
