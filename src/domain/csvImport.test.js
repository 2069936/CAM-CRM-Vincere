import { describe, expect, it } from 'vitest';
import {
  detectNinjaTraderFileType,
  normalizeHeader,
  normalizeStrategyFamily,
  parseNinjaTraderCsvText,
  parseStrategyParameters,
  parseStrategyVersion,
  parseCurrency,
  summarizeUploadTypes,
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

  it('detects an accounts file whose header is "Realized PnL" (not "Gross realized PnL")', () => {
    const csv = [
      'ConnectionStatus,Connection,Display name,Unrealized PnL,Realized PnL,Excess intraday margin,Cash value',
      'Connected,Live,2018219,0,-1071.95,27904.09,27904.09',
    ].join('\n');

    const parsed = parseNinjaTraderCsvText(csv, 'NinjaTrader Grid.csv');

    expect(detectNinjaTraderFileType(parsed.headers)).toBe('accounts');
    expect(parsed.type).toBe('accounts');
    expect(parsed.rows[0]).toMatchObject({
      accountName: '2018219',
      grossRealizedPnl: -1071.95,
      accountBalance: 27904.09,
    });
  });

  it('prefers non-zero Realized PnL over Gross realized PnL when both are exported', () => {
    const csv = [
      'Display name,Cash value,Gross realized PnL,Realized PnL',
      'ACC123,50100,-357,-376.8',
    ].join('\n');

    const parsed = parseNinjaTraderCsvText(csv, 'accounts.csv');

    expect(parsed.rows[0].grossRealizedPnl).toBe(-376.8);
  });

  it('falls back to Gross realized PnL when Realized PnL resets to zero', () => {
    const csv = [
      'Display name,Cash value,Gross realized PnL,Realized PnL',
      'ACC123,50100,-497,0',
    ].join('\n');

    const parsed = parseNinjaTraderCsvText(csv, 'accounts.csv');

    expect(parsed.rows[0].grossRealizedPnl).toBe(-497);
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

  it('detects executions files by entry/exit headers', () => {
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

describe('summarizeUploadTypes', () => {
  it('is complete when all four required types are present', () => {
    const files = ['accounts', 'strategies', 'orders', 'executions'].map((type) => ({ type, fileName: `${type}.csv` }));
    const summary = summarizeUploadTypes(files);
    expect(summary.isComplete).toBe(true);
    expect(summary.missingTypes).toEqual([]);
    expect(summary.unknownFiles).toEqual([]);
  });

  it('flags the missing types when a file is not provided', () => {
    const files = [{ type: 'accounts', fileName: 'a.csv' }, { type: 'strategies', fileName: 's.csv' }];
    const summary = summarizeUploadTypes(files);
    expect(summary.isComplete).toBe(false);
    expect(summary.missingTypes).toEqual(['orders', 'executions']);
  });

  it('flags unknown (unrecognized) files by name and marks the upload incomplete', () => {
    const files = [
      { type: 'accounts', fileName: 'a.csv' }, { type: 'strategies', fileName: 's.csv' },
      { type: 'orders', fileName: 'o.csv' }, { type: 'executions', fileName: 'e.csv' },
      { type: 'unknown', fileName: 'mystery.csv' },
    ];
    const summary = summarizeUploadTypes(files);
    expect(summary.isComplete).toBe(false);
    expect(summary.unknownFiles).toEqual(['mystery.csv']);
    expect(summary.missingTypes).toEqual([]);
  });
});

describe('normalizeHeader', () => {
  it('lowercases and removes spaces, dots, and special chars', () => {
    expect(normalizeHeader('Gross Realized P&L')).toBe('grossrealizedpl');
    expect(normalizeHeader('Account Display Name')).toBe('accountdisplayname');
    expect(normalizeHeader('Entry/Exit')).toBe('entryexit');
  });

  it('handles null and empty input without throwing', () => {
    expect(normalizeHeader(null)).toBe('');
    expect(normalizeHeader('')).toBe('');
    expect(normalizeHeader(undefined)).toBe('');
  });
});

describe('normalizeStrategyFamily', () => {
  it('extracts known family from NT-prefixed name', () => {
    expect(normalizeStrategyFamily('0 - RBO-1.8')).toBe('RBO');
    expect(normalizeStrategyFamily('2 - IFSP-2.0')).toBe('IFSP');
    expect(normalizeStrategyFamily('1 - OGX-1.0')).toBe('OGX');
  });

  it('normalizes PF suffix to FAMILY_PF format', () => {
    expect(normalizeStrategyFamily('0 - RBO-PF-1.8')).toBe('RBO_PF');
    expect(normalizeStrategyFamily('1 - IFSP-PF-2.0')).toBe('IFSP_PF');
  });

  it('identifies Bullet Bot by keyword regardless of prefix', () => {
    expect(normalizeStrategyFamily('0 - BulletBot-3.0')).toBe('Bullet Bot');
    expect(normalizeStrategyFamily('Bullet Bot v2')).toBe('Bullet Bot');
  });

  it('uppercases unknown families instead of returning Unknown', () => {
    expect(normalizeStrategyFamily('0 - CUSTOM-1.0')).toBe('CUSTOM');
  });

  it('returns Unknown for empty or null input', () => {
    expect(normalizeStrategyFamily('')).toBe('Unknown');
    expect(normalizeStrategyFamily(null)).toBe('Unknown');
  });
});

describe('optional grid columns must not read as zero', () => {
  // A CAM who has not enabled "Trailing max drawdown" exports a file without it.
  // Reading that as 0 would record a confident number nobody measured and leave
  // every drawdown flag silent, which is how an account dies unnoticed.
  it('reports an absent trailing column as unknown, not as zero', () => {
    const withoutColumn = parseNinjaTraderCsvText(
      'Display name,Cash value,Realized PnL\nROME-7045,49352.84,-1100\n',
      'accounts.csv',
    ).rows[0];
    expect(withoutColumn.trailingMaxDrawdown).toBeNull();
    expect(withoutColumn.weeklyPnl).toBeNull();
  });

  it('reports an empty cell as unknown too', () => {
    const emptyCell = parseNinjaTraderCsvText(
      'Display name,Cash value,Realized PnL,Trailing max drawdown,Weekly PnL\nROME-7045,49352.84,-1100,,\n',
      'accounts.csv',
    ).rows[0];
    expect(emptyCell.trailingMaxDrawdown).toBeNull();
    expect(emptyCell.weeklyPnl).toBeNull();
  });

  it('still reads a real value, including a genuine zero', () => {
    const populated = parseNinjaTraderCsvText(
      'Display name,Cash value,Realized PnL,Trailing max drawdown,Weekly PnL\nROME-7045,49352.84,-1100,888.48,0\n',
      'accounts.csv',
    ).rows[0];
    expect(populated.trailingMaxDrawdown).toBe(888.48);
    expect(populated.weeklyPnl).toBe(0);
  });

  // The Strategies grid's Realized column is switchable too, and one client
  // folder in a real export was captured without it. Read as 0 it became a
  // CLAIM — "this strategy made nothing" — about a strategy that had lost
  // $1,115, and a cross-check then scored the absence as a disagreement with the
  // derivation that had it right. Absent has to stay absent.
  it('reports an absent strategy Realized column as unknown, not as zero', () => {
    const row = parseNinjaTraderCsvText(
      'Enabled,Parameters,Account display name,Strategy,Instrument,Data series,Connection\nTrue,raw,MFF123,0 - Bullet Bot-1.1,NQ SEP26,20 Second,Lucid\n',
      'strategies.csv',
    ).rows[0];
    expect(row.realized).toBeNull();
    expect(row.unrealized).toBeNull();
  });

  it('keeps a strategy Realized of exactly zero as a reported zero', () => {
    const row = parseNinjaTraderCsvText(
      'Enabled,Parameters,Account display name,Strategy,Instrument,Realized,Unrealized,Data series,Connection\nTrue,raw,MFF123,0 - Bullet Bot-1.1,NQ SEP26,$0.00,$0.00,20 Second,Lucid\n',
      'strategies.csv',
    ).rows[0];
    expect(row.realized).toBe(0);
    expect(row.unrealized).toBe(0);
  });
});

describe('gross realized PnL is kept apart from the net figure', () => {
  // mapAccount prefers 'Realized PnL' when the grid exported both, and that
  // column is NET of commissions — it differed from gross on 19 of 21 traded
  // accounts on the export this was measured against. A FIFO derivation
  // reproduces GROSS, so it needs the raw column, not the blend.
  it('preserves the raw Gross realized PnL column alongside the blended field', () => {
    const row = parseNinjaTraderCsvText(
      'Display name,Cash value,Gross realized PnL,Realized PnL\nACC1,50000,-1115.00,-1128.36\n',
      'accounts.csv',
    ).rows[0];
    expect(row.grossRealizedPnl).toBe(-1128.36);
    expect(row.grossRealizedPnlReported).toBe(-1115);
  });

  it('reports an accounts grid with no gross column as unknown rather than zero', () => {
    const row = parseNinjaTraderCsvText(
      'Display name,Cash value,Realized PnL\nACC1,50000,-1128.36\n',
      'accounts.csv',
    ).rows[0];
    expect(row.grossRealizedPnlReported).toBeNull();
  });
});

describe('grids are classified by header, never by column count or filename', () => {
  // The defect that produced the original "Bullet Bot" mystery. A throwaway
  // probe sniffed orders as `'Strategy' in row && 'Avg. price' in row`; one
  // client had the optional "Avg. price" column switched on in the STRATEGIES
  // grid, that file sorted first alphabetically, and the id->strategy map
  // collapsed to a single undefined key — every one of that client's fills fell
  // through to "(manual)". detectNinjaTraderFileType is already header-truthful;
  // this pins it so nothing re-sniffs headers ad hoc.
  it('classifies a strategies grid that also carries Avg. price as strategies', () => {
    const parsed = parseNinjaTraderCsvText(
      'Strategy,Instrument,Account display name,Parameters,Avg. price,Realized,Unrealized,Enabled\n0 - Bullet Bot-1.1,NQ SEP26,ACC1,raw,23145.25,($100.00),$0.00,True\n',
      'NinjaTrader Grid 2026-08-18 04-07 PM2.csv',
    );
    expect(parsed.type).toBe('strategies');
  });

  it('still classifies the orders grid in the same export as orders', () => {
    const parsed = parseNinjaTraderCsvText(
      'Instrument,Action,Type,Quantity,Avg. price,State,Filled,Remaining,Name,Strategy,Account display name,ID,Time\nNQ SEP26,Buy,Market,1,23145.25,Filled,1,0,Close,,ACC1,12345,8/18/2026 9:30:01 AM\n',
      'NinjaTrader Grid 2026-08-18 04-07 PM3.csv',
    );
    expect(parsed.type).toBe('orders');
    expect(parsed.rows[0]).toMatchObject({ id: '12345', name: 'Close', strategyName: '' });
  });
});
