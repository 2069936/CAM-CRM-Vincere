import { describe, expect, it, vi } from 'vitest';
import { createHandler, parseFleetQuery } from './ingest-fleet.js';
import { ApiError } from '../_lib/http.js';

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
});
