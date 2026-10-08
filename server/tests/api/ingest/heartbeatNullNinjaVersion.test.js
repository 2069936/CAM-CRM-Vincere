import { Buffer } from 'node:buffer';
import { describe, it, expect, vi } from 'vitest';
import { createHandler, createHeartbeatStore, normalizeHeartbeatBody } from '../../../autoCollection/ingest/heartbeat.js';

/* THE DEADLOCK THIS UNDOES.
 *
 * ninjaTraderVersion was validated as a required version string, and the agent
 * does not know that version until the add-on has told it. So a machine that
 * had not completed a capture sent null, the heartbeat was refused as malformed
 * with a 400, and because ninjatrader_version is only ever written BY a
 * heartbeat, the device could never acquire the value that would let its
 * heartbeats be accepted.
 *
 * Observed on the desk: four devices paired across three days, every one with
 * ninjatrader_version NULL, health_status 'pending', last_seen_at frozen at the
 * second it paired, and nine captured snapshots waiting on disk. */

const body = (over = {}) => ({
  agentVersion: '1.0.2',
  addonVersion: '1.0.0',
  ninjaTraderVersion: null,
  lastCaptureAt: null,
  lastSuccessAt: null,
  lastErrorCode: null,
  lastErrorMessage: null,
  queueDepth: 9,
  queueBytes: 23481,
  addonAvailable: true,
  ...over,
});

describe('a collector that does not know its NinjaTrader version yet', () => {
  it('is accepted, because not knowing yet is what a new install looks like', () => {
    expect(normalizeHeartbeatBody(body())).toMatchObject({
      agentVersion: '1.0.2',
      ninjaTraderVersion: null,
      queueDepth: 9,
    });
  });

  it.each([[null], [undefined], ['']], )('treats %p as not known rather than as malformed', (value) => {
    expect(normalizeHeartbeatBody(body({ ninjaTraderVersion: value })).ninjaTraderVersion).toBeNull();
  });

  it('treats whitespace as not known too', () => {
    expect(normalizeHeartbeatBody(body({ ninjaTraderVersion: '   ' })).ninjaTraderVersion).toBeNull();
  });

  it('still records the version once the add-on reports one', () => {
    expect(normalizeHeartbeatBody(body({ ninjaTraderVersion: '8.1.5.2' })).ninjaTraderVersion).toBe('8.1.5.2');
  });

  it('still rejects a NinjaTrader version that is not a version', () => {
    // Relaxing null must not relax the string itself. This column is displayed.
    for (const bad of ['not-a-version', '8.1.5.2-beta', '<script>', '1'.repeat(40)]) {
      expect(() => normalizeHeartbeatBody(body({ ninjaTraderVersion: bad }))).toThrow();
    }
  });
});

/* THE SAME NULL, ONE LAYER DOWN.
 *
 * Relaxing the route was half the fix. The RPC record_ingest_heartbeat still
 * refused `p_ninjatrader_version is null` (step 41), and the route turned that
 * refusal into the same 400, so the deadlock the comment above describes simply
 * moved into the database. Step 63 relaxes the RPC. This proves the route's half
 * end to end: a body with ninjaTraderVersion null, through the real handler and
 * the real store, reaches the RPC with p_ninjatrader_version null and nothing
 * else invented in its place. If the route ever substituted a default here, the
 * database would store a version nobody is running. */
describe('a null NinjaTrader version travels to the RPC as null', () => {
  const DEVICE_ID = '33333333-3333-4333-8333-333333333333';

  function request(payload) {
    const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
    return {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(bytes.length) },
      async *[Symbol.asyncIterator]() { yield bytes; },
    };
  }

  function res() {
    const sent = {};
    return {
      sent,
      setHeader(name, value) { (sent.headers ||= {})[name] = value; },
      status(code) { sent.status = code; return this; },
      json(body) { sent.json = body; return this; },
      end() {},
    };
  }

  it('through the real handler and the real store, p_ninjatrader_version is null and the heartbeat is 200', async () => {
    const rpc = vi.fn(async () => ({
      data: [{
        device_id: DEVICE_ID,
        health_status: 'online',
        throttled: false,
        schedule_time: '16:45:00',
        schedule_timezone: 'America/New_York',
      }],
      error: null,
    }));
    const handler = createHandler({
      createClient: () => ({ rpc }),
      createAuthStore: () => ({}),
      authenticate: async () => ({ id: DEVICE_ID, clientId: 'client-1' }),
      createStore: createHeartbeatStore,
      pepper: 'test-pepper',
      minimumAgentVersion: '1.2.0',
      minIntervalSeconds: 30,
      reportEmailSecret: '',
      reportEmailUrl: '',
    });

    const target = res();
    await handler(request(body({ agentVersion: '1.2.0', ninjaTraderVersion: null })), target);

    expect(target.sent.status).toBe(200);
    expect(target.sent.json).toMatchObject({ ok: true, deviceId: DEVICE_ID, status: 'online', updateRequired: false });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('record_ingest_heartbeat', {
      p_device_id: DEVICE_ID,
      p_agent_version: '1.2.0',
      p_addon_version: '1.0.0',
      p_ninjatrader_version: null,
      p_last_capture_at: null,
      p_last_success_at: null,
      p_last_error_code: null,
      p_last_error_message: null,
      p_queue_depth: 9,
      p_queue_bytes: 23481,
      p_addon_available: true,
      p_health_status: 'online',
      p_min_interval_seconds: 30,
    });
    // Null in the call, not in a string: the RPC's regex would refuse 'null'.
    expect(rpc.mock.calls[0][1].p_ninjatrader_version).toBeNull();
  });

  it('an empty string and whitespace from an older serializer travel as null too', async () => {
    for (const value of ['', '   ']) {
      const rpc = vi.fn(async () => ({
        data: [{ device_id: DEVICE_ID, health_status: 'online', throttled: false, schedule_time: '16:45:00', schedule_timezone: 'America/New_York' }],
        error: null,
      }));
      const handler = createHandler({
        createClient: () => ({ rpc }),
        createAuthStore: () => ({}),
        authenticate: async () => ({ id: DEVICE_ID, clientId: 'client-1' }),
        createStore: createHeartbeatStore,
        pepper: 'test-pepper',
        minimumAgentVersion: '1.2.0',
        minIntervalSeconds: 30,
        reportEmailSecret: '',
        reportEmailUrl: '',
      });
      const target = res();
      await handler(request(body({ agentVersion: '1.2.0', ninjaTraderVersion: value })), target);
      expect(target.sent.status).toBe(200);
      expect(rpc.mock.calls[0][1].p_ninjatrader_version).toBeNull();
    }
  });

  it('the database refusing that null still surfaces as the 400 the agent logs as heartbeat_failed', async () => {
    // What production does today, before step 63 runs: the shape the eight
    // silent machines are seeing every minute.
    const rpc = vi.fn(async () => ({ data: null, error: { code: '22023', message: 'INVALID_HEARTBEAT_REQUEST' } }));
    const handler = createHandler({
      createClient: () => ({ rpc }),
      createAuthStore: () => ({}),
      authenticate: async () => ({ id: DEVICE_ID, clientId: 'client-1' }),
      createStore: createHeartbeatStore,
      pepper: 'test-pepper',
      minimumAgentVersion: '1.2.0',
      minIntervalSeconds: 30,
      reportEmailSecret: '',
      reportEmailUrl: '',
    });
    const target = res();
    await handler(request(body({ agentVersion: '1.2.0', ninjaTraderVersion: null })), target);
    expect(target.sent.status).toBe(400);
    expect(target.sent.json).toEqual({ error: 'invalid_heartbeat' });
    expect(rpc.mock.calls[0][1].p_ninjatrader_version).toBeNull();
  });
});

describe('what stays required', () => {
  it('still demands the agent and add-on versions, which the agent always knows', () => {
    expect(() => normalizeHeartbeatBody(body({ agentVersion: null }))).toThrow();
    expect(() => normalizeHeartbeatBody(body({ addonVersion: null }))).toThrow();
    expect(() => normalizeHeartbeatBody(body({ agentVersion: 'nope' }))).toThrow();
  });

  it('still refuses a body carrying a key it does not know', () => {
    expect(() => normalizeHeartbeatBody({ ...body(), schemaVersion: 1 })).toThrow();
  });
});

/* The heartbeat endpoint hid its failures the same way the upload one did.
 *
 * Four devices have been refused since 31 August. The agent version, add-on
 * version and NinjaTrader version it sends are all valid literals, the VPS clock
 * is exactly in step with the server, and the RPC signature matches what the
 * code calls. Four theories, none of them survived. The endpoint is going to
 * have to say it itself. */

describe('a heartbeat that fails for a reason nobody has guessed', () => {
  // The endpoint reads the raw body off the stream, so the request has to be
  // one, not an object with a `body` on it.
  function request(payload) {
    const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
    return {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(bytes.length) },
      async *[Symbol.asyncIterator]() { yield bytes; },
    };
  }

  function res() {
    const sent = {};
    return {
      sent,
      setHeader(name, value) { (sent.headers ||= {})[name] = value; },
      status(code) { sent.status = code; return this; },
      json(body) { sent.json = body; return this; },
      end() {},
    };
  }

  it('reports the real error and names its cause, instead of a bare 500', async () => {
    const reported = [];
    const handler = createHandler({
      createClient: () => ({}),
      authenticate: async () => ({ id: 'device-1', clientId: 'client-1' }),
      createStore: () => ({
        recordHeartbeat: async () => {
          throw Object.assign(new Error('permission denied for function record_ingest_heartbeat'), { code: '42501' });
        },
      }),
      report: (error) => reported.push(error),
    });

    const target = res();
    await handler(request({
        agentVersion: '1.0.2',
        addonVersion: '1.0.0',
        ninjaTraderVersion: '8.1.0',
        lastCaptureAt: null,
        lastSuccessAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        queueDepth: 9,
        queueBytes: 23481,
        addonAvailable: true,
    }), target);

    expect(target.sent.status).toBe(500);
    expect(target.sent.json.error).toBe('heartbeat_unavailable');
    expect(target.sent.json.cause).toBe('server_permission_denied');
  });
});
