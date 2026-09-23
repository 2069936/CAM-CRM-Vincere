import { describe, expect, it } from 'vitest';
import {
  MISSED_GRACE_MINUTES,
  PAIRING_GRACE_MS,
  COLLECTOR_FLAG_TAB,
  collectorFlagBadge,
  collectorFlags,
} from './collectorFlags.js';

/* Both of these were knowable on every request and shown on neither surface a
 * CAM opens: the agent's version because it only ever reached the fleet screen,
 * and the empty capture because the client card has never read a batch at all.
 * Derived, never stored, so there is nothing to acknowledge away. */
const NOW = '2026-09-23T21:00:00Z'; // 17:00 New York, Wednesday
const LONG_AGO = '2026-01-04T12:00:00Z';

function status(overrides = {}) {
  return {
    release: { version: '1.0.8' },
    device: {
      id: 'device-1',
      status: 'active',
      healthStatus: 'online',
      agentVersion: '1.0.8',
      revokedAt: null,
      createdAt: LONG_AGO,
      lastSeenAt: NOW,
      schedule: { time: '16:30:00', timezone: 'America/New_York' },
    },
    lastBatch: {
      tradingDate: '2026-09-23',
      status: 'processed',
      receivedAt: NOW,
      rowCounts: { accounts: 5, strategies: 7, orders: 12, executions: 4 },
    },
    ...overrides,
  };
}

function ids(value, now = NOW) {
  return collectorFlags(value, now).map((flag) => flag.id);
}

describe('collector flags', () => {
  it('says nothing when the VPS is current and collecting', () => {
    expect(ids(status())).toEqual([]);
    expect(collectorFlagBadge([])).toBeNull();
  });

  it('raises the agent version the CRM has always known and never shown here', () => {
    const flags = collectorFlags(status({ device: { ...status().device, agentVersion: '1.0.5' } }), NOW);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ id: 'agent_out_of_date', severity: 'warning', tab: COLLECTOR_FLAG_TAB });
    expect(flags[0].detail).toContain('1.0.5');
    expect(flags[0].detail).toContain('1.0.8');
  });

  it('does not ask anyone to downgrade a machine ahead of the release', () => {
    expect(ids(status({ device: { ...status().device, agentVersion: '1.1.0' } }))).toEqual([]);
  });

  it('says nothing about a version it does not know', () => {
    expect(ids(status({ release: null }))).toEqual([]);
    expect(ids(status({ device: { ...status().device, agentVersion: null } }))).toEqual([]);
  });

  it('raises a capture that carried no accounts, which the Connected light cannot see', () => {
    // 11 of 79 clients on 2026-09-22. The VPS was checking in every minute.
    const flags = collectorFlags(status({
      lastBatch: { ...status().lastBatch, rowCounts: { accounts: 0, strategies: 7, orders: 0, executions: 0 } },
    }), NOW);
    expect(flags[0]).toMatchObject({ id: 'collecting_nothing', severity: 'alert' });
    expect(flags[0].detail).toMatch(/NinjaTrader/);
  });

  it('raises a missed capture once the window has really passed', () => {
    const yesterday = { ...status().lastBatch, tradingDate: '2026-09-22' };
    // 16:30 plus the grace. Before it, nothing; after it, the alert.
    const early = `2026-09-23T${String(20 + Math.floor((30 + MISSED_GRACE_MINUTES - 10) / 60)).padStart(2, '0')}:00:00Z`;
    expect(ids(status({ lastBatch: yesterday }), early)).toEqual([]);
    expect(ids(status({ lastBatch: yesterday }), '2026-09-23T22:00:00Z')).toEqual(['missed_today']);
  });

  it('does not raise a missed capture at the weekend', () => {
    const yesterday = { ...status().lastBatch, tradingDate: '2026-09-25' };
    // 2026-09-26 is a Saturday and 2026-09-27 a Sunday, New York.
    expect(ids(status({ lastBatch: yesterday }), '2026-09-26T22:00:00Z')).toEqual([]);
    expect(ids(status({ lastBatch: yesterday }), '2026-09-27T22:00:00Z')).toEqual([]);
  });

  it('never says the same thing twice', () => {
    // Collected nothing yesterday and nothing today is one problem, not two.
    const flags = collectorFlags(status({
      lastBatch: { tradingDate: '2026-09-22', status: 'processed', rowCounts: { accounts: 0 } },
    }), '2026-09-23T22:00:00Z');
    expect(flags.map((flag) => flag.id)).toEqual(['collecting_nothing']);
  });

  it('leaves a freshly paired VPS alone, on the screen used to confirm the install', () => {
    const justPaired = { ...status().device, createdAt: '2026-09-23T20:00:00Z' };
    expect(ids(status({ device: justPaired, lastBatch: null }), NOW)).toEqual([]);
    // But the version is still worth saying: it is true the moment it pairs.
    expect(ids(status({
      device: { ...justPaired, agentVersion: '1.0.5' }, lastBatch: null,
    }), NOW)).toEqual(['agent_out_of_date']);
    // And once the grace has run out AND a capture window has passed, the
    // silence ends. The grace alone expires at 04:00 New York on the Friday,
    // which is long before anything is due that day, so the first moment this
    // can speak is after that day's 16:30.
    const graceEnds = Date.parse('2026-09-23T20:00:00Z') + PAIRING_GRACE_MS;
    expect(ids(status({ device: justPaired, lastBatch: null }), new Date(graceEnds + 1000).toISOString()))
      .toEqual([]);
    expect(ids(status({ device: justPaired, lastBatch: null }), '2026-09-25T22:00:00Z'))
      .toEqual(['missed_today']);
  });

  it('says nothing about a client with no VPS, or one deliberately revoked', () => {
    expect(ids(status({ device: null }))).toEqual([]);
    expect(ids(status({ device: { ...status().device, revokedAt: NOW, agentVersion: '1.0.1' } }))).toEqual([]);
  });

  it('puts what stopped the collection ahead of what is merely old', () => {
    const flags = collectorFlags(status({
      device: { ...status().device, agentVersion: '1.0.5' },
      lastBatch: { ...status().lastBatch, rowCounts: { accounts: 0 } },
    }), NOW);
    expect(flags.map((flag) => flag.id)).toEqual(['collecting_nothing', 'agent_out_of_date']);
    expect(collectorFlagBadge(flags)).toMatchObject({
      severity: 'alert', count: 2, tab: COLLECTOR_FLAG_TAB,
    });
    expect(collectorFlagBadge(flags).label).toBe('Collected nothing on the last capture +1');
  });

  it('survives a status body with pieces missing', () => {
    for (const value of [null, undefined, {}, { device: {} }, { device: { id: 'd' } }]) {
      expect(() => collectorFlags(value, NOW)).not.toThrow();
    }
    expect(ids({ device: { id: 'd', schedule: {} }, lastBatch: { rowCounts: {} } })).toEqual([]);
  });
});
