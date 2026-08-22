// The desk-wide deviation alerts, measured on the real book.
//
// The manager's consolidated view now renders buildCamOverview over every
// client. The rules — one producer, one row component, the per-CAM panel stays —
// are pinned in src/components/DeviationAlertList.test.jsx, which needs no book
// and runs everywhere. The NUMBERS live here, where the book is, because the one
// thing a synthetic fixture cannot show is how far the desk figure sits from the
// eight CAM figures it will be read against.
//
// That gap is the reason the manager's panel carries a reconciliation sentence
// instead of a bare count. A peer group is every account running the same
// algorithm and version IN THE BOOK BEING LOOKED AT, so widening from one CAM to
// the desk moves the mean and the 1.5-sigma threshold under it. The desk list is
// a different question, not a bigger copy of theirs, and a manager who has just
// been told "12" by a CAM has to be able to see that in writing.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCamOverview } from './camOverview';
import { effectiveClientIds } from './camCoverage';
import { buildCrmStateFromTables } from './supabaseStore';

// The day the manager's page is pinned to when nothing is pinned — the same
// fallback clientsForCam uses in App.jsx.
const TODAY = '2026-08-11';

describe('the real book (public/local-snapshot.json, closes 2026-07-13 → 2026-07-30)', () => {
  const snapshot = JSON.parse(
    readFileSync(new URL('../../public/local-snapshot.json', import.meta.url), 'utf8'),
  );
  const state = buildCrmStateFromTables(snapshot.tables);
  const clientById = Object.fromEntries(state.clients.map((client) => [client.id, client]));
  // Scoped exactly as the screens scope it: clientsForCam in App.jsx resolves a
  // CAM's book through effectiveClientIds, so a client on loan through coverage
  // counts for whoever is carrying it. state.coverage is empty on this export,
  // so this is the CAMs' own books today — but measuring it the other way would
  // stop being about the panel the first time somebody goes on leave.
  const camClients = (profile) => {
    const ids = effectiveClientIds(profile, state.coverage || [], TODAY);
    return state.clients.filter((client) => ids.has(client.id));
  };

  const desk = buildCamOverview(state.clients);
  const perCam = state.camProfiles.map((profile) => ({
    name: profile.name,
    overview: buildCamOverview(camClients(profile)),
  }));

  it('reads 74 alerts across the desk, of the two kinds the panel prints', () => {
    expect(desk.totals.openDeviationFlags).toBe(74);
    expect(desk.deviationFlags).toHaveLength(74);
    // Peer performance and execution drift are separate rules inside the same
    // function, and the panel's one sentence describes both. If either half
    // stops firing the total alone would not say which.
    const peer = desk.deviationFlags.filter((flag) => flag.executionMove === undefined);
    expect(peer).toHaveLength(36);
    expect(desk.deviationFlags.length - peer.length).toBe(38);
    expect(desk.totals.algorithms).toBe(16);
    expect(desk.totals.accounts).toBe(336);
  });

  it('is not the sum of the eight CAM lists, and the panel says so with these numbers', () => {
    // The exact figures the reconciliation sentence is written around. If the
    // threshold or the grouping changes, this fails and the sentence has to be
    // rewritten rather than left saying something that is no longer true.
    const camTotal = perCam.reduce((total, entry) => total + entry.overview.deviationFlags.length, 0);
    expect(perCam).toHaveLength(8);
    expect(camTotal).toBe(30);

    const deskIds = new Set(desk.deviationFlags.map((flag) => flag.id));
    const onBoth = perCam.reduce(
      (total, entry) => total + entry.overview.deviationFlags.filter((flag) => deskIds.has(flag.id)).length,
      0,
    );
    expect(onBoth).toBe(25);
    // 5 alerts a CAM sees that the desk does not, and 49 the desk sees that no
    // CAM's own page shows. Both directions are real: a narrower book can put an
    // account outside its peers that the wider book absorbs, and vice versa.
    expect(camTotal - onBoth).toBe(5);
    expect(desk.deviationFlags.length - onBoth).toBe(49);
  });

  it('names a client on every alert, so the manager can route all 74', () => {
    // The attribution the consolidated panel prints. A flag with no clientId
    // renders no CAM, which on 74 rows would be a silent hole rather than a
    // visible one.
    const byClient = {};
    for (const profile of state.camProfiles) {
      for (const clientId of profile.clientIds || []) byClient[clientId] = profile.name;
    }
    for (const flag of desk.deviationFlags) {
      expect(clientById[flag.clientId]).toBeTruthy();
      expect(byClient[flag.clientId]).toBeTruthy();
    }
    // All eight CAMs carry at least one, which is itself the point: this is a
    // desk-wide list and no CAM's page is a substitute for it.
    expect(new Set(desk.deviationFlags.map((flag) => byClient[flag.clientId])).size).toBe(8);
  });
});
