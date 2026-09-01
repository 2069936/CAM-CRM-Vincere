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
