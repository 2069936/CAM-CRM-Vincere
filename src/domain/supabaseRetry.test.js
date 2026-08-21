import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_ATTEMPTS,
  createRequestGate,
  createRetryingFetch,
  parseRetryAfterMs,
  retryDelayMs,
} from './supabaseRetry.js';

const midJitter = () => 0.5;

function fakeResponse(status, headers = {}) {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    status,
    headers: { get: (name) => lower[String(name).toLowerCase()] ?? null },
  };
}

describe('retryDelayMs', () => {
  it('retries a read on the statuses a saturated project actually returns', () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(
        retryDelayMs({ completedAttempts: 1, status, method: 'GET', jitter: midJitter }),
      ).toBeGreaterThan(0);
    }
  });

  it('retries a read that never reached the server', () => {
    expect(
      retryDelayMs({ completedAttempts: 1, transportFailure: true, method: 'GET', jitter: midJitter }),
    ).toBeGreaterThan(0);
  });

  it('does not retry a status a second attempt cannot change', () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(
        retryDelayMs({ completedAttempts: 1, status, method: 'GET', jitter: midJitter }),
      ).toBeNull();
    }
  });

  it('retries a write only on 429, because only 429 says the work was refused', () => {
    // The saturation in the incident produced 429s, so the write path is
    // covered for the case that caused it. Everything else is left alone: a
    // retried POST that Postgres had already applied inserts the row twice, and
    // PostgREST offers no idempotency key to tell the two apart.
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      expect(
        retryDelayMs({ completedAttempts: 1, status: 429, method, jitter: midJitter }),
      ).toBeGreaterThan(0);
      for (const status of [408, 500, 502, 503]) {
        expect(
          retryDelayMs({ completedAttempts: 1, status, method, jitter: midJitter }),
        ).toBeNull();
      }
      expect(
        retryDelayMs({ completedAttempts: 1, transportFailure: true, method, jitter: midJitter }),
      ).toBeNull();
    }
  });

  it('stops at six attempts, like the collector', () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBe(6);
    expect(
      retryDelayMs({ completedAttempts: 5, status: 429, jitter: midJitter }),
    ).toBeGreaterThan(0);
    expect(
      retryDelayMs({ completedAttempts: 6, status: 429, jitter: midJitter }),
    ).toBeNull();
  });

  it('backs off exponentially from the base delay', () => {
    const at = (completedAttempts) => retryDelayMs({
      completedAttempts,
      status: 429,
      jitter: midJitter,
      baseDelayMs: 1000,
      maximumDelayMs: 60000,
    });
    // 0.8 + 0.4 * 0.5 = 1.0, so mid jitter is the unjittered delay.
    expect(at(1)).toBe(1000);
    expect(at(2)).toBe(2000);
    expect(at(3)).toBe(4000);
    expect(at(4)).toBe(8000);
  });

  it('spreads twelve machines apart with jitter rather than re-colliding', () => {
    // The whole point on this incident: twelve VPS machines that all failed at
    // the same moment must not all come back at the same moment.
    const low = retryDelayMs({ completedAttempts: 3, status: 429, jitter: () => 0, baseDelayMs: 1000 });
    const high = retryDelayMs({ completedAttempts: 3, status: 429, jitter: () => 1, baseDelayMs: 1000 });
    expect(low).toBeCloseTo(3200, 6);
    expect(high).toBeCloseTo(4800, 6);
    expect(high - low).toBeGreaterThan(1500);
  });

  it('caps the backoff at the maximum delay', () => {
    expect(
      retryDelayMs({
        completedAttempts: 5,
        status: 429,
        jitter: midJitter,
        baseDelayMs: 2000,
        maximumDelayMs: 10000,
      }),
    ).toBe(10000);
  });

  it('honours Retry-After ahead of its own backoff, capped at the maximum', () => {
    expect(
      retryDelayMs({ completedAttempts: 1, status: 429, retryAfterMs: 45000, jitter: midJitter }),
    ).toBe(45000);
    expect(
      retryDelayMs({
        completedAttempts: 1,
        status: 429,
        retryAfterMs: 900000,
        maximumDelayMs: 120000,
        jitter: midJitter,
      }),
    ).toBe(120000);
  });

  it('refuses a jitter source outside 0..1 instead of inventing a delay', () => {
    expect(() => retryDelayMs({ completedAttempts: 1, status: 429, jitter: () => 4 })).toThrow(/jitter/i);
  });
});

describe('parseRetryAfterMs', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfterMs('30')).toBe(30000);
  });

  it('reads an HTTP-date relative to now', () => {
    const now = Date.parse('2026-08-20T10:00:00Z');
    expect(parseRetryAfterMs('Thu, 20 Aug 2026 10:00:20 GMT', { now })).toBe(20000);
  });

  it('reads a date already in the past as retry now, not as a negative wait', () => {
    const now = Date.parse('2026-08-20T10:00:00Z');
    expect(parseRetryAfterMs('Thu, 20 Aug 2026 09:59:00 GMT', { now })).toBe(0);
  });

  it('returns null for an absent or unparseable header', () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs('')).toBeNull();
    expect(parseRetryAfterMs('soon')).toBeNull();
  });
});

describe('createRetryingFetch', () => {
  function harness(responses, options = {}) {
    const waits = [];
    let call = 0;
    const baseFetch = async () => {
      const next = responses[Math.min(call, responses.length - 1)];
      call += 1;
      if (next instanceof Error) throw next;
      return next;
    };
    const fetchWithRetry = createRetryingFetch(baseFetch, {
      jitter: midJitter,
      baseDelayMs: 10,
      delay: (ms) => { waits.push(ms); return Promise.resolve(); },
      ...options,
    });
    return { fetchWithRetry, waits, calls: () => call };
  }

  it('returns a 429 that later succeeds, having waited in between', async () => {
    const { fetchWithRetry, waits, calls } = harness([
      fakeResponse(429),
      fakeResponse(429),
      fakeResponse(200),
    ]);
    const response = await fetchWithRetry('https://example.test/rest/v1/orders', { method: 'GET' });
    expect(response.status).toBe(200);
    expect(calls()).toBe(3);
    expect(waits).toEqual([10, 20]);
  });

  it('waits exactly as long as Retry-After asks', async () => {
    const { fetchWithRetry, waits } = harness([
      fakeResponse(429, { 'Retry-After': '7' }),
      fakeResponse(200),
    ]);
    await fetchWithRetry('https://example.test/rest/v1/orders', { method: 'GET' });
    expect(waits).toEqual([7000]);
  });

  it('gives up after six attempts and hands the last response back', async () => {
    const { fetchWithRetry, calls } = harness([fakeResponse(429)]);
    const response = await fetchWithRetry('https://example.test/rest/v1/orders', { method: 'GET' });
    expect(response.status).toBe(429);
    expect(calls()).toBe(6);
  });

  it('does not retry a POST that failed with 500', async () => {
    const { fetchWithRetry, calls } = harness([fakeResponse(500)]);
    const response = await fetchWithRetry('https://example.test/rest/v1/clients', { method: 'POST' });
    expect(response.status).toBe(500);
    expect(calls()).toBe(1);
  });

  it('does retry a POST that was rate limited', async () => {
    const { fetchWithRetry, calls } = harness([fakeResponse(429), fakeResponse(201)]);
    const response = await fetchWithRetry('https://example.test/rest/v1/clients', { method: 'POST' });
    expect(response.status).toBe(201);
    expect(calls()).toBe(2);
  });

  it('rethrows a transport failure a read could not recover from', async () => {
    const boom = new TypeError('Failed to fetch');
    const { fetchWithRetry, calls } = harness([boom]);
    await expect(
      fetchWithRetry('https://example.test/rest/v1/orders', { method: 'GET' }),
    ).rejects.toThrow('Failed to fetch');
    expect(calls()).toBe(6);
  });

  it('defaults to GET when no method is given, as supabase-js reads do', async () => {
    const { fetchWithRetry, calls } = harness([fakeResponse(503), fakeResponse(200)]);
    const response = await fetchWithRetry('https://example.test/rest/v1/orders');
    expect(response.status).toBe(200);
    expect(calls()).toBe(2);
  });
});

describe('createRequestGate', () => {
  function tracker() {
    const state = { inFlight: 0, peak: 0, started: [] };
    const task = (label, ticks = 2) => async () => {
      state.inFlight += 1;
      state.peak = Math.max(state.peak, state.inFlight);
      state.started.push(label);
      for (let i = 0; i < ticks; i += 1) await Promise.resolve();
      state.inFlight -= 1;
      return label;
    };
    return { state, task };
  }

  it('never has more than the limit in flight', async () => {
    const { state, task } = tracker();
    const gate = createRequestGate(4);
    const labels = Array.from({ length: 31 }, (_, i) => i);
    const results = await Promise.all(labels.map((label) => gate(task(label))));
    expect(state.peak).toBe(4);
    expect(results).toEqual(labels);
  });

  it('keeps Promise.all order however the tasks settle', async () => {
    const gate = createRequestGate(2);
    const order = [30, 5, 20, 0];
    const results = await Promise.all(order.map((ms) => gate(async () => {
      await new Promise((resolve) => { setTimeout(resolve, ms); });
      return `#${ms}`;
    })));
    expect(results).toEqual(['#30', '#5', '#20', '#0']);
  });

  it('drains the queue after a failure instead of staying shut', async () => {
    // A gate that leaked its slot on a rejection would let one failed page
    // wedge every later request — the load would hang rather than fail, which
    // is strictly worse to diagnose.
    const gate = createRequestGate(1);
    const failed = gate(() => Promise.reject(new Error('page 2 failed')));
    const after = gate(() => Promise.resolve('ran anyway'));
    await expect(failed).rejects.toThrow('page 2 failed');
    await expect(after).resolves.toBe('ran anyway');
  });

  it('treats a zero or negative limit as one rather than as none', async () => {
    // A limit that fell through as 0 would leave the gate with no slots and
    // promises that never settle — a hang, not a slow load.
    for (const limit of [0, -5, Number.NaN]) {
      const gate = createRequestGate(limit);
      expect(await Promise.all([1, 2, 3].map((n) => gate(async () => n)))).toEqual([1, 2, 3]);
    }
  });

  it('does not run a queued task before a slot frees', async () => {
    const { state, task } = tracker();
    const gate = createRequestGate(1);
    const first = gate(task('first', 4));
    const second = gate(task('second', 1));
    await Promise.resolve();
    expect(state.started).toEqual(['first']);
    await Promise.all([first, second]);
    expect(state.started).toEqual(['first', 'second']);
    expect(state.peak).toBe(1);
  });
});
