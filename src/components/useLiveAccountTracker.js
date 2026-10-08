import { useEffect, useMemo, useState } from 'react';
import { loadSupabaseAccountTracker } from '../domain/supabaseStore';

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
 * @returns {{tracker: object|null, clock: number}}
 */
export default function useLiveAccountTracker(clientIds = [], { refreshMs = 120_000 } = {}) {
  const [tracker, setTracker] = useState(null);
  const [clock, setClock] = useState(() => Date.now());
  const scope = useMemo(
    () => [...new Set((clientIds || []).filter(Boolean))].sort().join(','),
    [clientIds],
  );
  useEffect(() => {
    let live = true;
    const ids = scope ? scope.split(',') : [];
    // Nothing to read for an empty set; the return below answers null for it
    // rather than this effect setting state it would have to unset again.
    if (!ids.length) return undefined;
    async function read() {
      try {
        const result = await loadSupabaseAccountTracker({ clientIds: ids });
        if (!live) return;
        setTracker(result.available ? result : null);
        setClock(Date.now());
      } catch {
        if (live) setTracker(null);
      }
    }
    read();
    const timer = refreshMs > 0 ? setInterval(read, refreshMs) : null;
    return () => {
      live = false;
      if (timer) clearInterval(timer);
    };
  }, [scope, refreshMs]);
  return { tracker: scope ? tracker : null, clock };
}
