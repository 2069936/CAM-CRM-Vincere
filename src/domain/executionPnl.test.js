import { describe, it, expect } from 'vitest';
import { instrumentRoot, specForInstrument } from './instrumentSpecs';
import { computeExecutionPnl } from './executionPnl';

describe('instrumentRoot', () => {
  it('extracts the contract root from NinjaTrader instrument labels', () => {
    expect(instrumentRoot('NQ JUN26')).toBe('NQ');
    expect(instrumentRoot('M2K JUN26')).toBe('M2K');
    expect(instrumentRoot('NG JUL26')).toBe('NG');
    expect(instrumentRoot('NQZ25')).toBe('NQ');
  });
  it('knows the common specs', () => {
    expect(specForInstrument('NQ JUN26').pointValue).toBe(20);
    expect(specForInstrument('GC JUN26').pointValue).toBe(100);
    expect(specForInstrument('WHAT JUN26')).toBeNull();
  });
});

describe('computeExecutionPnl', () => {
  it('realizes PnL on a winning long round trip (NQ $20/pt)', () => {
    const execs = [
      { accountName: 'A1', instrument: 'NQ JUN26', price: 19000, quantity: 2, position: 'Long', entryExit: 'Entry' },
      { accountName: 'A1', instrument: 'NQ JUN26', price: 19010, quantity: 2, position: 'Flat', entryExit: 'Exit' },
    ];
    const [row] = computeExecutionPnl(execs);
    expect(row.realizedPnl).toBe(400); // 10 pts * 2 * 20
    expect(row.ticksMoved).toBe(40); // 10 / 0.25
    expect(row.roundTrips).toBe(1);
  });

  it('realizes a short profit when price drops', () => {
    const execs = [
      { accountName: 'A1', instrument: 'NQ JUN26', price: 19000, quantity: 1, position: 'Short', entryExit: 'Entry' },
      { accountName: 'A1', instrument: 'NQ JUN26', price: 18990, quantity: 1, position: 'Flat', entryExit: 'Exit' },
    ];
    const [row] = computeExecutionPnl(execs);
    expect(row.realizedPnl).toBe(200); // 10 pts down * 1 * 20
  });

  it('flags instruments without a spec instead of guessing PnL', () => {
    const execs = [
      { accountName: 'A1', instrument: 'ZZZ JUN26', price: 100, quantity: 1, position: 'Long', entryExit: 'Entry' },
      { accountName: 'A1', instrument: 'ZZZ JUN26', price: 110, quantity: 1, position: 'Flat', entryExit: 'Exit' },
    ];
    const [row] = computeExecutionPnl(execs);
    expect(row.realizedPnl).toBe(0);
    expect(row.unknownInstruments).toContain('ZZZ');
  });
});
