import { Buffer } from 'node:buffer';
import { gzipSync } from 'node:zlib';
import { describe, it, expect } from 'vitest';
import { decodeSnapshotRequest } from '../../apiLib/autoImportStore.js';

/* EVERY UPLOAD SINCE 31 AUGUST DIED ON A TYPE TEST.
 *
 * api/ingest/[action].js exports `config = { api: { bodyParser: false } }`, a
 * Next.js Pages Router key, in a project that is not Next.js. Nothing reads it.
 * The Vercel Node runtime installs `req.query` and a lazy `req.body` getter in
 * the same call, and that router dispatches on `req.query.action`, so routing
 * working is proof the getter is installed.
 *
 * The getter parses by Content-Type. The agent sends gzip bytes under
 * Content-Type application/json (CrmClient sets application/json for every
 * call and adds Content-Encoding gzip for this one), so the parse fails and the
 * getter throws the moment anything touches it. It threw out of
 * `Buffer.isBuffer(req.body)`, a line that was only asking what type it was.
 *
 * That happened before the batch row was claimed, which is why the failures
 * left a 500 with no cause and no row in ingest_batches to point at. */

const snapshot = {
  captureId: '9df838a8-f692-43af-add0-ea7d62361607',
  tradingDate: '2026-09-02',
  capturedAt: '2026-09-02T20:30:00.000+00:00',
  schemaVersion: 1,
  source: { machineId: 'machine-1' },
  accounts: [],
  strategies: [],
  orders: [],
  executions: [],
};

function request(bytes, { throwingGetter = true } = {}) {
  return {
    headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    // The runtime restores the stream after reading it, so the bytes are still
    // here even though the getter already failed on them.
    get body() {
      if (throwingGetter) throw new SyntaxError('Invalid JSON');
      return undefined;
    },
    async *[Symbol.asyncIterator]() { yield bytes; },
  };
}

describe('a gzip upload arriving through a platform that parsed it as JSON', () => {
  it('is decoded from the stream instead of dying on the getter', async () => {
    const bytes = gzipSync(Buffer.from(JSON.stringify(snapshot), 'utf8'));
    const decoded = await decodeSnapshotRequest(request(bytes));
    expect(decoded.snapshot).toMatchObject({ captureId: snapshot.captureId, tradingDate: '2026-09-02' });
    expect(decoded.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('still works when the platform left the body alone', async () => {
    const bytes = gzipSync(Buffer.from(JSON.stringify(snapshot), 'utf8'));
    const decoded = await decodeSnapshotRequest(request(bytes, { throwingGetter: false }));
    expect(decoded.snapshot.captureId).toBe(snapshot.captureId);
  });

  it('still refuses a body that is not gzip at all', async () => {
    // Guarding the getter must not turn into accepting anything.
    await expect(decodeSnapshotRequest(request(Buffer.from('not gzip', 'utf8'))))
      .rejects.toMatchObject({ status: 400 });
  });

  it('still refuses a request that does not declare gzip', async () => {
    const bytes = gzipSync(Buffer.from(JSON.stringify(snapshot), 'utf8'));
    const req = request(bytes);
    req.headers = { 'content-type': 'application/json' };
    await expect(decodeSnapshotRequest(req)).rejects.toMatchObject({ status: 415 });
  });

  it('still enforces the compressed size limit', async () => {
    const bytes = gzipSync(Buffer.from(JSON.stringify(snapshot), 'utf8'));
    await expect(decodeSnapshotRequest(request(bytes), { maxCompressedBytes: 4 }))
      .rejects.toMatchObject({ status: 413 });
  });
});
