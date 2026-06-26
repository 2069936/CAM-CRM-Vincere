import { describe, expect, it } from 'vitest';
import {
  detectNinjaTraderFileType,
  parseNinjaTraderCsvText,
  parseStrategyParameters,
  parseStrategyVersion,
  parseCurrency,
} from './csvImport';

describe('parseCurrency', () => {
  it('parses plain numbers', () => {
    expect(parseCurrency('1234.56')).toBe(1234.56);
    expect(parseCurrency(1234.56)).toBe(1234.56);
  });

  it('strips dollar signs and commas', () => {
    expect(parseCurrency('$1,234.56')).toBe(1234.56);
    expect(parseCurrency('$50,000')).toBe(50000);
  });

  it('converts accounting parentheses negatives used in NT exports', () => {
    expect(parseCurrency('(1,234.56)')).toBe(-1234.56);
    expect(parseCurrency('($500)')).toBe(-500);
  });

  it('returns 0 for empty or non-numeric input', () => {
    expect(parseCurrency('')).toBe(0);
    expect(parseCurrency(null)).toBe(0);
    expect(parseCurrency('N/A')).toBe(0);
  });
});

describe('parseStrategyVersion', () => {
  it('extracts the trailing version number from a strategy name', () => {
    expect(parseStrategyVersion('0 - ARPD-1.8')).toBe('1.8');
    expect(parseStrategyVersion('0 - Bullet Bot-1.1')).toBe('1.1');
  });

  it('returns empty string when no version is present', () => {
    expect(parseStrategyVersion('0 - RBO')).toBe('');
    expect(parseStrategyVersion('')).toBe('');
  });
});

describe('parseStrategyParameters', () => {
  it('parses named NinjaTrader parameters without splitting date values', () => {
    const parameters = '38/5/22/5/False/30/False/2/True/1/1/2020 4:45:00 PM/V-KEY-W/Both/3/3/2/125/150/200/127/100/1/1/2020 11:30:00 AM/1/1/2020 10:00:00 AM/True/70/15/True (B2X1/B2X2/B2X3/B2X4/Backtest/BreakEvenAfterTicks/BreakEvenIsOn/BreakEvenOffset/CloseAllOpenTrades/CloseAllOpenTradeTime/LicenseKey/MyTradeDirection/PosSize1/PosSize2/PosSize3/ProfitTargetTicks1/ProfitTargetTicks2/ProfitTargetTicks3/StartTrailAfterTicks/StopLossTicks/TradeEndTime/TradeStartTime/TradeWindowIsOn/TrailByTicks/TrailFrequency/TrailIsOn)';

    expect(parseStrategyParameters(parameters)).toMatchObject({
      parsed: true,
      direction: 'Both',
      posSizes: [3, 3, 2],
      profitTargets: [125, 150, 200],
      stopLossTicks: 100,
      tradeWindow: ['1/1/2020 10:00:00 AM', '1/1/2020 11:30:00 AM'],
      valuesByName: {
        CloseAllOpenTradeTime: '1/1/2020 4:45:00 PM',
        LicenseKey: 'V-KEY-W',
      },
    });
  });

  it('fails closed when parameter values cannot realign to names', () => {
    expect(parseStrategyParameters('1/2/3 (First/Second)')).toEqual({ parsed: false });
  });
});

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

  it('normalizes prop firm strategy families with PF suffix', () => {
    const csv = [
      'Strategy,Instrument,Account display name,Data series,Parameters,Unrealized,Realized,Connection,Enabled',
      '0 - IFSP-PF-1.1,NG JUL26,ACC1,8 Minute,raw,$0.00,$0.00,Legends Trading,True',
    ].join('\n');

    const parsed = parseNinjaTraderCsvText(csv, 'strategies.csv');

    expect(parsed.rows[0]).toMatchObject({
      strategyName: '0 - IFSP-PF-1.1',
      strategyFamily: 'IFSP_PF',
    });
  });

  it('infers strategy direction from NinjaTrader parameters when present', () => {
    const csv = [
      'Strategy,Instrument,Account display name,Data series,Parameters,Unrealized,Realized,Connection,Enabled',
      '0 - Bullet Bot-1.1,NQ JUN26,ACC1,20 Second,False/10/V-C0E19E-F6089795-EF0841W/Short/2/155/1/1/2020 9:29:30 AM/1/1/2020 9:27:00 AM/110/1/1/2020 9:30:20 AM/1/1/2020 9:27:00 AM/True (Backtest/EntryOrderTickOffset/LicenseKey/MyTradeDirection/PositionSize/ProfitTargetTicks/RangeEnd/RangeStart/StopLossTicks/TradeEnd1/TradeStart1/TradeWindow1IsOn),$0.00,$0.00,Lucid,True',
    ].join('\n');

    const parsed = parseNinjaTraderCsvText(csv, 'strategies.csv');

    expect(parsed.rows[0]).toMatchObject({
      strategyFamily: 'Bullet Bot',
      direction: 'Short',
      params: expect.objectContaining({
        parsed: true,
        direction: 'Short',
        stopLossTicks: 110,
      }),
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

  it('detects executions files by entry exit headers', () => {
    const csv = [
      'Account display name,E/X,Instrument,Action,Quantity,Price,Time,Order ID,Name,Connection',
      'ACC1,Entry,NQ JUN26,Buy,2,19000,6/2/2026 9:30:00 AM,99,Enter Long,Lucid',
    ].join('\n');

    const parsed = parseNinjaTraderCsvText(csv, 'executions.csv');

    expect(parsed.type).toBe('executions');
    expect(parsed.rows[0]).toMatchObject({
      accountName: 'ACC1',
      entryExit: 'Entry',
      price: 19000,
      quantity: 2,
    });
  });
});
