import { describe, expect, it } from 'vitest';
import { detectNinjaTraderFileType, parseNinjaTraderCsvText } from './csvImport';

describe('csvImport', () => {
  it('detects accounts files by headers regardless of column order', () => {
    const csv = [
      'Weekly PnL,Display name,Connection,Cash value,Gross realized PnL,Trailing max drawdown,Unrealized PnL,ConnectionStatus',
      '12.5,ACC123,Lucid,50100,100,-250,0,Connected',
    ].join('\n');

    const parsed = parseNinjaTraderCsvText(csv, 'random-name.csv');

    expect(detectNinjaTraderFileType(parsed.headers)).toBe('accounts');
    expect(parsed.type).toBe('accounts');
    expect(parsed.rows[0]).toMatchObject({
      accountName: 'ACC123',
      connection: 'Lucid',
      grossRealizedPnl: 100,
      trailingMaxDrawdown: -250,
      accountBalance: 50100,
      weeklyPnl: 12.5,
    });
  });

  it('detects strategies files and parses account strategy links by header', () => {
    const csv = [
      'Enabled,Parameters,Account display name,Strategy,Instrument,Realized,Unrealized,Data series,Connection',
      'True,False/10/key/Long/2,MFF123,0 - Bullet Bot-1.1,NQ JUN26,($100.00),$0.00,20 Second,My Funded Futures',
    ].join('\n');

    const parsed = parseNinjaTraderCsvText(csv, 'strategies.csv');

    expect(parsed.type).toBe('strategies');
    expect(parsed.rows[0]).toMatchObject({
      accountName: 'MFF123',
      strategyName: '0 - Bullet Bot-1.1',
      strategyFamily: 'Bullet Bot',
      instrument: 'NQ JUN26',
      enabled: true,
      realized: -100,
    });
  });

  it('detects orders files by headers regardless of file name', () => {
    const csv = [
      'State,Account display name,Strategy,Instrument,Action,Type,Quantity,Limit,Stop,Filled,Avg. price,Remaining,Name,ID,Time',
      'Working,ACC1,0 - RBO-1.8,M2K JUN26,Sell,Limit,2,2957.8,0,0,0,2,PT3-Long,42,6/2/2026 10:47:46 AM',
    ].join('\n');

    const parsed = parseNinjaTraderCsvText(csv, 'anything.csv');

    expect(parsed.type).toBe('orders');
    expect(parsed.rows[0]).toMatchObject({
      accountName: 'ACC1',
      strategyName: '0 - RBO-1.8',
      state: 'Working',
      action: 'Sell',
      quantity: 2,
    });
  });

  it('detects executions or positions files by entry exit headers', () => {
    const csv = [
      'Account display name,E/X,Instrument,Action,Quantity,Price,Time,Order ID,Name,Connection',
      'ACC1,Entry,NQ JUN26,Buy,2,19000,6/2/2026 9:30:00 AM,99,Enter Long,Lucid',
    ].join('\n');

    const parsed = parseNinjaTraderCsvText(csv, 'positions.csv');

    expect(parsed.type).toBe('executions');
    expect(parsed.rows[0]).toMatchObject({
      accountName: 'ACC1',
      entryExit: 'Entry',
      price: 19000,
      quantity: 2,
    });
  });
});
