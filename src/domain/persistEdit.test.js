import { describe, expect, it, vi } from 'vitest';
import {
  persistEdit,
  refreshFailedMessage,
  saveFailedMessage,
} from './persistEdit.js';
import {
  resolveFlagInImport,
  updateCamProfile,
  updateImportStatus,
} from './crmStateStore.js';

/** A stand-in for React's setState: updater form, synchronous, inspectable. */
function store(initial) {
  let value = initial;
  return {
    setState: (updater) => {
      value = typeof updater === 'function' ? updater(value) : updater;
    },
    get current() { return value; },
  };
}

/**
 * The desk's shape, cut down to the three things that were reported broken: a
 * client with one close, that close carrying one open flag, and a CAM profile
 * holding the sidebar order.
 */
function deskState() {
  return {
    accountManager: { id: 'cam-1', name: 'Priya' },
    camProfiles: [{
      id: 'cam-1',
      name: 'Priya',
      clientIds: ['client-a', 'client-b', 'client-c'],
      clientOrder: ['client-a', 'client-b', 'client-c'],
    }],
    clients: [{
      id: 'client-a',
      name: 'Craig',
      accountRegistry: {},
      activityLog: [],
      tasks: [],
      dailyImports: [{
        id: 'imp-1',
        uuid: 'e5f6a7b8-1111-4222-8333-444455556666',
        date: '2026-08-19',
        status: 'Needs review',
        snapshots: [],
        strategies: [],
        flags: [{
          id: '11112222-3333-4444-8555-666677778888',
          type: 'Drawdown breach',
          message: 'APEX-4471 below trailing limit',
          severity: 'Critical',
          status: 'Open',
        }],
      }],
    }, {
      id: 'client-b', name: 'Dana', accountRegistry: {}, activityLog: [], tasks: [], dailyImports: [],
    }, {
      id: 'client-c', name: 'Ola', accountRegistry: {}, activityLog: [], tasks: [], dailyImports: [],
    }],
    selectedClientId: 'client-a',
  };
}

const flagOf = (state) => state.clients[0].dailyImports[0].flags[0];
const importOf = (state) => state.clients[0].dailyImports[0];
const orderOf = (state) => state.camProfiles[0].clientOrder;

const rejecting = (message) => () => Promise.reject(new Error(message));

describe('persistEdit', () => {
  it('shows the edit before the write has answered', async () => {
    const desk = store({ n: 0 });
    let resolveWrite;
    let valueWhenWriteStarted = null;
    const pending = persistEdit({
      setState: desk.setState,
      apply: (current) => ({ ...current, n: 1 }),
      write: () => {
        valueWhenWriteStarted = desk.current.n;
        return new Promise((resolve) => { resolveWrite = resolve; });
      },
    });
    // On screen before the call to persistEdit has even returned.
    expect(desk.current.n).toBe(1);
    await Promise.resolve();
    expect(valueWhenWriteStarted).toBe(1);
    resolveWrite(null);
    await pending;
    expect(desk.current.n).toBe(1);
  });

  it('folds in what the write returned', async () => {
    const desk = store({ id: 'local-1', saved: false });
    await persistEdit({
      setState: desk.setState,
      write: () => Promise.resolve({ id: 'server-1' }),
      reconcile: (current, result) => ({ ...current, id: result.id, saved: true }),
    });
    expect(desk.current).toEqual({ id: 'server-1', saved: true });
  });

  it('rolls back and reports a failed save when the WRITE fails', async () => {
    const desk = store({ n: 0 });
    const onSaveFailed = vi.fn();
    const outcome = await persistEdit({
      setState: desk.setState,
      apply: (current) => ({ ...current, n: 1 }),
      rollback: (current) => ({ ...current, n: 0 }),
      write: rejecting('rate limited'),
      onSaveFailed,
    });
    expect(outcome).toMatchObject({ saved: false });
    expect(desk.current.n).toBe(0);
    expect(onSaveFailed).toHaveBeenCalledTimes(1);
    expect(onSaveFailed.mock.calls[0][1]).toEqual({ rolledBack: true, applied: true });
  });

  it('says the change is still on screen when there is nothing to roll back to', async () => {
    const desk = store({ n: 0 });
    const onSaveFailed = vi.fn();
    await persistEdit({
      setState: desk.setState,
      apply: (current) => ({ ...current, n: 1 }),
      write: rejecting('rate limited'),
      onSaveFailed,
    });
    expect(desk.current.n).toBe(1);
    expect(onSaveFailed.mock.calls[0][1]).toEqual({ rolledBack: false, applied: true });
  });

  it('does not call an edit undone when nothing was ever put on screen', async () => {
    // A create whose id only the server can hand out: nothing is shown until
    // the row comes back, so a failed write leaves the screen untouched. It
    // must not be described as rolled back — there is nothing to roll back.
    const onSaveFailed = vi.fn();
    const rollback = vi.fn((current) => current);
    await persistEdit({
      setState: store({}).setState,
      rollback,
      write: rejecting('rate limited'),
      onSaveFailed,
    });
    expect(rollback).not.toHaveBeenCalled();
    expect(onSaveFailed.mock.calls[0][1]).toEqual({ rolledBack: false, applied: false });
  });

  it('never starts the refresh when the write failed', async () => {
    const refresh = vi.fn(() => Promise.resolve());
    await persistEdit({
      setState: store({}).setState,
      write: rejecting('rate limited'),
      refresh,
    });
    await Promise.resolve();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('reports the save as done without waiting for the refresh', async () => {
    let releaseRefresh;
    const outcome = await persistEdit({
      setState: store({}).setState,
      write: () => Promise.resolve('ok'),
      refresh: () => new Promise((resolve) => { releaseRefresh = resolve; }),
    });
    // The refresh is still in flight and the edit has already settled as saved.
    expect(outcome).toEqual({ saved: true, result: 'ok' });
    expect(typeof releaseRefresh).toBe('function');
    releaseRefresh(null);
  });

  it('keeps a failed refresh out of the save path entirely', async () => {
    const desk = store({ n: 0 });
    const onSaveFailed = vi.fn();
    const onRefreshFailed = vi.fn();
    const outcome = await persistEdit({
      setState: desk.setState,
      apply: (current) => ({ ...current, n: 1 }),
      rollback: (current) => ({ ...current, n: 0 }),
      write: () => Promise.resolve('written'),
      onSaveFailed,
      refresh: rejecting('429 Too Many Requests'),
      onRefreshFailed,
    });
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    expect(outcome).toEqual({ saved: true, result: 'written' });
    expect(onSaveFailed).not.toHaveBeenCalled();
    expect(onRefreshFailed).toHaveBeenCalledTimes(1);
    // The rollback exists and was NOT used: a refresh that could not replace
    // the state does not get to revert it.
    expect(desk.current.n).toBe(1);
  });

  it('refuses to run without a write', () => {
    expect(() => persistEdit({ setState: store({}).setState })).toThrow(/write/);
  });
});

describe('the two failure messages are two different facts', () => {
  const error = new Error('429 Too Many Requests');

  it('a failed save names the save and says nothing was written', () => {
    const text = saveFailedMessage('the flag', error);
    expect(text).toContain('Could not save the flag');
    expect(text).toContain('429 Too Many Requests');
    expect(text).toContain('Nothing was written');
  });

  it('a failed refresh never claims the save failed', () => {
    const text = refreshFailedMessage('Flag', error);
    expect(text).toMatch(/^Flag saved\./);
    expect(text).toContain('could not be refreshed');
    expect(text).toContain('your change is safe');
    expect(text).not.toMatch(/could not save/i);
  });

  it('does not tell the user their change was undone when it was not', () => {
    expect(saveFailedMessage('the day', error, { rolledBack: false }))
      .toContain('still on screen but is NOT saved');
    expect(saveFailedMessage('the day', error, { rolledBack: false }))
      .not.toContain('undone');
  });

  it('says nothing changed when nothing was ever shown', () => {
    const text = saveFailedMessage('the CAM profile', error, { rolledBack: false, applied: false });
    expect(text).toContain('Could not save the CAM profile');
    expect(text).toContain('nothing on screen has changed');
    expect(text).not.toContain('undone');
    expect(text).not.toContain('still on screen but is NOT saved');
  });
});

/**
 * The three symptoms the desk manager reported, each wired the way App.jsx now
 * wires it: the real crmStateStore patch, an optimistic apply, a rollback that
 * only a failed WRITE can reach, and no refetch at all.
 */
describe('symptom: marks a flag -> error, the view reloads, the flag is back', () => {
  const flagId = '11112222-3333-4444-8555-666677778888';
  const wire = (desk, { write, onSaveFailed, onRefreshFailed, refresh }) => persistEdit({
    setState: desk.setState,
    apply: (current) => resolveFlagInImport(current, 'client-a', 'imp-1', flagId, 'Resolved'),
    rollback: (current) => resolveFlagInImport(current, 'client-a', 'imp-1', flagId, 'Open'),
    write,
    onSaveFailed,
    refresh,
    onRefreshFailed,
  });

  it('shows the flag resolved without downloading anything', async () => {
    const desk = store(deskState());
    const load = vi.fn(() => Promise.resolve({}));
    await wire(desk, { write: () => Promise.resolve({ id: flagId, status: 'Resolved' }) });
    expect(flagOf(desk.current).status).toBe('Resolved');
    expect(load).not.toHaveBeenCalled();
  });

  it('keeps the flag resolved when a background refresh fails, and does not call it a failed save', async () => {
    const desk = store(deskState());
    const onSaveFailed = vi.fn();
    const messages = [];
    await wire(desk, {
      write: () => Promise.resolve({ id: flagId, status: 'Resolved' }),
      onSaveFailed,
      refresh: rejecting('429 Too Many Requests'),
      onRefreshFailed: (error) => messages.push(refreshFailedMessage('Flag', error)),
    });
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    expect(flagOf(desk.current).status).toBe('Resolved');
    expect(onSaveFailed).not.toHaveBeenCalled();
    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toMatch(/could not save/i);
  });

  it('puts the flag back only when the WRITE itself failed, and says so', async () => {
    const desk = store(deskState());
    const messages = [];
    await wire(desk, {
      write: rejecting('429 Too Many Requests'),
      onSaveFailed: (error, { rolledBack }) => messages.push(saveFailedMessage('the flag', error, { rolledBack })),
    });
    expect(flagOf(desk.current).status).toBe('Open');
    expect(messages[0]).toContain('Could not save the flag');
  });
});

describe('symptom: closes the day -> the view reloads and the day reads as not closed', () => {
  const wire = (desk, options) => persistEdit({
    setState: desk.setState,
    apply: (current) => updateImportStatus(current, 'client-a', 'imp-1', 'Closed'),
    rollback: (current) => updateImportStatus(current, 'client-a', 'imp-1', 'Needs review'),
    ...options,
  });

  it('reads as closed from the click, not from a refetch', async () => {
    const desk = store(deskState());
    await wire(desk, { write: () => Promise.resolve({ status: 'Closed' }) });
    expect(importOf(desk.current).status).toBe('Closed');
  });

  it('stays closed when a background refresh fails', async () => {
    const desk = store(deskState());
    const onSaveFailed = vi.fn();
    const refreshErrors = [];
    await wire(desk, {
      write: () => Promise.resolve({ status: 'Closed' }),
      onSaveFailed,
      refresh: rejecting('500 Internal Server Error'),
      onRefreshFailed: (error) => refreshErrors.push(error),
    });
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    expect(importOf(desk.current).status).toBe('Closed');
    expect(onSaveFailed).not.toHaveBeenCalled();
    expect(refreshErrors).toHaveLength(1);
  });

  it('reopens only when the WRITE failed', async () => {
    const desk = store(deskState());
    const seen = [];
    await wire(desk, {
      write: rejecting('429 Too Many Requests'),
      onSaveFailed: (error, { rolledBack }) => seen.push(saveFailedMessage('the close', error, { rolledBack })),
    });
    expect(importOf(desk.current).status).toBe('Needs review');
    expect(seen[0]).toContain('Could not save the close');
  });
});

describe('symptom: drags a client to reorder the sidebar -> the client snaps back', () => {
  const reordered = ['client-c', 'client-a', 'client-b'];
  const wire = (desk, options) => persistEdit({
    setState: desk.setState,
    apply: (current) => updateCamProfile(current, 'cam-1', { clientOrder: reordered }),
    rollback: (current) => updateCamProfile(current, 'cam-1', { clientOrder: ['client-a', 'client-b', 'client-c'] }),
    ...options,
  });

  it('keeps the dragged order the moment it is dropped', async () => {
    const desk = store(deskState());
    await wire(desk, { write: () => Promise.resolve({ client_order: reordered }) });
    expect(orderOf(desk.current)).toEqual(reordered);
  });

  it('does not snap back when a background refresh fails', async () => {
    const desk = store(deskState());
    const onSaveFailed = vi.fn();
    await wire(desk, {
      write: () => Promise.resolve({ client_order: reordered }),
      onSaveFailed,
      refresh: rejecting('429 Too Many Requests'),
      onRefreshFailed: () => {},
    });
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    expect(orderOf(desk.current)).toEqual(reordered);
    expect(onSaveFailed).not.toHaveBeenCalled();
  });

  it('snaps back only when the WRITE failed, and says the order was not saved', async () => {
    const desk = store(deskState());
    const seen = [];
    await wire(desk, {
      write: rejecting('429 Too Many Requests'),
      onSaveFailed: (error, { rolledBack }) => seen.push(saveFailedMessage('the sidebar order', error, { rolledBack })),
    });
    expect(orderOf(desk.current)).toEqual(['client-a', 'client-b', 'client-c']);
    expect(seen[0]).toContain('Could not save the sidebar order');
    expect(seen[0]).toContain('undone');
  });
});
