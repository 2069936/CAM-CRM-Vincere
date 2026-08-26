// The sidebar's working list, checked against public/local-snapshot.json — the
// real redacted book.
//
// The book has NO Inactive client today (Active 95, Paused 1 once
// buildCrmStateFromTables has dropped the soft-deleted rows; 132/3/1/0 across
// Active/Onboarding/Paused/Inactive in the raw table). That is exactly why the
// bug survived: nothing in the fixture exercises the branch, so a test written
// only against it would pass on the broken sidebar too.
//
// So this file does both halves. First it pins that the change is a no-op on
// today's data — every client the CAM works today still appears, in order, and
// no "Former clients" section can appear at all. Then it marks a real client
// Inactive, the way a CAM does from the Client stage selector, and pins that
// exactly that one moves and nothing else does.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCrmStateFromTables } from './supabaseStore';
import { partitionSidebarClients } from './clientLifecycle';

const snapshot = JSON.parse(
  readFileSync(new URL('../../public/local-snapshot.json', import.meta.url), 'utf8'),
);
const { clients } = buildCrmStateFromTables(snapshot.tables);

function stageCounts(book) {
  const counts = {};
  for (const client of book) {
    const stage = client.profile?.stage || '(none)';
    counts[stage] = (counts[stage] || 0) + 1;
  }
  return counts;
}

describe('the sidebar working list on the real book', () => {
  it('starts from a book with no Inactive client, which is why the fixture alone cannot prove this', () => {
    expect(stageCounts(clients)).toEqual({ Active: 95, Paused: 1 });
  });

  it('leaves every client of the real book in the working list', () => {
    const { working, former } = partitionSidebarClients(clients);
    expect(working).toHaveLength(96);
    expect(former).toHaveLength(0);
    // Order untouched: the caller has already applied the CAM's drag order or
    // the urgency sort, and a reshuffled sidebar is its own bug report.
    expect(working.map((c) => c.id)).toEqual(clients.map((c) => c.id));
  });

  it('moves only the client a CAM actually marked Inactive', () => {
    // The stage selector (src/App.jsx, "Client stage") writes profile.stage on
    // one client. Nothing else about them changes — same accounts, same closes,
    // same CAM — so nothing else about the list may change either.
    const churned = clients[7];
    const book = clients.map((client) =>
      client.id === churned.id
        ? { ...client, profile: { ...client.profile, stage: 'Inactive' } }
        : client,
    );

    const { working, former } = partitionSidebarClients(book);
    expect(former.map((c) => c.id)).toEqual([churned.id]);
    expect(working).toHaveLength(95);
    expect(working.some((c) => c.id === churned.id)).toBe(false);
    // Still reachable, and still the same client — not a stub, not a name in a
    // list. A CAM opens a former client precisely to pull their history.
    expect(former[0].name).toBe(churned.name);
    expect(former[0].dailyImports).toBe(churned.dailyImports);
    expect(Object.keys(former[0].accountRegistry || {})).toEqual(
      Object.keys(churned.accountRegistry || {}),
    );
    // Everyone else keeps their position.
    expect(working.map((c) => c.id)).toEqual(
      clients.filter((c) => c.id !== churned.id).map((c) => c.id),
    );
  });

  it('keeps the one Paused client of the book in the working list', () => {
    const paused = clients.filter((c) => c.profile?.stage === 'Paused');
    expect(paused).toHaveLength(1);
    const { working, former } = partitionSidebarClients(paused);
    expect(working).toHaveLength(1);
    expect(former).toHaveLength(0);
  });
});
