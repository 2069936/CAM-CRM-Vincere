import { describe, expect, it, vi } from 'vitest';
import { AutoCollectionApiError, createAutoCollectionApi } from './autoCollectionApi';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';

function jsonResponse(body, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, json: vi.fn(async () => body) };
}

describe('auto collection browser API', () => {
  it('loads client-scoped status with a bearer token and signal', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ client: { uuid: CLIENT_ID } }));
    const api = createAutoCollectionApi({ fetchImpl, getAccessToken: vi.fn(async () => 'browser-token'), retryDelay: () => Promise.resolve() });
    const controller = new AbortController();
    await expect(api.loadStatus(CLIENT_ID, { signal: controller.signal })).resolves.toMatchObject({ client: { uuid: CLIENT_ID } });
    expect(fetchImpl).toHaveBeenCalledWith(`/api/admin/ingest-status?clientUuid=${CLIENT_ID}`, expect.objectContaining({
      method: 'GET', signal: controller.signal, headers: expect.objectContaining({ Authorization: 'Bearer browser-token' }),
    }));
  });

  it('loads bounded Manager fleet and client history pages', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ rows: [], batches: [] }));
    const api = createAutoCollectionApi({ fetchImpl, getAccessToken: async () => 'manager-token' });
    await api.loadFleet({ page: 2, pageSize: 25, search: 'Rome & Co' });
    await api.loadBatchHistory({ clientUuid: CLIENT_ID, pageSize: 20, from: '2026-07-01', to: '2026-07-31' });
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/admin/ingest-fleet?page=2&pageSize=25&search=Rome+%26+Co');
    expect(fetchImpl.mock.calls[1][0]).toBe(`/api/admin/ingest-batches?clientUuid=${CLIENT_ID}&pageSize=20&from=2026-07-01&to=2026-07-31`);
    expect(fetchImpl.mock.calls.every(([, options]) => options.headers.Authorization === 'Bearer manager-token')).toBe(true);
  });

  it('rejects unbounded Manager list inputs before fetching', async () => {
    const fetchImpl = vi.fn();
    const api = createAutoCollectionApi({ fetchImpl, getAccessToken: async () => 'token' });
    await expect(api.loadFleet({ pageSize: 101 })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(api.loadBatchHistory({ clientUuid: CLIENT_ID, from: 'not-a-date' })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('downloads immutable JSON and ZIP through authenticated requests', async () => {
    const blob = new Blob(['snapshot']);
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, blob: async () => blob, headers: { get: () => 'attachment' } }));
    const api = createAutoCollectionApi({ fetchImpl, getAccessToken: async () => 'manager-token' });
    await expect(api.downloadBatch('33333333-3333-4333-8333-333333333333', 'zip')).resolves.toMatchObject({ blob });
    expect(fetchImpl).toHaveBeenCalledWith('/api/admin/ingest-download?batchId=33333333-3333-4333-8333-333333333333&format=zip', expect.objectContaining({ headers: { Authorization: 'Bearer manager-token' } }));
  });

  it('submits an explicit bounded batch replay confirmation', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, status: 'processed' }));
    const api = createAutoCollectionApi({ fetchImpl, getAccessToken: async () => 'manager-token' });
    await api.reprocessBatch({ batchId: '33333333-3333-4333-8333-333333333333', reason: 'Reviewed capture failure', confirmation: 'REPROCESS Acme 2026-07-23', confirmClosedDay: false });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ batchId: '33333333-3333-4333-8333-333333333333', reason: 'Reviewed capture failure', confirmation: 'REPROCESS Acme 2026-07-23', confirmClosedDay: false });
  });

  it('retries one transient status failure without retrying permission errors', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError('network detail'))
      .mockResolvedValueOnce(jsonResponse({ device: null }));
    const api = createAutoCollectionApi({ fetchImpl, getAccessToken: async () => 'token', retryDelay: () => Promise.resolve() });
    await expect(api.loadStatus(CLIENT_ID)).resolves.toEqual({ device: null });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    fetchImpl.mockReset();
    fetchImpl.mockResolvedValue(jsonResponse({ error: 'Client assignment required.', database: 'secret' }, { status: 403 }));
    await expect(api.loadStatus(CLIENT_ID)).rejects.toMatchObject({ status: 403, code: 'permission_denied', message: 'You do not have access to this client setup.' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('generates, intentionally rebinds, and revokes with exact bounded payloads', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }, { status: 201 }));
    const api = createAutoCollectionApi({ fetchImpl, getAccessToken: async () => 'token' });
    await api.generateEnrollment(CLIENT_ID);
    await api.rebind(CLIENT_ID, 'vps_rebuilt');
    await api.revoke(CLIENT_ID, { deviceId: '22222222-2222-4222-8222-222222222222', reason: 'security_revoke' });
    expect(fetchImpl.mock.calls.map(([, options]) => [options.method, JSON.parse(options.body)])).toEqual([
      ['POST', { clientUuid: CLIENT_ID, action: 'generate' }],
      ['POST', { clientUuid: CLIENT_ID, action: 'rebind', reason: 'vps_rebuilt' }],
      ['DELETE', { clientUuid: CLIENT_ID, deviceId: '22222222-2222-4222-8222-222222222222', reason: 'security_revoke' }],
    ]);
    expect(fetchImpl.mock.calls.every(([, options]) => options.headers.Authorization === 'Bearer token')).toBe(true);
  });

  it('validates mutation inputs before making a request', async () => {
    const fetchImpl = vi.fn();
    const api = createAutoCollectionApi({ fetchImpl, getAccessToken: async () => 'token' });
    await expect(api.rebind(CLIENT_ID, 'typed secret')).rejects.toBeInstanceOf(AutoCollectionApiError);
    await expect(api.revoke(CLIENT_ID, { deviceId: 'bad', reason: 'security_revoke' })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sanitizes server, parse, and network errors without reflecting backend content', async () => {
    const secret = 'postgres password product_key machine_hash';
    for (const response of [
      jsonResponse({ error: secret }, { status: 500 }),
      { ok: false, status: 502, json: vi.fn(async () => { throw new Error(secret); }) },
    ]) {
      const api = createAutoCollectionApi({ fetchImpl: vi.fn(async () => response), getAccessToken: async () => 'token', retryDelay: () => Promise.resolve() });
      const error = await api.generateEnrollment(CLIENT_ID).catch((caught) => caught);
      expect(error.message).toBe('Collector setup is temporarily unavailable. Try again.');
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });

  it('stops status retry immediately when aborted', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => { controller.abort(); throw new DOMException('Aborted', 'AbortError'); });
    const api = createAutoCollectionApi({ fetchImpl, getAccessToken: async () => 'token', retryDelay: vi.fn() });
    await expect(api.loadStatus(CLIENT_ID, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

/* THE REASON WAS COMPUTED, SENT, AND THROWN AWAY.
 *
 * create_ingest_enrollment refuses on any of five conditions, and the server
 * learned to say which one. The messages for all five were written at the same
 * time and sat in SAFE_MESSAGES unreachable, because the allow-list here only
 * knew the old generic name. Every precise reason fell through to the 4xx line
 * and came out as "The collector setup request is invalid. Refresh and try
 * again." Refreshing fixes none of the five.
 *
 * Observed on a real client: no product key, and the CAM was told to reload. */
describe('the reason a client cannot be enrolled reaches the CAM', () => {
  const refusing = (code) => createAutoCollectionApi({
    fetchImpl: async () => new Response(JSON.stringify({ error: code }), { status: 409 }),
    getAccessToken: async () => 'token',
  });

  it.each([
    ['client_product_key_missing', 'no product key'],
    ['client_not_active', 'not Active'],
    ['client_deleted', 'deleted'],
    ['client_name_missing', 'no name'],
    ['client_not_found', 'no longer exists'],
  ])('names %s instead of telling them to refresh', async (code, fragment) => {
    await expect(refusing(code).generateEnrollment(CLIENT_ID)).rejects.toMatchObject({ code });
    await expect(refusing(code).generateEnrollment(CLIENT_ID)).rejects.toThrow(new RegExp(fragment, 'i'));
  });

  it('says nothing about refreshing, because refreshing cannot fix any of them', async () => {
    await expect(refusing('client_product_key_missing').generateEnrollment(CLIENT_ID))
      .rejects.not.toThrow(/refresh/i);
  });

  it('keeps the generic answer for a 409 it does not recognise', async () => {
    // A new refusal added to the RPC must not leak an unreviewed string.
    await expect(refusing('something_new_from_the_rpc').generateEnrollment(CLIENT_ID))
      .rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('still names the two it already handled', async () => {
    await expect(refusing('active_device_exists').generateEnrollment(CLIENT_ID))
      .rejects.toMatchObject({ code: 'active_device_exists' });
    await expect(refusing('client_not_eligible').generateEnrollment(CLIENT_ID))
      .rejects.toMatchObject({ code: 'client_not_eligible' });
  });
});

/* ── Slim trading exports (step 72), for the Data lab page ───────────────── */

describe('trading exports', () => {
  const PATH = '/api/admin/ingest-trading-export';
  const REQUEST_ID = '55555555-5555-4555-8555-555555555555';
  const ids = (count) => Array.from({ length: count }, (_, n) => `d0000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
  const bodies = (fetchImpl) => fetchImpl.mock.calls.map(([, options]) => JSON.parse(options.body));

  it('requests any number of devices in slices of 300 and adds the counts up', async () => {
    const fetchImpl = vi.fn(async (_path, options) => {
      const { deviceIds } = JSON.parse(options.body);
      return jsonResponse({ ok: true, requested: deviceIds.length - 1, skipped: 1, needsVps: 1 });
    });
    const api = createAutoCollectionApi({ fetchImpl, getAccessToken: async () => 'manager-token' });
    await expect(api.requestTradingExports({ deviceIds: ids(301), from: '2026-07-01', to: '', datasets: ['trades', 'orders'] }))
      .resolves.toEqual({ ok: true, requested: 299, skipped: 2, needsVps: 2 });
    expect(fetchImpl.mock.calls.every(([path, options]) => path === PATH && options.method === 'POST')).toBe(true);
    expect(bodies(fetchImpl).map((body) => [body.action, body.deviceIds.length, body.from, body.to, body.datasets]))
      .toEqual([['request', 300, '2026-07-01', null, ['orders', 'trades']], ['request', 1, '2026-07-01', null, ['orders', 'trades']]]);
  });

  it('refuses a request it can see is wrong before fetching', async () => {
    const fetchImpl = vi.fn();
    const api = createAutoCollectionApi({ fetchImpl, getAccessToken: async () => 'token' });
    for (const input of [
      { deviceIds: [] },
      { deviceIds: ['device-1'] },
      { deviceIds: ids(1), datasets: [] },
      { deviceIds: ids(1), datasets: ['fills'] },
      { deviceIds: ids(1), from: '2026-10-20', to: '2026-10-19' },
      { deviceIds: ids(1), from: '2026-02-30' },
    ]) {
      await expect(api.requestTradingExports(input), JSON.stringify(input)).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lists every client\'s exports by page and status, and the devices', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, exports: [], total: 0, devices: [] }));
    const api = createAutoCollectionApi({ fetchImpl, getAccessToken: async () => 'token' });
    await api.listTradingExports({ limit: 200, offset: 400, status: 'ready' });
    await api.listTradingExports();
    await api.loadTradingExportDevices();
    await api.listClientTradingExports(CLIENT_ID.toUpperCase());
    expect(bodies(fetchImpl)).toEqual([
      { action: 'listAll', limit: 200, offset: 400, status: 'ready' },
      { action: 'listAll', limit: 50, offset: 0, status: null },
      { action: 'devices' },
      { action: 'list', clientId: CLIENT_ID },
    ]);
    await expect(api.listTradingExports({ status: 'done' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(api.listTradingExports({ limit: 201 })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('cancels, downloads and deletes by request id', async () => {
    const fetchImpl = vi.fn(async (_path, options) => {
      const { action } = JSON.parse(options.body);
      if (action === 'download') return jsonResponse({ ok: true, url: 'https://storage.example.test/sign/x?token=t', fileName: 'Gray-Elm_2026-07-01_2026-10-19.jsonl.gz', expiresAt: '2026-10-20T15:05:00.000Z' });
      if (action === 'cancel') return jsonResponse({ ok: true, cancelled: 1 });
      return jsonResponse({ ok: true, deleted: true });
    });
    const api = createAutoCollectionApi({ fetchImpl, getAccessToken: async () => 'token' });
    await expect(api.cancelTradingExports([REQUEST_ID])).resolves.toEqual({ ok: true, cancelled: 1 });
    await expect(api.downloadTradingExport(REQUEST_ID)).resolves.toEqual({
      url: 'https://storage.example.test/sign/x?token=t', fileName: 'Gray-Elm_2026-07-01_2026-10-19.jsonl.gz', expiresAt: '2026-10-20T15:05:00.000Z',
    });
    await expect(api.deleteTradingExport(REQUEST_ID)).resolves.toEqual({ ok: true, deleted: true });
    expect(bodies(fetchImpl)).toEqual([
      { action: 'cancel', requestIds: [REQUEST_ID] },
      { action: 'download', requestId: REQUEST_ID },
      { action: 'delete', requestId: REQUEST_ID },
    ]);
  });

  it('never hands the browser something that is not a web address to open', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, url: 'javascript:alert(1)', fileName: 'x' }));
    const api = createAutoCollectionApi({ fetchImpl, getAccessToken: async () => 'token' });
    await expect(api.downloadTradingExport(REQUEST_ID)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it.each([
    [404, 'trading_export_unavailable', 'Trading exports need step 72 in the database. Run it, then reload this page.'],
    [404, 'export_not_found', 'This export no longer exists. Refresh the list.'],
    [409, 'export_not_ready', 'This export is not ready to download.'],
    [410, 'export_expired', 'This export has expired and its file is gone. Request a new one.'],
  ])('reads %i %s as its own message', async (status, code, message) => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: code }, { status }));
    const api = createAutoCollectionApi({ fetchImpl, getAccessToken: async () => 'token' });
    await expect(api.downloadTradingExport(REQUEST_ID)).rejects.toMatchObject({ code, status, message });
    expect(new AutoCollectionApiError(code).message).not.toMatch(/[‒–—―]/);
  });
});
