import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../apiLib/http.js';
import {
  MAX_ACCOUNTS,
  config,
  createAccountSampleStore,
  createHandler,
  normalizeAccountSampleBody as normalizeImpl,
} from '../../../autoCollection/ingest/accounts.js';

const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const REFERENCE_NOW = new Date('2026-10-05T15:00:00Z');

function normalize(value, options = {}) {
  return normalizeImpl(value, { now: REFERENCE_NOW, ...options });
}

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(status) { this.statusCode = status; return this; },
    json(body) { this.body = body; return this; },
  };
}

/* What the agent will serialise. Newtonsoft writes a DateTimeOffset with seven
 * fractional digits and a +00:00 rather than a Z, and a null as null rather than
 * leaving the key out, which is why both forms appear below. */
function account(overrides = {}) {
  return {
    accountName: 'APEX-1',
    connectionName: 'Rithmic',
    connected: true,
    status: 'Connected',
    realizedPnl: 412.5,
    unrealizedPnl: -120,
    totalPnl: 292.5,
    strategyCount: 3,
    enabledStrategyCount: 2,
    ...overrides,
  };
}

function body(overrides = {}) {
  return {
    schemaVersion: 1,
    sampledAt: '2026-10-05T14:50:09.1234567+00:00',
    accounts: [
      account(),
      account({
        accountName: 'APEX-2',
        connected: false,
        status: 'Disconnected',
        connectionName: null,
        realizedPnl: null,
        unrealizedPnl: null,
        totalPnl: null,
        strategyCount: null,
        enabledStrategyCount: null,
      }),
    ],
    ...overrides,
  };
}

function setup({ authenticateImpl, recordImpl, now = () => REFERENCE_NOW } = {}) {
  const calls = { authenticate: [], record: [], createClient: 0 };
  const admin = {};
  const store = {
    async recordSample(payload) {
      calls.record.push(payload);
      if (recordImpl) return recordImpl(payload);
      return {
        deviceId: DEVICE_ID,
        recorded: payload.accounts.length,
        removed: 0,
        throttled: false,
        sampleIntervalSeconds: 600,
      };
    },
  };
  const handler = createHandler({
    createClient: () => { calls.createClient += 1; return admin; },
    createAuthStore: () => ({}),
    createStore: () => store,
    authenticate: async (req, deps) => {
      calls.authenticate.push({ req, deps });
      if (authenticateImpl) return authenticateImpl(req, deps);
      return {
        id: DEVICE_ID,
        clientId: CLIENT_ID,
        status: 'active',
        revokedAt: null,
        scheduleTime: '16:30:00',
        scheduleTimezone: 'America/New_York',
      };
    },
    pepper: 'test-pepper',
    now,
  });
  return { handler, calls };
}

function request(payload, { method = 'POST' } = {}) {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) };
}

describe('the account sample body', () => {
  it('takes the sample the agent sends, with nulls kept as nulls', () => {
    const normalized = normalize(body());
    expect(normalized.sampledAt).toBe('2026-10-05T14:50:09.1234567+00:00');
    expect(normalized.accounts).toHaveLength(2);
    expect(normalized.accounts[0]).toEqual({
      accountName: 'APEX-1',
      connectionName: 'Rithmic',
      connected: true,
      status: 'Connected',
      realizedPnl: 412.5,
      unrealizedPnl: -120,
      totalPnl: 292.5,
      strategyCount: 3,
      enabledStrategyCount: 2,
    });
    /* NULL IS NOT ZERO. An account that reported no P&L must not arrive as
     * "$0 today": that is a confident number about something nobody measured,
     * and it is the exact failure src/domain/liveAccounts.js exists to stop. */
    expect(normalized.accounts[1].totalPnl).toBeNull();
    expect(normalized.accounts[1].strategyCount).toBeNull();
    expect(normalized.accounts[1].connected).toBe(false);
  });

  it('REFUSES the close capture fields, rather than ignoring them', () => {
    /* Pedro asked for the least data possible, and the close already stores all
     * of this. Ignoring an unknown key would let an agent quietly start posting
     * the whole AutoExportSnapshot here and nobody would notice until the table
     * was the size of the close. */
    for (const key of [
      'netLiquidation', 'cashValue', 'weeklyPnl', 'trailingMaxDrawdown',
      'buyingPower', 'grossRealizedPnl', 'accountValues', 'currency', 'displayName',
      'initialMargin', 'maintenanceMargin', 'excessIntradayMargin',
    ]) {
      expect(() => normalize(body({ accounts: [account({ [key]: 1 })] })), `${key} was accepted`)
        .toThrow(ApiError);
    }
    // And on the envelope.
    expect(() => normalize({ ...body(), orders: [] })).toThrow(ApiError);
    expect(() => normalize({ ...body(), executions: [] })).toThrow(ApiError);
    expect(() => normalize({ ...body(), strategies: [] })).toThrow(ApiError);
  });

  it('refuses a prototype-polluted object at both levels', () => {
    const polluted = JSON.parse('{"schemaVersion":1,"sampledAt":"2026-10-05T14:50:00Z","accounts":[],"__proto__":{"x":1}}');
    expect(() => normalize(polluted)).toThrow(ApiError);
    expect(() => normalize(body({ accounts: [Object.create({ accountName: 'A' })] }))).toThrow(ApiError);
  });

  it('refuses a sample with no connected flag, because that is the traffic light', () => {
    expect(() => normalize(body({ accounts: [{ ...account(), connected: undefined }] }))).toThrow(ApiError);
    const { connected, ...withoutFlag } = account();
    expect(connected).toBe(true);
    expect(() => normalize(body({ accounts: [withoutFlag] }))).toThrow(ApiError);
    for (const value of ['true', 1, 0, null]) {
      expect(() => normalize(body({ accounts: [account({ connected: value })] })), `${value} was accepted`)
        .toThrow(ApiError);
    }
  });

  it('refuses a NaN, an Infinity and an absurd money value', () => {
    // JSON cannot carry NaN, but a hand-rolled or a non-JSON body can reach here
    // as a JS object, and one NaN turns a client's whole live total into NaN.
    for (const value of [Number.NaN, Infinity, -Infinity, 1e13, -1e13, '412.5']) {
      expect(() => normalize(body({ accounts: [account({ totalPnl: value })] })), `${value} was accepted`)
        .toThrow(ApiError);
    }
    expect(() => normalize(body({ accounts: [account({ realizedPnl: Number.NaN })] }))).toThrow(ApiError);
  });

  it('refuses half a strategy count, and an enabled count above the total', () => {
    expect(() => normalize(body({ accounts: [account({ enabledStrategyCount: null })] }))).toThrow(ApiError);
    expect(() => normalize(body({ accounts: [account({ strategyCount: null })] }))).toThrow(ApiError);
    expect(() => normalize(body({ accounts: [account({ strategyCount: 2, enabledStrategyCount: 3 })] })))
      .toThrow(ApiError);
    expect(() => normalize(body({ accounts: [account({ strategyCount: -1, enabledStrategyCount: 0 })] })))
      .toThrow(ApiError);
    expect(() => normalize(body({ accounts: [account({ strategyCount: 1.5, enabledStrategyCount: 1 })] })))
      .toThrow(ApiError);
    // Both absent is the ordinary case for an agent that cannot read strategies.
    expect(normalize(body({ accounts: [account({ strategyCount: null, enabledStrategyCount: null })] }))
      .accounts[0].strategyCount).toBeNull();
  });

  it('refuses free text in the status word but accepts one it has not met', () => {
    expect(() => normalize(body({ accounts: [account({ status: '<script>x</script>' })] }))).toThrow(ApiError);
    expect(() => normalize(body({ accounts: [account({ status: 'x'.repeat(40) })] }))).toThrow(ApiError);
    expect(() => normalize(body({ accounts: [account({ status: '' })] }))).toThrow(ApiError);
    /* An unknown word is a newer NinjaTrader, and the desk still needs every
     * other account in the sample. Refusing the report for one word is the
     * heartbeat's trap, which this route deliberately does not repeat. */
    expect(normalize(body({ accounts: [account({ status: 'ConnectionLostReconnecting' })] }))
      .accounts[0].status).toBe('ConnectionLostReconnecting');
    expect(normalize(body({ accounts: [account({ status: null })] })).accounts[0].status).toBeNull();
  });

  it('refuses an untrimmed, empty or overlong account name', () => {
    for (const name of ['', ' APEX-1', 'APEX-1 ', '  ', 'x'.repeat(65), 42, null]) {
      expect(() => normalize(body({ accounts: [account({ accountName: name })] })), `"${name}" was accepted`)
        .toThrow(ApiError);
    }
  });

  it('refuses the same account twice, because an account has one name', () => {
    expect(() => normalize(body({ accounts: [account(), account()] }))).toThrow(ApiError);
  });

  it('refuses a sample from the future, and allows five minutes of clock skew', () => {
    expect(() => normalize(body({ sampledAt: '2026-10-05T15:06:00Z' }))).toThrow(ApiError);
    expect(normalize(body({ sampledAt: '2026-10-05T15:04:00Z' })).sampledAt).toBe('2026-10-05T15:04:00Z');
    for (const value of ['2026-10-05', '2026-13-05T14:00:00Z', '2026-02-30T14:00:00Z', 'yesterday', null, 1_759_000_000]) {
      expect(() => normalize(body({ sampledAt: value })), `${value} was accepted`).toThrow(ApiError);
    }
  });

  it('refuses a schema version it has not met, and a missing one', () => {
    expect(() => normalize(body({ schemaVersion: 2 }))).toThrow(ApiError);
    expect(() => normalize(body({ schemaVersion: '1' }))).toThrow(ApiError);
    const { schemaVersion, ...withoutVersion } = body();
    expect(schemaVersion).toBe(1);
    expect(() => normalize(withoutVersion)).toThrow(ApiError);
  });

  it('bounds the sample at a number of accounts a terminal could hold', () => {
    const many = (n) => Array.from({ length: n }, (_, i) => account({ accountName: `A-${i}` }));
    expect(normalize(body({ accounts: many(MAX_ACCOUNTS) })).accounts).toHaveLength(MAX_ACCOUNTS);
    expect(() => normalize(body({ accounts: many(MAX_ACCOUNTS + 1) }))).toThrow(ApiError);
    // An empty sample is legal: a machine whose NinjaTrader holds no account
    // reports that, and it is not the same as a machine that did not report.
    expect(normalize(body({ accounts: [] })).accounts).toEqual([]);
  });

  it('answers every refusal with one public code and never a reason', () => {
    try {
      normalize(body({ accounts: [account({ totalPnl: Number.NaN })] }));
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error.status).toBe(400);
      expect(error.message).toBe('invalid_account_sample');
    }
  });
});

describe('the handler', () => {
  it('declares the body parser off, the way every ingest route does', () => {
    expect(config).toEqual({ api: { bodyParser: false } });
  });

  it('authenticates the device and records the sample under its id', async () => {
    const { handler, calls } = setup();
    const res = response();
    await handler(request(body()), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, recorded: 2, throttled: false, sampleIntervalSeconds: 600 });
    expect(calls.authenticate).toHaveLength(1);
    // The device id comes from the credential, never from the body: there is no
    // deviceId key in SAMPLE_KEYS and an agent cannot name another machine.
    expect(calls.record[0].deviceId).toBe(DEVICE_ID);
    expect(calls.record[0].accounts).toHaveLength(2);
  });

  it('refuses anything but POST', async () => {
    const { handler } = setup();
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      const res = response();
      await handler(request(body(), { method }), res);
      expect(res.statusCode).toBe(405);
    }
  });

  it('answers 401 when the credential does not resolve, and reads no body first', async () => {
    const { handler, calls } = setup({
      authenticateImpl: () => { throw new ApiError(401, 'Invalid device credential.'); },
    });
    const res = response();
    await handler(request(body()), res);
    expect(res.statusCode).toBe(401);
    expect(calls.record).toEqual([]);
  });

  it('answers 404 when step 55 has not run yet, which is what makes it harmless', async () => {
    /* The agent treats a 404 here exactly as it treats a CRM with no such route
     * at all: one line, one attempt later, nothing marked on the device. So the
     * deploy and the migration can land in either order with no error on a VPS,
     * and this half of the work is safe to merge on its own. */
    for (const error of [
      { code: 'PGRST202', message: 'Could not find the function public.record_account_live_sample' },
      { code: '42883', message: 'function public.record_account_live_sample(uuid, timestamptz, jsonb) does not exist' },
      { code: '42P01', message: 'relation "public.account_live_samples" does not exist' },
    ]) {
      const admin = { rpc: async () => ({ data: null, error }) };
      const store = createAccountSampleStore(admin);
      await expect(store.recordSample({ deviceId: DEVICE_ID, sampledAt: '2026-10-05T14:50:00Z', accounts: [] }))
        .rejects.toMatchObject({ status: 404, message: 'not_found' });
    }
  });

  it('maps the function\'s two refusals the way the quarantine route maps its own', async () => {
    const malformed = { rpc: async () => ({ data: null, error: { code: '22023', message: 'INVALID_ACCOUNT_SAMPLE' } }) };
    await expect(createAccountSampleStore(malformed)
      .recordSample({ deviceId: DEVICE_ID, sampledAt: '2026-10-05T14:50:00Z', accounts: [] }))
      .rejects.toMatchObject({ status: 400, message: 'invalid_account_sample' });

    const inactive = { rpc: async () => ({ data: null, error: { code: 'P0001', message: 'INVALID_INGEST_DEVICE' } }) };
    await expect(createAccountSampleStore(inactive)
      .recordSample({ deviceId: DEVICE_ID, sampledAt: '2026-10-05T14:50:00Z', accounts: [] }))
      .rejects.toMatchObject({ status: 401, message: 'invalid_device_credential' });
  });

  it('passes the throttle and the retuned interval back to the agent', async () => {
    /* The only CRM-to-agent channel this route has, and the reason the fleet's
     * cadence is retunable from the SQL editor rather than from an environment
     * variable Pedro cannot set. */
    const admin = {
      rpc: async () => ({
        data: {
          device_id: DEVICE_ID, recorded: 0, removed: 0, throttled: true, sample_interval_seconds: 900,
        },
        error: null,
      }),
    };
    const result = await createAccountSampleStore(admin)
      .recordSample({ deviceId: DEVICE_ID, sampledAt: '2026-10-05T14:50:00Z', accounts: [] });
    expect(result).toMatchObject({ throttled: true, recorded: 0, sampleIntervalSeconds: 900 });
  });

  it('never reports an interval of zero, whatever an older function returns', async () => {
    // A zero honoured as truth is a machine sampling flat out against live prop
    // firm accounts. The column default stands in instead.
    for (const value of [0, -600, null, undefined, '900', 1.5]) {
      const admin = {
        rpc: async () => ({
          data: { device_id: DEVICE_ID, recorded: 1, removed: 0, throttled: false, sample_interval_seconds: value },
          error: null,
        }),
      };
      const result = await createAccountSampleStore(admin)
        .recordSample({ deviceId: DEVICE_ID, sampledAt: '2026-10-05T14:50:00Z', accounts: [] });
      expect(result.sampleIntervalSeconds, `${value} was honoured`).toBe(600);
    }
  });

  it('answers 503 and not 500 when something unexpected breaks', async () => {
    const { handler } = setup({ recordImpl: () => { throw new Error('socket hang up'); } });
    const res = response();
    await handler(request(body()), res);
    expect(res.statusCode).toBe(503);
    // `cause` is handleApiError's own addition for an error the client is not
    // allowed to see; the message the agent reads is still the one public code.
    expect(res.body.error).toBe('account_sample_unavailable');
    expect(res.body).not.toHaveProperty('message');
    expect(JSON.stringify(res.body)).not.toContain('socket hang up');
  });

  it('answers 400 for a body that is not JSON and 413 for one that is too large', async () => {
    const { handler } = setup();
    const bad = response();
    await handler({ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }, bad);
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toEqual({ error: 'invalid_account_sample' });

    const huge = response();
    await handler({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, sampledAt: '2026-10-05T14:50:00Z', accounts: [], pad: 'x'.repeat(200_000) }),
    }, huge);
    expect([400, 413]).toContain(huge.statusCode);
    expect(huge.body).toEqual({ error: 'invalid_account_sample' });
  });

  it('says nothing about the heartbeat, in either direction', async () => {
    const source = await import('node:fs').then(({ readFileSync }) => readFileSync(
      new URL('../../../autoCollection/ingest/accounts.js', import.meta.url), 'utf8',
    ));
    /* The whole reason this is its own route. An error code written onto the
     * device would paint the machine "Failed" on the fleet view for a tracker
     * hiccup while its daily close was working perfectly - both codes a sample
     * would naturally produce are inside the heartbeat's accepted set. */
    expect(source).not.toMatch(/record_ingest_heartbeat|last_error_code|health_status/);
    expect(source).not.toMatch(/from '\.\/heartbeat\.js'/);
  });
});
