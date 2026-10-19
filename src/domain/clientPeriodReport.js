/**
 * The client period report: one client, one window of closes, every figure
 * built from the closes it names and nothing else.
 *
 * WHAT THIS IS FOR. The daily report answers "what happened to this client's
 * money today". This answers the same question over a week, two, four, a
 * month or a range somebody typed, for the client to read. It shows data and
 * leaves the reading to the reader: no verdict, no ranking, no comparison with
 * anybody else's accounts, and nothing the desk uses internally (no flag, no
 * status light, no configuration finding). An algorithm shows its own numbers
 * on this client's accounts and nothing more.
 *
 * WHAT IT DELIBERATELY DOES NOT DECIDE. Which accounts count is the daily
 * report's question and is asked of the daily report, close by close
 * (`buildDailyReportSummary`): Inactive / Ignore is out, a Failed account drops
 * out after the close it failed on, evaluations are listed and kept out of the
 * totals, and the money of every counted account is the money the daily PDF
 * printed for that day. Simulated accounts never reach a figure here, because
 * the close's `snapshots` are live only (simulationAccounts.js splits them
 * first) and the simulated side is read through `buildSimulationSection`, into
 * its own row and nowhere else. Which algorithm ran, and what it made on an
 * account day, is the attribution algorithmTemperature.js already uses
 * (`dayAlgoRows` on the traded basis, a sole algorithm credited the whole
 * account day, several credited their own figures only when those add up to
 * the account's day, otherwise not split). The buffer is read by the rules in
 * accountLifecycle.js and propFirmRules.js and never from a guessed plan.
 *
 * THE THREE RULES EVERY FIGURE HERE OBEYS.
 *
 * 1. COVERAGE FIRST. The report states how many closes it is built from before
 *    it states anything built from them.
 * 2. A WEEKDAY WITHOUT A CLOSE IS A GAP, NEVER A ZERO. It is a row with no
 *    figure in every table, a labelled hole in every chart, and it is named in
 *    a sentence. A close whose account rows were not loaded is the same kind
 *    of hole and is named as missing; a close whose fills were not loaded
 *    prints "not loaded" where a fill count would go.
 * 3. REAL MONEY ONLY. Simulated accounts appear in the Simulation* row and in
 *    no other figure; accounts whose nature is undetermined appear in no figure
 *    and are named.
 */

import { buildDailyReportSummary, buildSimulationSection } from './report.js';
import { ACCOUNT_STATUSES, ACCOUNT_TYPES, isCashType } from './reconcile.js';
import { dayAlgoRows, executionsForAccount } from './comboPerformance';
import { measuredOnAccountDay } from './algorithmRanking';
import { reconcilesOn } from './algoContribution';
import { familyFromStrategyName } from './strategyRan';
import { parseStrategyVersion } from './csvImport';
import { instrumentRoot } from './instrumentSpecs';
import { closeRowsMissing } from './deskPeriodReport';
import { fillsLoadedFor } from './closeLoadState';
import { isWeekday, lastDayOfMonth, mondayOf, shiftDate } from './deskPeriod';
import { resolveAccountLimits } from './propFirmRules';

/* ------------------------------------------------------------------ */
/* Windows.                                                            */

export const WINDOW_KINDS = ['week', 'twoWeeks', 'fourWeeks', 'month', 'custom'];

export const WINDOW_LABELS = {
  week: 'Week',
  twoWeeks: '2 weeks',
  fourWeeks: '4 weeks',
  month: 'Month',
  custom: 'Custom',
};

const WINDOW_TITLES = {
  week: 'Weekly performance report',
  twoWeeks: 'Two week performance report',
  fourWeeks: 'Four week performance report',
  month: 'Monthly performance report',
  custom: 'Performance report',
};

const WEEKS_IN = { week: 1, twoWeeks: 2, fourWeeks: 4 };

/**
 * The longest custom range the report takes.
 *
 * A bound on paper, not on data: the sheet is posted to /api/report/pdf as
 * markup, which refuses anything over 256 KB (server/report/reportPdf.js), and
 * the activity grid and the daily record grow with every day in the window.
 * Three months of a busy client stays well inside it; a year does not.
 */
export const MAX_CUSTOM_DAYS = 92;

function day(value) {
  return String(value || '').slice(0, 10);
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

const lower = (value) => String(value || '').toLowerCase();

/** The client's closes, oldest first, one per date (the later one wins). */
function closesOf(client) {
  const byDate = new Map();
  for (const dailyImport of client?.dailyImports || []) {
    const date = day(dailyImport?.date);
    if (!date) continue;
    byDate.set(date, dailyImport);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, dailyImport]) => dailyImport);
}

/**
 * The date a window is built around.
 *
 * THE CLIENT'S CLOSES, NOT THE WALL CLOCK. The workspace date picker is seeded
 * from today, and a week built around a day this client has no close on is a
 * week of gaps. So the selected date is used when the client has a close on
 * it, and the client's latest close otherwise.
 */
export function defaultAnchor(client, selectedDate = '') {
  const closes = closesOf(client);
  const selected = day(selectedDate);
  if (selected && closes.some((dailyImport) => day(dailyImport.date) === selected)) return selected;
  const latest = closes.length ? day(closes[closes.length - 1].date) : '';
  return latest || selected;
}

/**
 * The bounds of one window, and the close just before it.
 *
 * A week is Monday to Sunday. Two and four weeks end on the Sunday of the
 * anchor's week and start on the Monday one or three weeks earlier. A month is
 * the anchor's calendar month. A custom range is what was typed, put in order
 * and held to MAX_CUSTOM_DAYS.
 */
export function resolveClientPeriodWindow(client, {
  kind = 'week', anchor = '', from = '', to = '',
} = {}) {
  const windowKind = WINDOW_KINDS.includes(kind) ? kind : 'week';
  const closes = closesOf(client);
  const latest = closes.length ? day(closes[closes.length - 1].date) : '';
  const at = day(anchor) || latest;
  let start;
  let end;
  let clipped = false;

  if (WEEKS_IN[windowKind]) {
    const monday = mondayOf(at);
    end = monday ? shiftDate(monday, 6) : '';
    start = monday ? shiftDate(monday, -7 * (WEEKS_IN[windowKind] - 1)) : '';
  } else if (windowKind === 'month') {
    const month = at.slice(0, 7);
    start = month ? `${month}-01` : '';
    end = month ? lastDayOfMonth(month) : '';
  } else {
    start = day(from) || at;
    end = day(to) || at;
    if (start && end && start > end) [start, end] = [end, start];
    if (start && end && shiftDate(start, MAX_CUSTOM_DAYS - 1) < end) {
      end = shiftDate(start, MAX_CUSTOM_DAYS - 1);
      clipped = true;
    }
  }

  let prior = null;
  for (const dailyImport of closes) {
    if (day(dailyImport.date) < start) prior = dailyImport;
  }

  return {
    kind: windowKind,
    label: WINDOW_LABELS[windowKind],
    title: WINDOW_TITLES[windowKind],
    anchor: at,
    from: start,
    to: end,
    clipped,
    priorDate: prior ? day(prior.date) : '',
  };
}

/**
 * The anchor one window earlier (-1) or later (+1): a week, two or four weeks
 * move by their own length, a month by a calendar month. A custom range has no
 * neighbour and keeps its anchor.
 */
export function shiftAnchor(window, direction = -1) {
  const anchor = day(window?.anchor);
  if (!anchor) return '';
  if (WEEKS_IN[window.kind]) return shiftDate(anchor, direction * 7 * WEEKS_IN[window.kind]);
  if (window.kind === 'month') {
    const [year, month] = anchor.slice(0, 7).split('-').map(Number);
    return new Date(Date.UTC(year, month - 1 + direction, 1)).toISOString().slice(0, 10);
  }
  return anchor;
}

/**
 * The closes this report reads and this session does not fully hold yet.
 *
 * NOT LOADED IS NOT EMPTY, twice over. A login holds each client's latest
 * close account by account and every older close with `snapshots: []`
 * (`closeRowsMissing`), and it holds no close's orders (`fillsLoadedFor`). Read
 * as data, the first is a day on which no account reported and the second a
 * day on which nothing traded. Every close in the window is asked for when
 * either is missing; the close before the window is asked for when its rows
 * are, because only its balances are read.
 *
 * Ids are the database id (`uuid`) when there is one, the key the row fetch
 * filters on.
 */
export function closesNeedingDetail(client, window = {}) {
  const from = day(window.from);
  const to = day(window.to);
  if (!from || !to) return [];
  const ids = [];
  for (const dailyImport of closesOf(client)) {
    const date = day(dailyImport.date);
    if (date >= from && date <= to) {
      if (closeRowsMissing(dailyImport) || !fillsLoadedFor(dailyImport)) ids.push(dailyImport.uuid || dailyImport.id);
    } else if (date === window.priorDate && closeRowsMissing(dailyImport)) {
      ids.push(dailyImport.uuid || dailyImport.id);
    }
  }
  return [...new Set(ids.filter(Boolean))];
}

/* ------------------------------------------------------------------ */
/* Formatting. Sentence case, no dashes, tabular figures in the sheet. */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parts(iso) {
  const time = Date.parse(`${day(iso)}T12:00:00Z`);
  if (Number.isNaN(time)) return null;
  const date = new Date(time);
  return {
    year: date.getUTCFullYear(),
    month: MONTHS[date.getUTCMonth()],
    day: date.getUTCDate(),
    weekday: WEEKDAYS[date.getUTCDay()],
  };
}

/** `Oct 12`, or `Mon, Oct 12` when `long`, plus `, 2026` when `year`. */
export function dayLabel(iso, { long = false, year = false } = {}) {
  const p = parts(iso);
  if (!p) return '';
  const base = `${p.month} ${p.day}`;
  return `${long ? `${p.weekday}, ` : ''}${base}${year ? `, ${p.year}` : ''}`;
}

/** `Mon, Oct 12 to Fri, Oct 16, 2026`, with both years when they differ. */
export function periodText(from, to) {
  const a = parts(from);
  const b = parts(to);
  if (!a || !b) return '';
  if (a.year === b.year) return `${dayLabel(from, { long: true })} to ${dayLabel(to, { long: true, year: true })}`;
  return `${dayLabel(from, { long: true, year: true })} to ${dayLabel(to, { long: true, year: true })}`;
}

/** `$1,234.56`, `-$1,234.56`, and `+$1,234.56` when `sign` is asked for. */
export function fmtMoney(value, { sign = false } = {}) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '';
  const n = round2(value);
  const text = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n < 0) return `-$${text}`;
  return `${sign && n > 0 ? '+' : ''}$${text}`;
}

/** `$1.2k`, `-$480`, `$12k`: axis labels and the best and worst day. */
export function fmtShort(value) {
  const n = Number(value) || 0;
  const a = Math.abs(n);
  let text;
  if (a >= 1000) text = `${(a / 1000).toFixed(a >= 10000 ? 0 : 1).replace(/\.0$/, '')}k`;
  else text = String(Math.round(a));
  return `${n < 0 ? '-' : ''}$${text}`;
}

/* Chart scales, here so they are tested with everything else. */

/** A round step for about `ticks` gridlines over `range`. */
export function niceStep(range, ticks) {
  const raw = Math.max(range, 1) / ticks;
  const power = 10 ** Math.floor(Math.log10(raw));
  const m = raw / power;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * power;
}

/**
 * An axis label with as many decimals as the step needs. `fmtShort` alone
 * prints `$125k` on every tick of a balance axis that runs from 125,000 to
 * 125,750, which is a scale with no readable values on it.
 */
export function axisLabel(value, step) {
  const n = Math.round(Number(value) * 100) / 100;
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a >= 1000) {
    const decimals = step >= 1000 ? (step % 1000 === 0 ? 0 : 1) : (step >= 100 ? 1 : 2);
    return `${sign}$${(a / 1000).toFixed(decimals)}k`;
  }
  return `${sign}$${step < 1 ? a.toFixed(2) : Math.round(a)}`;
}

export function fmtCount(value) {
  return Number(value || 0).toLocaleString('en-US');
}

function plural(count, one, many = `${one}s`) {
  return count === 1 ? one : many;
}

function listOf(items) {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** `Oct 19, 2026, 9:40 am ET`, read in New York time like the close. */
export function stampText(builtAt) {
  const time = builtAt ? new Date(builtAt) : null;
  if (!time || Number.isNaN(time.getTime())) return '';
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(time);
  const get = (type) => formatted.find((part) => part.type === type)?.value || '';
  return `${get('month')} ${get('day')}, ${get('year')}, ${get('hour')}:${get('minute')} ${get('dayPeriod').toLowerCase()} ET`;
}

/**
 * The account type as a client reads it.
 *
 * The stored values carry " - " separators ("Evaluation - Bullet Bot",
 * "Cash - IRA"), which would print as dashes on the client's paper, and
 * "Unassigned" is the desk's word for an account nobody has classified yet.
 */
export function accountTypeLabel(accountType) {
  switch (accountType) {
    case ACCOUNT_TYPES.FUNDED: return 'Funded';
    case ACCOUNT_TYPES.CASH_IRA: return 'Cash IRA';
    case ACCOUNT_TYPES.CASH_STRAIGHT:
    case ACCOUNT_TYPES.CASH: return 'Cash';
    case ACCOUNT_TYPES.EVALUATION_STANDARD: return 'Evaluation';
    case ACCOUNT_TYPES.EVALUATION_BULLET: return 'Bullet Bot evaluation';
    case ACCOUNT_TYPES.PENDING_CLASSIFICATION: return 'Not yet classified';
    default: return 'Other';
  }
}

const TYPE_ORDER = ['Funded', 'Cash IRA', 'Cash', 'Other', 'Evaluation', 'Bullet Bot evaluation', 'Not yet classified'];

/* ------------------------------------------------------------------ */
/* One close, read the daily report's way.                             */

/**
 * The registry as it stood at one close.
 *
 * `buildDailyReportSummary` reads an account's status as it is TODAY, so an
 * account that failed on Wednesday reads as failed on Monday too, and on a
 * period report it would vanish from the days it was trading. Where the day it
 * failed is on record, the closes before that day read it as it was then.
 * Without the date, the daily report's own rule stands untouched.
 */
function clientAsOf(client, date) {
  const registry = client?.accountRegistry || {};
  let changed = false;
  const out = {};
  for (const [name, meta] of Object.entries(registry)) {
    const failedOn = day(meta?.dateFailed);
    if (meta?.status === ACCOUNT_STATUSES.FAILED && failedOn && date < failedOn) {
      out[name] = { ...meta, status: ACCOUNT_STATUSES.ACTIVE };
      changed = true;
    } else {
      out[name] = meta;
    }
  }
  return changed ? { ...client, accountRegistry: out } : client;
}

/** The fills on one account that name one algorithm. */
function fillsFor(algo, accountFills, sameFamilyCount) {
  return accountFills.filter((execution) => {
    if (familyFromStrategyName(execution?.strategyName) !== algo.family) return false;
    // Two versions of one family on one account day: the version on the fill
    // decides. One version: the family is enough, because a fill names the
    // version the way the grid does only when the strategy name carries it.
    if (sameFamilyCount < 2) return true;
    return algo.versions.includes(parseStrategyVersion(execution?.strategyName));
  }).length;
}

/**
 * Which algorithms ran on one account day, and what each one made.
 *
 * THE ATTRIBUTION algorithmTemperature.js USES, built from the same exported
 * pieces rather than a fourth copy of them: `dayAlgoRows` decides what ran and
 * what it is called, a sole algorithm is credited the whole account day, and
 * several are credited their own measured figures (`measuredOnAccountDay`)
 * only when those reconcile with the account's day (`reconcilesOn`). Anything
 * else is NOT SPLIT: the algorithms ran, the account's money is in the account
 * figures, and no algorithm is handed a share of it.
 */
function attributeAccountDay(snapshot, accountFills, fillsLoaded) {
  const pnl = Number(snapshot?.grossRealizedPnl || 0);
  const algos = dayAlgoRows(snapshot, accountFills, { basis: 'traded', level: 'version' });
  if (!algos.length) return { case: 'none', pnl, algos: [] };

  let credits = null;
  let attribution = 'unsplit';
  if (algos.length === 1) {
    credits = [pnl];
    attribution = 'sole';
  } else {
    const figures = algos.map((algo) => {
      let figure = null;
      for (const strategy of algo.strategies) {
        const measured = measuredOnAccountDay(strategy);
        if (measured == null) continue;
        figure = (figure == null ? 0 : figure) + measured;
      }
      return figure;
    });
    if (figures.every((figure) => figure != null)) {
      const sum = figures.reduce((total, figure) => total + figure, 0);
      if (reconcilesOn(pnl, sum, figures.some((figure) => figure !== 0))) {
        credits = figures;
        attribution = 'measured';
      }
    }
  }

  const families = new Map();
  for (const algo of algos) families.set(algo.family, (families.get(algo.family) || 0) + 1);
  return {
    case: attribution,
    pnl,
    algos: algos.map((algo, index) => {
      const roots = new Map();
      for (const strategy of algo.strategies) {
        const root = instrumentRoot(strategy?.instrument);
        if (root) roots.set(root, (roots.get(root) || 0) + 1);
      }
      if (!roots.size) {
        // A family named only on the fills carries its instrument there.
        for (const execution of accountFills) {
          if (familyFromStrategyName(execution?.strategyName) !== algo.family) continue;
          const root = instrumentRoot(execution?.instrument);
          if (root) roots.set(root, (roots.get(root) || 0) + 1);
        }
      }
      const fills = fillsLoaded ? fillsFor(algo, accountFills, families.get(algo.family)) : null;
      const credit = credits ? round2(credits[index]) : null;
      return {
        key: algo.key,
        family: algo.family,
        versions: algo.versions,
        roots,
        credit,
        fills,
        traded: (fills != null && fills > 0) || (credit != null && credit !== 0),
      };
    }),
  };
}

function readAccount(row, dailyImport, fillsLoaded, { attribute = false } = {}) {
  const accountName = row.accountName || '';
  const accountFills = executionsForAccount(dailyImport, accountName);
  return {
    key: lower(accountName),
    accountName,
    alias: row.meta?.alias || accountName,
    meta: row.meta || {},
    type: accountTypeLabel(row.meta?.accountType),
    realized: round2(row.grossRealizedPnl),
    balance: round2(row.accountBalance),
    trailing: Number(row.trailingMaxDrawdown),
    fills: fillsLoaded ? accountFills.length : null,
    attribution: attribute ? attributeAccountDay(row, accountFills, fillsLoaded) : null,
  };
}

function readClose(client, dailyImport) {
  const date = day(dailyImport.date);
  const fillsLoaded = fillsLoadedFor(dailyImport);
  if (closeRowsMissing(dailyImport)) {
    return { date, dailyImport, rowsLoaded: false, fillsLoaded };
  }
  const summary = buildDailyReportSummary(clientAsOf(client, date), dailyImport);
  const grouped = summary.grouped;
  // The daily report's own split: these three are counted towards the day,
  // evaluations and not-yet-classified accounts are shown and not counted,
  // Inactive / Ignore and accounts that failed on an earlier close are out.
  const counted = [...grouped.funded, ...grouped.cash, ...grouped.unclassified]
    .map((row) => readAccount(row, dailyImport, fillsLoaded, { attribute: true }));
  const shown = [...grouped.evaluations, ...grouped.pendingClassification]
    .map((row) => readAccount(row, dailyImport, fillsLoaded));
  const simulation = buildSimulationSection(client, dailyImport, (dailyImport.snapshots || []).length);
  return {
    date,
    dailyImport,
    rowsLoaded: true,
    fillsLoaded,
    realized: round2(summary.totals.grossRealizedPnl),
    balance: round2(summary.totals.aggregateBalance),
    counted,
    shown,
    ignored: grouped.ignored.map((row) => lower(row.accountName)),
    retired: grouped.retired.map((row) => lower(row.accountName)),
    simulation,
  };
}

/* ------------------------------------------------------------------ */
/* The buffer to the drawdown limit, read the way the product reads it. */

/**
 * The buffer at one close, or null with the reason there is none.
 *
 * accountLifecycle.js owns the reading: EXACTLY 0 IS "NOT MEASURED", a cash
 * account has no trailing rule, and the trailing figure means two different
 * things. With `max_drawdown_limit` on record it is the loss so far against
 * that limit, so the buffer is the limit less the loss. Without one it IS the
 * remaining buffer, as the platform reported it. A limit is printed beside the
 * buffer when it is on record or when the account's plan is on record
 * (`resolveAccountLimits`, `ruleSource: 'plan'`); a limit from the tightest
 * rule a firm sells is a guess about a plan nobody recorded and is never shown.
 */
export function bufferAtClose(account, client) {
  const meta = account?.meta || {};
  if (isCashType(meta.accountType)) return { value: null, limit: null, reason: 'cash' };
  const reading = Number(account?.trailing);
  if (!Number.isFinite(reading) || reading === 0) return { value: null, limit: null, reason: 'not reported' };
  const stored = Number(meta.maxDrawdownLimit);
  if (Number.isFinite(stored) && stored > 0) {
    return { value: round2(stored - Math.abs(reading)), limit: stored, reason: 'limit on record' };
  }
  const limits = resolveAccountLimits(
    { ...meta, accountName: account.accountName },
    { dailyImports: client?.dailyImports || [] },
  );
  const planLimit = limits.ruleSource === 'plan' && Number(limits.maxDrawdownLimit) > 0
    ? Number(limits.maxDrawdownLimit)
    : null;
  return { value: round2(reading), limit: planLimit, reason: planLimit ? 'plan on record' : 'reported' };
}

/* ------------------------------------------------------------------ */
/* The report.                                                         */

function accountRows(population, { startClose, windowCloses, lastDate, client }) {
  const rows = [];
  for (const [key, entry] of population) {
    const series = entry.series;
    const first = series[0];
    const last = series[series.length - 1];
    const prior = startClose ? startClose.get(key) : null;
    const start = prior ? prior.balance : first.balance;
    const startSource = prior ? 'prior' : 'first';
    const realized = round2(series.reduce((total, point) => total + point.realized, 0));
    rows.push({
      key,
      accountName: entry.accountName,
      alias: entry.alias,
      type: entry.type,
      start: round2(start),
      startSource,
      startDate: prior ? null : first.date,
      end: round2(last.balance),
      endDate: last.date,
      endIsLastClose: last.date === lastDate,
      change: round2(last.balance - start),
      realized,
      buffer: bufferAtClose(last.account, client),
      series: windowCloses.map((date) => {
        const point = series.find((p) => p.date === date);
        return point ? point.balance : null;
      }),
    });
  }
  rows.sort((a, b) => {
    const typeOrder = TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type);
    if (typeOrder) return typeOrder;
    return a.alias.localeCompare(b.alias);
  });
  const totals = rows.length
    ? {
      start: round2(rows.reduce((total, row) => total + row.start, 0)),
      end: round2(rows.reduce((total, row) => total + row.end, 0)),
      realized: round2(rows.reduce((total, row) => total + row.realized, 0)),
    }
    : null;
  if (totals) totals.change = round2(totals.end - totals.start);
  return { rows, totals };
}

function collect(population, read, closeDate, kind) {
  for (const account of read[kind]) {
    const entry = population.get(account.key) || {
      accountName: account.accountName,
      alias: account.alias,
      type: account.type,
      series: [],
    };
    entry.alias = account.alias;
    entry.type = account.type;
    entry.series.push({
      date: closeDate,
      balance: account.balance,
      realized: account.realized,
      account,
    });
    population.set(account.key, entry);
  }
}

/**
 * The days the header names: the first and last weekday of the window, wider
 * only if a close landed on a weekend outside them. The whole window, not the
 * part of it that has happened yet; coverage says how much of it has.
 */
function spanOf(from, to, reads) {
  const weekdays = weekdaysBetween(from, to);
  let first = weekdays[0] || from;
  let last = weekdays[weekdays.length - 1] || to;
  for (const read of reads) {
    if (read.date < first) first = read.date;
    if (read.date > last) last = read.date;
  }
  return [first, last];
}

function weekdaysBetween(from, to) {
  const out = [];
  if (!from || !to || from > to) return out;
  for (let date = from; date && date <= to; date = shiftDate(date, 1)) {
    if (isWeekday(date)) out.push(date);
  }
  return out;
}

/**
 * The whole report for one client and one window.
 *
 * `window` is `resolveClientPeriodWindow`'s answer. `asOf` is today's date in
 * the reader's calendar: a weekday after it has not happened yet and is not a
 * gap, and today itself is not a gap until its close is due and missing,
 * which this report cannot tell before the day is over, so today without a
 * close is left out and the period is said to be in progress.
 */
export function buildClientPeriodReport(client, {
  window,
  asOf = '',
  builtAt = '',
  accountManager = '',
  firm = 'Vincere Trading',
} = {}) {
  const from = day(window?.from);
  const to = day(window?.to);
  const today = day(asOf);
  const closes = closesOf(client);
  const firstOnRecord = closes.length ? day(closes[0].date) : '';
  const inWindow = closes.filter((dailyImport) => {
    const date = day(dailyImport.date);
    return date >= from && date <= to;
  });
  const priorImport = [...closes].reverse().find((dailyImport) => day(dailyImport.date) < from) || null;

  const reads = inWindow.map((dailyImport) => readClose(client, dailyImport));
  const readByDate = new Map(reads.map((read) => [read.date, read]));
  const priorRead = priorImport ? readClose(client, priorImport) : null;
  const loaded = reads.filter((read) => read.rowsLoaded);
  const lastLoaded = loaded[loaded.length - 1] || null;

  /* THE DAYS OF THE WINDOW. Every weekday the client could have closed on,
   * plus any close that landed on a weekend. A weekday after `asOf` has not
   * happened; `asOf` itself without a close is still open; a weekday before
   * the client's first close on record is not missing, there is simply no
   * history yet. Every other weekday without a close is a gap. */
  const horizon = today && today < to ? today : to;
  const beforeFirst = [];
  const pending = [];
  const dates = new Set();
  for (const date of weekdaysBetween(from, horizon)) {
    if (firstOnRecord && date < firstOnRecord) {
      beforeFirst.push(date);
      continue;
    }
    if (date === today && !readByDate.has(date)) {
      pending.push(date);
      continue;
    }
    dates.add(date);
  }
  for (const read of reads) dates.add(read.date);
  const windowDays = [...dates].sort();
  // In progress while a trading day of the window is still ahead or today's
  // close is not in yet. A Saturday report on a Monday to Sunday week is not.
  const inProgress = Boolean(today)
    && (pending.length > 0 || weekdaysBetween(from, to).some((date) => date > today));

  /* THE ACCOUNTS, counted and shown, across the window's loaded closes. */
  const counted = new Map();
  const shown = new Map();
  const ignored = new Set();
  const retired = new Set();
  for (const read of loaded) {
    collect(counted, read, read.date, 'counted');
    collect(shown, read, read.date, 'shown');
    for (const key of read.ignored) ignored.add(key);
    for (const key of read.retired) retired.add(key);
  }
  // Counted as left out only when they are in no row of this report. An
  // account that failed inside the period is in the table up to that close.
  for (const key of [...counted.keys(), ...shown.keys()]) {
    retired.delete(key);
    ignored.delete(key);
  }

  const startBasis = priorRead && priorRead.rowsLoaded ? 'prior' : 'first';
  const startClose = startBasis === 'prior'
    ? new Map([...priorRead.counted, ...priorRead.shown].map((account) => [account.key, account]))
    : null;
  const accounts = accountRows(counted, {
    startClose, windowCloses: windowDays, lastDate: lastLoaded?.date, client,
  });
  const evaluations = accountRows(shown, {
    startClose, windowCloses: windowDays, lastDate: lastLoaded?.date, client,
  });

  /* THE DAYS, one record per day of the window, gaps and all.
   *
   * Four states and only one of them carries a figure. `gap` is a weekday with
   * no close, `missing` a close whose account figures were not loaded, and
   * `noAccounts` a close on which none of the counted accounts reported (an
   * account opened later in the period, or a client whose accounts are all
   * evaluations). The daily report prints $0 for that last one; a period report
   * would draw it as a flat day, which is a claim about trading that nobody
   * made, so it carries no figure either. */
  const days = windowDays.map((date) => {
    const read = readByDate.get(date);
    if (!read) return { date, state: 'gap', realized: null, balance: null, fills: null };
    if (!read.rowsLoaded) return { date, state: 'missing', realized: null, balance: null, fills: null };
    if (!read.counted.length) return { date, state: 'noAccounts', realized: null, balance: null, fills: null };
    const fills = read.fillsLoaded
      ? read.counted.reduce((total, account) => total + account.fills, 0)
      : null;
    const accountsTraded = read.fillsLoaded
      ? read.counted.filter((account) => account.fills > 0).length
      : null;
    return {
      date,
      state: 'close',
      realized: read.realized,
      balance: read.balance,
      fills,
      accountsTraded,
      accountsReporting: read.counted.length,
      traded: read.fillsLoaded ? fills > 0 : (read.realized !== 0 ? true : null),
    };
  });

  const closed = days.filter((entry) => entry.state === 'close');
  const gaps = days.filter((entry) => entry.state === 'gap').map((entry) => entry.date);
  const missingRows = days.filter((entry) => entry.state === 'missing').map((entry) => entry.date);
  const noAccounts = days.filter((entry) => entry.state === 'noAccounts').map((entry) => entry.date);
  const missingFills = loaded.filter((read) => !read.fillsLoaded).map((read) => read.date);

  /* THE SUMMARY. Built from the closes that were read; a window with none has
   * no figure, which is not a figure of zero. */
  let summary = null;
  if (closed.length) {
    const realized = round2(closed.reduce((total, entry) => total + entry.realized, 0));
    const best = closed.reduce((pick, entry) => (pick === null || entry.realized > pick.realized ? entry : pick), null);
    const worst = closed.reduce((pick, entry) => (pick === null || entry.realized < pick.realized ? entry : pick), null);
    summary = {
      realized,
      closes: closed.length,
      closesWithTrades: closed.filter((entry) => entry.traded === true).length,
      closesTradeUnknown: closed.filter((entry) => entry.traded === null).length,
      daysWithGain: closed.filter((entry) => entry.realized > 0).length,
      daysWithLoss: closed.filter((entry) => entry.realized < 0).length,
      daysFlat: closed.filter((entry) => entry.realized === 0).length,
      best: { date: best.date, realized: best.realized },
      worst: { date: worst.date, realized: worst.realized },
      balanceStart: accounts.totals ? accounts.totals.start : null,
      balanceEnd: accounts.totals ? accounts.totals.end : null,
      balanceChange: accounts.totals ? accounts.totals.change : null,
    };
  }

  /* THE BALANCE LINE: the close before the window, then every close in it.
   * A gap breaks the line; it is never bridged. */
  const balanceLine = [];
  if (startBasis === 'prior' && priorRead.counted.length) {
    balanceLine.push({ date: priorRead.date, value: priorRead.balance, prior: true });
  }
  for (const entry of days) {
    balanceLine.push({
      date: entry.date,
      value: entry.state === 'close' ? entry.balance : null,
      state: entry.state,
      prior: false,
    });
  }

  /* THE ALGORITHMS, on the counted accounts only. */
  const algorithms = new Map();
  let unsplit = { accountDays: 0, realized: 0 };
  let unattributed = { accountDays: 0, realized: 0 };
  for (const read of loaded) {
    for (const account of read.counted) {
      const attribution = account.attribution;
      if (attribution.case === 'none') {
        if (attribution.pnl !== 0) {
          unattributed = {
            accountDays: unattributed.accountDays + 1,
            realized: round2(unattributed.realized + attribution.pnl),
          };
        }
        continue;
      }
      if (attribution.case === 'unsplit') {
        unsplit = {
          accountDays: unsplit.accountDays + 1,
          realized: round2(unsplit.realized + attribution.pnl),
        };
      }
      for (const algo of attribution.algos) {
        const row = algorithms.get(algo.key) || {
          key: algo.key,
          family: algo.family,
          roots: new Map(),
          accounts: new Set(),
          accountDays: 0,
          measuredAccountDays: 0,
          unsplitAccountDays: 0,
          fills: 0,
          fillsUnknown: false,
          realized: 0,
          byDate: new Map(),
        };
        for (const [root, count] of algo.roots) row.roots.set(root, (row.roots.get(root) || 0) + count);
        row.accounts.add(account.key);
        row.accountDays += 1;
        if (algo.credit == null) row.unsplitAccountDays += 1;
        else {
          row.measuredAccountDays += 1;
          row.realized = round2(row.realized + algo.credit);
        }
        if (algo.fills == null) row.fillsUnknown = true;
        else row.fills += algo.fills;
        const cell = row.byDate.get(read.date) || {
          realized: null, fills: 0, fillsUnknown: false, accounts: 0, unsplit: 0, traded: false,
        };
        cell.accounts += 1;
        if (algo.credit == null) cell.unsplit += 1;
        else cell.realized = round2((cell.realized || 0) + algo.credit);
        if (algo.fills == null) cell.fillsUnknown = true;
        else cell.fills += algo.fills;
        if (algo.traded) cell.traded = true;
        row.byDate.set(read.date, cell);
        algorithms.set(algo.key, row);
      }
    }
  }

  const algorithmRows = [...algorithms.values()]
    // Ordered by name. Any other order is a ranking, and this report does not
    // rank anything.
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((row) => {
      const cells = [...row.byDate.values()];
      const traded = cells.filter((cell) => cell.traded);
      // A day counts as a gain only when the algorithm's whole result that day
      // is known. One account day not split makes the day's sum partial, and
      // a partial sum is not a gain or a loss, it is a number with a hole in it.
      return {
        key: row.key,
        family: row.family,
        instruments: [...row.roots.entries()]
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
          .map(([root]) => root),
        accounts: row.accounts.size,
        accountDays: row.accountDays,
        measuredAccountDays: row.measuredAccountDays,
        unsplitAccountDays: row.unsplitAccountDays,
        daysTraded: traded.length,
        daysWithGain: traded.filter((cell) => !cell.unsplit && cell.realized != null && cell.realized > 0).length,
        fills: row.fillsUnknown ? null : row.fills,
        realized: round2(row.realized),
        perAccountDay: row.measuredAccountDays ? round2(row.realized / row.measuredAccountDays) : null,
        cells: days.map((entry) => {
          const { date } = entry;
          if (entry.state === 'gap') return { date, state: 'noClose' };
          if (entry.state === 'missing') return { date, state: 'missing' };
          const cell = row.byDate.get(date);
          if (!cell) return { date, state: 'notLoaded' };
          const fills = cell.fillsUnknown ? null : cell.fills;
          const base = { date, realized: cell.realized, fills, accounts: cell.accounts, unsplit: cell.unsplit };
          // Any account day not split makes the cell's sum partial: it is
          // drawn as not split, never shaded as a gain, a loss or a quiet day.
          if (cell.unsplit) return { ...base, state: 'unsplit' };
          if (cell.realized > 0) return { ...base, state: 'gain' };
          if (cell.realized < 0) return { ...base, state: 'loss' };
          return { ...base, realized: 0, state: 'quiet' };
        }),
      };
    });

  const heatMax = Math.max(0, ...algorithmRows.flatMap((row) => row.cells
    .filter((cell) => cell.state === 'gain' || cell.state === 'loss')
    .map((cell) => Math.abs(cell.realized))));

  /* RUNNING AT THE LAST CLOSE THAT WAS READ. */
  let running = null;
  if (lastLoaded) {
    const byKey = new Map();
    for (const account of lastLoaded.counted) {
      for (const algo of account.attribution.algos) {
        const entry = byKey.get(algo.key) || { key: algo.key, roots: new Map(), accounts: [] };
        for (const [root, count] of algo.roots) entry.roots.set(root, (entry.roots.get(root) || 0) + count);
        entry.accounts.push(account.alias);
        byKey.set(algo.key, entry);
      }
    }
    running = {
      date: lastLoaded.date,
      chips: [...byKey.values()]
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map((entry) => ({
          key: entry.key,
          instruments: [...entry.roots.entries()].sort((a, b) => b[1] - a[1]).map(([root]) => root),
          accounts: [...new Set(entry.accounts)].sort((a, b) => a.localeCompare(b)),
        })),
    };
  }

  /* THE SIMULATION ROW, from the simulated side of each close and nowhere
   * else. */
  const simAccounts = new Map();
  const undetermined = new Map();
  for (const read of loaded) {
    const section = read.simulation;
    if (!section) continue;
    for (const row of section.accounts || []) {
      const key = lower(row.accountName);
      const entry = simAccounts.get(key) || {
        name: row.meta?.alias || row.accountName, realized: 0, balance: 0, date: '',
      };
      entry.realized = round2(entry.realized + Number(row.grossRealizedPnl || 0));
      entry.balance = round2(row.accountBalance);
      entry.date = read.date;
      simAccounts.set(key, entry);
    }
    for (const row of section.undetermined?.accounts || []) {
      undetermined.set(lower(row.accountName), row.meta?.alias || row.accountName);
    }
  }
  const simulation = simAccounts.size
    ? {
      accounts: [...simAccounts.values()].sort((a, b) => a.name.localeCompare(b.name)),
      totals: {
        realized: round2([...simAccounts.values()].reduce((total, entry) => total + entry.realized, 0)),
        balance: round2([...simAccounts.values()].reduce((total, entry) => total + entry.balance, 0)),
      },
    }
    : null;

  /* COVERAGE, which the sheet prints before anything built from it. */
  const everyClose = [...counted.values()]
    .filter((entry) => entry.series.length === loaded.length).length;
  const algorithmAccountDays = algorithmRows.reduce((total, row) => total + row.accountDays, 0);
  const totalFills = missingFills.length
    ? null
    : closed.reduce((total, entry) => total + (entry.fills || 0), 0);
  const tradingDays = windowDays.length;

  const sentences = [];
  if (gaps.length) {
    sentences.push(`No close on ${listOf(gaps.map((date) => dayLabel(date, { long: true })))}. `
      + `${gaps.length === 1 ? 'That day is a gap' : 'Those days are gaps'} in every chart and table, never a zero.`);
  } else if (windowDays.length) {
    sentences.push('Every trading day in the period has a close.');
  }
  if (missingRows.length) {
    sentences.push(`The account figures of the ${plural(missingRows.length, 'close')} on `
      + `${listOf(missingRows.map((date) => dayLabel(date, { long: true })))} could not be loaded. `
      + `${missingRows.length === 1 ? 'That close is' : 'Those closes are'} missing from every figure, not counted as zero.`);
  }
  if (!counted.size && loaded.length) {
    sentences.push('No funded, cash or other counted account reported in this period, so the summary, the charts and the algorithm figures are empty.');
  } else if (noAccounts.length) {
    sentences.push(`None of the counted accounts reported on ${listOf(noAccounts.map((date) => dayLabel(date, { long: true })))}, `
      + `so ${noAccounts.length === 1 ? 'that close carries' : 'those closes carry'} no figure.`);
  }
  if (missingFills.length) {
    sentences.push(`Fills were not loaded for ${listOf(missingFills.map((date) => dayLabel(date, { long: true })))}, `
      + 'so fill counts for those days read not loaded.');
  }
  if (beforeFirst.length) {
    sentences.push(`The first close on record for this client is ${dayLabel(firstOnRecord, { long: true })}. `
      + 'The days before it are not part of this report.');
  }
  if (inProgress) {
    sentences.push(lastLoaded
      ? `This period is still in progress. It holds the closes through ${dayLabel(lastLoaded.date, { long: true })}.`
      : 'This period is still in progress and holds no close yet.');
  }
  if (window?.clipped) {
    sentences.push(`A custom period covers at most ${MAX_CUSTOM_DAYS} days, so this one ends on ${dayLabel(to, { long: true, year: true })}.`);
  }

  /* FOOTNOTES: definitions, and how each figure was read. */
  const notes = [
    {
      term: 'Realized P&L',
      text: 'is the profit or loss of trades closed during the day, as the trading platform reports it at the daily close. It does not include open positions.',
    },
    {
      term: 'Balance',
      text: 'is the account balance the trading platform reports at the close. Withdrawals and deposits change it as well as trading.',
    },
    {
      term: 'Start',
      text: startBasis === 'prior'
        ? `is each account's balance at the close before the period, ${dayLabel(priorRead.date, { long: true, year: true })}. An account that first reported inside the period starts at its first close in it.`
        : (priorImport
          ? `is each account's balance at its first close in the period, because the account figures of the close before it, ${dayLabel(priorImport.date, { long: true, year: true })}, could not be loaded.`
          : "is each account's balance at its first close in the period, because there is no close on record before it."),
    },
    {
      term: 'An algorithm is loaded',
      text: 'on an account at a close when the platform showed it switched on, its fills name it, or it reported a realized result that day. Each such account and close is one account day.',
    },
    {
      term: "An algorithm's realized P&L",
      text: "comes from the accounts' own figures. When it was the only algorithm loaded on an account, that account's realized P&L for the day is its own. When several were loaded, each one's own reported result is used when together they add up to the account's result.",
    },
    {
      term: 'Buffer to limit',
      text: "is the room left before the firm's drawdown limit at the account's last close in the period, read from the drawdown figure the trading platform reported. The limit is shown beside it when it is on record. n/a means no drawdown figure was reported or the account has no drawdown rule.",
    },
    {
      term: 'Fills',
      text: 'are the executions the trading platform recorded on these accounts.',
    },
  ];
  if (unsplit.accountDays) {
    notes.push({
      term: 'Not split',
      text: `marks ${fmtCount(unsplit.accountDays)} account ${plural(unsplit.accountDays, 'day')} on which more than one algorithm was loaded and their own results did not add up to the account's result. Those days count for each algorithm that was loaded, and their ${fmtMoney(unsplit.realized, { sign: true })} is in the account figures and in no algorithm's figure.`,
    });
  }
  if (unattributed.accountDays) {
    notes.push({
      term: 'No algorithm',
      text: `was loaded on ${fmtCount(unattributed.accountDays)} account ${plural(unattributed.accountDays, 'day')} that still had a realized result, ${fmtMoney(unattributed.realized, { sign: true })} in all. It is in the account figures and in no algorithm's figure.`,
    });
  }
  if (evaluations.rows.length) {
    notes.push({
      term: 'Evaluation accounts',
      text: 'are challenge accounts. They are listed with the accounts and are not included in any total, chart or algorithm figure, as in the daily report.',
    });
  }
  if (simulation) {
    notes.push({
      term: '*Simulated funds, not real money.',
      text: 'These balances and results are shown separately and are not included in any figure above.',
    });
  }

  const excluded = { ignored: ignored.size, retired: retired.size };

  return {
    header: {
      firm,
      title: window?.title || WINDOW_TITLES.custom,
      clientName: client?.name || 'Client',
      accountManager: accountManager || '',
      periodText: periodText(...spanOf(from, to, reads)),
      builtAt: stampText(builtAt),
      lastClose: lastLoaded ? dayLabel(lastLoaded.date, { long: true }) : '',
    },
    window: {
      kind: window?.kind || 'custom',
      from,
      to,
      days: windowDays,
      inProgress,
      pending,
      beforeFirst,
    },
    coverage: {
      tradingDays,
      closes: reads.length,
      loadedCloses: loaded.length,
      gaps,
      missingRows,
      missingFills,
      noAccounts,
      accounts: counted.size,
      accountsEveryClose: everyClose,
      evaluationAccounts: shown.size,
      algorithms: algorithmRows.length,
      algorithmAccountDays,
      unsplitAccountDays: unsplit.accountDays,
      fills: totalFills,
      sentences,
    },
    start: {
      basis: startBasis,
      date: startBasis === 'prior' ? priorRead.date : (loaded[0]?.date || ''),
    },
    summary,
    days,
    balanceLine,
    accounts: { ...accounts, excluded },
    evaluations: evaluations.rows.length ? evaluations : null,
    algorithms: {
      rows: algorithmRows,
      heatMax,
      unsplit,
      unattributed,
    },
    running,
    simulation,
    undetermined: [...undetermined.values()].sort((a, b) => a.localeCompare(b)),
    notes,
  };
}
