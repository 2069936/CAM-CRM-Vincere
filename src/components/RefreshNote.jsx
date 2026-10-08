import { useEffect, useState } from 'react';
import { LIVE_REFRESH_MS, refreshWords } from '../domain/liveRefresh';

/**
 * "Updated 40 s ago, refreshes every 2 min."
 *
 * Pedro's question: does the screen refresh by itself if I leave it open all
 * day? It does, and now it says so. The age is the hook's clock (which moves
 * only on a successful read) against the wall clock, re-rendered every ten
 * seconds; the tick is a re-render and never a read.
 *
 * The wall clock is state the tick advances, never Date.now() in the render
 * body, so the component stays pure. Between ticks a fresh read is aged from
 * its own stamp (the later of the two), so it reads "just now" the moment it
 * lands and not nine seconds later.
 *
 * Not a live region: a sentence that changes every ten seconds would be read
 * aloud every ten seconds.
 */
export default function RefreshNote({
  updatedAt,
  refreshMs = LIVE_REFRESH_MS,
  tickMs = 10_000,
  className = 'live-refresh',
}) {
  const [wall, setWall] = useState(() => Date.now());
  useEffect(() => {
    if (!(tickMs > 0)) return undefined;
    const timer = setInterval(() => setWall(Date.now()), tickMs);
    return () => clearInterval(timer);
  }, [tickMs]);
  const stamp = updatedAt instanceof Date ? updatedAt.getTime() : (typeof updatedAt === 'number' ? updatedAt : Date.parse(updatedAt || ''));
  const now = Number.isFinite(stamp) ? Math.max(wall, stamp) : wall;
  return <span className={className}>{refreshWords({ updatedAt, now, refreshMs })}</span>;
}
