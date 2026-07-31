import { describe, expect, it, vi } from 'vitest';
import {
  assessIngestPersistence,
  createHandler,
  createVerificationStore,
  parseVerificationQuery,
} from './ingest-verify.js';
import { ApiError } from '../_lib/http.js';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const CAPTURE_ID = '33333333-3333-4333-8333-333333333333';
const BATCH_ID = '44444444-4444-4444-8444-444444444444';
const DAILY_ID = '55555555-5555-4555-8555-555555555555';

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function evidence(overrides = {}) {
  return {
    batch: {
      id: BATCH_ID,
      captureId: CAPTURE_ID,
      deviceId: DEVICE_ID,
      clientId: CLIENT_ID,
      tradingDate: '2026-07-23',
      dailyImportId: DAILY_ID,
      status: 'processed',
    },
    dailyImport: {
      id: DAILY_ID,
      clientId: CLIENT_ID,
      tradingDate: '2026-07-23',
      sourceType: 'automatic',
      sourceBatchId: BATCH_ID,
      sourceSummary: {
        accounts: 1, strategies: 1, orders: 1, executions: 1, flags: 2,
        pnl_sources: {
          realized: 0, gross_fallback: 1, gross_missing_realized: 0, unavailable: 0, unknown: 0,
        },
      },
    },
    normalizedCounts: { accounts: 1, strategies: 1, orders: 1, executions: 1, flags: 2 },
    duplicateClaimCount: 1,
    terminalAuditCount: 1,
    downloadAuditCount: 2,
    ...overrides,
  };
}

describe('collector persistence verification evidence', () => {
  it('accepts one exact automatic import with matching normalized rows and audit evidence', () => {
    expect(assessIngestPersistence(evidence())).toEqual({
      ok: true,
      failures: [],
      counts: { accounts: 1, strategies: 1, orders: 1, executions: 1, flags: 2 },
      expectedCounts: { accounts: 1, strategies: 1, orders: 1, executions: 1, flags: 2 },
      pnlSources: {
        realized: 0, gross_fallback: 1, gross_missing_realized: 0, unavailable: 0, unknown: 0,
      },
      duplicateClaimCount: 1,
      terminalAuditCount: 1,
      downloadAuditCount: 2,
    });
  });

  it('reports stable aggregate failures without returning row values or database details', () => {
    const result = assessIngestPersistence(evidence({
      dailyImport: {
        id: '66666666-6666-4666-8666-666666666666',
        clientId: '77777777-7777-4777-8777-777777777777',
        tradingDate: '2026-07-22',
        sourceType: 'manual',
        sourceBatchId: '88888888-8888-4888-8888-888888888888',
        sourceSummary: {
          accounts: 9, strategies: 1, orders: 1, executions: 1, flags: 2,
          pnl_sources: {
            realized: 9, gross_fallback: 0, gross_missing_realized: 0, unavailable: 0, unknown: 0,
          },
        },
        secretRowValue: 'must-not-leak',
      },
      normalizedCounts: { accounts: 0, strategies: 1, orders: 1, executions: 1, flags: 2 },
      duplicateClaimCount: 2,
      terminalAuditCount: 0,
      downloadAuditCount: 1,
    }));

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      'batch_daily_link_mismatch',
      'client_routing_mismatch',
      'download_audit_missing',
      'duplicate_capture_claim',
      'normalized_count_mismatch',
      'source_batch_mismatch',
      'source_type_mismatch',
      'terminal_audit_mismatch',
      'trading_date_mismatch',
    ]);
    expect(JSON.stringify(result)).not.toMatch(/must-not-leak|secretRowValue/);
  });

  it('treats missing persisted evidence as a stable failed verification', () => {
    expect(assessIngestPersistence(evidence({ dailyImport: null }))).toMatchObject({
      ok: false,
      failures: ['daily_import_missing'],
      expectedCounts: null,
      pnlSources: null,
    });
  });
});

describe('Manager collector persistence verification endpoint', () => {
  it('authorizes a Manager and verifies exactly one batch without exposing identifiers or internals', async () => {
    const verify = vi.fn(async () => evidence());
    const authorize = vi.fn(async () => ({ id: 'manager-1', role: 'Manager' }));
    const handler = createHandler({
      createClients: () => ({ admin: {}, auth: {} }),
      authorize,
      createStore: () => ({ verify }),
    });
    const res = response();
    await handler({ method: 'GET', query: { batchId: BATCH_ID } }, res);

    expect(authorize).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ roles: ['Manager'] }));
    expect(verify).toHaveBeenCalledWith(BATCH_ID);
    expect(res).toMatchObject({ statusCode: 200, body: { ok: true, failures: [], counts: { accounts: 1, flags: 2 } } });
    expect(res.headers['Cache-Control']).toBe('private, no-store');
    expect(JSON.stringify(res.body)).not.toMatch(new RegExp(`${CLIENT_ID}|${DEVICE_ID}|${CAPTURE_ID}|${BATCH_ID}|${DAILY_ID}`));
  });

  it('returns a stable 404 only after Manager authorization when the exact batch is absent', async () => {
    const verify = vi.fn(async () => null);
    const authorize = vi.fn(async () => ({ role: 'Manager' }));
    const handler = createHandler({
      createClients: () => ({ admin: {}, auth: {} }), authorize,
      createStore: () => ({ verify }),
    });
    const res = response();
    await handler({ method: 'GET', query: { batchId: BATCH_ID } }, res);
    expect(res).toMatchObject({ statusCode: 404, body: { error: 'batch_not_found' } });
  });

  it('does not parse or query before Manager authorization succeeds', async () => {
    const verify = vi.fn();
    const handler = createHandler({
      createClients: () => ({ admin: {}, auth: {} }),
      authorize: async () => { throw new ApiError(403, 'Manager permission required.'); },
      createStore: () => ({ verify }),
    });
    const res = response();
    await handler({ method: 'GET', query: { batchId: 'invalid' } }, res);
    expect(res).toMatchObject({ statusCode: 403, body: { error: 'Manager permission required.' } });
    expect(verify).not.toHaveBeenCalled();
  });

  it.each([
    [{}, 'invalid_batch_id'],
    [{ batchId: 'invalid' }, 'invalid_batch_id'],
    [{ batchId: [BATCH_ID] }, 'invalid_batch_id'],
  ])('rejects an invalid exact identifier %#', (query, error) => {
    expect(() => parseVerificationQuery(query)).toThrow(error);
  });

  it('maps dependency failures to one stable error without leaking details', async () => {
    const handler = createHandler({
      createClients: () => ({ admin: {}, auth: {} }),
      authorize: async () => ({ role: 'Manager' }),
      createStore: () => ({ verify: async () => { throw new Error('database credential'); } }),
    });
    const res = response();
    await handler({ method: 'GET', query: { batchId: BATCH_ID } }, res);
    expect(res).toMatchObject({ statusCode: 500, body: { error: 'ingest_verification_failed' } });
    expect(JSON.stringify(res.body)).not.toContain('database credential');
  });

  it('rejects non-GET methods before authorization', async () => {
    const authorize = vi.fn();
    const handler = createHandler({
      createClients: () => ({ admin: {}, auth: {} }), authorize,
      createStore: () => ({ verify: vi.fn() }),
    });
    const res = response();
    await handler({ method: 'POST', query: { batchId: BATCH_ID } }, res);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe('GET');
    expect(authorize).not.toHaveBeenCalled();
  });
});

describe('collector persistence verification Supabase adapter', () => {
  it('loads only the exact linked import and counts every normalized and audit table', async () => {
    const calls = [];
    const rows = {
      ingest_batches: {
        id: BATCH_ID, capture_id: CAPTURE_ID, device_id: DEVICE_ID, client_id: CLIENT_ID,
        trading_date: '2026-07-23', daily_import_id: DAILY_ID, status: 'processed',
      },
      daily_imports: {
        id: DAILY_ID, client_id: CLIENT_ID, trading_date: '2026-07-23',
        source_type: 'automatic', source_batch_id: BATCH_ID,
        source_summary: {
          accounts: 1, strategies: 1, orders: 1, executions: 1, flags: 2,
          pnl_sources: {
            realized: 0, gross_fallback: 1, gross_missing_realized: 0, unavailable: 0, unknown: 0,
          },
        },
      },
    };
    const counts = {
      account_snapshots: 1,
      strategy_snapshots: 1,
      orders: 1,
      executions: 1,
      operational_flags: 2,
      ingest_batches: 1,
      'audit_logs:terminal': 1,
      'audit_logs:download': 2,
    };

    function builder(table) {
      const state = { table, filters: [], mode: 'rows', auditKind: null };
      const query = {
        select(columns, options) {
          calls.push(['select', table, columns, options]);
          if (options?.head) state.mode = 'count';
          return this;
        },
        eq(column, value) {
          calls.push(['eq', table, column, value]);
          state.filters.push([column, value]);
          if (table === 'audit_logs' && column === 'action' && value === 'ingest_batch_downloaded') state.auditKind = 'download';
          return this;
        },
        in(column, values) {
          calls.push(['in', table, column, values]);
          if (table === 'audit_logs' && column === 'action') state.auditKind = 'terminal';
          return this;
        },
        maybeSingle() { return Promise.resolve({ data: rows[table] || null, error: null }); },
        then(resolve) {
          const key = table === 'audit_logs' ? `${table}:${state.auditKind}` : table;
          return Promise.resolve({ data: null, count: counts[key], error: null }).then(resolve);
        },
      };
      return query;
    }

    const store = createVerificationStore({ from: vi.fn((table) => builder(table)) });
    expect(await store.verify(BATCH_ID)).toEqual(evidence());
    expect(calls).toContainEqual(['eq', 'daily_imports', 'id', DAILY_ID]);
    expect(calls).toContainEqual(['eq', 'account_snapshots', 'daily_import_id', DAILY_ID]);
    expect(calls).toContainEqual(['eq', 'operational_flags', 'daily_import_id', DAILY_ID]);
    expect(calls).toContainEqual(['eq', 'ingest_batches', 'device_id', DEVICE_ID]);
    expect(calls).toContainEqual(['eq', 'ingest_batches', 'capture_id', CAPTURE_ID]);
    expect(calls).toContainEqual(['eq', 'audit_logs', 'entity_id', BATCH_ID]);
    expect(calls).toContainEqual(['eq', 'audit_logs', 'action', 'ingest_batch_downloaded']);
  });
});
