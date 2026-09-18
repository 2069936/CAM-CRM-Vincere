// What a period is, on a synthetic book so CI can run it without the real one.
//
// Every case here is a boundary. The report's whole arithmetic hangs off four
// dates — `from`, `to`, `priorFrom`, `priorTo` — and an off-by-one in any of
// them silently moves account days between two columns that are printed side by
// side under different headings.

import { describe, expect, it } from 'vitest';
import {
  PERIOD_KINDS,
  daysInclusive,
  lastDayOfMonth,
  listPeriods,
  mondayOf,
  resolvePeriod,
  shiftDate,
} from './deskPeriod';

const book = (dates) => [{
  id: 'c1',
  name: 'Client One',
  dailyImports: dates.map((date) => ({ date, snapshots: [] })),
}];

describe('the calendar helpers', () => {
  it('takes the Monday of an ISO week from any day in it', () => {
    expect(mondayOf('2026-07-29')).toBe('2026-07-27'); // a Wednesday
    expect(mondayOf('2026-07-27')).toBe('2026-07-27'); // the Monday itself
    expect(mondayOf('2026-08-02')).toBe('2026-07-27'); // the Sunday closes it
  });

  it('counts days inclusively at both ends', () => {
    expect(daysInclusive('2026-07-27', '2026-07-27')).toBe(1);
    expect(daysInclusive('2026-07-27', '2026-08-02')).toBe(7);
  });

  it('finds the last day of a month, February included', () => {
    expect(lastDayOfMonth('2026-07')).toBe('2026-07-31');
    expect(lastDayOfMonth('2026-02')).toBe('2026-02-28');
    expect(lastDayOfMonth('2024-02')).toBe('2024-02-29');
  });

  it('shifts across a month boundary', () => {
    expect(shiftDate('2026-08-01', -1)).toBe('2026-07-31');
  });

  it('names its three kinds', () => {
    expect(PERIOD_KINDS).toEqual(['week', 'month', 'custom']);
  });
});

describe('listPeriods', () => {
  const clients = book(['2026-07-13', '2026-07-15', '2026-07-22', '2026-07-30', '2026-08-03']);

  it('lists the weeks the book holds a close in, newest first, with their counts', () => {
    const weeks = listPeriods(clients, 'week');
    expect(weeks.map((week) => week.key)).toEqual(['2026-08-03', '2026-07-27', '2026-07-20', '2026-07-13']);
    expect(weeks.map((week) => week.closeCount)).toEqual([1, 1, 1, 2]);
    expect(weeks[3].optionLabel).toBe('Week of 2026-07-13, 2 closes');
  });

  it('lists the months the same way', () => {
    const months = listPeriods(clients, 'month');
    expect(months.map((month) => month.key)).toEqual(['2026-08', '2026-07']);
    expect(months[1].optionLabel).toBe('2026-07, 4 closes');
    expect(months[1].from).toBe('2026-07-01');
    expect(months[1].to).toBe('2026-07-31');
  });

  it('offers the book’s own bounds for a custom range, so the picker can bound itself', () => {
    const [custom] = listPeriods(clients, 'custom');
    expect(custom.from).toBe('2026-07-13');
    expect(custom.to).toBe('2026-08-03');
  });

  it('returns nothing at all for a book with no close', () => {
    expect(listPeriods([], 'week')).toEqual([]);
  });
});

describe('resolvePeriod, week', () => {
  const clients = book(['2026-07-20', '2026-07-22', '2026-07-27', '2026-07-28', '2026-07-30']);

  it('takes Monday to Sunday from any day inside the week', () => {
    const period = resolvePeriod(clients, { kind: 'week', key: '2026-07-29' });
    expect([period.from, period.to]).toEqual(['2026-07-27', '2026-08-02']);
  });

  it('puts the prior period in the seven days immediately before, with its own closes', () => {
    const period = resolvePeriod(clients, { kind: 'week', key: '2026-07-27' });
    expect([period.priorFrom, period.priorTo]).toEqual(['2026-07-20', '2026-07-26']);
    expect(period.priorCloses).toEqual(['2026-07-20', '2026-07-22']);
    expect(period.priorEmpty).toBe(false);
    expect(period.priorLabel).toBe('Week of 2026-07-20');
  });

  it('holds only the closes inside its own bounds', () => {
    const period = resolvePeriod(clients, { kind: 'week', key: '2026-07-27' });
    expect(period.closes).toEqual(['2026-07-27', '2026-07-28', '2026-07-30']);
  });

  it('is partial when it runs past the book, and says both causes', () => {
    const period = resolvePeriod(clients, { kind: 'week', key: '2026-07-27' });
    expect(period.partial).toBe(true);
    expect(period.runsPastBook).toBe(true);
    expect(period.missingWeekdays).toEqual(['2026-07-29', '2026-07-31']);
    expect(period.partialReasons.join(' ')).toContain('It runs to 2026-08-02');
    expect(period.partialReasons.join(' ')).toContain('2026-07-29, 2026-07-31');
  });

  it('is not partial when every weekday holds a close and the period ends inside the book', () => {
    const full = book(['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24', '2026-07-31']);
    const period = resolvePeriod(full, { kind: 'week', key: '2026-07-20' });
    expect(period.missingWeekdays).toEqual([]);
    expect(period.partial).toBe(false);
  });

  it('defaults to the week of the book’s latest close, never the wall clock', () => {
    const period = resolvePeriod(clients, {});
    expect(period.from).toBe('2026-07-27');
  });
});

describe('resolvePeriod, month', () => {
  const clients = book(['2026-07-13', '2026-07-30']);

  it('runs the first to the last calendar day and compares with the calendar month before', () => {
    const period = resolvePeriod(clients, { kind: 'month', key: '2026-07' });
    expect([period.from, period.to]).toEqual(['2026-07-01', '2026-07-31']);
    expect([period.priorFrom, period.priorTo]).toEqual(['2026-06-01', '2026-06-30']);
  });

  it('reports priorEmpty when the book holds no close in the month before', () => {
    const period = resolvePeriod(clients, { kind: 'month', key: '2026-07' });
    expect(period.priorEmpty).toBe(true);
    expect(period.priorCloses).toEqual([]);
  });

  it('crosses a year boundary', () => {
    const period = resolvePeriod(book(['2026-01-05']), { kind: 'month', key: '2026-01' });
    expect([period.priorFrom, period.priorTo]).toEqual(['2025-12-01', '2025-12-31']);
  });
});

describe('resolvePeriod, custom', () => {
  const clients = book(['2026-07-13', '2026-07-20', '2026-07-30']);

  it('puts the prior period in the same number of calendar days ending the day before from', () => {
    const period = resolvePeriod(clients, { kind: 'custom', from: '2026-07-13', to: '2026-07-21' });
    expect(daysInclusive(period.from, period.to)).toBe(9);
    expect([period.priorFrom, period.priorTo]).toEqual(['2026-07-04', '2026-07-12']);
    expect(daysInclusive(period.priorFrom, period.priorTo)).toBe(9);
  });

  it('swaps the bounds when they arrive the wrong way round', () => {
    const period = resolvePeriod(clients, { kind: 'custom', from: '2026-07-30', to: '2026-07-13' });
    expect([period.from, period.to]).toEqual(['2026-07-13', '2026-07-30']);
  });

  it('labels itself with its bounds, because a reader cannot infer them', () => {
    const period = resolvePeriod(clients, { kind: 'custom', from: '2026-07-13', to: '2026-07-21' });
    expect(period.label).toBe('2026-07-13 to 2026-07-21');
    expect(period.priorLabel).toBe('2026-07-04 to 2026-07-12');
  });
});

describe('a period the book has nothing in', () => {
  const clients = book(['2026-07-13', '2026-07-30']);

  it('says so by name rather than reporting zeros', () => {
    const period = resolvePeriod(clients, { kind: 'custom', from: '2026-09-01', to: '2026-09-07' });
    expect(period.empty).toBe(true);
    expect(period.closes).toEqual([]);
    expect(period.emptyReason).toBe(
      'No close inside this period. The book runs from 2026-07-13 to 2026-07-30.',
    );
  });
});

describe('a weekend close', () => {
  it('is inside the period and is counted apart from the weekdays', () => {
    const clients = book(['2026-07-24', '2026-07-25']); // Friday and Saturday
    const period = resolvePeriod(clients, { kind: 'week', key: '2026-07-20' });
    expect(period.closes).toEqual(['2026-07-24', '2026-07-25']);
    expect(period.weekendCloses).toEqual(['2026-07-25']);
    expect(period.weekdays).toBe(5);
  });
});
