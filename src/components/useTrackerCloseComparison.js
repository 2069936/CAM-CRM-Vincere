import { useCallback, useEffect, useMemo, useState } from 'react';
import { loadSupabaseAccountLiveSampleHistory, loadSupabaseTrackerCloseReadings } from '../domain/supabaseStore';
import { LIVE_REFRESH_MS, WAKE_MIN_GAP_MS } from '../domain/liveRefresh';

/**
 * THE TRACKER'S PINNED READINGS AT THE CLOSE, FOR A SET OF CLIENTS, KEPT FRESH.
 *
 * Twin of useLiveAccountTracker, with the same three rules and for the same
 * reasons: one PostgREST read for the whole set every two minutes (step 66's
 * SELECT policy, no serverless invocation); a re-read when the tab comes back
 * after thirty seconds away, never while hidden; and THE CLOCK ADVANCES ONLY
 * ON A SUCCESSFUL READ, so a fault on our side never ages what is on screen.
 *
 * TWO ANSWERS, NOT ONE. The pinned rows (and the tunables beside them) are the
 * comparison; the history slice is the day's trail for a sparkline, asked for
 * only when the caller names a window (`since`) and read beside the rows. A
 * history that could not be read is a panel without a trail, not a failed
 * panel: the verdicts do not depend on it.
 *
 * A FAILED READ KEEPS THE LAST ANSWER, with the error beside it, the way
 * useAlgorithmLiveRead does: a screen somebody is reading is not blanked for a
 * refresh that did not land. `available: false` is an answer, not a failure:
 * the screen names the state (not deployed, no database) from its reason.
 *
 * @param {object} options
 * @param {string[]} options.clientIds the uuids the rows carry (client.uuid || client.id).
 * @param {string[]|null} [options.importIds] the closes to read; null for every close of the day.
 * @param {string|null} [options.tradingDate] one day, for the overview's read of a whole book.
 * @param {string|Date|null} [options.since] the history window's start; null reads no history.
 * @param {boolean} [options.enabled] false reads nothing (no close on screen yet).
 * @returns {{answer: object|null, history: object|null, error: string|null, reading: boolean,
 *   clock: number, refreshMs: number, retry: Function}}
 */
export default function useTrackerCloseComparison({
  clientIds = [],
  importIds = null,
  tradingDate = null,
  since = null,
  enabled = true,
  refreshMs = LIVE_REFRESH_MS,
  wakeGapMs = WAKE_MIN_GAP_MS,
  load = loadSupabaseTrackerCloseReadings,
  loadHistory = loadSupabaseAccountLiveSampleHistory,
} = {}) {
  const [answer, setAnswer] = useState(null);
  const [history, setHistory] = useState(null);
  const [error, setError] = useState(null);
  const [reading, setReading] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  // Sorted and de-duplicated, so a re-ordered list is not a new request.
  const scope = useMemo(
    () => [...new Set((clientIds || []).filter(Boolean))].sort().join(','),
    [clientIds],
  );
  const imports = useMemo(
    () => (Array.isArray(importIds) ? [...new Set(importIds.filter(Boolean))].sort().join(',') : null),
    [importIds],
  );
  const sinceIso = since instanceof Date ? since.toISOString() : (since || null);
  const day = tradingDate || null;

  useEffect(() => {
    if (!enabled || !scope) return undefined;
    let live = true;
    let lastReadAt = 0;
    const ids = scope.split(',');
    const importList = imports === null ? null : (imports ? imports.split(',') : []);
    async function read() {
      lastReadAt = Date.now();
      setReading(true);
      try {
        const [rows, trail] = await Promise.all([
          load({ clientIds: ids, importIds: importList, tradingDate: day }),
          sinceIso
            ? loadHistory({ clientIds: ids, since: sinceIso }).catch(() => null)
            : Promise.resolve(null),
        ]);
        if (!live) return;
        setAnswer(rows);
        setHistory(trail);
        setError(null);
        setClock(Date.now());
      } catch (failure) {
        if (live) setError(String(failure?.message || failure || 'failed'));
      } finally {
        if (live) setReading(false);
      }
    }
    function wake() {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (Date.now() - lastReadAt < wakeGapMs) return;
      read();
    }
    read();
    const timer = refreshMs > 0 ? setInterval(read, refreshMs) : null;
    const listening = typeof document !== 'undefined' && typeof window !== 'undefined';
    if (listening) {
      document.addEventListener('visibilitychange', wake);
      window.addEventListener('focus', wake);
    }
    return () => {
      live = false;
      if (timer) clearInterval(timer);
      if (listening) {
        document.removeEventListener('visibilitychange', wake);
        window.removeEventListener('focus', wake);
      }
    };
  }, [enabled, scope, imports, day, sinceIso, refreshMs, wakeGapMs, load, loadHistory, attempt]);

  return {
    answer: enabled && scope ? answer : null,
    history: enabled && scope ? history : null,
    error,
    reading,
    clock,
    refreshMs,
    retry,
  };
}
