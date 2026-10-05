/* THE TRACKER HALF OF THE CLIENT CARD'S STATUS CALL.
 *
 * Why it is read here at all, rather than in the browser: the four states this
 * feature must keep apart - disconnected, the VPS cannot be reached, the
 * collector is too old to sample, nobody has ever sampled - need
 * `ingest_devices`, and step 28 shut that table to the browser key with a
 * restrictive denial. Three of the four are an ABSENT ROW in
 * account_live_samples and are indistinguishable without the device. This
 * endpoint already loads the device and already enforces the CAM's assignment,
 * and it is one invocation for the client workspace that is already being made.
 */

import { describe, expect, it, vi } from 'vitest';
import { createHandler, createIngestStatusStore } from '../../../autoCollection/admin/ingest-status.js';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_DEVICE_ID = '44444444-4444-4444-8444-444444444444';

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(status) { this.statusCode = status; return this; },
    json(body) { this.body = body; return this; },
  };
}

function sampleRow(overrides = {}) {
  return {
    device_id: DEVICE_ID,
    account_name: 'APEX-1',
    connection_name: 'Rithmic',
    connected: true,
    status: 'Connected',
    // PostgREST returns numeric as a string, which is the whole reason
    // numberOrNull exists rather than a Number() call.
    realized_pnl: '412.50',
    unrealized_pnl: '-120.00',
    total_pnl: '292.50',
    strategy_count: 3,
    enabled_strategy_count: 2,
    run_state: 'running',
    sampled_at: '2026-10-05T14:56:00.000Z',
    reported_at: '2026-10-05T14:56:02.000Z',
    ...overrides,
  };
}

function setup({ status } = {}) {
  const handler = createHandler({
    createClients: () => ({ admin: {}, auth: {} }),
    authorize: vi.fn(async () => ({ id: 'actor-1', role: 'CAM' })),
    enforceAssignment: vi.fn(async () => {}),
    createStore: () => ({
      load: vi.fn(async () => ({
        client: { id: CLIENT_ID, name: 'Gray Elm' },
        device: { id: DEVICE_ID, status: 'active', health_status: 'online', agent_version: '1.2.0' },
        enrollment: null,
        attempt: null,
        quarantine: [],
        batch: null,
        samples: [sampleRow()],
        settings: { stale_sample_seconds: 1500, sample_interval_seconds: 600, min_agent_version: '1.2.0' },
        ...status,
      })),
    }),
    env: {},
    fetchRelease: async () => { throw new Error('no release in this test'); },
    production: false,
    now: () => new Date('2026-10-05T15:00:00.000Z'),
  });
  return handler;
}

async function load(status) {
  const res = response();
  await setup({ status })(
    { method: 'GET', query: { clientUuid: CLIENT_ID }, headers: { authorization: 'Bearer session' } },
    res,
  );
  return res;
}

describe('the account tracker on the client status call', () => {
  it('returns the sample with its numbers parsed and nothing the close already stores', async () => {
    const res = await load();
    expect(res.statusCode).toBe(200);
    expect(res.body.accountTracker.accounts).toEqual([{
      accountName: 'APEX-1',
      connectionName: 'Rithmic',
      connected: true,
      status: 'Connected',
      realizedPnl: 412.5,
      unrealizedPnl: -120,
      totalPnl: 292.5,
      strategyCount: 3,
      enabledStrategyCount: 2,
      runState: 'running',
      sampledAt: '2026-10-05T14:56:00.000Z',
    }]);
    /* Pedro asked for the least data possible, and the close already holds all of
     * this. Asserted against the serialised body so a column added to the SELECT
     * later cannot ride out on this endpoint unnoticed. */
    const serialized = JSON.stringify(res.body.accountTracker);
    expect(serialized).not.toMatch(/netLiquidation|cashValue|weeklyPnl|trailingMaxDrawdown|buyingPower|accountValues|margin/i);
    // Not the device id either: nothing on the panel is actionable with it.
    expect(serialized).not.toContain(DEVICE_ID);
    expect(serialized).not.toContain('reportedAt');
  });

  it('carries the tuning, so the panel never holds a second copy of the numbers', async () => {
    const res = await load();
    expect(res.body.accountTracker).toMatchObject({
      staleSeconds: 1500,
      sampleIntervalSeconds: 600,
      minAgentVersion: '1.2.0',
      deviceHasSamples: true,
    });
  });

  it('falls back to the column defaults when the settings row is missing, never to zero', async () => {
    // A staleness horizon of zero would make every sample read silent the instant
    // it landed, which is the worst reading this screen can give.
    for (const settings of [null, {}, { stale_sample_seconds: 0, sample_interval_seconds: -1 }, { stale_sample_seconds: '1500' }]) {
      const res = await load({ settings });
      expect(res.body.accountTracker.staleSeconds).toBe(1500);
      expect(res.body.accountTracker.sampleIntervalSeconds).toBe(600);
    }
  });

  it('reports NO expected build rather than a garbage one', async () => {
    /* minAgentVersion NULL is the inert state: with no build named, no machine is
     * behind and the panel says the neutral true thing. A non-string must land on
     * null and not on something compareVersions would read as 0.0.0, which is
     * below every agent in the field. */
    for (const value of [null, '', 0, 7, {}, []]) {
      const res = await load({ settings: { stale_sample_seconds: 1500, min_agent_version: value } });
      expect(res.body.accountTracker.minAgentVersion, `${JSON.stringify(value)} leaked`).toBeNull();
    }
  });

  it('keeps a missing P&L null and never turns it into a zero', async () => {
    const res = await load({
      samples: [sampleRow({ realized_pnl: null, unrealized_pnl: '', total_pnl: undefined, strategy_count: null, enabled_strategy_count: null })],
    });
    expect(res.body.accountTracker.accounts[0]).toMatchObject({
      realizedPnl: null, unrealizedPnl: null, totalPnl: null, strategyCount: null, enabledStrategyCount: null,
    });
  });

  it('shows only this client\'s own device, the way the quarantine is narrowed', async () => {
    const res = await load({
      samples: [sampleRow(), sampleRow({ device_id: OTHER_DEVICE_ID, account_name: 'SOMEONE-ELSE' })],
    });
    expect(res.body.accountTracker.accounts.map((a) => a.accountName)).toEqual(['APEX-1']);
  });

  it('says deviceHasSamples false for a machine that has never sampled anything', async () => {
    /* The one derived fact the panel cannot work out for itself: it separates
     * "this VPS is sampling other accounts and has never sent this one" from
     * "this VPS has never sampled anything", and those are a different job each. */
    const res = await load({ samples: [] });
    expect(res.body.accountTracker.deviceHasSamples).toBe(false);
    expect(res.body.accountTracker.accounts).toEqual([]);
    // A machine that was never paired cannot have samples either.
    const noDevice = await load({ device: null, samples: [sampleRow()] });
    expect(noDevice.body.accountTracker.deviceHasSamples).toBe(false);
    expect(noDevice.body.accountTracker.accounts).toEqual([]);
  });

  it('is NULL, not empty, when step 55 has not run', async () => {
    /* The read swallows its own failure and returns null, and null has to reach
     * the panel as null: "the migration has not run" and "this VPS has sent
     * nothing" are a different sentence each, and an empty tracker would say the
     * second about the first. */
    const res = await load({ samples: null, settings: null });
    expect(res.body.accountTracker).toBeNull();
    expect(res.statusCode).toBe(200);
  });

  it('never fails the card over the tracker', async () => {
    /* The device and enrollment rows ARE the card. A tracker read that throws
     * must leave the page rendering, the same way the pairing audit, the
     * quarantine and the last batch do. */
    const throwing = {
      from: vi.fn((table) => {
        const query = {
          select() { return query; },
          eq() { return query; },
          order() { return query; },
          limit() { return query; },
          maybeSingle() { return query; },
          then(resolve, reject) {
            if (table === 'account_live_samples' || table === 'account_tracker_settings') {
              return Promise.reject(new Error('relation does not exist')).then(resolve, reject);
            }
            if (table === 'clients') return Promise.resolve({ data: { id: CLIENT_ID, name: 'Gray Elm' }, error: null }).then(resolve, reject);
            return Promise.resolve({ data: null, error: null }).then(resolve, reject);
          },
        };
        return query;
      }),
    };
    await expect(createIngestStatusStore(throwing).load(CLIENT_ID)).resolves.toMatchObject({
      client: { id: CLIENT_ID },
      samples: null,
      settings: null,
    });
  });

  it('asks for the tracker columns and for none of the close capture ones', async () => {
    const selected = [];
    const admin = {
      from: vi.fn((table) => {
        const query = {
          select(columns) { selected.push([table, columns]); return query; },
          eq() { return query; },
          order() { return query; },
          limit() { return query; },
          maybeSingle() { return query; },
          then(resolve, reject) {
            const data = table === 'clients' ? { id: CLIENT_ID, name: 'Gray Elm' } : null;
            return Promise.resolve({ data, error: null }).then(resolve, reject);
          },
        };
        return query;
      }),
    };
    await createIngestStatusStore(admin).load(CLIENT_ID);
    const sampleColumns = selected.find(([table]) => table === 'account_live_samples')?.[1] || '';
    expect(sampleColumns).toContain('run_state');
    expect(sampleColumns).toContain('sampled_at');
    expect(sampleColumns).toContain('connected');
    expect(sampleColumns).not.toMatch(/net_liquidation|cash_value|weekly_pnl|trailing_max_drawdown|buying_power|account_values|margin|client_id/);
    expect(selected.find(([table]) => table === 'account_tracker_settings')?.[1])
      .toBe('stale_sample_seconds,sample_interval_seconds,min_agent_version');
  });
});
