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
