import { describe, it, expect } from 'vitest';
import { parseNinjaTraderLog, dateFromLogFilename, parseNinjaTraderLogFile, summarizeLogByAccount } from './ninjaTraderLog';

const SAMPLE = [
  "2026-07-10 10:21:19:415|1|32|Order='490243547664/LTD15072018970002' Name='Enter Short' New state='Filled' Instrument='M2K SEP26' Action='Sell short' Limit price=0 Stop price=0 Quantity=6 Type='Market' Time in force=GTC Oco='' Filled=6 Fill price=2986.3 Error='No error' Native error=''",
  "2026-07-10 10:21:19:410|1|8|Execution='490243547664_1' Instrument='M2K SEP26' Account='LTD15072018970002' Exchange=Default Price=2986.3 Quantity=6 Market position=Short Operation=Operation_Add Order='490243547664' Time='7/10/2026 10:21 AM'",
  "2026-07-10 03:14:57:487|1|4|Enabling NinjaScript strategy 'BulletBot/388413837' : On starting a real-time strategy - StartBehavior=WaitUntilFlat EntryHandling=All entries",
  "2026-07-10 03:14:47:107|1|4|Disabling NinjaScript strategy 'RBO_PF/388413843'",
  "2026-07-10 03:09:58:536|1|2|blueSky: Primary connection=Connected, Price feed=Connection lost",
  "not a valid log line",
].join('\n');

describe('parseNinjaTraderLog', () => {
  it('parses an order line with multi-word keys and quoted values', () => {
    const { orders } = parseNinjaTraderLog(SAMPLE);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      id: '490243547664',
      accountName: 'LTD15072018970002',
      name: 'Enter Short',
      state: 'Filled',
      instrument: 'M2K SEP26',
      action: 'Sell short',
      quantity: 6,
      orderType: 'Market',
      filled: 6,
      fillPrice: 2986.3,
      error: 'No error',
    });
    expect(orders[0].time).toBe('2026-07-10 10:21:19:415');
  });

  it('parses an execution line with market position and derives entry/exit', () => {
    const { executions } = parseNinjaTraderLog(SAMPLE);
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      id: '490243547664_1',
      accountName: 'LTD15072018970002',
      price: 2986.3,
      quantity: 6,
      position: 'Short',
      operation: 'Operation_Add',
      entryExit: 'Entry',
      orderId: '490243547664',
    });
  });

  it('parses enable/disable strategy events with account split', () => {
    const { strategyEvents } = parseNinjaTraderLog(SAMPLE);
    expect(strategyEvents).toHaveLength(2);
    expect(strategyEvents[0]).toMatchObject({ action: 'Enable', strategyName: 'BulletBot', accountName: '388413837' });
    expect(strategyEvents[1]).toMatchObject({ action: 'Disable', strategyName: 'RBO_PF', accountName: '388413843' });
  });

  it('ignores connection/noise lines and malformed lines', () => {
    const result = parseNinjaTraderLog(SAMPLE);
    // Only the 1 order + 1 execution + 2 strategy events are extracted.
    expect(result.meta.orders + result.meta.executions + result.meta.strategyEvents).toBe(4);
  });

  it('handles empty / undefined input without throwing', () => {
    expect(parseNinjaTraderLog('').orders).toHaveLength(0);
    expect(() => parseNinjaTraderLog(undefined)).not.toThrow();
  });
});

describe('NinjaTrader log file import (filename date + backfill)', () => {
  it('extracts the trading date from the filename', () => {
    expect(dateFromLogFilename('log.20260710.00000.txt')).toBe('2026-07-10');
    expect(dateFromLogFilename('trace.20260710.00000.en.txt')).toBe('2026-07-10');
    expect(dateFromLogFilename('log.txt')).toBe('');
    expect(dateFromLogFilename('log.20261340.00000.txt')).toBe(''); // invalid month/day
  });

  it('dates the parsed activity by filename', () => {
    const result = parseNinjaTraderLogFile('log.20260710.00000.txt', SAMPLE);
    expect(result.date).toBe('2026-07-10');
    expect(result.filename).toBe('log.20260710.00000.txt');
    expect(result.executions).toHaveLength(1);
  });

  it('rolls executions up per account with long/short direction', () => {
    const parsed = parseNinjaTraderLogFile('log.20260710.00000.txt', SAMPLE);
    const rows = summarizeLogByAccount(parsed);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      accountName: 'LTD15072018970002',
      date: '2026-07-10',
      fills: 1,
      contracts: 6,
      short: 1,
      long: 0,
    });
  });
});
