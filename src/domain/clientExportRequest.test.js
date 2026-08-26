// The wire between the dialog and the endpoint, which is where a part number
// goes to get lost.
//
// This is a short file about one omission that a full green suite would not
// notice. The dialog plans the parts, the server echoes them, and both are
// pinned; between them sits loadClientScopedExport, which builds the request
// body by copying named fields. A field left off that list does not throw and
// does not warn — the parts simply arrive unlabelled, every file in the folder
// gets the same name because the name is built from the part number, and the
// last one written wins. Five files become one, and nothing anywhere says so.
//
// Everything here is synthetic and ungated, so CI pins it.

import { describe, expect, it, vi } from 'vitest';

const wire = { calls: [] };

vi.mock('../lib/supabaseClient', () => ({
  isSupabaseConfigured: true,
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'token' } }, error: null }),
    },
  },
}));

const { loadClientScopedExport } = await import('./supabaseDataPortability.js');

globalThis.fetch = vi.fn(async (url, options) => {
  wire.calls.push({ url, body: JSON.parse(options.body) });
  return { ok: true, status: 200, json: async () => ({ ok: true }) };
});

const sent = async (request) => {
  wire.calls.length = 0;
  await loadClientScopedExport(request);
  return wire.calls[0].body;
};

describe('the client export request', () => {
  it('carries the part number so the response can be labelled', async () => {
    const body = await sent({
      clientIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'],
      from: '2026-07-01',
      to: '2026-07-31',
      batch: { index: 2, of: 5 },
    });
    expect(body.batch).toEqual({ index: 2, of: 5 });
  });

  it('leaves it off an unbatched export rather than sending a part 1 of 1', async () => {
    // Absent means "not a part of anything". A payload stamped 1 of 1 would put
    // a part number on every ordinary export and make the real ones harder to
    // pick out of an audit log.
    const body = await sent({ clientIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'] });
    expect(body).not.toHaveProperty('batch');
  });

  it('still sends the scope and the range beside it', async () => {
    const body = await sent({
      clientIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'],
      from: '2026-07-01',
      to: '2026-07-31',
      includeTradeHistory: true,
      batch: { index: 1, of: 3 },
    });
    expect(body).toMatchObject({
      clientIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'],
      from: '2026-07-01',
      to: '2026-07-31',
      includeTradeHistory: true,
      batch: { index: 1, of: 3 },
    });
  });

  it('omits the client list entirely for "all my clients"', async () => {
    // The server then reads the assignment table itself. Sending an empty array
    // instead would be a filter matching nothing.
    const body = await sent({});
    expect(body).not.toHaveProperty('clientIds');
    expect(body.includeTradeHistory).toBe(false);
  });
});
