import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clientDailyTotals, lastContactDaysAgo, remainingBuffer } from './App';

// ── remainingBuffer ───────────────────────────────────────────────────────────

describe('remainingBuffer', () => {
  it('model-1: returns ddLimit minus absolute rawDD', () => {
    // ddLimit=2000, rawDD=-800 → buffer = 2000 - 800 = 1200
    expect(remainingBuffer({ trailingMaxDrawdown: -800 }, { maxDrawdownLimit: 2000 })).toBe(1200);
  });

  it('model-1: works with positive rawDD (absolute applied)', () => {
    expect(remainingBuffer({ trailingMaxDrawdown: 800 }, { maxDrawdownLimit: 2000 })).toBe(1200);
  });

  it('model-2: returns rawDD directly when ddLimit is 0', () => {
    expect(remainingBuffer({ trailingMaxDrawdown: 950 }, { maxDrawdownLimit: 0 })).toBe(950);
  });

  it('model-2: returns 0 when rawDD is 0 and no ddLimit', () => {
    expect(remainingBuffer({ trailingMaxDrawdown: 0 }, {})).toBe(0);
  });

  it('handles null/undefined snapshot and meta gracefully', () => {
    expect(remainingBuffer(null, null)).toBe(0);
    expect(remainingBuffer(undefined, undefined)).toBe(0);
  });
});

// ── lastContactDaysAgo ────────────────────────────────────────────────────────

describe('lastContactDaysAgo', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-06-25T12:00:00')); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns null when activityLog is empty', () => {
    expect(lastContactDaysAgo({ activityLog: [] })).toBeNull();
  });

  it('returns null when most recent log entry has no createdAt', () => {
    expect(lastContactDaysAgo({ activityLog: [{ id: 'e1', text: 'note' }] })).toBeNull();
  });

  it('returns 0 for log entry created today', () => {
    const client = { activityLog: [{ id: 'e1', createdAt: '2026-06-25T08:00:00.000Z' }] };
    expect(lastContactDaysAgo(client)).toBe(0);
  });

  it('returns correct days since last contact', () => {
    const client = { activityLog: [{ id: 'e1', createdAt: '2026-06-20T12:00:00.000Z' }] };
    expect(lastContactDaysAgo(client)).toBe(5);
  });

  it('uses index 0 (newest entry - log is prepended on insert)', () => {
    const client = {
      activityLog: [
        { id: 'new', createdAt: '2026-06-24T12:00:00.000Z' }, // 1 day ago
        { id: 'old', createdAt: '2026-06-10T12:00:00.000Z' }, // 15 days ago
      ],
    };
    expect(lastContactDaysAgo(client)).toBe(1);
  });
});

// ── clientDailyTotals ─────────────────────────────────────────────────────────

describe('clientDailyTotals', () => {
  it('returns empty for client with no imports', () => {
    expect(clientDailyTotals({ dailyImports: [] })).toHaveLength(0);
  });

  it('sums daily P&L, weekly P&L, and balance across all snapshots', () => {
    const client = {
      dailyImports: [{
        id: 'd1', date: '2026-06-25', accounts: {}, flags: [],
        snapshots: [
          { accountName: 'A1', grossRealizedPnl: 300, weeklyPnl: 1200, accountBalance: 51300 },
          { accountName: 'A2', grossRealizedPnl: 100, weeklyPnl: 400, accountBalance: 50100 },
        ],
      }],
    };
    const [row] = clientDailyTotals(client);
    expect(row.dailyPnl).toBe(400);
    expect(row.weeklyPnl).toBe(1600);
    expect(row.balance).toBe(101400);
    expect(row.accounts).toBe(2);
  });

  it('sorts entries ascending by date regardless of import order', () => {
    const client = {
      dailyImports: [
        { id: 'd2', date: '2026-06-25', accounts: {}, flags: [], snapshots: [] },
        { id: 'd1', date: '2026-06-24', accounts: {}, flags: [], snapshots: [] },
      ],
    };
    const totals = clientDailyTotals(client);
    expect(totals[0].date).toBe('2026-06-24');
    expect(totals[1].date).toBe('2026-06-25');
  });

  it('counts total flags on each day', () => {
    const client = {
      dailyImports: [{
        id: 'd1', date: '2026-06-25', accounts: {}, snapshots: [],
        flags: [{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }],
      }],
    };
    expect(clientDailyTotals(client)[0].flags).toBe(3);
  });
});
