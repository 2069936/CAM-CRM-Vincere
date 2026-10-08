import { describe, expect, it } from 'vitest';
import {
  LIVE_REFRESH_MS,
  WAKE_MIN_GAP_MS,
  refreshWords,
} from './liveRefresh';

/* ------------------------------------------------------------------------- *
 * THE REFRESH IS VISIBLE.
 *
 * Pedro's question: if I leave the screen open all day, does it refresh on its
 * own? It did, every two minutes, and nothing on the screen said so. The
 * sentence below is what both live panels print beside their picture, aged
 * from the hook's clock (which moves only on a successful read) against the
 * wall clock.
 * ------------------------------------------------------------------------- */

const AT = Date.parse('2026-10-08T14:00:00.000Z');

describe('refreshWords', () => {
  it('says how old the picture is and how often it refreshes', () => {
    expect(refreshWords({ updatedAt: AT, now: AT + 40_000, refreshMs: 120_000 }))
      .toBe('Updated 40 s ago, refreshes every 2 min.');
  });

  it('rounds to minutes after the first one, and to hours after the first hour', () => {
    expect(refreshWords({ updatedAt: AT, now: AT + 150_000, refreshMs: 120_000 }))
      .toBe('Updated 2 min ago, refreshes every 2 min.');
    expect(refreshWords({ updatedAt: AT, now: AT + 60_000, refreshMs: 120_000 }))
      .toBe('Updated 1 min ago, refreshes every 2 min.');
    expect(refreshWords({ updatedAt: AT, now: AT + 3 * 3_600_000 + 5 * 60_000, refreshMs: 120_000 }))
      .toBe('Updated 3 h ago, refreshes every 2 min.');
  });

  it('says just now under ten seconds, and for a clock that is ahead of the wall', () => {
    expect(refreshWords({ updatedAt: AT, now: AT + 3_000, refreshMs: 120_000 }))
      .toBe('Updated just now, refreshes every 2 min.');
    // A reading stamped a second in the future (two clocks) is not "-1 s ago".
    expect(refreshWords({ updatedAt: AT + 1_000, now: AT, refreshMs: 120_000 }))
      .toBe('Updated just now, refreshes every 2 min.');
  });

  it('names the cadence in the unit it has: minutes when whole, seconds otherwise', () => {
    expect(refreshWords({ updatedAt: AT, now: AT + 40_000, refreshMs: 60_000 })).toContain('refreshes every 1 min.');
    expect(refreshWords({ updatedAt: AT, now: AT + 40_000, refreshMs: 30_000 })).toContain('refreshes every 30 s.');
  });

  it('drops the cadence clause when nothing refreshes', () => {
    expect(refreshWords({ updatedAt: AT, now: AT + 40_000, refreshMs: 0 })).toBe('Updated 40 s ago.');
    expect(refreshWords({ updatedAt: AT, now: AT + 40_000, refreshMs: null })).toBe('Updated 40 s ago.');
  });

  it('says nothing has been read yet when there is no clock', () => {
    expect(refreshWords({ updatedAt: null, now: AT, refreshMs: 120_000 })).toBe('Not read yet, refreshes every 2 min.');
  });

  it('carries the two cadences the hooks share, so a screen cannot print a number the hook does not use', () => {
    expect(LIVE_REFRESH_MS).toBe(120_000);
    expect(WAKE_MIN_GAP_MS).toBe(30_000);
  });

  it('never prints a dash', () => {
    for (const now of [AT + 3_000, AT + 40_000, AT + 150_000, AT + 5 * 3_600_000]) {
      expect(refreshWords({ updatedAt: AT, now, refreshMs: 120_000 })).not.toMatch(/[–—]| - /);
    }
  });
});
