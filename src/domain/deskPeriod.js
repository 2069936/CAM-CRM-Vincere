/**
 * The period a desk report covers: a week, a month, or a range somebody typed.
 *
 * NO AGGREGATION LIVES HERE. This module answers four questions and nothing
 * else: which periods does the book hold, what are this period's bounds, what
 * is the period before it, and what is missing from it. Every number that
 * divides by one of these bounds is computed in `deskPeriodReport.js` from the
 * modules that already own it.
 *
 * WHY THE PERIOD IS BOUNDED BY THE BOOK AND NEVER BY THE WALL CLOCK. The same
 * defect has been fixed twice in this codebase already — `monthFor` in
 * deskMoney.js and the ranking anchor in algorithmRanking.js both carry the
 * note. On 2026-08-20 a wall-clock "this week" over a book whose newest close
 * is 2026-07-30 is an empty period, and an empty period prints zeros that read
 * as a flat desk. `listPeriods` offers only periods the book has a close in,
 * and `resolvePeriod` states in `partial` when the period runs past what the
 * book holds.
 *
 * WHY A WEEKDAY WITH NO CLOSE IS A FIRST-CLASS FACT. `Week of 2026-07-27` on
 * this book runs Monday to Sunday and holds closes on the 27th, 28th and 30th:
 * the 29th and the 31st are trading days on which nobody exported. A report
 * that silently divides by "3 closes" tells the reader the week was three days
 * long. `missingWeekdays` is on the object so the header can name them.
 */

import { bookCloses } from './deskMoney';

export const PERIOD_KINDS = ['week', 'month', 'custom'];

const MS_PER_DAY = 86400000;

function day(value) {
  return String(value || '').slice(0, 10);
}

function toTime(date) {
  return Date.parse(`${day(date)}T00:00:00Z`);
}

export function shiftDate(date, days) {
  const time = toTime(date);
  if (Number.isNaN(time)) return '';
  return new Date(time + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Inclusive count of calendar days between two ISO dates. */
export function daysInclusive(from, to) {
  const a = toTime(from);
  const b = toTime(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.floor((b - a) / MS_PER_DAY) + 1;
}

/** 1 = Monday … 7 = Sunday, the ISO numbering. */
function isoWeekday(date) {
  const time = toTime(date);
  if (Number.isNaN(time)) return 0;
  const dow = new Date(time).getUTCDay();
  return dow === 0 ? 7 : dow;
}

/** The Monday of the ISO week a date falls in. */
export function mondayOf(date) {
  const weekday = isoWeekday(date);
  if (!weekday) return '';
  return shiftDate(date, -(weekday - 1));
}

export function isWeekday(date) {
  const weekday = isoWeekday(date);
  return weekday >= 1 && weekday <= 5;
}

/** The last calendar day of a `YYYY-MM` month. */
export function lastDayOfMonth(month) {
  const [year, mon] = String(month || '').split('-').map(Number);
  if (!year || !mon) return '';
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, mon, 0)).toISOString().slice(0, 10);
}

function previousMonth(month) {
  const [year, mon] = String(month || '').split('-').map(Number);
  if (!year || !mon) return '';
  return new Date(Date.UTC(year, mon - 2, 1)).toISOString().slice(0, 7);
}

function datesBetween(from, to) {
  const out = [];
  if (!from || !to || from > to) return out;
  for (let date = day(from); date && date <= day(to); date = shiftDate(date, 1)) {
    out.push(date);
  }
  return out;
}

export function weekLabel(monday) {
  return `Week of ${day(monday)}`;
}

export function periodLabelFor(kind, { from = '', to = '', key = '' } = {}) {
  if (kind === 'week') return weekLabel(key || from);
  if (kind === 'month') return key || day(from).slice(0, 7);
  return `${day(from)} to ${day(to)}`;
}

/**
 * The periods of one kind that the book actually holds a close in, newest
 * first.
 *
 * A custom range has no list — it is whatever two dates the reader typed — so
 * `listPeriods(clients, 'custom')` returns the book's bounds as one entry the
 * picker uses to set its `min` and `max`, rather than an empty list the picker
 * has to special-case.
 */
export function listPeriods(clients = [], kind = 'week') {
  const { closes } = bookCloses(clients);
  if (!closes.length) return [];

  if (kind === 'custom') {
    return [{
      kind: 'custom',
      key: `${closes[0]}..${closes[closes.length - 1]}`,
      from: closes[0],
      to: closes[closes.length - 1],
      closes: [...closes],
      closeCount: closes.length,
      label: periodLabelFor('custom', { from: closes[0], to: closes[closes.length - 1] }),
      optionLabel: `${closes[0]} to ${closes[closes.length - 1]}, ${closes.length} close${closes.length === 1 ? '' : 's'}`,
    }];
  }

  const buckets = new Map();
  for (const close of closes) {
    const key = kind === 'month' ? close.slice(0, 7) : mondayOf(close);
    if (!key) continue;
    const held = buckets.get(key) || [];
    held.push(close);
    buckets.set(key, held);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([key, held]) => {
      const from = kind === 'month' ? `${key}-01` : key;
      const to = kind === 'month' ? lastDayOfMonth(key) : shiftDate(key, 6);
      return {
        kind,
        key,
        from,
        to,
        closes: held,
        closeCount: held.length,
        label: periodLabelFor(kind, { key, from, to }),
        optionLabel: kind === 'month'
          ? `${key}, ${held.length} close${held.length === 1 ? '' : 's'}`
          : `${weekLabel(key)}, ${held.length} close${held.length === 1 ? '' : 's'}`,
      };
    });
}

/**
 * The bounds of one period, the period before it, and what each of them holds.
 *
 * The prior period for a custom range is the same NUMBER OF CALENDAR DAYS
 * ending the day before `from`, not the same number of closes: a comparison
 * whose two windows are different lengths of calendar is one the reader cannot
 * check, and the page prints the prior bounds for exactly that reason.
 */
export function resolvePeriod(clients = [], {
  kind = 'week', key = '', from = '', to = '',
} = {}) {
  const book = bookCloses(clients);
  const closes = book.closes;
  const bookFirstClose = closes[0] || '';
  const bookLastClose = book.latest || '';

  let periodKind = PERIOD_KINDS.includes(kind) ? kind : 'week';
  let periodKey = day(key);
  let periodFrom = day(from);
  let periodTo = day(to);

  if (periodKind === 'week') {
    const monday = mondayOf(periodKey || periodFrom || bookLastClose);
    periodKey = monday;
    periodFrom = monday;
    periodTo = monday ? shiftDate(monday, 6) : '';
  } else if (periodKind === 'month') {
    const month = (periodKey || periodFrom || bookLastClose).slice(0, 7);
    periodKey = month;
    periodFrom = month ? `${month}-01` : '';
    periodTo = month ? lastDayOfMonth(month) : '';
  } else {
    periodFrom = periodFrom || bookFirstClose;
    periodTo = periodTo || bookLastClose;
    if (periodFrom && periodTo && periodFrom > periodTo) {
      const swap = periodFrom;
      periodFrom = periodTo;
      periodTo = swap;
    }
    periodKey = `${periodFrom}..${periodTo}`;
  }

  let priorFrom = '';
  let priorTo = '';
  if (periodKind === 'week') {
    priorFrom = shiftDate(periodFrom, -7);
    priorTo = shiftDate(periodFrom, -1);
  } else if (periodKind === 'month') {
    const prior = previousMonth(periodKey);
    priorFrom = prior ? `${prior}-01` : '';
    priorTo = prior ? lastDayOfMonth(prior) : '';
  } else {
    const span = daysInclusive(periodFrom, periodTo);
    priorTo = shiftDate(periodFrom, -1);
    priorFrom = span > 0 ? shiftDate(priorTo, -(span - 1)) : '';
  }

  const inPeriod = closes.filter((date) => date >= periodFrom && date <= periodTo);
  const inPrior = closes.filter((date) => priorFrom && date >= priorFrom && date <= priorTo);
  const calendarDays = datesBetween(periodFrom, periodTo);
  const weekdays = calendarDays.filter(isWeekday);
  const held = new Set(inPeriod);
  const missingWeekdays = weekdays.filter((date) => !held.has(date));
  // Closes on a Saturday or a Sunday. This book has one (2026-07-25, one
  // client), and a "closes of weekdays" line that ignored it would be a count
  // whose numerator and denominator come from different sets.
  const weekendCloses = inPeriod.filter((date) => !isWeekday(date));

  const runsPastBook = Boolean(bookLastClose) && periodTo > bookLastClose;
  const partialReasons = [];
  if (runsPastBook) {
    partialReasons.push(`It runs to ${periodTo} and the book's newest close is ${bookLastClose}.`);
  }
  if (missingWeekdays.length) {
    partialReasons.push(
      `${missingWeekdays.length} weekday${missingWeekdays.length === 1 ? '' : 's'} inside it `
      + `hold${missingWeekdays.length === 1 ? 's' : ''} no close: ${missingWeekdays.join(', ')}.`,
    );
  }

  const priorLabel = periodKind === 'week'
    ? weekLabel(priorFrom)
    : (periodKind === 'month'
      ? (priorFrom ? priorFrom.slice(0, 7) : 'the month before')
      : `${priorFrom} to ${priorTo}`);

  return {
    kind: periodKind,
    key: periodKey,
    from: periodFrom,
    to: periodTo,
    label: periodLabelFor(periodKind, { kind: periodKind, key: periodKey, from: periodFrom, to: periodTo }),
    closes: inPeriod,
    closeCount: inPeriod.length,
    calendarDays: calendarDays.length,
    weekdays: weekdays.length,
    weekdayDates: weekdays,
    missingWeekdays,
    weekendCloses,
    priorFrom,
    priorTo,
    priorLabel,
    priorCloses: inPrior,
    priorCloseCount: inPrior.length,
    // Two separate claims, and both are printed. `priorEmpty` is why a monthly
    // report on this book has no comparison column at all; `partial` is why the
    // period it does report on is not a full week either.
    priorEmpty: inPrior.length === 0,
    partial: runsPastBook || missingWeekdays.length > 0,
    partialReasons,
    runsPastBook,
    bookFirstClose,
    bookLastClose,
    empty: inPeriod.length === 0,
    emptyReason: inPeriod.length === 0 && bookFirstClose
      ? `No close inside this period. The book runs from ${bookFirstClose} to ${bookLastClose}.`
      : null,
  };
}
