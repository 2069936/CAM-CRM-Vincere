// The book-backed half of camFlagQueue's suite.
//
// Split out for one reason: it reads public/local-snapshot.json, so
// vite.config.js drops it on every clone that does not hold the export. A test
// that only runs here is not a test CI can hold anyone to, and the synthetic
// half of this suite was being dropped alongside it for no reason at all. The
// rules live in camFlagQueue.test.js, which runs everywhere; the NUMBERS
// live here, where the book is.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCamFlagQueue, flagResolutionPlan, isFlagOpen } from './camFlagQueue';
import { buildCrmStateFromTables } from './supabaseStore';

const TODAY = '2026-08-11';

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

