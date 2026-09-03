import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  ApiError,
  handleApiError,
  readJsonBody,
  requireMethod,
  sendJson,
} from './http.js';

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(status) { this.statusCode = status; return this; },
    json(body) { this.body = body; return this; },
  };
}

describe('http helpers', () => {
  it('rejects a disallowed method with an Allow header', () => {
    expect(() => requireMethod({ method: 'POST' }, ['GET'])).toThrow(ApiError);
    try {
      requireMethod({ method: 'POST' }, ['GET']);
    } catch (error) {
      expect(error).toMatchObject({ status: 405, message: 'Method not allowed.', headers: { Allow: 'GET' } });
    }
  });

  it('reads a JSON request body up to its byte limit', async () => {
    const body = await readJsonBody({ body: '{"ok":true}' }, { maxBytes: 32 });
    expect(body).toEqual({ ok: true });
  });

  it('rejects request bodies beyond its byte limit', async () => {
    await expect(readJsonBody({ body: '{"value":"too-long"}' }, { maxBytes: 8 }))
      .rejects.toMatchObject({ status: 413 });
  });

  it('enforces the byte limit for an already-parsed UTF-8 body', async () => {
    const body = { note: '💣'.repeat(5) };
    const maxBytes = Buffer.byteLength(JSON.stringify(body), 'utf8') - 1;
    await expect(readJsonBody({ body }, { maxBytes })).rejects.toMatchObject({ status: 413 });
  });

  it('accepts an already-parsed body that fits its byte limit', async () => {
    const body = { note: 'ok' };
    const result = await readJsonBody({ body }, { maxBytes: Buffer.byteLength(JSON.stringify(body), 'utf8') });
    expect(result).toEqual(body);
  });

  it('survives a body getter that throws, and falls through to the stream', async () => {
    // THE ONE THAT BROKE EVERY UPLOAD. The Vercel runtime installs req.body as
    // a lazy getter that parses by Content-Type, and every snapshot is gzip
    // bytes sent as application/json. Looking at req.body threw, out of a line
    // that was only testing what type it was.
    const bytes = Buffer.from('{"note":"from the stream"}', 'utf8');
    const req = {
      get body() { throw new SyntaxError('Invalid JSON'); },
      async *[Symbol.asyncIterator]() { yield bytes; },
    };
    await expect(readJsonBody(req, { maxBytes: 1024 })).resolves.toEqual({ note: 'from the stream' });
  });

  it('accepts a body the platform parsed rather than refusing it', async () => {
    // This used to throw 400 "Raw JSON request body is required" whenever the
    // platform had already parsed. That encoded an assumption that the platform
    // never parses, which is false on this deployment: the runtime installs
    // req.query and the req.body getter in the same call, and the ingest router
    // dispatches on req.query.action. Routing works, so the getter is there.
    // Every heartbeat was refused with 400 before a single field was read.
    await expect(readJsonBody({ body: { note: 'small' } }, { maxBytes: 1024 }))
      .resolves.toEqual({ note: 'small' });
  });

  it('sends JSON with the requested status', () => {
    const res = response();
    sendJson(res, 201, { created: true });
    expect(res).toMatchObject({ statusCode: 201, body: { created: true } });
  });

  it('does not leak an unexpected error message or stack in production', () => {
    const res = response();
    const error = new Error('database password: secret');
    error.stack = 'private stack';
    handleApiError(res, error, { production: true, fallbackMessage: 'Request failed.' });
    expect(res).toMatchObject({ statusCode: 500, body: { error: 'Request failed.' } });
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });
});
