import { useEffect, useMemo, useState } from 'react';
import { loadSupabaseAccountTracker } from '../domain/supabaseStore';
import { LIVE_REFRESH_MS, WAKE_MIN_GAP_MS } from '../domain/liveRefresh';

/**
 * WHAT IS HAPPENING RIGHT NOW, for a set of clients, kept fresh.
 *
 * This used to be an effect inside CamOverview. It is a hook now because the
 * Operations Command Center wants the same picture for the whole desk, and two
 * copies of a polling effect is how the two screens start disagreeing about the
 * cadence or the failure rule.
 *
 * Its own small read, not part of the login state: the login state is loaded
 * once and held, and a tracker that only moved at login would be a tracker of
 * whenever the CAM signed in. One PostgREST request for the whole set, under
 * step 55's SELECT policy, so a 37-client overview costs no serverless
 * invocations at all.
 *
 * REFRESHED FASTER THAN IT CHANGES, on purpose. The fleet samples about every
 * ten minutes; this asks every two, which is what keeps "4 minutes ago" on a
 * tile from reading "4 minutes ago" a quarter of an hour later.
 *
 * AND IT WAKES UP WITH THE TAB. Pedro's question: if I leave this open all day,
 * does it refresh on its own? A laptop that slept through the afternoon fires no
 * interval while asleep, so the first thing he saw on opening the lid was an age
 * from before lunch. The hook re-reads the moment the document becomes visible
 * again or the window regains focus, at most once every WAKE_MIN_GAP_MS, because
 * a lid opening fires both events within a second and one read is the answer.
 * A hidden tab is never read for: nobody is looking.
 *
 * ITS OWN FAILURE IS SILENCE. `available: false` is what a CRM where step 55
 * has not run answers, and it is also what a failed read answers, and both
 * mean the same thing here: say nothing live. The screens render that as the
 * "not available on this CRM yet" state rather than as an error banner.
 *
 * THE CLOCK ADVANCES ONLY ON A SUCCESSFUL READ, the rule AccountTrackerPanel is
 * built on: ageing the last reading through a failed refresh would paint a
 * machine silent for a fault on our side.
 *
 * @param {string[]} clientIds the clients to read; the hook sorts and
 *   de-duplicates them so a re-ordered list is not a new request.
 * @returns {{tracker: object|null, clock: number, refreshMs: number}} refreshMs
 *   is handed back so the screen prints the cadence the hook actually uses.
 */
export default function useLiveAccountTracker(
  clientIds = [],
  { refreshMs = LIVE_REFRESH_MS, wakeGapMs = WAKE_MIN_GAP_MS } = {},
) {
  const [tracker, setTracker] = useState(null);
  const [clock, setClock] = useState(() => Date.now());
  const scope = useMemo(
    () => [...new Set((clientIds || []).filter(Boolean))].sort().join(','),
    [clientIds],
  );
  useEffect(() => {
    let live = true;
    let lastReadAt = 0;
    const ids = scope ? scope.split(',') : [];
    // Nothing to read for an empty set; the return below answers null for it
    // rather than this effect setting state it would have to unset again.
    if (!ids.length) return undefined;
    async function read() {
      lastReadAt = Date.now();
      try {
        const result = await loadSupabaseAccountTracker({ clientIds: ids });
        if (!live) return;
        setTracker(result.available ? result : null);
        setClock(Date.now());
      } catch {
        if (live) setTracker(null);
      }
    }
    function wake() {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      // The interval's reads count too: a wake a second after the timer fired
      // is not a second request.
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
  }, [scope, refreshMs, wakeGapMs]);
  return { tracker: scope ? tracker : null, clock, refreshMs };
}
