import { useEffect, useState } from 'react';
import { loadSupabaseClientLiveStrategies } from '../domain/supabaseStore';
import { LIVE_REFRESH_MS } from '../domain/liveRefresh';

/**
 * WHAT ONE CLIENT IS RUNNING, read when a pill is opened.
 *
 * The detail under an account pill lists the strategy instances of that account
 * from algorithm_live_samples and holds each against the desk. Those rows are
 * not part of the tracker read (one row per account, every two minutes, for the
 * whole book); they are read here, per CLIENT, on demand:
 *
 *   * ONE READ PER CLIENT, NOT PER ACCOUNT. The select is scoped to the client,
 *     so opening a second account on the same client costs nothing, and every
 *     pill on that client can carry its amber marker from the one answer.
 *   * ONLY WHILE SOMETHING IS OPEN. `active` is the caller's "a pill of mine is
 *     expanded"; while it is true the hook refreshes on the tracker's cadence,
 *     and when it goes false the interval stops.
 *   * CACHED PER CLIENT, in this module, so a closed and reopened pill, or a
 *     tile that re-renders on the tracker's refresh, shows the last answer at
 *     once and the marker does not blink. A cached answer older than the
 *     cadence is re-read on the next activation.
 *   * A FAILED READ IS AN ERROR BESIDE THE LAST GOOD ANSWER, never zeros and
 *     never a banner: the detail prints "Could not read what is running" when it
 *     has nothing else, and the pills keep their colour.
 *
 * @param {string} clientId the uuid the rows carry (client.uuid || client.id).
 * @param {{active?: boolean, refreshMs?: number, load?: Function}} [options]
 * @returns {{data: object|null, error: string|null, reading: boolean, at: number|null}}
 */
const cache = new Map();

/** For tests only: forget every client. */
export function resetClientLiveStrategiesCache() {
  cache.clear();
}

/** The cached answer for a client, if any, without reading. */
export function cachedClientLiveStrategies(clientId) {
  return cache.get(clientId) || null;
}

export default function useClientLiveStrategies(
  clientId,
  { active = true, refreshMs = LIVE_REFRESH_MS, load = loadSupabaseClientLiveStrategies } = {},
) {
  const key = typeof clientId === 'string' ? clientId.trim() : '';
  const [, bump] = useState(0);
  useEffect(() => {
    if (!key || !active) return undefined;
    let live = true;
    async function read() {
      try {
        const data = await load({ clientId: key });
        if (!live) return;
        cache.set(key, { data, at: Date.now(), error: null });
      } catch (failure) {
        if (!live) return;
        const previous = cache.get(key);
        cache.set(key, {
          data: previous?.data ?? null,
          at: previous?.at ?? null,
          error: String(failure?.message || failure || 'failed'),
        });
      }
      bump((value) => value + 1);
    }
    const held = cache.get(key);
    const fresh = Boolean(held?.data) && Number.isFinite(held?.at) && Date.now() - held.at < refreshMs;
    if (!fresh) read();
    const timer = refreshMs > 0 ? setInterval(read, refreshMs) : null;
    return () => {
      live = false;
      if (timer) clearInterval(timer);
    };
  }, [key, active, refreshMs, load]);
  const entry = key ? cache.get(key) || null : null;
  return {
    data: entry?.data ?? null,
    error: entry?.error ?? null,
    at: entry?.at ?? null,
    reading: Boolean(key && active && !entry),
  };
}
