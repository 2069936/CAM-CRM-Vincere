import { describe, expect, it } from 'vitest';
import { JOIN_KEYS, collapsedJoins } from './redactionJoins.mjs';

// Synthetic only. Nothing here reads a real or redacted export; the shapes below
// are the two columns the fill pipeline joins on and nothing else.

const sourceBook = () => ({
  orders: [
    { external_order_id: '4200001', strategy_name: 'RBO-1.8', name: 'Enter Long' },
    { external_order_id: '4200002', strategy_name: 'IFSP-1.1', name: 'Stop Short' },
    { external_order_id: '4200003', strategy_name: '', name: 'PT1-Short' },
  ],
  executions: [
    { external_order_id: '4200001', external_execution_id: '9001_1' },
    { external_order_id: '4200002', external_execution_id: '9001_2' },
    { external_order_id: '4200003', external_execution_id: '9002_1' },
  ],
});

/** A 1:1 rename, which is what ID_FIELDS' token() does. */
const renamed = (book, prefix = 'x') => ({
  orders: book.orders.map((row) => ({ ...row, external_order_id: `${prefix}${row.external_order_id}` })),
  executions: book.executions.map((row) => ({
    ...row,
    external_order_id: `${prefix}${row.external_order_id}`,
    external_execution_id: `${prefix}${row.external_execution_id}`,
  })),
});

/** What `[redacted N]` does: every value of the same length becomes one value. */
const lengthBucketed = (book) => ({
  orders: book.orders.map((row) => ({ ...row, external_order_id: `[redacted ${row.external_order_id.length}]` })),
  executions: book.executions.map((row) => ({
    ...row,
    external_order_id: `[redacted ${row.external_order_id.length}]`,
    external_execution_id: `[redacted ${row.external_execution_id.length}]`,
  })),
});

describe('collapsedJoins', () => {
  it('passes a redaction that renames every id 1:1', () => {
    expect(collapsedJoins(sourceBook(), renamed(sourceBook()))).toEqual([]);
  });

  it('refuses a book whose join key was collapsed to a length bucket', () => {
    const failures = collapsedJoins(sourceBook(), lengthBucketed(sourceBook()));
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.join('\n')).toContain('orders.external_order_id');
    expect(failures.join('\n')).toContain('3 distinct values collapsed to 1');
  });

  it('names the execution id column separately from the order id column', () => {
    const book = sourceBook();
    const half = renamed(book);
    // Only the ordering-basis column collapses; the exec->order join is intact.
    half.executions = half.executions.map((row) => ({ ...row, external_execution_id: '[redacted 6]' }));
    const failures = collapsedJoins(book, half);
    expect(failures.join('\n')).toContain('executions.external_execution_id');
    expect(failures.join('\n')).not.toContain('orders.external_order_id');
  });

  it('refuses a redaction that keeps both sides distinct but stops them meeting', () => {
    // Distinct counts survive on both tables; the two sides are tokenised by
    // different recipes, so not one fill can find its order. Counting alone
    // would wave this through.
    const book = sourceBook();
    const split = renamed(book, 'a');
    split.orders = book.orders.map((row) => ({ ...row, external_order_id: `b${row.external_order_id}` }));
    const failures = collapsedJoins(book, split);
    expect(failures.join('\n')).toContain('executions -> orders on external_order_id');
    expect(failures.join('\n')).toContain('100.0% of fills found their order before redaction, 0.0% after');
  });

  it('says nothing about a book with no fills to join', () => {
    expect(collapsedJoins({ orders: [], executions: [] }, { orders: [], executions: [] })).toEqual([]);
  });

  it('covers both sides of the executions -> orders join and the ordering basis', () => {
    // The list is the contract. A column dropped from it is a column nothing
    // will ever check again, which is exactly how external_order_id shipped.
    expect(JOIN_KEYS).toEqual(expect.arrayContaining([
      ['executions', 'external_order_id'],
      ['orders', 'external_order_id'],
      ['executions', 'external_execution_id'],
    ]));
  });
});
