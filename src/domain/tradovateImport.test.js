import { describe, expect, it } from 'vitest';
import {
  detectTradovateFileType,
  parseTradovateCsv,
  parseTradovateMoney,
  summarizeTradovateAccount,
  summarizeTradovateByDay,
  tradovateDate,
  tradovateInstrumentRoot,
} from './tradovateImport';

describe('parseTradovateMoney', () => {
  it('reads plain, dollar and parenthesised negatives', () => {
    expect(parseTradovateMoney('430.00')).toBe(430);
    expect(parseTradovateMoney('$430.00')).toBe(430);
    expect(parseTradovateMoney('$(200.00)')).toBe(-200);
    expect(parseTradovateMoney('-330.00')).toBe(-330);
    expect(parseTradovateMoney('$0.00')).toBe(0);
    expect(parseTradovateMoney('')).toBe(0);
    expect(parseTradovateMoney('$1,250.50')).toBe(1250.5);
  });
});

describe('tradovateInstrumentRoot', () => {
  it('strips the contract month and year', () => {
    expect(tradovateInstrumentRoot('MNQM6')).toBe('MNQ');
    expect(tradovateInstrumentRoot('M2KU6')).toBe('M2K');
    expect(tradovateInstrumentRoot('NGN6')).toBe('NG');
  });
});

describe('tradovateDate', () => {
  it('converts MM/DD/YYYY to ISO without a timezone shift', () => {
    expect(tradovateDate('06/01/2026 09:17:47')).toBe('2026-06-01');
    expect(tradovateDate('2026-06-01')).toBe('2026-06-01');
    expect(tradovateDate('')).toBe('');
  });
});

const PERFORMANCE_CSV = `symbol,_priceFormat,_priceFormatType,_tickSize,buyFillId,sellFillId,qty,buyPrice,sellPrice,pnl,boughtTimestamp,soldTimestamp,duration
NGN6,-3,0,0.001,111,112,1,3.181,3.224,$430.00,06/01/2026 09:17:47,06/01/2026 08:42:39,35min 8sec
MNQM6,-2,0,0.25,113,114,2,30354.50,30304.50,$(200.00),06/01/2026 10:08:09,06/01/2026 10:00:02,8min 6sec
MNQM6,-2,0,0.25,115,116,1,30467.25,30522.25,$110.00,06/02/2026 11:17:33,06/02/2026 11:30:31,12min 57sec`;

const POSITION_HISTORY_CSV = `Position ID,Timestamp,Trade Date,Net Pos,Net Price,Bought,Avg. Buy,Sold,Avg. Sell,Account,Contract,Product,Product Description,_priceFormat,_priceFormatType,_tickSize,Pair ID,Buy Fill ID,Sell Fill ID,Paired Qty,Buy Price,Sell Price,P/L,Currency,Bought Timestamp,Sold Timestamp
1,06/01/2026 09:17:47,2026-06-01,0,,1,3.181,1,3.224,1665298,NGN6,NG,Natural Gas,-3,0,0.001,2,3,4,1,3.181,3.224,430.00,USD,06/01/2026 09:17:47,06/01/2026 08:42:39
2,06/01/2026 11:49:30,2026-06-01,0,,4,30410.88,4,30410.81,1665298,MNQM6,MNQ,Micro E-mini NASDAQ-100,-2,0,0.25,5,6,7,2,30354.50,30304.50,-200.00,USD,06/01/2026 10:08:09,06/01/2026 10:00:02`;

describe('detectTradovateFileType', () => {
  it('recognises the two P/L exports', () => {
    expect(detectTradovateFileType(PERFORMANCE_CSV.split('\n')[0].split(','))).toBe('performance');
    expect(detectTradovateFileType(POSITION_HISTORY_CSV.split('\n')[0].split(','))).toBe('positionHistory');
  });

  it('does not misread an unrelated file', () => {
    expect(detectTradovateFileType(['a', 'b', 'c'])).toBe('unknown');
  });
});

describe('parseTradovateCsv', () => {
  it('parses the Performance export into trades', () => {
    const { type, trades } = parseTradovateCsv(PERFORMANCE_CSV);
    expect(type).toBe('performance');
    expect(trades).toHaveLength(3);
    expect(trades[0]).toMatchObject({ instrument: 'NG', pnl: 430, date: '2026-06-01' });
    expect(trades[1].pnl).toBe(-200);
  });

  it('parses the Position History export, keeping the account', () => {
    const { type, trades } = parseTradovateCsv(POSITION_HISTORY_CSV);
    expect(type).toBe('positionHistory');
    expect(trades).toHaveLength(2);
    expect(trades[0]).toMatchObject({ account: '1665298', instrument: 'NG', pnl: 430, date: '2026-06-01' });
    expect(trades[1].pnl).toBe(-200);
  });
});

describe('summaries', () => {
  const { trades } = parseTradovateCsv(PERFORMANCE_CSV);

  it('rolls P/L up per day with a win rate', () => {
    const byDay = summarizeTradovateByDay(trades);
    expect(byDay).toHaveLength(2);
    expect(byDay[0]).toMatchObject({ date: '2026-06-01', realizedPnl: 230, trades: 2, wins: 1, losses: 1 });
    expect(byDay[0].winRate).toBe(0.5);
    expect(byDay[1]).toMatchObject({ date: '2026-06-02', realizedPnl: 110 });
  });

  it('rolls up the whole account', () => {
    const summary = summarizeTradovateAccount(trades);
    expect(summary.realizedPnl).toBe(340);
    expect(summary.trades).toBe(3);
    expect(summary.wins).toBe(2);
    expect(summary.tradingDays).toBe(2);
    expect(summary.firstDate).toBe('2026-06-01');
    expect(summary.lastDate).toBe('2026-06-02');
    expect(summary.avgDurationSec).toBeGreaterThan(0);
    expect(summary.byInstrument.find((r) => r.instrument === 'NG').realizedPnl).toBe(430);
  });
});
