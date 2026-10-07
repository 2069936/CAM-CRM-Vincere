// The revenue panel, fed the way the app feeds it.
//
// revenueHealth.js reads client.subscriptionPrice, client.createdAt and
// client.deletedAt at the TOP LEVEL of each client. revenueHealth.test.js hands
// it clients already shaped that way, so it passes whatever the store does.
// What it never checked is the store: buildCrmStateFromTables is the one
// mapping a login and a local snapshot both go through, and it put the tier
// only inside `profile` and never mapped the two dates. The panel then read
// "Total MRR $0 ... 10 of 10 clients have no tier set" over a book where every
// row had a tier. The earlier fix mapped the three fields in
// createSupabaseClient, which only shapes a client created in this session.
//
// The second half is the edit. The client form sends `{ profile }` and
// updateClientDetails merges it shallowly, so without a mirror the panel keeps
// the tier the client had at login until the next full load.
//
// Synthetic throughout: no book, so CI runs every line.

import { describe, expect, it } from 'vitest';
import { buildCrmStateFromTables } from './supabaseStore';
import { revenueLeakage, revenueSnapshot } from './revenueHealth';
import { addClient, updateClientDetails } from './crmStateStore';

const row = (over) => ({ status: 'Active', stage: 'Active', deleted_at: null, ...over });

const tables = () => ({
  clients: [
    row({ id: 'u1', legacy_key: 'c1', name: 'Alder', subscription_price: '$500', created_at: '2026-06-01T14:00:00.000Z' }),
    row({ id: 'u2', legacy_key: 'c2', name: 'Birch', subscription_price: '$250', created_at: '2026-07-01T14:00:00.000Z' }),
    row({ id: 'u3', legacy_key: 'c3', name: 'Cedar', subscription_price: 'Free', created_at: '2026-08-01T14:00:00.000Z' }),
    row({ id: 'u4', legacy_key: 'c4', name: 'Dogwood', subscription_price: null, created_at: '2026-09-01T14:00:00.000Z' }),
    // Deleted. The store drops it before mapping, so it must not reach the
    // panel as a live $500.
    row({
      id: 'u5', legacy_key: 'c5', name: 'Elm', subscription_price: '$500',
      created_at: '2026-05-01T14:00:00.000Z', deleted_at: '2026-09-15T10:00:00.000Z',
    }),
  ],
});

const loaded = () => buildCrmStateFromTables(tables());
const byId = (state, id) => state.clients.find((client) => client.id === id);

describe('the revenue panel over a state built from tables', () => {
  it('sees the tier each row carries, not Undetermined for everyone', () => {
    expect(revenueSnapshot(loaded().clients)).toMatchObject({
      activeClients: 4,
      mrr: 750,
      priced: 3,
      unpriced: 1,
      paying: 2,
      byTier: { $500: 1, $250: 1, Free: 1, Undetermined: 1 },
    });
  });

  it('ages a free client from the date the row was created', () => {
    const leakage = revenueLeakage(loaded().clients, { asOf: '2026-09-08' });
    expect(leakage).toMatchObject({ freeClients: 1, convertible: 1, potentialMrr: 375, undated: 0 });
    expect(leakage.aging).toEqual([
      { id: 'c3', name: 'Cedar', since: '2026-08-01T14:00:00.000Z', days: 37 },
    ]);
  });

  it('puts the three fields at the top level and keeps the profile copy for the form', () => {
    for (const client of loaded().clients) {
      expect(client.subscriptionPrice).toBe(client.profile.subscriptionPrice);
      expect(client.deletedAt).toBeNull();
    }
    expect(byId(loaded(), 'c1')).toMatchObject({
      subscriptionPrice: '$500',
      createdAt: '2026-06-01T14:00:00.000Z',
      profile: { subscriptionPrice: '$500' },
    });
  });

  it('normalizes a missing or unknown tier the same way at both levels', () => {
    const state = buildCrmStateFromTables({
      clients: [row({ id: 'u9', legacy_key: 'c9', name: 'Fir', subscription_price: 'premium' })],
    });
    expect(state.clients[0].subscriptionPrice).toBe('Undetermined');
    expect(state.clients[0].profile.subscriptionPrice).toBe('Undetermined');
    // No created_at on the row reads as empty, which revenueLeakage reports as
    // undated rather than as a client free since today.
    expect(state.clients[0].createdAt).toBe('');
  });
});

describe('a tier edited in the client form', () => {
  // What CredentialsTab's updateProfile hands onUpdateClient: the whole
  // profile, one field changed.
  const editTier = (state, id, subscriptionPrice) => updateClientDetails(state, id, {
    profile: { ...byId(state, id).profile, subscriptionPrice },
  });

  it('moves the panel on the same render, not at the next login', () => {
    const next = editTier(loaded(), 'c4', '$500');
    expect(byId(next, 'c4').subscriptionPrice).toBe('$500');
    expect(byId(next, 'c4').profile.subscriptionPrice).toBe('$500');
    expect(revenueSnapshot(next.clients)).toMatchObject({ mrr: 1250, priced: 4, unpriced: 0 });
  });

  it('takes revenue away as readily as it adds it', () => {
    const next = editTier(loaded(), 'c1', 'Free');
    expect(revenueSnapshot(next.clients)).toMatchObject({ mrr: 250, paying: 1 });
    expect(revenueLeakage(next.clients, { asOf: '2026-09-08' }).freeClients).toBe(2);
  });

  it('leaves the tier alone when a profile edit does not carry one', () => {
    // A placeholder from addClient starts with an empty profile and no tier,
    // and the stage edit that follows it must not invent one.
    const state = addClient(loaded(), 'Ginkgo', null, { id: 'pending-1' });
    const next = updateClientDetails(state, 'pending-1', { profile: { stage: 'Onboarding' } });
    expect(byId(next, 'pending-1')).not.toHaveProperty('subscriptionPrice');
    // And an unrelated top level edit on a priced client keeps its tier.
    const pinned = updateClientDetails(loaded(), 'c2', { pinned: true });
    expect(byId(pinned, 'c2').subscriptionPrice).toBe('$250');
  });
});
