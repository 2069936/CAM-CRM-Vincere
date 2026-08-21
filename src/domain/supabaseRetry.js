/**
 * The browser's half of the collector's retry policy.
 *
 * collector/src/Vincere.AutoExport.Agent/Crm/RetryPolicy.cs has handled a
 * rejecting CRM correctly since it was written: six attempts, exponential
 * backoff with jitter, Retry-After honoured when the server sends one, and the
 * item kept in a durable queue rather than dropped. The browser had none of it
 * — one 429 anywhere in a page load surfaced as a hard failure — so twelve
 * machines hitting the same project turned a rate limit into "Data: Supabase
 * required" and an empty client list.
 *
 * The numbers here are deliberately the same as the agent's (6 / 2s / 2min /
 * 0.8-1.2x jitter) so one policy is described in one place even though it is
 * implemented twice, in two languages, on two sides of the wire.
 *
 * WHAT IS RETRIED, AND WHY IT DIFFERS BY METHOD
 *
 * A read can be repeated freely: worst case it costs another request. A write
 * cannot. supabase-js speaks PostgREST over plain HTTP with no idempotency key,
 * so a retried POST that the server had in fact already applied inserts the row
 * twice, and a retried DELETE that already ran deletes whatever took its place.
 * The one status that is safe for every method is 429: the server is saying it
 * refused the request BEFORE doing the work. That is also exactly the status
 * this incident produced.
 *
 *   GET, HEAD                  -> 408, 429, 5xx, transport failure
 *   POST, PATCH, PUT, DELETE   -> 429 only
 *
 * A transport failure (fetch rejects: DNS, connection reset, the tab losing the
 * network) is NOT retried for writes for the same reason: the request may have
 * reached Postgres and only the response was lost.
 */

export const DEFAULT_MAX_ATTEMPTS = 6;
export const DEFAULT_BASE_DELAY_MS = 2000;
export const DEFAULT_MAX_DELAY_MS = 120000;

const READ_METHODS = new Set(['GET', 'HEAD']);

/**
 * Retry-After, in milliseconds, or null when the header is absent or unusable.
 *
 * The header comes in two shapes (RFC 9110): delta-seconds, and an HTTP-date.
 * Both are accepted; a date already in the past reads as "retry now" rather
 * than as a negative delay.
 */
export function parseRetryAfterMs(value, { now = Date.now() } = {}) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/**
 * How long to wait before attempt N+1, or null to stop trying.
 *
 * `completedAttempts` counts attempts already made, so the first call after one
 * failure passes 1 — the same contract as GetRetryDelay in the agent.
 */
export function retryDelayMs({
  completedAttempts,
  status = null,
  method = 'GET',
  transportFailure = false,
  retryAfterMs = null,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maximumDelayMs = DEFAULT_MAX_DELAY_MS,
  jitter = Math.random,
} = {}) {
  if (completedAttempts >= maxAttempts) return null;

  const verb = String(method || 'GET').toUpperCase();
  const isRead = READ_METHODS.has(verb);
  const retryableStatus = status === 429
    || (isRead && (status === 408 || (Number.isFinite(status) && status >= 500)));
  const retryableTransport = transportFailure && isRead;
  if (!retryableStatus && !retryableTransport) return null;

  if (retryAfterMs !== null && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, maximumDelayMs);
  }

  const multiplier = 2 ** Math.max(0, completedAttempts - 1);
  const unjittered = Math.min(maximumDelayMs, baseDelayMs * multiplier);
  const sample = jitter();
  if (!(sample >= 0 && sample <= 1)) {
    throw new Error('Retry jitter must be between zero and one.');
  }
  return Math.min(maximumDelayMs, unjittered * (0.8 + 0.4 * sample));
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Wraps fetch so every Supabase request — read or write, from anywhere in the
 * app — goes through the policy above.
 *
 * Installed once on the client (src/lib/supabaseClient.js) rather than around
 * individual calls: the failures this exists for are not per-feature, and a
 * per-call wrapper would be one more thing to remember at each of the ~50 write
 * helpers in supabaseStore.js.
 *
 * Retry-After is read off the Response here, which is the only place it is
 * visible: supabase-js hands callers `{ data, error, status }` and drops the
 * headers, so a policy layered above it could not honour the header at all.
 */
export function createRetryingFetch(baseFetch, {
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maximumDelayMs = DEFAULT_MAX_DELAY_MS,
  jitter = Math.random,
  delay = sleep,
  now = Date.now,
} = {}) {
  return async function retryingFetch(input, init) {
    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    let completedAttempts = 0;

    for (;;) {
      let response = null;
      let transportError = null;
      try {
        response = await baseFetch(input, init);
      } catch (error) {
        transportError = error;
      }
      completedAttempts += 1;

      const status = response ? response.status : null;
      if (response && status < 400) return response;

      const wait = retryDelayMs({
        completedAttempts,
        status,
        method,
        transportFailure: Boolean(transportError),
        retryAfterMs: response
          ? parseRetryAfterMs(response.headers?.get?.('Retry-After'), { now: now() })
          : null,
        maxAttempts,
        baseDelayMs,
        maximumDelayMs,
        jitter,
      });

      // Out of attempts, or a status nothing can be done about (a 400 will be a
      // 400 next time too). Hand back exactly what happened — the caller's
      // error message is the user's only account of it.
      if (wait === null) {
        if (transportError) throw transportError;
        return response;
      }
      await delay(wait);
    }
  };
}

/**
 * A gate that lets at most `limit` requests be in flight at once.
 *
 * Promise.all over every page of every table is what turned one dashboard load
 * into a burst: 31 pages of `orders` and 16 of `operational_flags` all left the
 * tab in the same tick, and twelve machines doing that together is what the
 * project started refusing. The gate is deliberately global to the reader
 * rather than per-table — a per-table bound of four still leaves nineteen
 * tables × four in flight, which is the same cliff a little further away.
 *
 * Order is not this function's business: callers keep it with Promise.all over
 * the gated promises, which resolves in argument order regardless of when each
 * task actually ran. A rejection propagates to that Promise.all as usual; the
 * queued work behind it still drains, so the gate cannot be left permanently
 * closed by one failed page.
 */
export function createRequestGate(limit) {
  const max = Math.max(1, Math.floor(limit) || 1);
  const waiting = [];
  let active = 0;

  function release() {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  }

  return function run(task) {
    return new Promise((resolve, reject) => {
      const start = () => {
        active += 1;
        Promise.resolve()
          .then(task)
          .then(
            (value) => { release(); resolve(value); },
            (error) => { release(); reject(error); },
          );
      };
      if (active < max) start();
      else waiting.push(start);
    });
  };
}
