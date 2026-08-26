import { describe, expect, it } from 'vitest';
import { CARRY_IN_REASONS, carryForwardLots } from './carryForwardLots.js';
import { deriveStrategyPnl } from './deriveStrategyPnl.js';

// EVERY FIXTURE HERE IS SYNTHETIC, and that is the honest state of this module.
// Neither real export held so far (2026-08-18, 2026-08-19) contains a single
// book that carried a position in: 25 of 25 and 31 of 31 opened flat and closed
// flat. So nothing below has ever been checked against NinjaTrader's own
// arithmetic on a real carried-in day. What these tests pin is the SHAPE of the
// answer — priced when the chain is unbroken, refused when it is not — not that
// the price is the one NinjaTrader would report. Re-verify on the first real
// carry-in day before trusting a split that rests on it.

const close = (date, executions, orders) => ({ date, executions, orders });
const buy = (id, qty, price, position, orderId, account = 'ACC1', instrument = 'MNQ SEP26') =>
  ({ id, accountName: account, instrument, action: 'Buy', quantity: qty, price, position, orderId, time: '' });
const sell = (id, qty, price, position, orderId, account = 'ACC1', instrument = 'MNQ SEP26') =>
  ({ id, accountName: account, instrument, action: 'Sell', quantity: qty, price, position, orderId, time: '' });

describe('what the previous close left open', () => {
  it('hands over the open lots at their real prices, with the strategy that opened them', () => {
    const { byAccount, priorDate, days } = carryForwardLots({
      dailyImports: [close('2026-08-17', [buy('1_1', 2, 100, '2 L', 'P1')], [{ id: 'P1', strategyName: 'Alpha-1.0' }])],
      date: '2026-08-18',
    });
    expect(days).toBe(1);
    expect(priorDate).toBe('2026-08-17');
    expect(byAccount.get('ACC1')).toEqual({
      available: true,
      reason: '',
      priorDate: '2026-08-17',
      lots: [{ instrument: 'MNQ SEP26', side: 1, qty: 2, price: 100, strategyName: 'Alpha-1.0' }],
    });
  });

  it('carries a lot across more than one stored close', () => {
    // Opened Monday, still open Tuesday night, sold Wednesday. A replay that
    // only looked at the immediately preceding close would lose the basis.
    const { byAccount } = carryForwardLots({
      dailyImports: [
        close('2026-08-17', [buy('1_1', 1, 100, '1 L', 'P1')], [{ id: 'P1', strategyName: 'Alpha-1.0' }]),
        close('2026-08-18', [buy('2_1', 1, 120, '2 L', 'P2')], [{ id: 'P2', strategyName: 'Alpha-1.0' }]),
      ],
      date: '2026-08-19',
    });
    expect(byAccount.get('ACC1').available).toBe(true);
    expect(byAccount.get('ACC1').lots.map((lot) => lot.price)).toEqual([100, 120]);
  });

  it('reports nothing open when the stored closes all ended flat', () => {
    const { byAccount } = carryForwardLots({
      dailyImports: [close('2026-08-17', [buy('1_1', 1, 100, '1 L', 'P1'), sell('2_1', 1, 110, '-', 'P2')], [])],
      date: '2026-08-18',
    });
    expect(byAccount.get('ACC1')).toMatchObject({ available: true, lots: [] });
  });

  it('is absent for an account with no stored close at all', () => {
    const { byAccount } = carryForwardLots({ dailyImports: [], date: '2026-08-18' });
    expect(byAccount.size).toBe(0);
    // Absent is what deriveStrategyPnl reads as 'no-history' — nobody looked.
    expect(deriveStrategyPnl({
      executions: [sell('1_1', 1, 110, '1 L', 'O1')],
      orders: [{ id: 'O1', strategyName: 'Alpha-1.0' }],
      reportedGross: 400,
      carryIn: byAccount.get('ACC1') || null,
    }).refusedBooks[0].carryInReason).toBe('no-history');
  });

  it('ignores closes on or after the day being derived, so a re-import cannot feed itself', () => {
    const { byAccount, days } = carryForwardLots({
      dailyImports: [
        close('2026-08-18', [buy('1_1', 1, 100, '1 L', 'P1')], []),
        close('2026-08-19', [buy('2_1', 5, 999, '6 L', 'P2')], []),
      ],
      date: '2026-08-18',
    });
    expect(days).toBe(0);
    expect(byAccount.size).toBe(0);
  });
});

describe('a gap in the book', () => {
  it('refuses when a stored close needed a position the replay never held', () => {
    // Monday is missing. Tuesday's first fill sells from 1 long that nothing in
    // the history opened, so the chain is broken and everything after it rests
    // on a basis nobody has.
    const { byAccount } = carryForwardLots({
      dailyImports: [close('2026-08-18', [sell('1_1', 1, 110, '-', 'P1'), buy('2_1', 1, 105, '1 L', 'P2')], [])],
      date: '2026-08-19',
    });
    expect(byAccount.get('ACC1')).toMatchObject({ available: false, reason: CARRY_IN_REASONS.GAP });
  });

  it('keeps the quantities honest through the break, so the next day still lines up', () => {
    // The lot it could not price is still counted. A replay that dropped it
    // would come out one contract short and the NEXT day's Position check would
    // report a second, phantom gap instead of the real one.
    const { byAccount } = carryForwardLots({
      // Already 1 short when this close opens, and 1 more sold inside it.
      dailyImports: [close('2026-08-18', [sell('1_1', 1, 110, '2 S', 'P1')], [])],
      date: '2026-08-19',
    });
    const entry = byAccount.get('ACC1');
    expect(entry.available).toBe(false);
    expect(entry.lots.reduce((n, lot) => n + lot.side * lot.qty, 0)).toBe(-2);
    expect(entry.lots.filter((lot) => lot.price == null)).toHaveLength(1);
  });

  it('refuses when the lots it would hand over have no price', () => {
    const { byAccount } = carryForwardLots({
      dailyImports: [close('2026-08-18', [sell('1_1', 1, 110, '1 L', 'P1')], [])],
      date: '2026-08-19',
    });
    expect(byAccount.get('ACC1').available).toBe(false);
    expect(byAccount.get('ACC1').lots.some((lot) => lot.price == null)).toBe(true);
  });
});

describe('end to end, the thing the one-day script cannot do', () => {
  it('prices yesterday\'s lot sold today, and refuses the same day without the history', () => {
    const history = [close('2026-08-17', [buy('1_1', 2, 100, '2 L', 'P1')], [{ id: 'P1', strategyName: 'Alpha-1.0' }])];
    const today = {
      executions: [sell('9_1', 2, 110, '-', 'O1')],
      orders: [{ id: 'O1', strategyName: 'Alpha-1.0' }],
      reportedGross: 40,
    };

    const { byAccount } = carryForwardLots({ dailyImports: history, date: '2026-08-18' });
    const withHistory = deriveStrategyPnl({ ...today, carryIn: byAccount.get('ACC1') });
    expect(withHistory.status).toBe('exact');
    expect(withHistory.byStrategy).toEqual([{ strategyName: 'Alpha-1.0', realized: 40, pairs: 1 }]);

    const withoutHistory = deriveStrategyPnl({ ...today, carryIn: null });
    expect(withoutHistory.status).toBe('refused');
    expect(withoutHistory.byStrategy).toEqual([]);
  });

  it('keeps each account\'s carry-in to itself', () => {
    const { byAccount } = carryForwardLots({
      dailyImports: [close('2026-08-17', [
        buy('1_1', 1, 100, '1 L', 'P1', 'ACC1'),
        buy('2_1', 1, 500, '1 L', 'P1', 'ACC2'),
      ], [{ id: 'P1', strategyName: 'Alpha-1.0' }])],
      date: '2026-08-18',
    });
    expect(byAccount.get('ACC1').lots).toEqual([{ instrument: 'MNQ SEP26', side: 1, qty: 1, price: 100, strategyName: 'Alpha-1.0' }]);
    expect(byAccount.get('ACC2').lots).toEqual([{ instrument: 'MNQ SEP26', side: 1, qty: 1, price: 500, strategyName: 'Alpha-1.0' }]);
  });
});
