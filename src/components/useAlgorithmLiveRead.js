import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { loadSupabaseAlgorithmLive } from '../domain/supabaseStore';
import { LIVE_REFRESH_MS } from '../domain/liveRefresh';

/**
 * THE LIVE PER STRATEGY READINGS FOR A SET OF CLIENTS, KEPT FRESH.
 *
 * The one read behind the roll call (AlgorithmRollCall) and the per account
 * comparison (AlgorithmLivePanel): loadSupabaseAlgorithmLive, the floors, the
 * desk figure from algorithm_live_desk() and the viewer's own rows, every two
 * minutes. Both panels used to carry their own copy of the read and of the
 * rules below, and a CAM overview with both open read the same thing twice
 * per cadence. The rules live here once:
 *
 *   * BY UUID. The rows carry client_id, a uuid; a client's `id` is its legacy
 *     key when it has one, and PostgREST refuses a legacy key as a uuid.
 *     algorithmLiveClientIds is the one place that picks the key.
 *   * KEEP THE LAST COMPLETE CYCLE WHILE THE NEXT ONE FILLS. A screen somebody
 *     is reading is not blanked because the newest cycle is half in; the
 *     previous answer stays, with the filling cycle's start beside it.
 *   * THE CLOCK MOVES ONLY ON A SUCCESSFUL READ, the rule the account tracker
 *     follows: a failed refresh never ages what is on screen.
 *
 * ONE READ PER SCOPE AND CADENCE, SHARED. The answer is kept in this module per
 * loader, per cadence and per set of clients, the way useClientLiveStrategies
 * keeps one answer per client: every panel that asks for the same clients on
 * the same cadence subscribes to the same entry, and one timer reads for all of
 * them. The first subscriber starts it, the last one to leave stops it, and an
 * answer younger than the cadence is shown at once to a panel opened later,
 * with the next read due when that answer turns a cadence old, not a cadence
 * after the panel opened. A read already in flight is joined, never repeated.
 *
 * @param {{clientIds?: string[], load?: Function, refreshMs?: number, now?: Function}} options
 * @returns {{data: object|null, error: string, reading: boolean, clock: Date, retry: Function}}
 */

/* loader -> "cadence|sorted ids" -> entry. A WeakMap on the loader, so a test's
 * own loader never shares an entry with the app's. */
let entries = new WeakMap();

/** For tests only: forget every answer. Subscribed panels keep their entry. */
export function resetAlgorithmLiveReadCache() {
  entries = new WeakMap();
}

/** The ids the rows carry: the uuid when the client has one, else its id. */
export function algorithmLiveClientIds(clients) {
  return (Array.isArray(clients) ? clients : []).map((client) => client?.uuid || client?.id).filter(Boolean);
}

function scopeKeyOf(clientIds) {
  return [...new Set((clientIds || []).filter(Boolean))].sort().join(',');
}

function entryFor(load, refreshMs, scopeKey) {
  let byKey = entries.get(load);
  if (!byKey) {
    byKey = new Map();
    entries.set(load, byKey);
  }
  const key = `${refreshMs}|${scopeKey}`;
  let entry = byKey.get(key);
  if (!entry) {
    entry = {
      load,
      refreshMs,
      clientIds: scopeKey ? scopeKey.split(',') : [],
      snapshot: { data: null, error: '', reading: true, clock: null },
      at: null,
      inflight: null,
      timer: null,
      now: () => new Date(),
      listeners: new Set(),
    };
    byKey.set(key, entry);
  }
  return entry;
}

function publish(entry, change) {
  entry.snapshot = { ...entry.snapshot, ...change };
  for (const listener of [...entry.listeners]) listener();
}

/* While the newest cycle fills, keep the last complete one on screen and say a
 * newer one is coming. The previous read's rows go with it, so the desk and
 * the accounts are still from one cycle. */
function keepLastComplete(previous, result) {
  const filling = result?.available && result.desk?.filling;
  const previousComplete = previous?.available && previous.desk?.cycleStart && !previous.desk.filling;
  if (filling && previousComplete) return { ...previous, fillingCycleStart: result.desk.cycleStart };
  return result;
}

function read(entry) {
  if (entry.inflight) return entry.inflight;
  entry.inflight = (async () => {
    try {
      const result = await entry.load({ clientIds: entry.clientIds });
      entry.at = Date.now();
      publish(entry, { data: keepLastComplete(entry.snapshot.data, result), error: '', reading: false, clock: entry.now() });
    } catch (failure) {
      publish(entry, { error: String(failure?.message || failure || 'failed'), reading: false });
    } finally {
      entry.inflight = null;
    }
  })();
  return entry.inflight;
}

function schedule(entry, delay) {
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (!entry.listeners.size) return;
    read(entry);
    schedule(entry, entry.refreshMs);
  }, Math.max(0, delay));
}

function subscribe(entry, listener, now) {
  // The latest subscriber's clock stamps the next answer.
  entry.now = now;
  entry.listeners.add(listener);
  if (entry.listeners.size === 1) {
    const age = entry.at === null ? Infinity : Date.now() - entry.at;
    const fresh = entry.refreshMs > 0 && entry.snapshot.data !== null && age < entry.refreshMs;
    if (!fresh) read(entry);
    if (entry.refreshMs > 0) schedule(entry, fresh ? entry.refreshMs - age : entry.refreshMs);
  }
  return () => {
    entry.listeners.delete(listener);
    if (!entry.listeners.size && entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  };
}

export default function useAlgorithmLiveRead({
  clientIds = [],
  load = loadSupabaseAlgorithmLive,
  refreshMs = LIVE_REFRESH_MS,
  now = () => new Date(),
} = {}) {
  const scopeKey = useMemo(() => scopeKeyOf(clientIds), [clientIds]);
  const cadence = Number(refreshMs) > 0 ? Number(refreshMs) : 0;
  const entry = useMemo(() => entryFor(load, cadence, scopeKey), [load, cadence, scopeKey]);

  // `now` is a clock, not a dependency: a new function each render must not
  // resubscribe. The entry asks the latest one when a read lands.
  const nowRef = useRef(now);
  useEffect(() => { nowRef.current = now; });

  const onSubscribe = useCallback((listener) => subscribe(entry, listener, () => nowRef.current()), [entry]);
  const snapshot = useSyncExternalStore(onSubscribe, () => entry.snapshot, () => entry.snapshot);

  // Before the first answer the clock is the moment this panel mounted.
  const [mounted] = useState(() => now());
  const retry = useCallback(() => { read(entry); }, [entry]);

  return {
    data: snapshot.data,
    error: snapshot.error,
    reading: snapshot.reading,
    clock: snapshot.clock || mounted,
    retry,
  };
}
