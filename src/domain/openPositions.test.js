import { describe, it, expect } from 'vitest';
import { accountsWithOpenPositions, describeOpenPositions, openPositionsAt } from './openPositions';

/* THE DAY THIS EXISTS FOR.
 *
 * 2026-09-08. The scheduled capture fired at 16:30:00 and reported -$2,064.
 * The real number was -$1,319. The $745 difference sat in unrealized PnL on
 * three accounts whose closing fills landed at 16:32, two minutes later. A
 * capture from the same machine at 18:28 matched the manual export exactly. */

const capturedAt1630 = {
  accounts: [
    { accountName: 'FTDFYL100619242775', grossRealizedPnl: -441, unrealizedPnl: 0 },
    { accountName: 'FTDFYL100794922280', grossRealizedPnl: -307, unrealizedPnl: 235 },
    { accountName: 'FTDFYL100895903898', grossRealizedPnl: -306, unrealizedPnl: 235 },
    { accountName: 'FTDFYL150817891975', grossRealizedPnl: -200, unrealizedPnl: 245 },
    { accountName: 'LFE05088741120005', grossRealizedPnl: -810, unrealizedPnl: 0 },
  ],
};

const capturedAt1828 = {
  accounts: [
    { accountName: 'FTDFYL100619242775', grossRealizedPnl: -441, unrealizedPnl: 0 },
    { accountName: 'FTDFYL100794922280', grossRealizedPnl: -62, unrealizedPnl: 0 },
    { accountName: 'FTDFYL100895903898', grossRealizedPnl: -61, unrealizedPnl: 0 },
    { accountName: 'FTDFYL150817891975', grossRealizedPnl: 55, unrealizedPnl: 0 },
    { accountName: 'LFE05088741120005', grossRealizedPnl: -810, unrealizedPnl: 0 },
  ],
};

describe('catching a close taken before the day finished closing', () => {
  it('names the accounts that were still in a position', () => {
    const result = openPositionsAt(capturedAt1630);
    expect(result.open).toBe(true);
    expect(result.accounts.map((a) => a.accountName)).toEqual([
      'FTDFYL100794922280', 'FTDFYL100895903898', 'FTDFYL150817891975',
    ]);
  });

  it('reports how far off the realized total is likely to be', () => {
    // $715 of the $745 gap, which is enough for a reader to judge whether it
    // matters rather than being told only that something is wrong.
    expect(openPositionsAt(capturedAt1630).unrealizedTotal).toBe(715);
  });

  it('passes the capture taken after everything closed', () => {
    expect(openPositionsAt(capturedAt1828)).toMatchObject({ open: false, unrealizedTotal: 0 });
  });

  it('says nothing about a clean capture', () => {
    expect(describeOpenPositions(openPositionsAt(capturedAt1828))).toBeNull();
    expect(describeOpenPositions(null)).toBeNull();
  });

  it('tells the CAM what to do rather than only that something is wrong', () => {
    const message = describeOpenPositions(openPositionsAt(capturedAt1630));
    expect(message).toContain('3 accounts were still in a position');
    expect(message).toContain('$715');
    expect(message).toContain('Re-capture after the strategies have closed');
  });

  it('catches a short position too, where unrealized is negative', () => {
    expect(openPositionsAt({ accounts: [{ accountName: 'A', unrealizedPnl: -120 }] }))
      .toMatchObject({ open: true, unrealizedTotal: -120 });
  });

  it('survives a snapshot with no accounts, and one that is not a snapshot', () => {
    expect(openPositionsAt({ accounts: [] }).open).toBe(false);
    expect(openPositionsAt(null).open).toBe(false);
    expect(accountsWithOpenPositions(undefined)).toEqual([]);
  });

  it('ignores an unreadable unrealized value rather than calling it open', () => {
    // A missing or malformed field is not evidence of a position, and treating
    // it as one would flag every clean close on a client whose export omits it.
    expect(openPositionsAt({ accounts: [{ accountName: 'A', unrealizedPnl: null }] }).open).toBe(false);
    expect(openPositionsAt({ accounts: [{ accountName: 'A', unrealizedPnl: 'n/a' }] }).open).toBe(false);
  });
});
