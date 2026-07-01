import { describe, expect, it } from 'vitest';
import { computeNewStreak, prevTradingDay } from './dailySopUtils';

// ── prevTradingDay ────────────────────────────────────────────────────────────

describe('prevTradingDay', () => {
  it('steps back one day on a Tuesday (Mon is prev trading day)', () => {
    expect(prevTradingDay('2026-06-23')).toBe('2026-06-22'); // Tue → Mon
  });

  it('steps back to Friday from Monday (skips weekend)', () => {
    expect(prevTradingDay('2026-06-22')).toBe('2026-06-19'); // Mon → Fri
  });

  it('steps back to Friday from Saturday', () => {
    // Saturday itself won't be used as "today" in practice, but guard anyway
    expect(prevTradingDay('2026-06-20')).toBe('2026-06-19'); // Sat → Fri
  });

  it('steps back to Friday from Sunday', () => {
    expect(prevTradingDay('2026-06-21')).toBe('2026-06-19'); // Sun → Fri
  });
});

// ── computeNewStreak ──────────────────────────────────────────────────────────

describe('computeNewStreak', () => {
  it('returns unchanged streak when isNowComplete is false', () => {
    const streak = { count: 3, lastDate: '2026-06-24' };
    expect(computeNewStreak('2026-06-25', streak, false, false)).toBe(streak);
  });

  it('returns unchanged streak when wasComplete is already true', () => {
    const streak = { count: 3, lastDate: '2026-06-25' };
    expect(computeNewStreak('2026-06-25', streak, true, true)).toBe(streak);
  });

  it('increments count when lastDate is the previous trading day', () => {
    // Today = Wednesday 2026-06-24, lastDate = Tuesday 2026-06-23
    const streak = { count: 2, lastDate: '2026-06-23' };
    const result = computeNewStreak('2026-06-24', streak, false, true);
    expect(result.count).toBe(3);
    expect(result.lastDate).toBe('2026-06-24');
  });

  it('resets count to 1 when streak is broken (lastDate not prev trading day)', () => {
    const streak = { count: 5, lastDate: '2026-06-20' }; // 2 days ago, gap
    const result = computeNewStreak('2026-06-24', streak, false, true);
    expect(result.count).toBe(1);
    expect(result.lastDate).toBe('2026-06-24');
  });

  it('increments streak across a weekend (Mon completing after Fri)', () => {
    // Today = Monday 2026-06-22, lastDate = Friday 2026-06-19
    const streak = { count: 4, lastDate: '2026-06-19' };
    const result = computeNewStreak('2026-06-22', streak, false, true);
    expect(result.count).toBe(5);
    expect(result.lastDate).toBe('2026-06-22');
  });

  it('starts new streak at 1 when no prior streak (empty lastDate)', () => {
    const streak = { count: 0, lastDate: '' };
    const result = computeNewStreak('2026-06-25', streak, false, true);
    expect(result.count).toBe(1);
    expect(result.lastDate).toBe('2026-06-25');
  });
});
