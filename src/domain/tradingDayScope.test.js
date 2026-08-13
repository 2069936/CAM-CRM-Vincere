import { describe, expect, it } from 'vitest';
import {
  isLiveOrderState,
  scopeExecutionsToDay,
  scopeOrdersToDay,
  summarizeScope,
  tradingDateOf,
} from './tradingDayScope';

describe('tradingDateOf', () => {
  it('reads both formats the CRM receives', () => {
    // NinjaTrader grids write US dates; the AddOn and the database write ISO.
    expect(tradingDateOf('7/13/2026 12:15:35 PM')).toBe('2026-07-13');
    expect(tradingDateOf('12/1/2026 9:00:00 AM')).toBe('2026-12-01');
    expect(tradingDateOf('2026-07-13T12:15:35-04:00')).toBe('2026-07-13');
  });

  it('answers null rather than guessing', () => {
    expect(tradingDateOf('')).toBeNull();
    expect(tradingDateOf('not a date')).toBeNull();
    expect(tradingDateOf(null)).toBeNull();
  });
});

describe('isLiveOrderState', () => {
  it('recognises the states that mean the order is still working', () => {
    for (const state of ['Working', 'Accepted', 'Initialized', 'Submitted', 'Cancel pending']) {
      expect(isLiveOrderState(state)).toBe(true);
    }
  });

  it('treats finished states as finished', () => {
    for (const state of ['Filled', 'Cancelled', 'Unknown', 'Suspended', '']) {
      expect(isLiveOrderState(state)).toBe(false);
    }
  });

  it('matches a rejection by its prefix, not the whole broker message', () => {
    // Brokers append the entire reason, sometimes hundreds of characters.
    expect(isLiveOrderState('Rejected: Your account is currently set to liquidation only')).toBe(false);
    expect(isLiveOrderState('Rejected')).toBe(false);
  });
});

describe('scopeOrdersToDay', () => {
  const orders = [
    { id: 'today', time: '7/27/2026 10:49:33 AM', state: 'Filled' },
    { id: 'old-filled', time: '7/21/2026 10:00:00 AM', state: 'Filled' },
    { id: 'old-working', time: '7/21/2026 10:00:00 AM', state: 'Working' },
    { id: 'old-rejected', time: '7/21/2026 10:00:00 AM', state: 'Rejected: Access is denied' },
    { id: 'undated', time: '', state: 'Filled' },
  ];

  it('keeps today and drops finished business from earlier days', () => {
    const kept = scopeOrdersToDay(orders, '2026-07-27').map((order) => order.id);

    expect(kept).toContain('today');
    expect(kept).not.toContain('old-filled');
    expect(kept).not.toContain('old-rejected');
  });

  it('keeps a working order placed on an earlier day', () => {
    // A GTC order placed on Friday is still that client's exposure on Monday.
    // State outranks date here.
    expect(scopeOrdersToDay(orders, '2026-07-27').map((o) => o.id)).toContain('old-working');
  });

  it('keeps a row whose timestamp it cannot read', () => {
    // Dropping rows over an unrecognised format would silently delete real
    // trading, which is worse than carrying a few extra.
    expect(scopeOrdersToDay(orders, '2026-07-27').map((o) => o.id)).toContain('undated');
  });

  it('returns everything when the day itself is unusable', () => {
    expect(scopeOrdersToDay(orders, '')).toHaveLength(orders.length);
  });
});

describe('scopeExecutionsToDay', () => {
  const executions = [
    { id: 'today', time: '7/27/2026 10:49:33 AM' },
    { id: 'old', time: '7/21/2026 10:00:00 AM' },
    { id: 'undated', time: '' },
  ];

  it('keeps only fills from the day itself', () => {
    // A fill is an event with a time. One from last week was already counted on
    // the day it happened; counting it again today doubles it.
    const kept = scopeExecutionsToDay(executions, '2026-07-27').map((e) => e.id);

    expect(kept).toEqual(['today', 'undated']);
  });

  it('has no live-state exception, unlike orders', () => {
    const withState = [{ id: 'old', time: '7/21/2026 10:00:00 AM', state: 'Working' }];

    expect(scopeExecutionsToDay(withState, '2026-07-27')).toEqual([]);
  });
});

describe('summarizeScope', () => {
  it('reports what was dropped so a history-laden capture is visible', () => {
    const summary = summarizeScope(
      [
        { time: '7/27/2026 1:00:00 PM', state: 'Filled' },
        { time: '1/5/2026 1:00:00 PM', state: 'Filled' },
      ],
      [{ time: '1/5/2026 1:00:00 PM' }],
      '2026-07-27',
    );

    expect(summary.orders).toEqual({ received: 2, kept: 1, dropped: 1 });
    expect(summary.executions).toEqual({ received: 1, kept: 0, dropped: 1 });
  });
});
