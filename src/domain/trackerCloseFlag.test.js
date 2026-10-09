import { describe, expect, it, vi } from 'vitest';
import {
  TRACKER_CLOSE_FLAG_TYPE,
  buildTrackerCloseFlag,
  createTrackerCloseFlagAdder,
  trackerCloseFlagTitle,
} from './trackerCloseFlag';
import { addFlagToImport, removeFlagFromImport } from './crmStateStore';

/* ------------------------------------------------------------------------- *
 * "ADD FLAG" ON A ROW THAT ASKS FOR A LOOK.
 *
 * The queue's own path, in the other direction: an optimistic patch into the
 * client's close, one insert into operational_flags, one audit row, and the
 * patch undone when the write fails. Everything injected, so no database.
 * ------------------------------------------------------------------------- */

function row(over = {}) {
  return {
    accountName: 'ACC 01',
    verdict: 'differs',
    attention: true,
    flags: [],
    delta: 140.4,
    tracker: { realized: 340.4, total: 340.4, unrealized: 0 },
    close: { realized: 200 },
    sentence: 'Tracker realized $340.40 differs from the close $200.00 by $140.40, beyond the $5.00 tolerance.',
    ...over,
  };
}

describe('the title', () => {
  it('says the account and the whole dollar gap for a row that differs', () => {
    expect(trackerCloseFlagTitle(row())).toBe('Tracker and close differ on ACC 01 by $140');
    expect(trackerCloseFlagTitle(row({ delta: -140.6 }))).toBe('Tracker and close differ on ACC 01 by $141');
  });

  it('has a sentence for every attention verdict and every flag, and nothing for a row that matches', () => {
    expect(trackerCloseFlagTitle(row({ verdict: 'tracker_reset' }))).toBe('Tracker reset seen on ACC 01: tracker $340 against close $200');
    expect(trackerCloseFlagTitle(row({ verdict: 'tracker_only', close: null, delta: null }))).toBe('Tracker saw ACC 01 at the close but the close does not list it');
    expect(trackerCloseFlagTitle(row({ verdict: 'close_only', tracker: null, delta: null }))).toBe('Close lists ACC 01 but the tracker had no reading before the capture');
    expect(trackerCloseFlagTitle(row({ verdict: 'stale_reading' }))).toBe('Tracker reading for ACC 01 was stale at the close');
    expect(trackerCloseFlagTitle(row({ verdict: 'matches', flags: ['algo_moved'] }))).toBe('An algorithm on ACC 01 moved between the tracker and the close');
    expect(trackerCloseFlagTitle(row({ verdict: 'matches', flags: ['strategies_differ'] }))).toBe('Strategies on ACC 01 differ between the tracker and the close');
    expect(trackerCloseFlagTitle(row({ verdict: 'matches', flags: ['connection_differs'] }))).toBe('Connection on ACC 01 differs between the tracker and the close');
    expect(trackerCloseFlagTitle(row({ verdict: 'matches', attention: false }))).toBeNull();
    expect(trackerCloseFlagTitle(row({ verdict: 'after_close', attention: false }))).toBeNull();
  });

  it('never a dash as punctuation', () => {
    for (const verdict of ['differs', 'tracker_reset', 'tracker_only', 'close_only', 'stale_reading']) {
      expect(trackerCloseFlagTitle(row({ verdict }))).not.toMatch(/[–—]| - /);
    }
  });
});

describe('the flag', () => {
  it('is a Warning, Open, typed, named after the account, with a uuid Postgres accepts', () => {
    const flag = buildTrackerCloseFlag(row());
    expect(flag).toMatchObject({ type: TRACKER_CLOSE_FLAG_TYPE, severity: 'Warning', accountName: 'ACC 01', status: 'Open', message: 'Tracker and close differ on ACC 01 by $140' });
    expect(flag.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(buildTrackerCloseFlag(row(), { id: 'fixed' }).id).toBe('fixed');
    expect(TRACKER_CLOSE_FLAG_TYPE).toBe('Tracker differs from the close');
  });

  it('is null for a row that asks for nothing', () => {
    expect(buildTrackerCloseFlag(row({ verdict: 'matches', attention: false }))).toBeNull();
  });
});

describe('the state patch', () => {
  const state = { clients: [{ id: 'c-1', uuid: 'u-1', dailyImports: [{ id: 'di-1', uuid: 'imp-1', flags: [{ id: 'f-0' }] }, { id: 'di-2', flags: [] }] }, { id: 'c-2', dailyImports: [{ id: 'di-1', flags: [] }] }] };
  const flag = { id: 'f-new', type: TRACKER_CLOSE_FLAG_TYPE, message: 'x', status: 'Open' };

  it('appends the flag to the one close of the one client, by import id or uuid, and removes it again', () => {
    const next = addFlagToImport(state, 'c-1', 'di-1', flag);
    expect(next.clients[0].dailyImports[0].flags.map((entry) => entry.id)).toEqual(['f-0', 'f-new']);
    expect(next.clients[0].dailyImports[1].flags).toEqual([]);
    expect(next.clients[1].dailyImports[0].flags).toEqual([]);
    expect(addFlagToImport(state, 'c-1', 'imp-1', flag).clients[0].dailyImports[0].flags).toHaveLength(2);
    const back = removeFlagFromImport(next, 'c-1', 'di-1', 'f-new');
    expect(back.clients[0].dailyImports[0].flags.map((entry) => entry.id)).toEqual(['f-0']);
    // Adding the same id twice is one flag.
    expect(addFlagToImport(next, 'c-1', 'di-1', flag).clients[0].dailyImports[0].flags).toHaveLength(2);
  });
});

describe('createTrackerCloseFlagAdder', () => {
  const flag = { id: 'f-new', type: TRACKER_CLOSE_FLAG_TYPE, severity: 'Warning', accountName: 'ACC 01', message: 'Tracker and close differ on ACC 01 by $140', status: 'Open' };

  it('resolves with the written flag when the write succeeds', async () => {
    const insertFlag = vi.fn(() => Promise.resolve({ ...flag, written: true }));
    const add = createTrackerCloseFlagAdder({ insertFlag, onError: vi.fn() });
    await expect(add('client-1', 'imp-1', flag)).resolves.toMatchObject({ id: 'f-new', written: true });
  });

  it('patches state, inserts the one flag and audits it with its source', async () => {
    const insertFlag = vi.fn(() => Promise.resolve({ ...flag }));
    const audit = vi.fn();
    const patchState = vi.fn((state) => state);
    let seen = null;
    const setState = vi.fn((updater) => { seen = updater({ clients: [] }); });
    const add = createTrackerCloseFlagAdder({ setState, patchState, insertFlag, audit });
    await add('client-1', 'imp-1', flag);
    expect(patchState).toHaveBeenCalledWith({ clients: [] }, 'client-1', 'imp-1', flag);
    expect(seen).toEqual({ clients: [] });
    expect(insertFlag).toHaveBeenCalledWith('client-1', 'imp-1', flag);
    expect(audit).toHaveBeenCalledWith({
      entityType: 'operational_flag',
      entityId: 'f-new',
      action: 'flag.create',
      afterData: { clientId: 'client-1', importId: 'imp-1', flagId: 'f-new', type: TRACKER_CLOSE_FLAG_TYPE, accountName: 'ACC 01', message: flag.message, source: 'tracker-close' },
    });
  });

  it('puts the row back when the write fails, and reports the failure', async () => {
    const insertFlag = vi.fn(() => Promise.reject(new Error('boom')));
    const onError = vi.fn();
    const calls = [];
    const setState = vi.fn((updater) => { calls.push(updater({ clients: [] })); });
    const patchState = vi.fn((state) => ({ ...state, patched: true }));
    const unpatchState = vi.fn((state) => ({ ...state, patched: false }));
    const add = createTrackerCloseFlagAdder({ setState, patchState, unpatchState, insertFlag, onError });
    // Rejects after onError, so the cell that asked can take back its "Flag added".
    await expect(add('client-1', 'imp-1', flag)).rejects.toThrow('boom');
    expect(patchState).toHaveBeenCalledTimes(1);
    expect(unpatchState).toHaveBeenCalledWith({ clients: [] }, 'client-1', 'imp-1', 'f-new');
    expect(calls).toEqual([{ clients: [], patched: true }, { clients: [], patched: false }]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toBe('boom');
  });

  it('refuses a call missing a client, an import or a message instead of failing silently', async () => {
    const insertFlag = vi.fn();
    const onError = vi.fn();
    const add = createTrackerCloseFlagAdder({ insertFlag, onError });
    await expect(add(null, 'imp-1', flag)).rejects.toThrow(/client/);
    await expect(add('client-1', null, flag)).rejects.toThrow(/import/);
    await expect(add('client-1', 'imp-1', { ...flag, message: '' })).rejects.toThrow(/message/);
    expect(insertFlag).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(3);
    expect(() => createTrackerCloseFlagAdder({ insertFlag })('x', null, flag)).toThrow(/import/);
  });
});
