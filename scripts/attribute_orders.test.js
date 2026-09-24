import { describe, expect, it } from 'vitest';
import { toOrders, toTemplate } from './attribute_orders.mjs';
import { attributeOrders } from '../src/domain/orderAttribution.js';

// Synthetic only. Nothing here reads a real export or a real book.

describe('a catalogue row as the matcher reads it', () => {
  it('renames the columns without touching the numbers', () => {
    expect(toTemplate({
      family: 'G4M', version: 'v1', risk: 'Low', instrument: 'MES', prop_firm: true,
      size_1: 2, size_2: 1, size_3: 1,
      stop_ticks: 80, target_1_ticks: 80, target_2_ticks: 120, target_3_ticks: 160,
    })).toEqual({
      family: 'G4M', version: 'v1', risk: 'Low', instrument: 'MES', propFirm: true,
      size1: 2, size2: 1, size3: 1,
      stopTicks: 80, target1Ticks: 80, target2Ticks: 120, target3Ticks: 160,
    });
  });
});

describe('putting one account-day in order', () => {
  const at = (clock, id) => ({
    id: `u${id}`, external_order_id: String(id), time_text: clock,
    name: 'Enter Long', instrument: 'MES', quantity: 1,
    limit_price: null, stop_price: null, avg_price: 100, strategy_name: null,
  });

  it('reads the clock instead of sorting it as text', () => {
    // "10:00 AM" sorts before "9:35 AM" as a string, which reorders a whole
    // morning and hands the first trade's targets to the second.
    const ordered = toOrders([
      at('8/18/2026 10:00:00 AM', 2),
      at('8/18/2026 9:35:00 AM', 1),
      at('8/18/2026 1:05:00 PM', 3),
    ]);
    expect(ordered.map((order) => order.id)).toEqual(['u1', 'u2', 'u3']);
    expect(ordered.map((order) => order.time)).toEqual([0, 1, 2]);
  });

  it('reads the other format the same grid writes', () => {
    const ordered = toOrders([at('2:43:30 PM', 2), at('9:35:00 AM', 1)]);
    expect(ordered.map((order) => order.id)).toEqual(['u1', 'u2']);
  });

  it('breaks a same-second tie on the order id, which NinjaTrader makes monotonic', () => {
    const ordered = toOrders([
      at('8/18/2026 9:35:00 AM', 100),
      at('8/18/2026 9:35:00 AM', 99),
    ]);
    expect(ordered.map((order) => order.id)).toEqual(['u99', 'u100']);
  });

  it('keeps an unreadable clock at the front rather than dropping the order', () => {
    const ordered = toOrders([at('8/18/2026 9:35:00 AM', 2), at('', 1)]);
    expect(ordered.map((order) => order.id)).toEqual(['u1', 'u2']);
  });

  it('renames the price columns the engine reads', () => {
    const [order] = toOrders([{
      id: 'u1', external_order_id: '1', time_text: '9:30:00 AM', name: 'PT1-Long',
      instrument: 'MES', quantity: 2, limit_price: 120, stop_price: 0, avg_price: null,
      strategy_name: 'Bullet Bot-1.1',
    }]);
    expect(order).toMatchObject({ limitPrice: 120, stopPrice: 0, avgPrice: null, strategyName: 'Bullet Bot-1.1' });
  });
});

describe('one account-day end to end', () => {
  const G4M = {
    family: 'G4M', version: 'v1', risk: 'Low', instrument: 'MES', prop_firm: false,
    size_1: 2, size_2: 1, size_3: 1,
    stop_ticks: 80, target_1_ticks: 80, target_2_ticks: 120, target_3_ticks: 160,
  };

  it('names the algorithm for a day the platform no longer remembers', () => {
    // Which is the whole point: Strategy2Order is cascade-deleted when the
    // strategy leaves the workspace, so strategy_name is null on 18,798 of
    // 18,827 orders across the seven months measured.
    const entry = 7691.25;
    const rows = [
      { id: 'u1', external_order_id: '1', time_text: '9:30:00 AM', name: 'Enter Short', instrument: 'MES', quantity: 4, avg_price: entry, limit_price: 0, stop_price: 0, strategy_name: null },
      { id: 'u2', external_order_id: '2', time_text: '9:31:00 AM', name: 'PT1-Short', instrument: 'MES', quantity: 2, limit_price: entry - 20, stop_price: 0, avg_price: null, strategy_name: null },
      { id: 'u3', external_order_id: '3', time_text: '9:32:00 AM', name: 'Stop Short', instrument: 'MES', quantity: 4, stop_price: entry + 20, limit_price: 0, avg_price: null, strategy_name: null },
    ];
    const answers = attributeOrders(toOrders(rows), [toTemplate(G4M)]);
    expect(answers).toHaveLength(3);
    expect(answers.every((answer) => answer.family === 'G4M' && answer.basis === 'inferred')).toBe(true);
  });
});
