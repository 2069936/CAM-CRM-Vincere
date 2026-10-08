import { useCallback, useEffect, useMemo, useState } from 'react';
import { loadSupabaseAlgorithmLive } from '../domain/supabaseStore';
import { LIVE_REFRESH_MS } from '../domain/liveRefresh';

/**
 * THE LIVE PER STRATEGY READINGS FOR A SET OF CLIENTS, KEPT FRESH.
 *
 * The same read AlgorithmLivePanel makes (loadSupabaseAlgorithmLive: the
 * floors, the desk figure from algorithm_live_desk() and the viewer's own
 * rows), on the same two minute cadence, with the same two rules:
 *
 *   * BY UUID. The rows carry client_id, a uuid; a client's `id` is its legacy
 *     key when it has one, and PostgREST refuses a legacy key as a uuid.
 *   * KEEP THE LAST COMPLETE CYCLE WHILE THE NEXT ONE FILLS. A screen somebody
 *     is reading is not blanked because the newest cycle is half in; the
 *     previous answer stays, with the filling cycle's start beside it.
 *
 * The clock moves only on a successful read, the rule the account tracker
 * follows: a failed refresh never ages what is on screen.
 *
 * @param {{clientIds?: string[], load?: Function, refreshMs?: number, now?: Function}} options
 * @returns {{data: object|null, error: string, reading: boolean, clock: Date, retry: Function}}
 */
export default function useAlgorithmLiveRead({
  clientIds = [],
  load = loadSupabaseAlgorithmLive,
  refreshMs = LIVE_REFRESH_MS,
  now = () => new Date(),
} = {}) {
  const scopeKey = useMemo(
    () => [...new Set((clientIds || []).filter(Boolean))].sort().join(','),
    [clientIds],
  );
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [reading, setReading] = useState(true);
  const [clock, setClock] = useState(() => now());
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    let live = true;
    async function read() {
      try {
        const result = await load({ clientIds: scopeKey ? scopeKey.split(',') : [] });
        if (!live) return;
        setData((previous) => {
          const filling = result?.available && result.desk?.filling;
          const previousComplete = previous?.available && previous.desk?.cycleStart && !previous.desk.filling;
          if (filling && previousComplete) return { ...previous, fillingCycleStart: result.desk.cycleStart };
          return result;
        });
        setError('');
        setClock(now());
      } catch (failure) {
        if (live) setError(String(failure?.message || failure || 'failed'));
      } finally {
        if (live) setReading(false);
      }
    }
    read();
    const timer = refreshMs ? setInterval(read, refreshMs) : null;
    return () => {
      live = false;
      if (timer) clearInterval(timer);
    };
    // `now` is a clock, not a dependency: a new function each render must not
    // turn the two minute refresh into a refresh every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, scopeKey, refreshMs, attempt]);

  return { data, error, reading, clock, retry };
}
