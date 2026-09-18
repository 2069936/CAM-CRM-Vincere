import Papa from 'papaparse';
import {
  normalizeHeader,
  normalizeStrategyFamily,
  parseCurrency,
  parseStrategyVersion,
} from './csvImport';

/**
 * My Futures Book backtest trade lists: parsing and aggregation.
 *
 * WHAT THESE FILES ARE, because every figure this module produces has to say so.
 *
 * The desk downloads one NinjaTrader trade list per algorithm x instrument x
 * risk level from its own portfolio page on myfuturesbook.com. `Account` reads
 * `Backtest` on every row of all 36 files. They are **backtests of the version
 * the desk runs today, re-run over history** — so a 2026-01 row is not what any
 * client experienced in January, it is what today's version would have done on
 * January's data. One simulated account, no client money, no survivorship
 * question because nothing here ever stopped.
 *
 * THREE TRAPS, each of them checked on all 68,146 trades of the real download
 * rather than assumed, and each of them wired into the shape of this module.
 *
 * 1. `Profit` is ALREADY NET of the separate `Commission` column. Verified by
 *    price arithmetic: RBO M2K Low trade 1 is 3.4 points on M2K at 6 lots =
 *    $102.00 of move, `Commission` $7.80, `Profit` $94.20. `Profit + Commission`
 *    matched the gross move on every checkable row of every file. So `net` is
 *    the sum of `Profit` and `gross` is `net + commission`; adding the
 *    Commission column to Profit and calling the result net double-counts it.
 *    `Cum. net profit` is the running sum of `Profit` (0 mismatches in 68,146
 *    trades), which is why every series carries a `reconciliation` block
 *    comparing our sum against the file's own running total.
 *
 * 2. THE RISK LEVEL IS NOT "ONE CONTRACT" AND IS NOT EVEN ONE SIZE. `Qty` varies
 *    *within* a single file as the strategy scales in and out: ARPD MGC Low
 *    holds 1, 2 and 4; RBO M2K High holds 6, 12, 18, 24 and 36. The risk level
 *    sets a base size, nothing more. `docs/stack-playbook-spec.md` section 3
 *    described My Futures Book as "one contract" before these files existed;
 *    that sentence is corrected on this branch because it is a false statement
 *    of basis. Every series here carries `quantities` so the label can say what
 *    the file actually traded, and `benchmarkBasisLabel` is the sentence to
 *    print wherever one of these numbers appears.
 *
 * 3. A WIN RATE FROM THESE FILES IS A PROPERTY OF THE FILE, NOT OF THE ALGORITHM.
 *    A larger base size splits one exit into more scale-out legs and every leg
 *    is its own `Trade number`, so the win count grows with the risk level while
 *    the loss count does not: IFSP over identical history reads 48.66% Low,
 *    61.26% Medium, 68.46% High. The risk level is part of every series key and
 *    of the basis label for exactly this reason, and no aggregate in this module
 *    ever spans two risk levels.
 *
 * WHAT THIS MODULE DOES NOT DO. It does not compare a benchmark series with
 * client account results. That comparison needs an overlap the book does not
 * have yet (see BENCHMARK_MIN_COMMON_CLOSES) and it needs a page that keeps the
 * two units in separate tables; neither lives here. This module is pure: text
 * in, aggregates out, no IO, no Supabase, no clock.
 */

export const BENCHMARK_VENDOR = 'My Futures Book';

export const BENCHMARK_RISK_LEVELS = ['Low', 'Medium', 'High'];

/*
 * There is no commission-rate constant here, deliberately.
 *
 * The rate is per instrument, not per vendor: measured over the desk's 36
 * files it is $1.30 a contract per round turn on the micros (M2K, MNQ, MES),
 * $1.80 on MGC, $4.36 on YM and $4.80 on NG and PL — and 3 PLPI trades carry
 * $0.00 against a non-zero Qty. A single "$1.80 per contract round turn"
 * written into the code would be right for one of twelve algorithms and wrong,
 * silently, for the rest. So every bucket reports `commissionPerContract` as
 * what its own rows actually paid: commission / contracts, measured, not
 * assumed, and null when there is nothing to divide.
 */

/**
 * Closes both series must hold in common before any agreement between a
 * benchmark series and this desk's client accounts may be stated.
 *
 * 20, and the number is an argument rather than a convention. Direction
 * agreement over n common closes is a coin toss under the null hypothesis, so at
 * n = 11 — the best-covered algorithm on today's book — 10 of the 11 would have
 * to agree before the result cleared a one-sided binomial at 5%, and a standard
 * nothing passes by skill is not a standard. At 20 the bar is 15 of 20, which a
 * real relationship can clear. Nothing in this repository computes an agreement
 * figure today; this constant exists so that the layer which eventually does has
 * one threshold to read rather than one to invent.
 */
export const BENCHMARK_MIN_COMMON_CLOSES = 20;

const REQUIRED_COLUMNS = [
  ['tradenumber', 'Trade number'],
  ['instrument', 'Instrument'],
  ['account', 'Account'],
  ['strategy', 'Strategy'],
  ['qty', 'Qty'],
  ['entrytime', 'Entry time'],
  ['exittime', 'Exit time'],
  ['profit', 'Profit'],
  ['commission', 'Commission'],
];

const BACKTEST_ACCOUNT = 'Backtest';

function money(value) {
  const rounded = Math.round(Math.abs(value) * 100) / 100;
  return value < 0 ? -rounded : rounded;
}

/**
 * Strict money, unlike `parseCurrency`, which reads an absent value as 0.
 *
 * A blank `Profit` is not a flat trade, it is a file this module does not
 * understand, and the same reasoning that keeps `parseOptionalCurrency` in
 * csvImport.js applies here one step harder: these rows are the only evidence
 * the series has. Returns null so the caller refuses the file by name and count
 * rather than importing a confident zero. The money grammar itself — `$`, thousands
 * separators, `($304.80)` for a negative — stays in `parseCurrency`, one grammar
 * for the whole codebase.
 */
export function parseBenchmarkMoney(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (!/^\(?-?\$?[\d,]*\.?\d+\)?$/.test(text.replace(/\s/g, ''))) return null;
  const parsed = parseCurrency(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * `1/6/2020 8:50:00 AM` → { date: '2020-01-06', at: <sortable> }.
 *
 * Month first: NinjaTrader wrote these in the US order, confirmed on the real
 * download where the first component never exceeds 12 and the second reaches 31.
 * Built from the components rather than handed to `new Date(string)`, which
 * would drag the runner's timezone into which calendar day a trade lands on.
 * `at` is a UTC millisecond value used only for ordering trades within a file.
 */
export function parseBenchmarkDateTime(value) {
  const text = String(value ?? '').trim();
  const match = text.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp])?\.?[Mm]?\.?)?$/,
  );
  if (!match) return null;
  const [, monthRaw, dayRaw, yearRaw, hourRaw, minuteRaw, secondRaw, meridiem] = match;
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const year = Number(yearRaw);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  let hour = hourRaw == null ? 0 : Number(hourRaw);
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    const isPm = /p/i.test(meridiem);
    hour = (hour % 12) + (isPm ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }
  const minute = minuteRaw == null ? 0 : Number(minuteRaw);
  const second = secondRaw == null ? 0 : Number(secondRaw);
  if (minute > 59 || second > 59) return null;
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return {
    date: `${pad(year, 4)}-${pad(month)}-${pad(day)}`,
    at: Date.UTC(year, month - 1, day, hour, minute, second),
  };
}

/**
 * `M2K 09-26` → { symbol: 'M2K', contract: '09-26' }.
 *
 * The contract month rolls inside a file — IFSP NG carries 08-26, 09-26 and
 * 10-26 — so the series is keyed on the symbol and the contract months seen are
 * kept beside it. They are the same instrument; they are not the same contract,
 * and a reader comparing months should be able to see which rolled.
 */
export function splitBenchmarkInstrument(value) {
  const text = String(value ?? '').trim();
  const match = text.match(/^(.+?)\s+(\d{2}-\d{2})$/);
  if (match) return { symbol: match[1].trim(), contract: match[2] };
  return { symbol: text, contract: '' };
}

/**
 * The risk level lives in the file name — `RBO_-_M2K_-_Low_Risk.csv` — and
 * nowhere inside the file. Returns '' when the name does not carry one, which
 * the parser treats as a refusal: an unlabelled risk level makes every figure in
 * the file unquotable (see trap 3 at the top of this file), so it must not be
 * guessed and must not default to Low.
 */
export function parseBenchmarkRiskLevel(fileName = '') {
  const match = String(fileName).match(/(low|medium|high)[\s_-]*risk/i);
  if (!match) return '';
  const word = match[1].toLowerCase();
  return word[0].toUpperCase() + word.slice(1);
}

/**
 * The sentence that must accompany any figure taken from these files, wherever
 * it appears — card, table, chart caption or stored row.
 */
export function benchmarkBasisLabel({ riskLevel = '', instrument = '', algorithm = '', version = '' } = {}) {
  const who = [algorithm, version].filter(Boolean).join(' ');
  const sizing = riskLevel ? `${riskLevel} risk sizing` : 'risk sizing not stated';
  const where = instrument ? `, ${instrument}` : '';
  return `${BENCHMARK_VENDOR} backtest${who ? ` of ${who}` : ''}. One simulated account, ${sizing}${where}, algorithm alone, net of commission. Not client account results.`;
}

function headerIndex(fields) {
  const byName = new Map();
  (fields || []).forEach((field, index) => {
    const key = normalizeHeader(field);
    if (key && !byName.has(key)) byName.set(key, index);
  });
  return byName;
}

function refusal(fileName, reason) {
  return { ok: false, fileName, reason, trades: [] };
}

/**
 * Parse one My Futures Book trade list.
 *
 * Returns `{ ok: true, fileName, riskLevel, trades, warnings }` or
 * `{ ok: false, fileName, reason }`. Every refusal reason is a complete sentence
 * naming what was found, because the person who sees it is holding 36 files and
 * needs to know which one to re-download.
 */
export function parseBenchmarkCsv(csvText, fileName = '') {
  const text = String(csvText ?? '');
  if (!text.trim()) return refusal(fileName, 'This file is empty. Import refused.');

  const riskLevel = parseBenchmarkRiskLevel(fileName);
  if (!riskLevel) {
    return refusal(
      fileName,
      `The risk level is not in the file name "${fileName}". A backtest figure cannot be labelled without it — the same algorithm reads a win rate up to 19.8 points apart depending only on which risk file was opened — so the import is refused. Keep the name My Futures Book downloads, for example "RBO_-_M2K_-_Low_Risk.csv".`,
    );
  }

  // header:false: the real files end every line with a trailing comma, which
  // gives the header row an unnamed 24th field. Papa's header mode turns that
  // into a duplicated empty key and silently renames it; reading by position off
  // the header row we build ourselves has no such surprise, and CRLF is handled
  // by Papa either way.
  const result = Papa.parse(text, { header: false, skipEmptyLines: true });
  const rows = result.data || [];
  if (!rows.length) return refusal(fileName, 'This file has no rows. Import refused.');

  const columns = headerIndex(rows[0]);
  const missing = REQUIRED_COLUMNS.filter(([key]) => !columns.has(key)).map(([, label]) => label);
  if (missing.length) {
    return refusal(
      fileName,
      `This file is not a ${BENCHMARK_VENDOR} trade list: the header has no ${missing
        .map((label) => `"${label}"`)
        .join(', ')} column${missing.length === 1 ? '' : 's'}. Export the trade list, not the summary. Import refused.`,
    );
  }

  const at = (row, key) => {
    const index = columns.get(key);
    return index == null ? '' : String(row[index] ?? '').trim();
  };

  const trades = [];
  const badMoney = [];
  const badDates = [];
  let crossedDay = 0;
  let cumulativeReported = null;

  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row || row.every((cell) => String(cell ?? '').trim() === '')) continue;
    const lineNumber = index + 1;

    const account = at(row, 'account');
    if (account !== BACKTEST_ACCOUNT) {
      return refusal(
        fileName,
        `This file is not a ${BENCHMARK_VENDOR} backtest: the Account column reads "${account}". Import refused.`,
      );
    }

    const net = parseBenchmarkMoney(at(row, 'profit'));
    const commission = parseBenchmarkMoney(at(row, 'commission'));
    if (net == null || commission == null) {
      badMoney.push(lineNumber);
      continue;
    }

    const exit = parseBenchmarkDateTime(at(row, 'exittime'));
    const entry = parseBenchmarkDateTime(at(row, 'entrytime'));
    if (!exit) {
      badDates.push(lineNumber);
      continue;
    }
    if (entry && entry.date !== exit.date) crossedDay += 1;

    const strategy = at(row, 'strategy');
    const instrument = splitBenchmarkInstrument(at(row, 'instrument'));
    const quantity = Number(at(row, 'qty'));
    const reportedCumulative = parseBenchmarkMoney(at(row, 'cumnetprofit'));
    if (reportedCumulative != null) cumulativeReported = reportedCumulative;

    trades.push({
      tradeNumber: Number(at(row, 'tradenumber')) || trades.length + 1,
      line: lineNumber,
      algorithm: normalizeStrategyFamily(strategy),
      version: parseStrategyVersion(strategy),
      strategyName: strategy,
      instrument: instrument.symbol,
      contract: instrument.contract,
      riskLevel,
      direction: at(row, 'marketpos'),
      quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 0,
      entryDate: entry ? entry.date : '',
      // The trade belongs to the day its P&L is realised, which is the exit.
      // 212 of 68,146 trades on the real download cross a date boundary (0.3%),
      // so the choice barely moves a figure and is stated anyway.
      date: exit.date,
      exitAt: exit.at,
      net: money(net),
      commission: money(commission),
      gross: money(net + commission),
      reportedCumulative,
    });
  }

  if (badMoney.length) {
    return refusal(
      fileName,
      `${badMoney.length} row${badMoney.length === 1 ? '' : 's'} of this file carr${badMoney.length === 1 ? 'ies' : 'y'} a Profit or Commission this import cannot read (first at line ${badMoney[0]}). A row that cannot be read must not be counted as zero, so the file is refused whole.`,
    );
  }
  if (badDates.length) {
    return refusal(
      fileName,
      `${badDates.length} row${badDates.length === 1 ? '' : 's'} of this file carr${badDates.length === 1 ? 'ies' : 'y'} an Exit time this import cannot read (first at line ${badDates[0]}). Every trade is dated by its exit, so the file is refused whole.`,
    );
  }
  if (!trades.length) {
    return refusal(fileName, 'This file has a trade list header and no trades. Import refused.');
  }

  const warnings = [];
  const keys = new Set(trades.map((trade) => `${trade.algorithm} ${trade.version} ${trade.instrument}`));
  if (keys.size > 1) {
    warnings.push(
      `This file holds ${keys.size} algorithm/version/instrument combinations (${[...keys].join(', ')}); each is aggregated as its own series.`,
    );
  }
  if (crossedDay) {
    warnings.push(
      `${crossedDay} of ${trades.length} trades exited on a later date than they entered and are counted on their exit date.`,
    );
  }

  return {
    ok: true,
    fileName,
    riskLevel,
    trades,
    warnings,
    reportedFinalCumulative: cumulativeReported,
  };
}

function emptyBucket() {
  return {
    trades: 0,
    wins: 0,
    losses: 0,
    scratches: 0,
    contracts: 0,
    gross: 0,
    commission: 0,
    net: 0,
    rows: [],
  };
}

function addTrade(bucket, trade) {
  bucket.trades += 1;
  if (trade.net > 0) bucket.wins += 1;
  else if (trade.net < 0) bucket.losses += 1;
  else bucket.scratches += 1;
  bucket.contracts += trade.quantity;
  bucket.gross += trade.gross;
  bucket.commission += trade.commission;
  bucket.net += trade.net;
  bucket.rows.push(trade);
}

/**
 * Peak to trough on the trade-closed equity curve INSIDE the bucket, with the
 * curve reset to zero at the bucket's start.
 *
 * That reset is the whole definition and it is why a month's drawdown never adds
 * up to the year's: a month that opens $3,000 below the all-history peak reads 0
 * here if it only rises. Stated as "deepest fall inside this window" everywhere
 * it is printed. Returned as a positive magnitude with the two dates that bound
 * it, so a reader can go and look at them.
 */
function drawdownOf(rows) {
  let cumulative = 0;
  let peak = 0;
  let peakDate = rows.length ? rows[0].date : null;
  let depth = 0;
  let fromDate = null;
  let toDate = null;
  for (const row of rows) {
    cumulative += row.net;
    if (cumulative > peak) {
      peak = cumulative;
      peakDate = row.date;
    }
    const fall = peak - cumulative;
    if (fall > depth) {
      depth = fall;
      fromDate = peakDate;
      toDate = row.date;
    }
  }
  return { depth: money(depth), fromDate, toDate };
}

function sealBucket(bucket, label) {
  const drawdown = drawdownOf(bucket.rows);
  const days = new Set(bucket.rows.map((row) => row.date));
  return {
    ...label,
    trades: bucket.trades,
    days: days.size,
    wins: bucket.wins,
    losses: bucket.losses,
    scratches: bucket.scratches,
    contracts: bucket.contracts,
    gross: money(bucket.gross),
    commission: money(bucket.commission),
    net: money(bucket.net),
    // wins / trades. Scratches (exactly $0.00) stay in the denominator and out
    // of the numerator: a flat trade is not a win. null rather than 0 when there
    // is nothing to divide, so "no trades" never reads as "never won".
    winRate: bucket.trades ? bucket.wins / bucket.trades : null,
    // What these rows actually paid per contract per round turn, measured
    // rather than assumed — it is a property of the instrument, not of the
    // vendor. See the note where a constant would otherwise live.
    commissionPerContract: bucket.contracts
      ? Math.round((bucket.commission / bucket.contracts) * 10000) / 10000
      : null,
    maxDrawdown: drawdown.depth,
    drawdownFrom: drawdown.fromDate,
    drawdownTo: drawdown.toDate,
  };
}

function seriesKeyOf(trade) {
  return [trade.algorithm, trade.version, trade.instrument, trade.riskLevel].join('|');
}

/**
 * Aggregate parsed trade lists into one series per
 * (algorithm, version, instrument, risk level), each with a day, a month and an
 * all-history level.
 *
 * Accepts one parse result or several. Files that were refused are ignored here;
 * the caller shows their reasons. A single file may produce more than one series
 * when the vendor's export mixes versions, and two files that describe the same
 * key (a re-download under a different name) merge into one series with both
 * file names recorded — the alternative, two series silently halving each other's
 * day counts, is the kind of number this report exists not to print.
 */
export function buildBenchmarkSeries(parsedFiles = []) {
  const files = Array.isArray(parsedFiles) ? parsedFiles : [parsedFiles];
  const bySeries = new Map();

  for (const file of files) {
    if (!file?.ok) continue;
    for (const trade of file.trades || []) {
      const key = seriesKeyOf(trade);
      let series = bySeries.get(key);
      if (!series) {
        series = {
          key,
          algorithm: trade.algorithm,
          version: trade.version,
          instrument: trade.instrument,
          riskLevel: trade.riskLevel,
          sourceFiles: [],
          contracts: new Set(),
          quantities: new Set(),
          trades: [],
        };
        bySeries.set(key, series);
      }
      if (file.fileName && !series.sourceFiles.includes(file.fileName)) {
        series.sourceFiles.push(file.fileName);
      }
      if (trade.contract) series.contracts.add(trade.contract);
      if (trade.quantity) series.quantities.add(trade.quantity);
      series.trades.push(trade);
    }
  }

  return [...bySeries.values()]
    .map((series) => {
      const sorted = [...series.trades].sort(
        (a, b) => a.exitAt - b.exitAt || a.tradeNumber - b.tradeNumber,
      );

      const dayBuckets = new Map();
      const monthBuckets = new Map();
      const all = emptyBucket();
      for (const trade of sorted) {
        const month = trade.date.slice(0, 7);
        if (!dayBuckets.has(trade.date)) dayBuckets.set(trade.date, emptyBucket());
        if (!monthBuckets.has(month)) monthBuckets.set(month, emptyBucket());
        addTrade(dayBuckets.get(trade.date), trade);
        addTrade(monthBuckets.get(month), trade);
        addTrade(all, trade);
      }

      const days = [...dayBuckets.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, bucket]) => sealBucket(bucket, { date }));
      const months = [...monthBuckets.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, bucket]) => sealBucket(bucket, { month }));
      const history = sealBucket(all, {});

      // The file's own running total against ours. It has matched on every row
      // of every file the desk has downloaded; if it ever stops matching, the
      // series says so rather than the report quietly disagreeing with the vendor.
      const reportedCumulative = sorted.length
        ? sorted.reduce((last, trade) => (trade.reportedCumulative != null ? trade.reportedCumulative : last), null)
        : null;
      const difference = reportedCumulative == null ? null : money(history.net - reportedCumulative);

      const quantities = [...series.quantities].sort((a, b) => a - b);

      return {
        key: series.key,
        vendor: BENCHMARK_VENDOR,
        algorithm: series.algorithm,
        version: series.version,
        instrument: series.instrument,
        riskLevel: series.riskLevel,
        sourceFiles: series.sourceFiles,
        sourceFile: series.sourceFiles[0] || '',
        contractMonths: [...series.contracts].sort(),
        quantities,
        quantityRange: quantities.length
          ? { min: quantities[0], max: quantities[quantities.length - 1] }
          : { min: 0, max: 0 },
        firstDate: sorted.length ? sorted[0].date : '',
        lastDate: sorted.length ? sorted[sorted.length - 1].date : '',
        basis: benchmarkBasisLabel(series),
        days,
        months,
        history,
        reconciliation: {
          // Sum of the Profit column as this module read it.
          computedNet: history.net,
          // The last value of the file's own `Cum. net profit` column.
          reportedNet: reportedCumulative,
          difference,
          matches: difference == null ? null : Math.abs(difference) < 0.01,
        },
      };
    })
    .sort(
      (a, b) =>
        a.algorithm.localeCompare(b.algorithm)
        || a.instrument.localeCompare(b.instrument)
        || BENCHMARK_RISK_LEVELS.indexOf(a.riskLevel) - BENCHMARK_RISK_LEVELS.indexOf(b.riskLevel),
    );
}

/**
 * The monthly aggregates as `supabase/step_44_algorithm_benchmarks.sql` stores
 * them: one row per (algorithm, version, instrument, risk level, month), which
 * is that table's unique key, so a re-import of the same file replaces its rows
 * instead of doubling them.
 *
 * Months, not days: a month is the smallest bucket this report quotes, it keeps
 * the table at roughly 2,900 rows for the desk's 36 files instead of ~60,000,
 * and every figure it holds is reproducible from the file it names.
 */
export function benchmarkMonthlyRows(series = []) {
  const list = Array.isArray(series) ? series : [series];
  return list.flatMap((entry) =>
    (entry.months || []).map((month) => ({
      vendor: entry.vendor || BENCHMARK_VENDOR,
      algorithm: entry.algorithm,
      version: entry.version,
      instrument: entry.instrument,
      riskLevel: entry.riskLevel,
      month: `${month.month}-01`,
      trades: month.trades,
      tradingDays: month.days,
      contracts: month.contracts,
      grossProfit: month.gross,
      commission: month.commission,
      netProfit: month.net,
      winRate: month.winRate,
      commissionPerContract: month.commissionPerContract,
      maxDrawdown: month.maxDrawdown,
      sourceFile: entry.sourceFile,
    })),
  );
}

/**
 * What the import card shows before anything is saved: the series found, the
 * files refused and their reasons, and the totals of what would be written.
 */
export function summarizeBenchmarkImport(parsedFiles = []) {
  const files = Array.isArray(parsedFiles) ? parsedFiles : [parsedFiles];
  const accepted = files.filter((file) => file?.ok);
  const rejected = files
    .filter((file) => file && !file.ok)
    .map((file) => ({ fileName: file.fileName, reason: file.reason }));
  const series = buildBenchmarkSeries(accepted);
  const monthlyRows = benchmarkMonthlyRows(series);
  const dates = series.flatMap((entry) => [entry.firstDate, entry.lastDate]).filter(Boolean).sort();
  return {
    series,
    rejected,
    warnings: accepted.flatMap((file) =>
      (file.warnings || []).map((warning) => ({ fileName: file.fileName, warning })),
    ),
    totals: {
      files: accepted.length,
      series: series.length,
      trades: series.reduce((sum, entry) => sum + entry.history.trades, 0),
      monthlyRows: monthlyRows.length,
      firstDate: dates[0] || '',
      lastDate: dates[dates.length - 1] || '',
      riskLevels: BENCHMARK_RISK_LEVELS.filter((risk) =>
        series.some((entry) => entry.riskLevel === risk),
      ),
      // Three counts, not one flag. A series whose file carried no
      // `Cum. net profit` column was never checked against the vendor, and
      // folding that into "reconciled" would let the card claim agreement it
      // never tested.
      reconciled: series.filter((entry) => entry.reconciliation.matches === true).length,
      unreconciled: series.filter((entry) => entry.reconciliation.matches === false).length,
      unchecked: series.filter((entry) => entry.reconciliation.matches === null).length,
    },
    monthlyRows,
  };
}

/**
 * What a benchmark series covers of one period, and whether it may be compared
 * with anything this desk's accounts did in that period.
 *
 * IT IS A COVERAGE TABLE, NOT A COMPARISON. Every row answers "is there a
 * published track record for this thing, of this version, on this contract, and
 * how many days do the two series even hold in common" — and then refuses the
 * comparison, by name, with the count that refused it. The refusal is the
 * point: a direction agreement over n common closes is a coin toss under the
 * null, and at the 11 common closes the best-covered algorithm on this book has
 * it would take 10 of 11 to clear a one-sided binomial at 5%.
 *
 * WHY A `_PF` FAMILY GETS `No series` RATHER THAN ITS BASE FAMILY'S FILE.
 * IFSP_PF is what the Strategies grid stores and it is not what the vendor
 * publishes. Handing IFSP's file to IFSP_PF's row would put a figure produced
 * from one catalogue entry under the name of another, which is the same defect
 * as a mislabelled column with an extra step in it. The row says the base
 * family has one, so a reader looking for the file finds where it is.
 *
 * Takes plain arguments — roster rows in, series in — so this module still
 * knows nothing about clients, snapshots or the CRM's population rules.
 */
export function buildBenchmarkCoverage(rosterRows = [], series = [], {
  from = '', to = '', riskLevel = 'Low',
} = {}) {
  const list = Array.isArray(series) ? series : [];
  const risk = BENCHMARK_RISK_LEVELS.includes(riskLevel) ? riskLevel : BENCHMARK_RISK_LEVELS[0];
  const inWindow = (date) => (!from || date >= from) && (!to || date <= to);

  const byAlgorithm = new Map();
  for (const entry of list) {
    const held = byAlgorithm.get(entry.algorithm) || [];
    held.push(entry);
    byAlgorithm.set(entry.algorithm, held);
  }

  const seenAlgorithms = new Set();
  const rows = (rosterRows || []).map((member) => {
    const family = member.algorithm || member.name || '';
    seenAlgorithms.add(family);
    const found = byAlgorithm.get(family) || [];
    const atRisk = found.find((entry) => entry.riskLevel === risk) || found[0] || null;
    const base = family.endsWith('_PF') ? family.slice(0, -3) : '';
    const baseHasSeries = Boolean(base && byAlgorithm.has(base));

    const closesHere = (member.closesPresent || []).filter(inWindow);
    const benchmarkDays = atRisk
      ? (atRisk.days || []).filter((entry) => inWindow(entry.date)).map((entry) => entry.date)
      : [];
    const benchmarkDaySet = new Set(benchmarkDays);
    const commonCloses = closesHere.filter((date) => benchmarkDaySet.has(date));

    const instrumentsHere = member.instruments || [];
    const instrumentsThere = [...new Set(found.map((entry) => entry.instrument))];
    let instrumentMatch = null;
    if (atRisk && instrumentsHere.length) {
      const overlap = instrumentsHere.filter((name) => instrumentsThere.includes(name));
      instrumentMatch = overlap.length === 0
        ? 'no'
        : (overlap.length === instrumentsHere.length ? 'yes' : 'partial');
    }

    return {
      algorithm: family,
      version: member.version || '',
      accountDays: member.accountDays || 0,
      accounts: member.accounts || 0,
      hasSeries: Boolean(atRisk),
      seriesNote: atRisk
        ? null
        : (baseHasSeries
          ? `No series for ${family}. ${base} has one; a prop-firm variant is not the same `
            + 'catalogue entry, and the vendor publishes no track record under this name.'
          : `No series. ${BENCHMARK_VENDOR} publishes no file for ${family || 'this algorithm'}.`),
      benchmarkVersion: atRisk ? atRisk.version : null,
      versionMatch: atRisk && member.version
        ? (atRisk.version === member.version ? 'yes' : 'no')
        : null,
      instrumentsHere,
      instrumentsThere,
      instrumentMatch,
      instrumentNote: instrumentMatch === 'no'
        ? `Runs on ${instrumentsHere.join(', ')} here and is benchmarked on `
          + `${instrumentsThere.join(', ')}. A different contract is a different measurement.`
        : (instrumentMatch === 'partial'
          ? `${instrumentsHere.filter((name) => !instrumentsThere.includes(name)).join(', ')} `
            + 'is not benchmarked.'
          : null),
      riskLevelsAvailable: BENCHMARK_RISK_LEVELS.filter((level) =>
        found.some((entry) => entry.riskLevel === level),
      ),
      riskLevel: atRisk ? atRisk.riskLevel : null,
      benchmarkDays: benchmarkDays.length,
      closesHere: closesHere.length,
      commonCloses: commonCloses.length,
      commonCloseDates: commonCloses,
      // One value, always false on this book, and computed rather than
      // asserted so the day it becomes true it becomes true by itself.
      comparable: commonCloses.length >= BENCHMARK_MIN_COMMON_CLOSES,
      comparisonRefusal: commonCloses.length >= BENCHMARK_MIN_COMMON_CLOSES
        ? null
        : `${commonCloses.length} close${commonCloses.length === 1 ? '' : 's'} in common, fewer `
          + `than the ${BENCHMARK_MIN_COMMON_CLOSES} any agreement figure needs.`,
    };
  });

  // Series the vendor publishes for algorithms this desk is not running. Worth
  // a row of its own: it is the only place the CRM can say "we pay for a track
  // record we do not use".
  const neverDeployed = [...byAlgorithm.entries()]
    .filter(([algorithm]) => !seenAlgorithms.has(algorithm))
    .map(([algorithm, found]) => {
      const atRisk = found.find((entry) => entry.riskLevel === risk) || found[0];
      return {
        algorithm,
        version: atRisk.version,
        instrument: atRisk.instrument,
        riskLevelsAvailable: BENCHMARK_RISK_LEVELS.filter((level) =>
          found.some((entry) => entry.riskLevel === level),
        ),
        firstDate: atRisk.firstDate,
        lastDate: atRisk.lastDate,
      };
    })
    .sort((a, b) => a.algorithm.localeCompare(b.algorithm));

  const bestCommon = rows.reduce((most, row) => Math.max(most, row.commonCloses), 0);
  return {
    riskLevel: risk,
    from,
    to,
    rows,
    neverDeployed,
    minCommonCloses: BENCHMARK_MIN_COMMON_CLOSES,
    bestCommonCloses: bestCommon,
    comparableCount: rows.filter((row) => row.comparable).length,
    seriesCount: list.length,
    // The sentence the page prints under the table, with this book's own
    // counts in it, so the refusal cannot drift from what refused it.
    refusal: `No agreement figure is stated. A comparison of direction needs at least `
      + `${BENCHMARK_MIN_COMMON_CLOSES} closes held by both series, and the best covered `
      + `algorithm in this window has ${bestCommon}. At ${bestCommon || 1} day`
      + `${bestCommon === 1 ? '' : 's'}, almost every one of them would have to agree before the `
      + 'result beat a coin toss, which is a standard that nothing passes by skill either. The '
      + 'count will grow with the book.',
  };
}
