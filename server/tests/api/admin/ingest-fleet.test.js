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

/* THE FOLDER ON THE VPS, AND THE TABLE STEP 46 ADDS THAT MAY NOT BE THERE YET. */
const CLIENT_1 = '11111111-1111-4111-8111-111111111111';
const CLIENT_2 = '22222222-2222-4222-8222-222222222222';
const DEVICE_1 = 'd1d1d1d1-1111-4111-8111-111111111111';
const DEVICE_2 = 'd2d2d2d2-2222-4222-8222-222222222222';
const CAPTURE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CAPTURE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CAPTURE_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function quarantineAdmin({ quarantineRows = [], batchRows = [], quarantineTableMissing = false } = {}) {
  const asked = [];
  const now = '2026-07-23T20:59:00.000Z';
  const device = (id, clientId) => ({ id, client_id: clientId, status: 'active', health_status: 'online', schedule_time: '16:45:00', schedule_timezone: 'America/New_York', agent_version: '1.0.7', last_seen_at: now, created_at: now });
  const tables = {
    clients: [{ id: CLIENT_1, name: 'Acme' }, { id: CLIENT_2, name: 'Bravo' }],
    ingest_devices: [device(DEVICE_1, CLIENT_1), device(DEVICE_2, CLIENT_2)],
    ingest_quarantine_reports: quarantineRows,
  };
  return {
    asked,
    from(table) {
      const filters = [];
      const builder = {
        select(columns) { asked.push({ table, columns, filters }); builder.columns = columns; return builder; },
        eq: () => builder,
        in(column, values) { filters.push({ column, values }); return builder; },
        order: () => builder,
        range: async () => {
          if (table === 'ingest_quarantine_reports' && quarantineTableMissing) {
            return { data: null, error: { code: '42P01', message: 'relation "public.ingest_quarantine_reports" does not exist' } };
          }
          if (table === 'ingest_batches') {
            const captureFilter = filters.find((filter) => filter.column === 'capture_id');
            // The day's batches carry no capture filter; the quarantine lookup does.
            return { data: captureFilter ? batchRows.filter((row) => captureFilter.values.includes(row.capture_id)) : [], error: null };
          }
          return { data: tables[table] || [], error: null };
        },
      };
      return builder;
    },
  };
}

const quarantineRows = [
  { id: 'q1', device_id: DEVICE_1, client_id: CLIENT_1, capture_id: CAPTURE_A, trading_date: '2026-07-14', code: 'snapshot_processing_failed', attempts: 1, quarantined_at: '2026-07-14T20:30:09Z', last_attempt_at: '2026-07-15T17:00:00Z', reported_at: '2026-07-23T17:00:00Z', final: false },
  { id: 'q2', device_id: DEVICE_1, client_id: CLIENT_1, capture_id: CAPTURE_B, trading_date: '2026-07-17', code: 'snapshot_rejected', attempts: 0, quarantined_at: '2026-07-17T20:30:09Z', last_attempt_at: null, reported_at: '2026-07-23T17:00:00Z', final: true },
  { id: 'q3', device_id: DEVICE_2, client_id: CLIENT_2, capture_id: CAPTURE_C, trading_date: '2026-07-18', code: 'unsupported_schema_version', attempts: 3, quarantined_at: '2026-07-18T20:30:09Z', last_attempt_at: '2026-07-21T17:00:00Z', reported_at: '2026-07-23T17:00:00Z', final: true },
];
const storedBatches = [
  // The 422 was stored before it was refused; the 400 never reached storage.
  { id: 'b-a', capture_id: CAPTURE_A, device_id: DEVICE_1, status: 'failed', error_code: 'normalization_failed' },
  // Same capture id on another device is not this device's batch.
  { id: 'b-c-other', capture_id: CAPTURE_C, device_id: DEVICE_1, status: 'processed', error_code: null },
  { id: 'b-c', capture_id: CAPTURE_C, device_id: DEVICE_2, status: 'failed', error_code: 'private detail' },
];

async function listFleet(admin) {
  return createFleetStore(admin).list({
    page: 1, pageSize: 25, search: '', tradingDate: '2026-07-23',
    now: new Date('2026-07-23T20:59:00.000Z'), releaseVersion: '1.0.7',
  });
}

it('carries each device\'s quarantine on its row, loaded in one query for the devices listed', async () => {
  const admin = quarantineAdmin({ quarantineRows, batchRows: storedBatches });
  const result = await listFleet(admin);
  const [acme, bravo] = result.rows;
  expect(acme.quarantine).toMatchObject({ count: 2, final: 1 });
  expect(acme.quarantine.items.map((item) => item.tradingDate)).toEqual(['2026-07-17', '2026-07-14']);
  expect(bravo.quarantine).toMatchObject({ count: 1, final: 1 });
  expect(acme.operationalStatus).toMatchObject({ state: 'quarantine', label: 'Quarantine' });
  expect(acme.operationalStatus.detail).toContain('2 captures in quarantine on the VPS');
  // One select for the reports, filtered to the devices on the screen, and one
  // for the batches they name. Five for the whole screen.
  const reportQuery = admin.asked.find((call) => call.table === 'ingest_quarantine_reports');
  expect(reportQuery.filters).toEqual([{ column: 'device_id', values: [DEVICE_1, DEVICE_2] }]);
  expect(admin.asked.map((call) => call.table)).toEqual(['clients', 'ingest_devices', 'ingest_batches', 'ingest_quarantine_reports', 'ingest_batches']);
});

it('matches each capture to the batch this CRM holds, on the same device, and says when there is none', async () => {
  const result = await listFleet(quarantineAdmin({ quarantineRows, batchRows: storedBatches }));
  const [acme, bravo] = result.rows;
  const byCapture = Object.fromEntries(acme.quarantine.items.map((item) => [item.captureId, item]));
  expect(byCapture[CAPTURE_A].stored).toEqual({ batchId: 'b-a', status: 'failed', errorCode: 'normalization_failed' });
  expect(byCapture[CAPTURE_B].stored).toBeNull();
  // The processed batch under the same capture id belongs to the other device.
  expect(bravo.quarantine.items[0].stored).toEqual({ batchId: 'b-c', status: 'failed', errorCode: 'ingest_failed' });
  expect(JSON.stringify(result)).not.toContain('private detail');
});

it('counts a row as needing attention only when the agent will never send one of its captures again', async () => {
  const retryingOnly = quarantineRows.filter((row) => row.id === 'q1');
  const result = await listFleet(quarantineAdmin({ quarantineRows: retryingOnly }));
  expect(result.summary).toMatchObject({ quarantine: 1, attention: 0 });
  const withFinal = await listFleet(quarantineAdmin({ quarantineRows }));
  expect(withFinal.summary).toMatchObject({ quarantine: 2, attention: 2 });
});

it('still renders the fleet when migration step 46 has not run, with no quarantine anywhere', async () => {
  // A relation that does not exist is an error from PostgREST, not an empty
  // list, and it must not blank the screen. Null rather than an empty
  // folder: nothing reported is not the same as reported empty.
  const admin = quarantineAdmin({ quarantineTableMissing: true });
  const result = await listFleet(admin);
  expect(result.total).toBe(2);
  expect(result.rows.map((row) => row.quarantine)).toEqual([null, null]);
  expect(result.rows.map((row) => row.operationalStatus.state)).toEqual(['expected', 'expected']);
  // No batch lookup for captures nobody named.
  expect(admin.asked.filter((call) => call.table === 'ingest_batches')).toHaveLength(1);
});

it('reports an empty folder as empty, and asks for no batches', async () => {
  const admin = quarantineAdmin({ quarantineRows: [] });
  const result = await listFleet(admin);
  expect(result.rows[0].quarantine).toEqual({ count: 0, final: 0, items: [] });
  expect(admin.asked.filter((call) => call.table === 'ingest_batches')).toHaveLength(1);
});

it('asks for the reports in slices of a hundred devices, so the list never outgrows a URL', async () => {
  const admin = quarantineAdmin();
  const now = '2026-07-23T20:59:00.000Z';
  const many = Array.from({ length: 150 }, (_, index) => {
    const suffix = String(index + 1).padStart(12, '0');
    return { client: { id: `c0000000-0000-4000-8000-${suffix}`, name: `Client ${index + 1}` }, device: { id: `d0000000-0000-4000-8000-${suffix}`, client_id: `c0000000-0000-4000-8000-${suffix}`, status: 'active', health_status: 'online', schedule_time: '16:45:00', schedule_timezone: 'America/New_York', agent_version: '1.0.7', last_seen_at: now, created_at: now } };
  });
  const base = admin.from;
  admin.from = (table) => {
    const builder = base(table);
    if (table === 'clients' || table === 'ingest_devices') {
      builder.range = async () => ({ data: many.map((entry) => (table === 'clients' ? entry.client : entry.device)), error: null });
    }
    return builder;
  };
  const result = await listFleet(admin);
  expect(result.total).toBe(150);
  const reportQueries = admin.asked.filter((call) => call.table === 'ingest_quarantine_reports');
  expect(reportQueries.map((call) => call.filters[0].values.length)).toEqual([100, 50]);
});
