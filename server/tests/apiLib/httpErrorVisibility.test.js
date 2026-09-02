import { describe, it, expect } from 'vitest';
import { ApiError, handleApiError } from '../../apiLib/http.js';

/* An error the client is not allowed to see still has to be visible somewhere.
 *
 * The collector spent two days retrying uploads that came back 500. The client
 * was told "Unexpected server error", which is correct, and that was also the
 * entire record: the error object was dropped. Nothing reached the function
 * logs, so the deployment could not say what had failed either, and the only
 * way to narrow it was to reason backwards from which retry disposition the
 * agent had picked. */

function res() {
  const sent = {};
  return {
    sent,
    setHeader(name, value) { (sent.headers ||= {})[name] = value; },
    statusCode: 0,
    end(body) { sent.body = body; },
    status(code) { sent.status = code; return this; },
    json(body) { sent.json = body; return this; },
  };
}

function capture() {
  const lines = [];
  return { lines, report: (error) => lines.push(error) };
}

describe('a failure the caller cannot see reaches the log', () => {
  it('reports a raw driver error behind a 500', () => {
    // The exact shape that went unseen: a PostgREST error, which is not an
    // ApiError, thrown straight out of a store.
    const { lines, report } = capture();
    const supabaseError = Object.assign(new Error('permission denied for table ingest_devices'), {
      code: '42501',
      details: 'Key (id)=(0c9f) is not present.',
      hint: 'some hint',
    });

    handleApiError(res(), supabaseError, { production: true, report });

    expect(lines).toHaveLength(1);
    expect(lines[0].code).toBe('42501');
  });

  it('says nothing about a 4xx, which already told the caller what was wrong', () => {
    // Logging these would bury the one line that matters under every rejected
    // request, and the desk rejects a lot of them on purpose.
    const { lines, report } = capture();
    handleApiError(res(), new ApiError(400, 'invalid_heartbeat'), { production: true, report });
    handleApiError(res(), new ApiError(401, 'invalid_device_credential'), { production: true, report });
    expect(lines).toHaveLength(0);
  });

  it('says nothing about a deliberate ApiError even at 5xx', () => {
    // A 503 the code chose already carries its own name in the response.
    const { lines, report } = capture();
    handleApiError(res(), new ApiError(503, 'snapshot_ingest_failed'), { production: true, report });
    expect(lines).toHaveLength(0);
  });

  it('still hides the detail from the caller', () => {
    // The point is to make it visible to the deployment, not to the client.
    const target = res();
    handleApiError(target, Object.assign(new Error('permission denied for table ingest_devices'), { code: '42501' }), {
      production: true,
      report: () => {},
    });
    expect(JSON.stringify(target.sent)).not.toContain('ingest_devices');
    expect(JSON.stringify(target.sent)).not.toContain('42501');
  });

  it('keeps the status and headers it always set', () => {
    const target = res();
    const error = new ApiError(429, 'slow down');
    error.headers = { 'Retry-After': '30' };
    handleApiError(target, error, { production: true, report: () => {} });
    expect(target.sent.headers).toEqual({ 'Retry-After': '30' });
  });

  it('survives being handed something that is not an error', () => {
    const { lines, report } = capture();
    expect(() => handleApiError(res(), null, { production: true, report })).not.toThrow();
    expect(() => handleApiError(res(), 'nope', { production: true, report })).not.toThrow();
    expect(lines.length).toBeGreaterThanOrEqual(1);
  });
});

describe('what the default reporter is allowed to write', () => {
  it('writes the code and message and never the row that failed', async () => {
    // details and hint quote the offending row. A log line is not the place for
    // a client's account number.
    const written = [];
    const original = console.error;
    console.error = (line) => written.push(String(line));
    try {
      handleApiError(res(), Object.assign(new Error('permission denied for table ingest_devices'), {
        code: '42501',
        details: 'Key (account)=(LTATASWAN501329011095) is not present.',
        hint: 'check the policy',
      }), { production: true });
    } finally {
      console.error = original;
    }

    expect(written).toHaveLength(1);
    expect(written[0]).toContain('42501');
    expect(written[0]).toContain('permission denied');
    expect(written[0]).not.toContain('LTATASWAN501329011095');
    expect(written[0]).not.toContain('check the policy');
  });
});

describe('the cause the caller is allowed to read', () => {
  const cause = (error) => {
    const target = res();
    handleApiError(target, error, { production: true, report: () => {} });
    return target.sent.json?.cause;
  };

  it('names a permission denial, which is the whole diagnosis in one word', () => {
    expect(cause(Object.assign(new Error('permission denied for table ingest_devices'), { code: '42501' })))
      .toBe('server_permission_denied');
  });

  it('names a missing relation, a missing column and a missing function the same way', () => {
    for (const code of ['42P01', '42703', '42883']) {
      expect(cause(Object.assign(new Error('x'), { code }))).toBe('server_schema_missing');
    }
  });

  it('names a timeout, a capacity limit and an unreachable backend', () => {
    expect(cause(Object.assign(new Error('x'), { code: '57014' }))).toBe('server_timeout');
    expect(cause(Object.assign(new Error('x'), { code: '53300' }))).toBe('server_capacity');
    expect(cause(Object.assign(new Error('x'), { code: '08006' }))).toBe('server_unreachable');
  });

  it('collapses anything it does not recognise, so a new code cannot leak by default', () => {
    expect(cause(Object.assign(new Error('x'), { code: 'P0001' }))).toBe('server_error');
    expect(cause(Object.assign(new Error('x'), { code: 'something odd' }))).toBe('server_error');
    expect(cause(new Error('no code at all'))).toBe('server_error');
  });

  it('never carries the message, the table, the row or the hint', () => {
    const target = res();
    handleApiError(target, Object.assign(new Error('permission denied for table ingest_devices'), {
      code: '42501',
      details: 'Key (account)=(LTATASWAN501329011095) is not present.',
      hint: 'check the policy',
    }), { production: true, report: () => {} });

    const body = JSON.stringify(target.sent.json || {});
    expect(body).toContain('server_permission_denied');
    expect(body).not.toContain('ingest_devices');
    expect(body).not.toContain('LTATASWAN501329011095');
    expect(body).not.toContain('check the policy');
    expect(body).not.toContain('42501');
  });

  it('adds nothing to a response the caller was already allowed to read', () => {
    // A 4xx already says what was wrong, and anything that reads `error` today
    // must keep seeing exactly what it saw.
    const target = res();
    handleApiError(target, new ApiError(400, 'invalid_heartbeat'), { production: true, report: () => {} });
    expect(target.sent.json).toEqual({ error: 'invalid_heartbeat' });
  });

  it('leaves the endpoint\'s own error string untouched', () => {
    const target = res();
    handleApiError(target, new Error('raw'), {
      production: true,
      fallbackMessage: 'snapshot_ingest_unavailable',
      report: () => {},
    });
    expect(target.sent.json.error).toBe('snapshot_ingest_unavailable');
  });
});
