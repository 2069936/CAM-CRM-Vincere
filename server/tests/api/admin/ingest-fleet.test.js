import { describe, expect, it, vi } from 'vitest';
import { createFleetStore, createHandler, parseFleetQuery } from '../../../autoCollection/admin/ingest-fleet.js';
import { ApiError } from '../../../apiLib/http.js';

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

describe('Manager collector fleet endpoint', () => {
  it('authorizes before parsing and returns a bounded server page', async () => {
    const list = vi.fn(async () => ({
      rows: [{ client: { uuid: '11111111-1111-4111-8111-111111111111', name: 'Acme' }, device: null, todayBatch: null }],
      summary: { total: 200, attention: 4 },
      total: 200,
    }));
    const authorize = vi.fn(async () => ({ role: 'Manager' }));
    const handler = createHandler({
      createClients: () => ({ admin: {}, auth: {} }), authorize,
      createStore: () => ({ list }), now: () => new Date('2026-07-23T21:00:00.000Z'),
    });
    const res = response();
    await handler({ method: 'GET', query: { page: '2', pageSize: '25', search: ' acme ' } }, res);
    expect(authorize).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ roles: ['Manager'] }));
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ page: 2, pageSize: 25, search: 'acme', tradingDate: '2026-07-23' }));
    expect(res).toMatchObject({ statusCode: 200, body: { page: 2, pageSize: 25, total: 200 } });
    expect(res.headers['Cache-Control']).toBe('private, no-store');
  });

  it('uses the same pinned release manifest version as the Profile status endpoint', async () => {
    const list = vi.fn(async () => ({ rows: [], summary: { total: 0 }, total: 0 }));
    const resolveRelease = vi.fn(async () => ({ version: '2.3.4' }));
    const env = { AUTO_COLLECTION_RELEASE_MANIFEST_URL: 'https://downloads.example.test/release-manifest.json' };
    const fetchRelease = vi.fn();
    const handler = createHandler({
      createClients: () => ({ admin: {}, auth: {} }),
      authorize: async () => ({ role: 'Manager' }),
      createStore: () => ({ list }),
      now: () => new Date('2026-07-23T21:00:00.000Z'),
      resolveRelease,
      env,
      fetchRelease,
      production: true,
    });
    const res = response();
    await handler({ method: 'GET', query: {} }, res);
    expect(resolveRelease).toHaveBeenCalledWith(env, { production: true, fetchImpl: fetchRelease });
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ releaseVersion: '2.3.4' }));
    expect(res.statusCode).toBe(200);
  });

  it.each([
    [{ page: '0' }, 'invalid_page'],
    [{ pageSize: '101' }, 'invalid_page_size'],
    [{ search: 'x'.repeat(101) }, 'invalid_search'],
  ])('rejects invalid query %#', async (query, error) => {
    const list = vi.fn();
    const handler = createHandler({
      createClients: () => ({ admin: {}, auth: {} }),
      authorize: async () => ({ role: 'Manager' }), createStore: () => ({ list }),
    });
    const res = response();
    await handler({ method: 'GET', query }, res);
    expect(res).toMatchObject({ statusCode: 400, body: { error } });
    expect(list).not.toHaveBeenCalled();
  });

  it('does not parse or query before Manager authorization', async () => {
    const list = vi.fn();
    const handler = createHandler({
      createClients: () => ({ admin: {}, auth: {} }),
      authorize: async () => { throw new ApiError(403, 'Manager permission required.'); },
      createStore: () => ({ list }),
    });
    const res = response();
    await handler({ method: 'GET', query: { page: 'bad' } }, res);
    expect(res).toMatchObject({ statusCode: 403, body: { error: 'Manager permission required.' } });
    expect(list).not.toHaveBeenCalled();
  });

  it('normalizes safe defaults', () => {
    expect(parseFleetQuery({})).toEqual({ page: 1, pageSize: 25, search: '' });
  });

  it('names the New York trading date the day line and the statuses were computed against', async () => {
    const list = vi.fn(async () => ({ rows: [], summary: { total: 0 }, total: 0, ingestDay: null }));
    const handler = createHandler({
      createClients: () => ({ admin: {}, auth: {} }),
      authorize: async () => ({ role: 'Manager' }),
      createStore: () => ({ list }),
      // 21:00 UTC on the 23rd is still the 23rd in New York; the UTC date the
      // screen would otherwise slice out of serverTime rolls over first.
      now: () => new Date('2026-07-24T02:30:00.000Z'),
    });
    const res = response();
    await handler({ method: 'GET', query: {} }, res);
    expect(res.body.tradingDate).toBe('2026-07-23');
  });
});

/* THE DAY LINE, AND THE TWO COLUMNS IT NEEDS THAT MAY NOT BE THERE YET. */
function fleetAdmin({ batchRows = [], failOnTimingColumns = false } = {}) {
  const asked = [];
  return {
    asked,
    from(table) {
      const builder = {
        select(columns) {
          asked.push({ table, columns });
          builder.columns = columns;
          return builder;
        },
        eq: () => builder,
        order: () => builder,
        range: async () => {
          if (table === 'ingest_batches' && failOnTimingColumns && builder.columns.includes('ingest_duration_ms')) {
            return { data: null, error: { code: '42703', message: 'column ingest_batches.ingest_duration_ms does not exist' } };
          }
          if (table === 'ingest_batches') return { data: batchRows, error: null };
          return { data: [], error: null };
        },
      };
      return builder;
    },
  };
}

const dayRows = [
  { id: 'b1', client_id: 'c1', trading_date: '2026-07-23', status: 'processed', row_counts: {}, ingest_duration_ms: 400, admission_deferrals: 0 },
  { id: 'b2', client_id: 'c2', trading_date: '2026-07-23', status: 'processed', row_counts: {}, ingest_duration_ms: 2600, admission_deferrals: 3 },
];

it('reads the timings from the batches it already loaded, without a second query', async () => {
  const admin = fleetAdmin({ batchRows: dayRows });
  const result = await createFleetStore(admin).list({
    page: 1, pageSize: 25, search: '', tradingDate: '2026-07-23',
    now: new Date('2026-07-23T21:00:00.000Z'), releaseVersion: '1.0.5',
  });
  expect(result.ingestDay).toMatchObject({ accepted: 2, shed: 3, measured: 2, medianMs: 400, slowestMs: 2600 });
  // Three selects for the whole screen: clients, devices, batches. The day line
  // adds none.
  expect(admin.asked.map((call) => call.table)).toEqual(['clients', 'ingest_devices', 'ingest_batches']);
});

it('still renders the fleet when migration step 45 has not run, with no day line at all', async () => {
  // PostgREST answers a select naming a column that does not exist with an
  // error rather than with nulls, so asking for the two new columns
  // unconditionally would turn a pending migration into a blank screen.
  const admin = fleetAdmin({ batchRows: dayRows, failOnTimingColumns: true });
  const result = await createFleetStore(admin).list({
    page: 1, pageSize: 25, search: '', tradingDate: '2026-07-23',
    now: new Date('2026-07-23T21:00:00.000Z'), releaseVersion: '1.0.5',
  });
  expect(result.ingestDay).toBeNull();
  expect(result.total).toBe(0);
  expect(admin.asked.filter((call) => call.table === 'ingest_batches')).toHaveLength(2);
});
