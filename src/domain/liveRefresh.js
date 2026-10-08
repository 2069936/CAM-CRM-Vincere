/* ────────────────────────────────────────────────────────────────────────────
 * THE REFRESH, SAID OUT LOUD.
 *
 * Pedro's question: if I leave this open all day, does it refresh on its own?
 * It did, every two minutes, and nothing on the screen said so, which to the
 * person looking at it is the same as not refreshing. Both live panels now
 * print the sentence this module builds, aged every ten seconds from the
 * hook's clock, and the hook re-reads when the tab wakes up.
 *
 * TWO NUMBERS, ONE PLACE. The cadence the hooks poll at and the shortest gap
 * between two wake-up reads live here so the screens print the number the
 * hooks use and never a literal of their own.
 *
 * Pure: no React, no clock of its own.
 * ──────────────────────────────────────────────────────────────────────────── */

/** How often the live panels re-read. The tracker samples about every ten
 * minutes; reading every two keeps "4 minutes ago" from reading "4 minutes ago"
 * a quarter of an hour later. */
export const LIVE_REFRESH_MS = 120_000;

/** The shortest gap between two reads caused by the tab waking up (visibility
 * or focus). A laptop lid opening fires both events within a second; one read
 * is the answer, not two. */
export const WAKE_MIN_GAP_MS = 30_000;

function ms(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = value instanceof Date ? value.getTime() : (typeof value === 'number' ? value : Date.parse(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function agoWords(seconds) {
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** "2 min" for a whole number of minutes, "30 s" otherwise. */
export function everyWords(refreshMs) {
  const value = Number(refreshMs);
  if (value % 60_000 === 0) return `${value / 60_000} min`;
  return `${Math.round(value / 1000)} s`;
}

/**
 * "Updated 40 s ago, refreshes every 2 min."
 *
 * @param {{updatedAt: number|string|Date|null, now?: number|Date, refreshMs?: number|null}} input
 *   updatedAt is the hook's clock (moves only on a successful read); now is the
 *   wall clock; refreshMs <= 0 or null means nothing refreshes and the clause
 *   is dropped.
 */
export function refreshWords({ updatedAt, now = Date.now(), refreshMs = LIVE_REFRESH_MS } = {}) {
  const at = ms(updatedAt);
  const wall = ms(now) ?? Date.now();
  // Clamped at zero: a reading stamped ahead of the wall clock (two machines,
  // two clocks) is "just now", never a negative age.
  const head = at === null ? 'Not read yet' : `Updated ${agoWords(Math.max(0, Math.floor((wall - at) / 1000)))}`;
  const cadence = Number(refreshMs) > 0 ? `, refreshes every ${everyWords(refreshMs)}.` : '.';
  return `${head}${cadence}`;
}
