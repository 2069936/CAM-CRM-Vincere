import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../apiLib/http.js';
import {
  MAX_STRATEGIES,
  ROW_KEYS,
  config,
  createHandler,
  createStrategySampleStore,
} from '../../../autoCollection/ingest/strategies.js';

const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const REFERENCE_NOW = new Date('2026-10-06T14:10:30Z');

/* THE SHARED FIXTURE, byte for byte as the wire contract states it. The agent
 * half serialises StrategySampleV1 and compares against this same JSON, so a
 * name that drifts on either side fails a test on that side. */
const FIXTURE = `{
  "schemaVersion": 1,
  "sampledAt": "2026-10-06T10:10:02.5-04:00",
  "strategies": [
    { "accountName": "SIM-FIXTURE-1", "strategyId": "123456789", "strategyName": "0 - OGX-PF-2.4", "instrument": "MNQ 12-26", "realizedPnl": -412.5, "unrealizedPnl": 37.5, "restartedAt": null },
    { "accountName": "SIM-FIXTURE-1", "strategyId": "123456790", "strategyName": "1 - ALPHA-1.2", "instrument": "NQ 12-26", "realizedPnl": null, "unrealizedPnl": null, "restartedAt": "2026-10-06T09:50:01-04:00" }
  ]
}`;

function fixture() {
  return JSON.parse(FIXTURE);
}

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(status) { this.statusCode = status; return this; },
    json(body) { this.body = body; return this; },
  };
}

function request(payload, { method = 'POST' } = {}) {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  };
}

/* A fake service client that records what reached the RPC, so the tests assert
 * on the payload SQL would see rather than on an intermediate object. */
function setup({ rpcImpl, authenticateImpl } = {}) {
  const calls = { rpc: [] };
  const admin = {
    async rpc(name, args) {
      calls.rpc.push({ name, args });
      if (rpcImpl) return rpcImpl(name, args);
      return {
        data: { recorded: args.p_strategies.length, throttled: false, cycleStart: '2026-10-06T10:10:00-04:00' },
        error: null,
      };
    },
  };
  const handler = createHandler({
    createClient: () => admin,
    createAuthStore: () => ({}),
    authenticate: async (req, deps) => {
      if (authenticateImpl) return authenticateImpl(req, deps);
      return { id: DEVICE_ID, clientId: CLIENT_ID, status: 'active', revokedAt: null };
    },
    pepper: 'test-pepper',
    now: () => REFERENCE_NOW,
  });
  return { handler, calls };
}

async function post(payload, options) {
  const { handler, calls } = setup(options);
  const res = response();
  await handler(request(payload, options), res);
  return { res, calls };
}

describe('POST /api/ingest/strategies', () => {
  it('declares the body parser off, the way every ingest route does', () => {
    expect(config).toEqual({ api: { bodyParser: false } });
  });

  it('accepts the contract fixture and answers the exact reply shape', async () => {
    const { res, calls } = await post(FIXTURE);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      recorded: 2,
      throttled: false,
      cycleStart: '2026-10-06T14:10:00.000Z',
      skipped: 0,
    });
    expect(calls.rpc).toHaveLength(1);
    expect(calls.rpc[0].name).toBe('record_algorithm_live_sample');
    expect(calls.rpc[0].args.p_device_id).toBe(DEVICE_ID);
    expect(calls.rpc[0].args.p_sampled_at).toBe('2026-10-06T10:10:02.5-04:00');
  });

  it('derives the algorithm by the product rule and the root, and keeps null as null', async () => {
    const { calls } = await post(FIXTURE);
    const [ogx, alpha] = calls.rpc[0].args.p_strategies;
    // familyFromStrategyName keeps the PF build apart: OGX_PF, not OGX-PF.
    expect(ogx).toMatchObject({ algorithm: 'OGX_PF', instrumentRoot: 'MNQ', realizedPnl: -412.5, unrealizedPnl: 37.5 });
    expect(alpha).toMatchObject({ algorithm: 'ALPHA', instrumentRoot: 'NQ', realizedPnl: null, unrealizedPnl: null });
    expect(alpha.restartedAt).toBe('2026-10-06T09:50:01-04:00');
  });

  it('IGNORES unknown keys, top level and per row, and forwards exactly the contract keys', async () => {
    const body = fixture();
    body.agentBuild = '1.3.0';
    body.strategies[0].state = 'Realtime';
    body.strategies[0].commission = 4.2;
    const { res, calls } = await post(body);
    expect(res.statusCode).toBe(200);
    for (const row of calls.rpc[0].args.p_strategies) {
      expect(Object.keys(row).sort()).toEqual([...ROW_KEYS].sort());
    }
    expect(Object.keys(calls.rpc[0].args).sort()).toEqual(['p_device_id', 'p_sampled_at', 'p_strategies']);
    expect(ROW_KEYS).toEqual([
      'accountName', 'strategyId', 'strategyName', 'algorithm', 'instrument',
      'instrumentRoot', 'realizedPnl', 'unrealizedPnl', 'restartedAt',
    ]);
  });

  it('treats a missing P&L key as not measured, never zero', async () => {
    const body = fixture();
    delete body.strategies[0].realizedPnl;
    delete body.strategies[0].unrealizedPnl;
    delete body.strategies[0].restartedAt;
    const { calls } = await post(body);
    expect(calls.rpc[0].args.p_strategies[0]).toMatchObject({ realizedPnl: null, unrealizedPnl: null, restartedAt: null });
  });

  it('trims the names before they reach SQL', async () => {
    const body = fixture();
    body.strategies[0].accountName = '  SIM-FIXTURE-1 ';
    const { calls } = await post(body);
    expect(calls.rpc[0].args.p_strategies[0].accountName).toBe('SIM-FIXTURE-1');
  });

  it('answers 401 when the credential does not resolve, and never calls the RPC', async () => {
    const { res, calls } = await post(FIXTURE, {
      authenticateImpl: () => { throw new ApiError(401, 'invalid_device_credential'); },
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_device_credential' });
    expect(calls.rpc).toEqual([]);
  });

  it('answers 405 to anything but POST', async () => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const { res } = await post(FIXTURE, { method });
      expect(res.statusCode).toBe(405);
    }
  });

  it('answers 413 over 128 KiB, and 400 for a body that is not JSON', async () => {
    const huge = fixture();
    huge.pad = 'x'.repeat(130 * 1024);
    const big = await post(huge);
    expect(big.res.statusCode).toBe(413);
    expect(big.res.body).toEqual({ error: 'strategy_sample_too_large' });

    const broken = await post('{');
    expect(broken.res.statusCode).toBe(400);
    expect(broken.res.body).toEqual({ error: 'invalid_strategy_sample' });
  });

  it('answers 400 unsupported_schema_version to any other version', async () => {
    for (const version of [2, 0, '1', null, undefined]) {
      const body = fixture();
      body.schemaVersion = version;
      const { res, calls } = await post(body);
      expect(res.statusCode, String(version)).toBe(400);
      expect(res.body).toEqual({ error: 'unsupported_schema_version' });
      expect(calls.rpc).toEqual([]);
    }
  });

  it('answers 400 to every malformed row, and calls nothing', async () => {
    const cases = [
      ['blank account', (row) => { row.accountName = '   '; }],
      ['long id', (row) => { row.strategyId = '9'.repeat(65); }],
      ['numeric id', (row) => { row.strategyId = 123456789; }],
      ['long name', (row) => { row.strategyName = `0 - ${'X'.repeat(200)}`; }],
      ['long instrument', (row) => { row.instrument = 'M'.repeat(65); }],
      ['string money', (row) => { row.realizedPnl = '12.5'; }],
      ['too large', (row) => { row.unrealizedPnl = 2e12; }],
      ['non finite', (row) => { row.realizedPnl = Number.POSITIVE_INFINITY; }],
      ['restart after the reading', (row) => { row.restartedAt = '2026-10-06T10:10:03-04:00'; }],
      ['restart a day before', (row) => { row.restartedAt = '2026-10-05T10:10:01-04:00'; }],
      ['restart without offset', (row) => { row.restartedAt = '2026-10-06T09:50:01'; }],
      ['row is an array', (row, body) => { body.strategies[0] = []; }],
    ];
    for (const [label, mutate] of cases) {
      const body = fixture();
      mutate(body.strategies[0], body);
      // Infinity does not survive JSON, so that case goes in as a parsed body.
      const payload = label === 'non finite' ? body : JSON.stringify(body);
      const { handler, calls } = setup();
      const res = response();
      await handler(typeof payload === 'string'
        ? request(payload)
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload }, res);
      expect(res.statusCode, label).toBe(400);
      expect(res.body, label).toEqual({ error: 'invalid_strategy_sample' });
      expect(calls.rpc, label).toEqual([]);
    }
  });

  it('answers 400 to a sampledAt without an offset or from the future', async () => {
    for (const sampledAt of ['2026-10-06T10:10:02', '2026-10-06T14:20:00Z', 'now']) {
      const body = fixture();
      body.sampledAt = sampledAt;
      const { res } = await post(body);
      expect(res.statusCode, sampledAt).toBe(400);
    }
  });

  it('answers 400 to the same instance twice in one post', async () => {
    const body = fixture();
    body.strategies[1].strategyId = body.strategies[0].strategyId;
    const { res, calls } = await post(body);
    expect(res.statusCode).toBe(400);
    expect(calls.rpc).toEqual([]);
  });

  it('answers 400 above the structural ceiling, and takes it exactly at the ceiling', async () => {
    // The P&L keys are left out (read as not measured) so 1,001 rows stay under
    // the 128 KiB body cap and the row ceiling is what answers.
    const many = (n) => Array.from({ length: n }, (_, i) => ({
      accountName: 'A', strategyId: String(i), strategyName: '0 - OGX-1.0', instrument: 'MNQ Z6',
    }));
    const over = await post({ schemaVersion: 1, sampledAt: '2026-10-06T10:10:02-04:00', strategies: many(MAX_STRATEGIES + 1) });
    expect(over.res.statusCode).toBe(400);
    const at = await post({ schemaVersion: 1, sampledAt: '2026-10-06T10:10:02-04:00', strategies: many(MAX_STRATEGIES) });
    expect(at.res.statusCode).toBe(200);
    expect(MAX_STRATEGIES).toBe(1000);
  });

  it('skips a row whose name yields no algorithm, counts it, and posts the rest', async () => {
    const body = fixture();
    body.strategies[1].strategyName = '0 - ';
    const { res, calls } = await post(body);
    expect(res.statusCode).toBe(200);
    expect(res.body.skipped).toBe(1);
    expect(calls.rpc[0].args.p_strategies).toHaveLength(1);
  });

  it('answers 200 with nothing recorded to an empty reading, without calling SQL', async () => {
    const { res, calls } = await post({ schemaVersion: 1, sampledAt: '2026-10-06T10:10:02-04:00', strategies: [] });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, recorded: 0, throttled: false, cycleStart: null, skipped: 0 });
    expect(calls.rpc).toEqual([]);
  });

  it('passes the throttle and an off cycle reading through', async () => {
    const throttled = await post(FIXTURE, {
      rpcImpl: () => ({ data: { recorded: 0, throttled: true, cycleStart: null }, error: null }),
    });
    expect(throttled.res.body).toEqual({ ok: true, recorded: 0, throttled: true, cycleStart: null, skipped: 0 });
  });

  it('answers 404 strategy_sample_not_deployed while migration 57 has not run', async () => {
    /* The agent reads 404 as "unsupported" and sets a STRATEGY ONLY silence of an
     * hour. A 503 here would be logged every cycle on every VPS until Pedro ran
     * the file, and the agent half would never back off. */
    for (const error of [
      { code: 'PGRST202', message: 'Could not find the function public.record_algorithm_live_sample' },
      { code: '42883', message: 'function public.record_algorithm_live_sample(uuid, timestamptz, jsonb) does not exist' },
      { code: '42P01', message: 'relation "public.algorithm_live_samples" does not exist' },
      { code: 'XX000', message: 'relation "public.algorithm_live_settings" does not exist' },
    ]) {
      const { res } = await post(FIXTURE, { rpcImpl: () => ({ data: null, error }) });
      expect(res.statusCode, error.code).toBe(404);
      expect(res.body).toEqual({ error: 'strategy_sample_not_deployed' });
    }
  });

  it('maps the function\'s two refusals to 400 and 401', async () => {
    const malformed = await post(FIXTURE, {
      rpcImpl: () => ({ data: null, error: { code: '22023', message: 'INVALID_STRATEGY_SAMPLE' } }),
    });
    expect(malformed.res.statusCode).toBe(400);
    expect(malformed.res.body).toEqual({ error: 'invalid_strategy_sample' });

    const inactive = await post(FIXTURE, {
      rpcImpl: () => ({ data: null, error: { code: 'P0001', message: 'INVALID_INGEST_DEVICE' } }),
    });
    expect(inactive.res.statusCode).toBe(401);
    expect(inactive.res.body).toEqual({ error: 'invalid_device_credential' });
  });

  it('answers 503 to any other database failure, without leaking it', async () => {
    for (const rpcImpl of [
      () => ({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }),
      () => { throw new Error('socket hang up'); },
      () => ({ data: { throttled: false }, error: null }),
    ]) {
      const { res } = await post(FIXTURE, { rpcImpl });
      expect(res.statusCode).toBe(503);
      expect(res.body.error).toBe('strategy_sample_unavailable');
      expect(JSON.stringify(res.body)).not.toContain('socket hang up');
    }
  });

  it('the store maps a missing RPC by itself, whoever calls it', async () => {
    const store = createStrategySampleStore({
      rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }),
    });
    await expect(store.recordSample({ deviceId: DEVICE_ID, sampledAt: 'x', strategies: [] }))
      .rejects.toMatchObject({ status: 404, message: 'strategy_sample_not_deployed' });
  });
});
