import { useEffect, useMemo, useState } from 'react';
import { loadSupabaseAccountLiveSampleHistory } from '../domain/supabaseStore';
import { historyWindowStart } from '../domain/disconnectedSince';

/**
 * TODAY'S TRACKER HISTORY, FOR THE CLIENTS WITH A DISCONNECTED ACCOUNT ONLY.
 *
 * The Live accounts panel says since when an account has been disconnected
 * ("Disconnected since 09:40"), and the start of that stretch is in step 66's
 * account_live_sample_history. This reads it, and reads as little as it can:
 *
 *   ONLY THE CLIENTS THAT NEED IT. `clientIds` are the keys of the clients with
 *   a disconnected pill right now; with none, nothing is read at all.
 *   ONCE PER TRACKER READ. `clock` is the tracker's (it moves on every
 *   successful read of the samples, every two minutes), so the history is read
 *   again exactly when the pills it explains have been read again.
 *   TODAY ONLY. The window starts at the viewer's midnight.
 *
 * ITS OWN READ, NEVER CHAINED TO THE TRACKER'S. A slow history read must not
 * hold the pills back and a failed one must not blank them: a read that throws
 * is a panel without the "since" words (null), and `available: false` (step 66
 * not run) is the same silence. A read whose answer arrives after the scope
 * moved on is dropped.
 *
 * @param {object} options
 * @param {string[]} options.clientIds the uuids the rows carry, of the clients
 *   with a disconnected pill.
 * @param {number|null} options.clock the tracker clock, epoch ms.
 * @param {Function} [options.load] loadSupabaseAccountLiveSampleHistory.
 * @returns {object|null} the loader's answer ({available, rows}) or null.
 */
export default function useDisconnectedSince({
  clientIds = [],
  clock = null,
  load = loadSupabaseAccountLiveSampleHistory,
} = {}) {
  const [answer, setAnswer] = useState(null);
  // Sorted and de-duplicated, so a re-ordered list is not a new request.
  const scope = useMemo(() => [...new Set((clientIds || []).filter(Boolean))].sort().join(','), [clientIds]);
  const since = useMemo(
    () => (Number.isFinite(clock) ? historyWindowStart(clock).toISOString() : null),
    [clock],
  );

  useEffect(() => {
    if (!scope || !since) return undefined;
    let live = true;
    Promise.resolve()
      .then(() => load({ clientIds: scope.split(','), since }))
      .then((result) => { if (live) setAnswer(result || null); })
      .catch(() => { if (live) setAnswer(null); });
    return () => { live = false; };
  }, [scope, since, clock, load]);

  return scope ? answer : null;
}
