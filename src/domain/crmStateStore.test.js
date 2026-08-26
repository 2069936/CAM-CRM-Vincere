// The reducers an edit is made visible with, and the ones a refused write is
// taken back off the screen with.
//
// Every one of these exists because an edit used to be shown by re-downloading
// the database: the apply half needed no local reducer at all, and the rollback
// half needed none either, because a failed write showed the user a lie and
// waited for the next full load to correct it. They are tested here rather than
// through App.jsx because they are where "the flag goes back" and "the client
// snaps back" actually happen, and because an inverse that is not quite an
// inverse is the way this class of fix goes wrong.

import { describe, expect, it } from 'vitest';
import {
  addClient,
  addTimeOffRequest,
  adoptSavedClient,
  removeClient,
  removeCoverageEntry,
  removeTimeOffRequest,
  replaceCoverageForRequest,
  restoreClient,
  updateTimeOffRequest,
  upsertCoverageEntry,
} from './crmStateStore.js';

function desk() {
  return {
    accountManager: { id: 'cam-1', name: 'Priya' },
    camProfiles: [
      { id: 'cam-1', name: 'Priya', clientIds: ['client-a', 'client-b'], clientOrder: ['client-b', 'client-a'] },
      { id: 'cam-2', name: 'Rowan', clientIds: [] },
    ],
    clients: [
      { id: 'client-a', name: 'Craig', accountRegistry: {}, activityLog: [], tasks: [], dailyImports: [] },
      { id: 'client-b', name: 'Dana', accountRegistry: {}, activityLog: [], tasks: [], dailyImports: [] },
    ],
    timeOff: [{ id: 'to-1', camProfileId: 'cam-1', status: 'Pending', startDate: '2026-09-01' }],
    coverage: [{ id: 'cov-1', timeOffId: 'to-1', clientId: 'client-a', coveringCamId: 'cam-2' }],
    selectedClientId: 'client-a',
  };
}

describe('addClient with a caller-supplied id', () => {
  it('uses the id it was given so the write can find its own placeholder', () => {
    // Without this the only handle on the row just added was "the client whose
    // name matches and was not there a moment ago", which is why the old code
    // re-read the whole database to learn one uuid.
    const next = addClient(desk(), 'Ola', 'cam-1', { id: 'pending-1' });
    expect(next.clients.at(-1).id).toBe('pending-1');
  });

  it('still generates one when none is given', () => {
    const next = addClient(desk(), 'Ola', 'cam-1');
    expect(next.clients.at(-1).id).toMatch(/^client/);
  });

  it('refuses a blank name rather than adding an unnamed placeholder', () => {
    const state = desk();
    expect(addClient(state, '   ', 'cam-1', { id: 'pending-1' })).toBe(state);
  });
});

describe('adoptSavedClient', () => {
  const saved = { id: 'client-real', uuid: 'e5f6a7b8-1111-4222-8333-444455556666', name: 'Ola' };

  it('swaps the placeholder for the saved row, keeping what was typed into it', () => {
    const withPlaceholder = addClient(desk(), 'Ola', 'cam-1', { id: 'pending-1' });
    const next = adoptSavedClient(withPlaceholder, 'pending-1', saved);
    const client = next.clients.find((c) => c.id === 'client-real');
    expect(client).toBeTruthy();
    expect(client.accountRegistry).toEqual({});
    expect(next.clients.some((c) => c.id === 'pending-1')).toBe(false);
  });

  it('moves the id in clientIds, in clientOrder and in the selection', () => {
    // A stale id left in clientOrder drops the client out of the sidebar's
    // ordered list silently — it renders from the order, not from clients.
    let state = addClient(desk(), 'Ola', 'cam-1', { id: 'pending-1' });
    state = {
      ...state,
      camProfiles: state.camProfiles.map((p) => (
        p.id === 'cam-1' ? { ...p, clientOrder: [...p.clientOrder, 'pending-1'] } : p
      )),
      selectedClientId: 'pending-1',
    };
    const next = adoptSavedClient(state, 'pending-1', saved);
    const cam = next.camProfiles.find((p) => p.id === 'cam-1');
    expect(cam.clientIds).toContain('client-real');
    expect(cam.clientIds).not.toContain('pending-1');
    expect(cam.clientOrder).toContain('client-real');
    expect(cam.clientOrder).not.toContain('pending-1');
    expect(next.selectedClientId).toBe('client-real');
  });

  it('leaves the state alone when the write returned nothing', () => {
    // Supabase helpers return null when the project is not configured. Adopting
    // null would delete the placeholder the user is looking at.
    const state = addClient(desk(), 'Ola', 'cam-1', { id: 'pending-1' });
    expect(adoptSavedClient(state, 'pending-1', null)).toBe(state);
    expect(adoptSavedClient(state, null, saved)).toBe(state);
  });
});

describe('restoreClient undoes removeClient', () => {
  it('puts the client, its CAM link and the selection back', () => {
    const before = desk();
    const after = removeClient(before, 'client-a');
    expect(after.clients.some((c) => c.id === 'client-a')).toBe(false);
    expect(after.selectedClientId).toBe('client-b');

    const restored = restoreClient(after, before.clients[0], {
      index: 0,
      camProfileIds: ['cam-1'],
      selectedClientId: 'client-a',
    });
    expect(restored.clients.map((c) => c.id)).toEqual(['client-a', 'client-b']);
    expect(restored.camProfiles[0].clientIds).toContain('client-a');
    expect(restored.selectedClientId).toBe('client-a');
  });

  it('puts it back where it was, not at the end', () => {
    // The sidebar falls back to `clients` order for a CAM with no saved
    // clientOrder, so a client that reappears at the bottom reads as a
    // different bug than the one that was just undone.
    const before = desk();
    const after = removeClient(before, 'client-a');
    const restored = restoreClient(after, before.clients[0], { index: 0, camProfileIds: ['cam-1'] });
    expect(restored.clients[0].id).toBe('client-a');
  });

  it('does not duplicate a client that is somehow still there', () => {
    const state = desk();
    const restored = restoreClient(state, state.clients[0], { index: 0, camProfileIds: ['cam-1'] });
    expect(restored.clients.filter((c) => c.id === 'client-a')).toHaveLength(1);
    expect(restored.camProfiles[0].clientIds.filter((id) => id === 'client-a')).toHaveLength(1);
  });

  it('gives the client back only to the CAMs that had it', () => {
    const before = desk();
    const after = removeClient(before, 'client-a');
    const restored = restoreClient(after, before.clients[0], { index: 0, camProfileIds: ['cam-1'] });
    expect(restored.camProfiles.find((p) => p.id === 'cam-2').clientIds).toEqual([]);
  });

  it('ignores a client with no id rather than inserting a nameless row', () => {
    const state = desk();
    expect(restoreClient(state, null)).toBe(state);
    expect(restoreClient(state, {})).toBe(state);
  });
});

describe('time-off requests', () => {
  it('adds a request the insert returned', () => {
    const next = addTimeOffRequest(desk(), { id: 'to-2', camProfileId: 'cam-2', status: 'Pending' });
    expect(next.timeOff).toHaveLength(2);
    expect(next.timeOff.at(-1).id).toBe('to-2');
  });

  it('does not add the same request twice', () => {
    // The list is keyed by id, so a retried save must replace rather than
    // stack a second copy of the same request onto the manager's queue.
    const once = addTimeOffRequest(desk(), { id: 'to-1', camProfileId: 'cam-1', status: 'Pending' });
    const twice = addTimeOffRequest(once, { id: 'to-1', camProfileId: 'cam-1', status: 'Pending' });
    expect(twice.timeOff).toHaveLength(1);
  });

  it('ignores a row with no id', () => {
    const state = desk();
    expect(addTimeOffRequest(state, {})).toBe(state);
  });

  it('patches only the request named, and only the keys given', () => {
    const next = updateTimeOffRequest(desk(), 'to-1', { status: 'Approved' });
    expect(next.timeOff[0]).toEqual({
      id: 'to-1', camProfileId: 'cam-1', status: 'Approved', startDate: '2026-09-01',
    });
  });

  it('is its own inverse, so a refused approval reads as Pending again', () => {
    const approved = updateTimeOffRequest(desk(), 'to-1', { status: 'Approved' });
    const reverted = updateTimeOffRequest(approved, 'to-1', { status: 'Pending' });
    expect(reverted.timeOff[0].status).toBe('Pending');
  });

  it('removes a request by id', () => {
    expect(removeTimeOffRequest(desk(), 'to-1').timeOff).toEqual([]);
  });
});

describe('coverage', () => {
  it('replaces every row for one request rather than appending', () => {
    // The write it mirrors deletes every client_coverage row carrying the
    // time_off_id and re-inserts, so re-distributing a cover must not
    // accumulate here either.
    const next = replaceCoverageForRequest(desk(), 'to-1', [
      { id: 'cov-2', timeOffId: 'to-1', clientId: 'client-b', coveringCamId: 'cam-2' },
    ]);
    expect(next.coverage.map((row) => row.id)).toEqual(['cov-2']);
  });

  it('leaves other requests\' covers alone', () => {
    const state = {
      ...desk(),
      coverage: [
        { id: 'cov-1', timeOffId: 'to-1', clientId: 'client-a', coveringCamId: 'cam-2' },
        { id: 'cov-9', timeOffId: 'to-9', clientId: 'client-b', coveringCamId: 'cam-2' },
      ],
    };
    const next = replaceCoverageForRequest(state, 'to-1', []);
    expect(next.coverage.map((row) => row.id)).toEqual(['cov-9']);
  });

  it('removes a cover outright with an empty list', () => {
    expect(replaceCoverageForRequest(desk(), 'to-1', []).coverage).toEqual([]);
  });

  it('upsertCoverageEntry is the exact inverse of removeCoverageEntry', () => {
    const before = desk();
    const ended = removeCoverageEntry(before, 'cov-1');
    expect(ended.coverage).toEqual([]);
    const restored = upsertCoverageEntry(ended, before.coverage[0]);
    expect(restored.coverage).toEqual(before.coverage);
  });

  it('does not cover the client twice when a rollback runs twice', () => {
    const before = desk();
    const once = upsertCoverageEntry(before, before.coverage[0]);
    const twice = upsertCoverageEntry(once, before.coverage[0]);
    expect(twice.coverage).toHaveLength(1);
  });

  it('ignores an entry with no id', () => {
    const state = desk();
    expect(upsertCoverageEntry(state, {})).toBe(state);
  });
});
