import { describe, expect, it, vi } from 'vitest';
import { accountsNamedBy, addStoredFills, storedFillsFromRows, withStoredFills } from './storedFills.js';

/* The day's stored fills, handed back to the derivation (step 73). The
 * database half of the same identity is asserted by the step 73 cluster test;
 * this is the JavaScript half: what is added, what is not, and that a failed
 * read never costs the close. */

const accounts = [{ id: 'a1', account_name: 'APEX 01' }, { id: 'a2', account_name: 'APEX 02' }];

function storedExecution(over = {}) {
  return {
    id: 'row-1', trading_account_id: 'a1', external_execution_id: 'E1', external_order_id: 'O1',
    strategy_name: '0 - OGX-PF-2.4', instrument: 'MNQ 12-26', action: 'Buy', quantity: '1', price: '21000.25',
    time_text: '2026-10-22 10:00:00', entry_exit: 'Entry', position: '1L', name: 'Entry', commission: null,
    rate: '1', connection: 'Northwind', ...over,
  };
}

function storedOrder(over = {}) {
  return {
    id: 'row-o1', trading_account_id: 'a1', external_order_id: 'O1', strategy_name: '0 - OGX-PF-2.4',
    instrument: 'MNQ 12-26', action: 'Buy', order_type: 'Market', quantity: '1', limit_price: null, stop_price: null,
    state: 'Filled', filled: '1', avg_price: '21000.25', remaining: '0', name: 'Entry', time_text: '2026-10-22 10:00:00',
    ...over,
  };
}

const captured = (over = {}) => ({
  id: 'E2', orderId: 'O2', accountName: 'APEX 01', instrument: 'MNQ 12-26', action: 'Sell', quantity: 1,
  price: 21010, time: '2026-10-22 15:00:00', ...over,
});

describe('storedFillsFromRows', () => {
  it('maps the stored rows to the normalizer\'s shape, keeps nulls as nulls and marks each one fromStore', () => {
    const stored = storedFillsFromRows({ executions: [storedExecution()], orders: [storedOrder()], accounts });
    expect(stored.executions).toEqual([{
      id: 'E1', orderId: 'O1', accountName: 'APEX 01', strategyName: '0 - OGX-PF-2.4', instrument: 'MNQ 12-26',
      action: 'Buy', quantity: 1, price: 21000.25, time: '2026-10-22 10:00:00', entryExit: 'Entry', position: '1L',
      name: 'Entry', commission: null, rate: 1, connection: 'Northwind', fromStore: true,
    }]);
    expect(stored.orders).toEqual([{
      id: 'O1', accountName: 'APEX 01', strategyName: '0 - OGX-PF-2.4', instrument: 'MNQ 12-26', action: 'Buy',
      orderType: 'Market', quantity: 1, limit: null, stop: null, state: 'Filled', filled: 1, avgPrice: 21000.25,
      remaining: 0, name: 'Entry', time: '2026-10-22 10:00:00', fromStore: true,
    }]);
  });

  it('drops a row whose account it cannot name, which no capture could match', () => {
    const stored = storedFillsFromRows({ executions: [storedExecution({ trading_account_id: null })], accounts });
    expect(stored.executions).toEqual([]);
  });
});

describe('withStoredFills', () => {
  const stored = storedFillsFromRows({
    executions: [
      storedExecution(),
      storedExecution({ id: 'row-2', external_execution_id: 'E2', external_order_id: 'O2', action: 'Sell', price: '21010', time_text: '2026-10-22 15:00:00' }),
      storedExecution({ id: 'row-3', trading_account_id: 'a2', external_execution_id: 'E9' }),
    ],
    orders: [storedOrder(), storedOrder({ id: 'row-o2', trading_account_id: 'a2', external_order_id: 'O9' })],
    accounts,
  });

  it('adds, for the accounts the capture names, the stored fills and orders it does not list', () => {
    const parsed = {
      accounts: [{ accountName: 'APEX 01' }],
      executions: [captured()],
      orders: [{ id: 'O2', accountName: 'APEX 01', state: 'Filled' }],
    };
    const { parsed: union, added } = withStoredFills(parsed, stored);
    expect(added).toEqual({ executions: 1, orders: 1 });
    expect(union.executions.map((row) => [row.id, row.fromStore === true])).toEqual([['E2', false], ['E1', true]]);
    expect(union.orders.map((row) => [row.id, row.fromStore === true])).toEqual([['O2', false], ['O1', true]]);
    expect(parsed.executions).toHaveLength(1);
  });

  it('never names an account the capture does not, and returns the capture itself when nothing is missing', () => {
    const parsed = { accounts: [{ accountName: 'apex 01' }], executions: [captured(), captured({ id: 'E1', orderId: 'O1', action: 'Buy', price: 21000.25, time: '2026-10-22 10:00:00' })], orders: [{ id: 'O1', accountName: 'APEX 01' }] };
    const result = withStoredFills(parsed, stored);
    expect(result.parsed).toBe(parsed);
    expect(result.added).toEqual({ executions: 0, orders: 0 });
  });

  it('an order in both is the capture\'s', () => {
    const parsed = { accounts: [{ accountName: 'APEX 01' }], orders: [{ id: 'O1', accountName: 'APEX 01', state: 'Working' }] };
    const { parsed: union } = withStoredFills(parsed, stored);
    expect(union.orders.filter((row) => row.id === 'O1')).toEqual([{ id: 'O1', accountName: 'APEX 01', state: 'Working' }]);
  });

  it('matches fills without an id by their fallback identity and by multiplicity', () => {
    const twin = { id: '', orderId: '', accountName: 'APEX 01', instrument: 'MNQ 12-26', action: 'Buy', quantity: 1, price: 21000, time: '2026-10-22 09:31:00' };
    const twins = storedFillsFromRows({
      executions: [1, 2, 3].map((n) => storedExecution({ id: `t${n}`, external_execution_id: '', external_order_id: '', price: '21000.00', time_text: '2026-10-22 09:31:00' })),
      accounts,
    });
    const { added } = withStoredFills({ accounts: [{ accountName: 'APEX 01' }], executions: [twin, { ...twin, quantity: '1' }] }, twins);
    expect(added.executions).toBe(1);
  });
});

describe('addStoredFills', () => {
  const parsed = { accounts: [{ accountName: 'APEX 01' }], executions: [], orders: [] };

  it('reads the day once and hands back the union', async () => {
    const store = { loadStoredFills: vi.fn(async () => storedFillsFromRows({ executions: [storedExecution()], accounts })) };
    const result = await addStoredFills({ store, clientId: 'c1', date: '2026-10-22', parsed });
    expect(store.loadStoredFills).toHaveBeenCalledWith('c1', '2026-10-22');
    expect(result.executions.map((row) => row.id)).toEqual(['E1']);
  });

  it('a store without the reader and a read that fails both leave the capture as it came, and the failure is reported', async () => {
    expect(await addStoredFills({ store: {}, clientId: 'c1', date: '2026-10-22', parsed })).toBe(parsed);
    const report = vi.fn(() => { throw new Error('the reporter fails too'); });
    const store = { loadStoredFills: async () => { throw Object.assign(new Error('timeout'), { code: '57014' }); } };
    expect(await addStoredFills({ store, clientId: 'c1', date: '2026-10-22', parsed, report })).toBe(parsed);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ code: '57014' }));
  });
});

describe('accountsNamedBy', () => {
  it('is every account any of the four sections names, lower cased and trimmed', () => {
    expect([...accountsNamedBy({
      accounts: [{ accountName: ' APEX 01 ' }],
      strategies: [{ accountName: 'APEX 02' }],
      orders: [{ accountName: '' }],
      executions: [{ accountName: 'apex 01' }],
    })].sort()).toEqual(['apex 01', 'apex 02']);
  });
});
