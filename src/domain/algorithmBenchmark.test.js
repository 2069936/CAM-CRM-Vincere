import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BENCHMARK_MIN_COMMON_CLOSES,
  benchmarkBasisLabel,
  benchmarkMonthlyRows,
  buildBenchmarkSeries,
  parseBenchmarkCsv,
  parseBenchmarkDateTime,
  parseBenchmarkMoney,
  parseBenchmarkRiskLevel,
  splitBenchmarkInstrument,
  summarizeBenchmarkImport,
} from './algorithmBenchmark';

/* Synthetic and fixture backed, never book backed: nothing here reads
 * public/local-snapshot.json, so this suite runs on a clone that does not hold
 * the export. The fixture is 40 lines of the desk's own
 * RBO_-_M2K_-_Low_Risk.csv download, kept byte for byte (CRLF, `$` amounts,
 * `($307.80)` negatives and the trailing comma on every line) so that a parser
 * that only works on a cleaned up file fails here. */
const FIXTURE_NAME = 'RBO_-_M2K_-_Low_Risk.sample.csv';
const fixture = readFileSync(
  new URL('../../test/fixtures/algorithm-benchmark/RBO_-_M2K_-_Low_Risk.sample.csv', import.meta.url),
  'utf8',
);

const HEADER = 'Trade number,Instrument,Account,Strategy,Market pos.,Qty,Entry price,Exit price,Entry time,Exit time,Entry name,Exit name,Profit,Cum. net profit,Commission,Clearing Fee,Exchange Fee,IP Fee,NFA Fee,MAE,MFE,ETD,Bars,';

// A trade list in the vendor's exact shape: CRLF, a trailing comma on every
// line, money as "$94.20" / "($307.80)", dates as "1/6/2020 8:50:00 AM".
function tradeList(trades, { account = 'Backtest', strategy = '0 - RBO-1.8', instrument = 'M2K 09-26' } = {}) {
  let cumulative = 0;
  const lines = trades.map((trade, index) => {
    cumulative = Math.round((cumulative + trade.profit) * 100) / 100;
    const cells = [
      index + 1,
      trade.instrument || instrument,
      account,
      trade.strategy || strategy,
      trade.direction || 'Long',
      trade.qty ?? 2,
      '1929.2',
      '1932.6',
      trade.entry,
      trade.exit,
      'Enter Long',
      'Exit Long Market',
      dollars(trade.profit),
      dollars(cumulative),
      dollars(trade.commission ?? 0),
      '$0.00', '$0.00', '$0.00', '$0.00', '$75.00', '$252.00', '$157.80', '40',
    ];
    return `${cells.join(',')},`;
  });
  return [HEADER, ...lines].join('\r\n') + '\r\n';
}

function dollars(value) {
  const text = Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return value < 0 ? `($${text})` : `$${text}`;
}

describe('reading a My Futures Book trade list', () => {
  it('parses the desk\'s own download: one algorithm, its version, its instrument', () => {
    const parsed = parseBenchmarkCsv(fixture, FIXTURE_NAME);
    expect(parsed.ok).toBe(true);
    expect(parsed.trades).toHaveLength(39);
    const [series, ...rest] = buildBenchmarkSeries([parsed]);
    expect(rest).toHaveLength(0);
    expect(series.algorithm).toBe('RBO');
    expect(series.version).toBe('1.8');
    expect(series.instrument).toBe('M2K');
    expect(series.contractMonths).toEqual(['09-26']);
    expect(series.firstDate).toBe('2020-01-03');
    expect(series.lastDate).toBe('2020-02-27');
    expect(series.history.trades).toBe(39);
    expect(series.history.days).toBe(32);
  });

  it('takes the risk level from the file name, because the file does not carry it', () => {
    expect(parseBenchmarkCsv(fixture, FIXTURE_NAME).riskLevel).toBe('Low');
    expect(parseBenchmarkRiskLevel('ARPD_-_MGC_-_Medium_Risk.csv')).toBe('Medium');
    expect(parseBenchmarkRiskLevel('FSA - MNQ - High Risk.csv')).toBe('High');
    expect(parseBenchmarkRiskLevel('FSA_-_MNQ.csv')).toBe('');
  });

  it('reads the vendor\'s money: dollar signs, thousands separators and parenthesised negatives', () => {
    expect(parseBenchmarkMoney('$94.20')).toBe(94.2);
    expect(parseBenchmarkMoney('($307.80)')).toBe(-307.8);
    expect(parseBenchmarkMoney('$1,234.56')).toBe(1234.56);
    expect(parseBenchmarkMoney('($1,234.56)')).toBe(-1234.56);
    expect(parseBenchmarkMoney('$0.00')).toBe(0);
    // Absent is not zero, and a word is not a number. Both have to come back
    // null so the file is refused rather than counted at 0.
    expect(parseBenchmarkMoney('')).toBeNull();
    expect(parseBenchmarkMoney('   ')).toBeNull();
    expect(parseBenchmarkMoney(null)).toBeNull();
    expect(parseBenchmarkMoney('n/a')).toBeNull();

    const parsed = parseBenchmarkCsv(fixture, FIXTURE_NAME);
    const loss = parsed.trades.find((trade) => trade.tradeNumber === 3);
    expect(loss.net).toBe(-307.8);
    expect(loss.commission).toBe(7.8);
  });

  it('reads the vendor\'s dates without letting the runner\'s timezone choose the day', () => {
    expect(parseBenchmarkDateTime('1/6/2020 8:50:00 AM')).toEqual({
      date: '2020-01-06',
      at: Date.UTC(2020, 0, 6, 8, 50, 0),
    });
    // Midnight and noon are the two the 12-hour clock gets wrong.
    expect(parseBenchmarkDateTime('3/9/2021 12:05:00 AM').at).toBe(Date.UTC(2021, 2, 9, 0, 5, 0));
    expect(parseBenchmarkDateTime('3/9/2021 12:05:00 PM').at).toBe(Date.UTC(2021, 2, 9, 12, 5, 0));
    expect(parseBenchmarkDateTime('12/31/2026 4:51:00 PM').date).toBe('2026-12-31');
    expect(parseBenchmarkDateTime('8/31/2026').date).toBe('2026-08-31');
    expect(parseBenchmarkDateTime('31/8/2026')).toBeNull();
    expect(parseBenchmarkDateTime('')).toBeNull();
    expect(parseBenchmarkDateTime('yesterday')).toBeNull();
  });

  it('keeps the contract month out of the instrument and beside it', () => {
    expect(splitBenchmarkInstrument('M2K 09-26')).toEqual({ symbol: 'M2K', contract: '09-26' });
    expect(splitBenchmarkInstrument('NG 08-26')).toEqual({ symbol: 'NG', contract: '08-26' });
    expect(splitBenchmarkInstrument('MNQ')).toEqual({ symbol: 'MNQ', contract: '' });
  });

  it('dates a trade by its exit, which is the day the money is realised', () => {
    const csv = tradeList([
      { entry: '1/6/2020 10:20:00 PM', exit: '1/7/2020 9:05:00 AM', profit: 100, commission: 7.8 },
      { entry: '1/7/2020 10:20:00 AM', exit: '1/7/2020 4:51:00 PM', profit: -50, commission: 7.8 },
    ], {});
    const parsed = parseBenchmarkCsv(csv, 'RBO_-_M2K_-_Low_Risk.csv');
    expect(parsed.trades.map((trade) => trade.date)).toEqual(['2020-01-07', '2020-01-07']);
    expect(parsed.trades[0].entryDate).toBe('2020-01-06');
    expect(parsed.warnings.join(' ')).toContain('1 of 2 trades exited on a later date');
    const [series] = buildBenchmarkSeries([parsed]);
    expect(series.days).toHaveLength(1);
    expect(series.days[0]).toMatchObject({ date: '2020-01-07', trades: 2, net: 50 });
  });
});

describe('what the numbers mean', () => {
  it('treats Profit as already net of commission, and reconciles against the file\'s own running total', () => {
    const parsed = parseBenchmarkCsv(fixture, FIXTURE_NAME);
    // Trade 1 of the real download: 3.4 points of M2K at 6 lots is $102.00 of
    // move, the file reports Profit $94.20 and Commission $7.80. Adding the
    // Commission column to Profit and calling it net double-counts.
    const first = parsed.trades[0];
    expect(first.net).toBe(94.2);
    expect(first.commission).toBe(7.8);
    expect(first.gross).toBe(102);

    const [series] = buildBenchmarkSeries([parsed]);
    expect(series.history.net).toBe(-203.2);
    expect(series.history.commission).toBe(252.2);
    expect(series.history.gross).toBe(49);
    expect(series.history.gross).toBe(series.history.net + series.history.commission);
    // The file's last `Cum. net profit` is the vendor's own answer.
    expect(series.reconciliation.reportedNet).toBe(-203.2);
    expect(series.reconciliation.difference).toBe(0);
    expect(series.reconciliation.matches).toBe(true);
  });

  it('says so when its sum and the file\'s own running total disagree', () => {
    const csv = tradeList([
      { entry: '1/6/2020 10:20:00 AM', exit: '1/6/2020 4:51:00 PM', profit: 100, commission: 7.8 },
      { entry: '1/7/2020 10:20:00 AM', exit: '1/7/2020 4:51:00 PM', profit: 40, commission: 7.8 },
    ], {}).replace('$140.00', '$999.00');
    const [series] = buildBenchmarkSeries([parseBenchmarkCsv(csv, 'RBO_-_M2K_-_Low_Risk.csv')]);
    expect(series.history.net).toBe(140);
    expect(series.reconciliation.reportedNet).toBe(999);
    expect(series.reconciliation.matches).toBe(false);
    expect(series.reconciliation.difference).toBe(-859);
  });

  it('counts a win as a trade above zero and leaves a flat trade in the denominator', () => {
    const csv = tradeList([
      { entry: '1/6/2020 10:20:00 AM', exit: '1/6/2020 4:51:00 PM', profit: 100, commission: 7.8 },
      { entry: '1/7/2020 10:20:00 AM', exit: '1/7/2020 4:51:00 PM', profit: -40, commission: 7.8 },
      { entry: '1/8/2020 10:20:00 AM', exit: '1/8/2020 4:51:00 PM', profit: 0, commission: 7.8 },
      { entry: '1/9/2020 10:20:00 AM', exit: '1/9/2020 4:51:00 PM', profit: 60, commission: 7.8 },
    ], {});
    const [series] = buildBenchmarkSeries([parseBenchmarkCsv(csv, 'RBO_-_M2K_-_Low_Risk.csv')]);
    expect(series.history).toMatchObject({ trades: 4, wins: 2, losses: 1, scratches: 1 });
    expect(series.history.winRate).toBe(0.5);
  });

  it('measures drawdown peak to trough inside the window, with the curve reset at its start', () => {
    // Jan: +300, -500, +100  → curve 300, -200, -100. Deepest fall from the
    // 300 peak is 500, on 1/8.
    // Feb: -200, -100        → curve -200, -300. The curve is reset at the
    // month's start, so the fall is measured from zero: 300.
    // All history: curve 300, -200, -100, -300, -400. Peak 300 on 1/6, trough
    // -400 on 2/7 → 700, which is larger than either month's own fall and is
    // not the sum of them either.
    const csv = tradeList([
      { entry: '1/6/2020 10:20:00 AM', exit: '1/6/2020 4:51:00 PM', profit: 300, commission: 7.8 },
      { entry: '1/8/2020 10:20:00 AM', exit: '1/8/2020 4:51:00 PM', profit: -500, commission: 7.8 },
      { entry: '1/9/2020 10:20:00 AM', exit: '1/9/2020 4:51:00 PM', profit: 100, commission: 7.8 },
      { entry: '2/5/2020 10:20:00 AM', exit: '2/5/2020 4:51:00 PM', profit: -200, commission: 7.8 },
      { entry: '2/7/2020 10:20:00 AM', exit: '2/7/2020 4:51:00 PM', profit: -100, commission: 7.8 },
    ], {});
    const [series] = buildBenchmarkSeries([parseBenchmarkCsv(csv, 'RBO_-_M2K_-_Low_Risk.csv')]);
    const [january, february] = series.months;
    expect(january).toMatchObject({ month: '2020-01', maxDrawdown: 500, drawdownFrom: '2020-01-06', drawdownTo: '2020-01-08' });
    expect(february).toMatchObject({ month: '2020-02', maxDrawdown: 300, drawdownFrom: '2020-02-05', drawdownTo: '2020-02-07' });
    expect(series.history).toMatchObject({ maxDrawdown: 700, drawdownFrom: '2020-01-06', drawdownTo: '2020-02-07' });
    // A window that only rises has no drawdown, and that is 0, not "unknown".
    const rising = buildBenchmarkSeries([
      parseBenchmarkCsv(
        tradeList([
          { entry: '1/6/2020 10:20:00 AM', exit: '1/6/2020 4:51:00 PM', profit: 100, commission: 7.8 },
          { entry: '1/7/2020 10:20:00 AM', exit: '1/7/2020 4:51:00 PM', profit: 50, commission: 7.8 },
        ], {}),
        'RBO_-_M2K_-_Low_Risk.csv',
      ),
    ])[0];
    expect(rising.history.maxDrawdown).toBe(0);
    expect(rising.history.drawdownFrom).toBeNull();
  });

  it('adds up: the days, the months and all history hold the same trades and the same dollars', () => {
    const [series] = buildBenchmarkSeries([parseBenchmarkCsv(fixture, FIXTURE_NAME)]);
    const sum = (rows, field) => Math.round(rows.reduce((total, row) => total + row[field], 0) * 100) / 100;
    for (const field of ['trades', 'net', 'commission', 'gross', 'wins', 'losses']) {
      expect(sum(series.days, field)).toBe(series.history[field]);
      expect(sum(series.months, field)).toBe(series.history[field]);
    }
    expect(sum(series.days, 'trades')).toBe(39);
    expect(series.months.map((month) => month.month)).toEqual(['2020-01', '2020-02']);
  });

  it('records what the file actually traded, which is not one contract', () => {
    // docs/stack-playbook-spec.md described My Futures Book as "one contract"
    // before these files existed. This 40 line sample alone carries two sizes,
    // and the full download runs to 36 in one file.
    const [series] = buildBenchmarkSeries([parseBenchmarkCsv(fixture, FIXTURE_NAME)]);
    expect(series.quantities).toEqual([2, 6]);
    expect(series.quantityRange).toEqual({ min: 2, max: 6 });
    expect(series.history.contracts).toBe(194);
  });

  it('never merges two risk levels into one series, because a win rate moves with the sizing', () => {
    const low = parseBenchmarkCsv(
      tradeList([{ entry: '1/6/2020 10:20:00 AM', exit: '1/6/2020 4:51:00 PM', profit: 100, commission: 7.8, qty: 2 }], {}),
      'RBO_-_M2K_-_Low_Risk.csv',
    );
    const high = parseBenchmarkCsv(
      tradeList([
        { entry: '1/6/2020 10:20:00 AM', exit: '1/6/2020 4:51:00 PM', profit: 300, commission: 23.4, qty: 6 },
        { entry: '1/6/2020 10:20:00 AM', exit: '1/6/2020 4:51:00 PM', profit: 100, commission: 7.8, qty: 2 },
      ], {}),
      'RBO_-_M2K_-_High_Risk.csv',
    );
    const series = buildBenchmarkSeries([low, high]);
    expect(series).toHaveLength(2);
    expect(series.map((entry) => entry.riskLevel)).toEqual(['Low', 'High']);
    expect(series.map((entry) => entry.history.trades)).toEqual([1, 2]);
  });

  it('labels every series with its basis, naming the risk level and the instrument', () => {
    const [series] = buildBenchmarkSeries([parseBenchmarkCsv(fixture, FIXTURE_NAME)]);
    expect(series.basis).toBe(
      'My Futures Book backtest of RBO 1.8. One simulated account, Low risk sizing, M2K, algorithm alone, net of commission. Not client account results.',
    );
    expect(benchmarkBasisLabel({})).toContain('risk sizing not stated');
  });

  it('keeps the threshold the desk would need before comparing with client accounts', () => {
    expect(BENCHMARK_MIN_COMMON_CLOSES).toBe(20);
  });

  it('measures the commission rate instead of assuming one, because it belongs to the instrument', () => {
    // M2K pays $1.30 a contract per round turn; MGC pays $1.80, YM $4.36, NG
    // and PL $4.80. A single rate written into this module would be right for
    // one of the desk's twelve algorithms.
    const [series] = buildBenchmarkSeries([parseBenchmarkCsv(fixture, FIXTURE_NAME)]);
    expect(series.history.commissionPerContract).toBe(1.3);
    expect(series.history.commission).toBe(
      Math.round(series.history.contracts * 1.3 * 100) / 100,
    );
    // A window with no contracts has no rate; 0 would read as "free".
    expect(series.months.every((month) => month.commissionPerContract === 1.3)).toBe(true);
  });
});

describe('what it refuses, and why it says so', () => {
  it('refuses a file that is not a trade list, naming the columns it wanted', () => {
    const refused = parseBenchmarkCsv('Instrument,Account,Qty\r\nM2K 09-26,Backtest,2\r\n', 'RBO_-_M2K_-_Low_Risk.csv');
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain('not a My Futures Book trade list');
    expect(refused.reason).toContain('"Trade number"');
    expect(refused.reason).toContain('"Exit time"');
    expect(refused.reason).toContain('"Profit"');
  });

  it('refuses a file whose Account column is not Backtest, with the message the spec fixes', () => {
    const live = fixture.replace(/Backtest/g, 'Sim101');
    const refused = parseBenchmarkCsv(live, FIXTURE_NAME);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe(
      'This file is not a My Futures Book backtest: the Account column reads "Sim101". Import refused.',
    );
  });

  it('refuses a file whose name does not carry a risk level', () => {
    const refused = parseBenchmarkCsv(fixture, 'RBO_-_M2K.csv');
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain('The risk level is not in the file name "RBO_-_M2K.csv"');
  });

  it('refuses an empty file and a header with no trades, rather than importing nothing as something', () => {
    expect(parseBenchmarkCsv('', 'RBO_-_M2K_-_Low_Risk.csv').reason).toBe('This file is empty. Import refused.');
    expect(parseBenchmarkCsv(`${HEADER}\r\n`, 'RBO_-_M2K_-_Low_Risk.csv').reason).toBe(
      'This file has a trade list header and no trades. Import refused.',
    );
  });

  it('refuses the whole file when a row\'s money or date cannot be read, instead of counting it as zero', () => {
    const csv = tradeList([
      { entry: '1/6/2020 10:20:00 AM', exit: '1/6/2020 4:51:00 PM', profit: 100, commission: 7.8 },
      { entry: '1/7/2020 10:20:00 AM', exit: '1/7/2020 4:51:00 PM', profit: -40, commission: 7.8 },
    ], {});
    const noProfit = csv.replace('($40.00)', '');
    const refusedMoney = parseBenchmarkCsv(noProfit, 'RBO_-_M2K_-_Low_Risk.csv');
    expect(refusedMoney.ok).toBe(false);
    expect(refusedMoney.reason).toContain('cannot read (first at line 3)');
    expect(refusedMoney.reason).toContain('must not be counted as zero');

    const noExit = csv.replace('1/7/2020 4:51:00 PM', '');
    const refusedDate = parseBenchmarkCsv(noExit, 'RBO_-_M2K_-_Low_Risk.csv');
    expect(refusedDate.ok).toBe(false);
    expect(refusedDate.reason).toContain('Exit time this import cannot read (first at line 3)');
  });
});

describe('what the import card is handed', () => {
  it('summarizes the accepted files, the refused ones and the rows that would be written', () => {
    const accepted = parseBenchmarkCsv(fixture, FIXTURE_NAME);
    const refused = parseBenchmarkCsv('nothing like a trade list', 'ARPD_-_MGC_-_High_Risk.csv');
    const summary = summarizeBenchmarkImport([accepted, refused]);
    expect(summary.totals).toMatchObject({
      files: 1,
      series: 1,
      trades: 39,
      monthlyRows: 2,
      firstDate: '2020-01-03',
      lastDate: '2020-02-27',
      riskLevels: ['Low'],
      reconciled: 1,
      unreconciled: 0,
      unchecked: 0,
    });
    // A series whose file carried no running total to check against is counted
    // apart from one that was checked and agreed.
    const noCheck = summarizeBenchmarkImport([
      parseBenchmarkCsv(fixture.replace(/,Cum\. net profit/, ',Ignored column'), FIXTURE_NAME),
    ]);
    expect(noCheck.totals).toMatchObject({ reconciled: 0, unreconciled: 0, unchecked: 1 });

    expect(summary.rejected).toEqual([
      { fileName: 'ARPD_-_MGC_-_High_Risk.csv', reason: expect.stringContaining('not a My Futures Book trade list') },
    ]);
  });

  it('writes one monthly row per algorithm, version, instrument, risk level and month', () => {
    const rows = benchmarkMonthlyRows(buildBenchmarkSeries([parseBenchmarkCsv(fixture, FIXTURE_NAME)]));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      vendor: 'My Futures Book',
      algorithm: 'RBO',
      version: '1.8',
      instrument: 'M2K',
      riskLevel: 'Low',
      month: '2020-01-01',
      trades: 22,
      tradingDays: 18,
      contracts: 108,
      grossProfit: 702,
      commission: 140.4,
      netProfit: 561.6,
      winRate: 14 / 22,
      // Measured, not assumed: $1.30 a contract per round turn is M2K's rate.
      // MGC pays $1.80, YM $4.36, NG and PL $4.80, which is why no constant
      // in this module claims to know it.
      commissionPerContract: 1.3,
      maxDrawdown: 1129.2,
      sourceFile: FIXTURE_NAME,
    });
    // The database's unique key. Two rows sharing it would double a month.
    const keys = rows.map((row) => [row.algorithm, row.version, row.instrument, row.riskLevel, row.month].join('|'));
    expect(new Set(keys).size).toBe(keys.length);
    // Every month is stored on the first of the month, which is what the
    // migration's own check constraint enforces.
    expect(rows.every((row) => row.month.endsWith('-01'))).toBe(true);
    // The stored gross is the stored net plus the stored commission, the one
    // arithmetic relation the table asserts about itself.
    expect(rows.every((row) => Math.abs(row.grossProfit - (row.netProfit + row.commission)) < 0.01)).toBe(true);
  });
});
