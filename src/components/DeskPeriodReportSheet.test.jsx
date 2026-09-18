// What the sheet must say, on synthetic fixtures, so CI runs it.
//
// DeskPeriodReportSheet.book.test.jsx renders the real book and is dropped on
// every clone that does not carry public/local-snapshot.json. That is why this
// file exists: the rules below are the ones a rewrite of the markup can break
// silently, and a rule pinned only by a gated suite is not pinned.
//
// Each assertion is here because it can break without failing a count. A
// tooltip that loses its window clause still renders. A heading that moves
// above coverage still renders. A benchmark dollar that lands in a client table
// still renders — and reads, to the desk manager, as what the algorithm made.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import DeskPeriodReportSheet from './DeskPeriodReportSheet';
import { buildDeskPeriodReport } from '../domain/deskPeriodReport';
import { listPeriods, resolvePeriod } from '../domain/deskPeriod';

function strat(algo, pnl) {
  return {
    strategyFamily: algo,
    strategyVersion: '1.0',
    instrument: 'MNQ SEP26',
    enabled: true,
    realized: pnl,
    params: { profitTargets: [100, 200, 300], stopLossTicks: 50, posSizes: [1, 1, 0] },
  };
}

function bulkClient({ id, algo = 'RBO', accountCount = 12, dates = [], pnl = -100 }) {
  const accounts = Array.from({ length: accountCount }, (_, index) => `${id}-A${index + 1}`);
  const accountRegistry = {};
  for (const accountName of accounts) {
    accountRegistry[accountName] = { accountName, accountType: 'Funded', status: 'Active' };
  }
  return {
    id,
    name: id,
    accountRegistry,
    dailyImports: dates.map((date) => ({
      id: `${id}-${date}`,
      date,
      importedAt: `${date}T22:00:00Z`,
      snapshots: accounts.map((accountName) => ({
        accountName,
        grossRealizedPnl: pnl,
        weeklyPnl: 0,
        accountBalance: 50000,
        strategies: [strat(algo, pnl)],
      })),
      executions: [],
      flags: [],
    })),
  };
}

const clients = [
  bulkClient({ id: 'prior', dates: ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23'], pnl: -100 }),
  bulkClient({ id: 'now', dates: ['2026-07-27', '2026-07-28', '2026-07-30'], pnl: -200 }),
];

const BENCHMARK = [{
  key: 'RBO|1.0|M2K|Low',
  algorithm: 'RBO',
  version: '1.0',
  instrument: 'M2K',
  riskLevel: 'Low',
  sourceFile: 'RBO_-_M2K_-_Low_Risk.csv',
  quantities: [2, 4],
  firstDate: '2026-07-20',
  lastDate: '2026-07-30',
  basis: 'My Futures Book backtest. One simulated account, Low risk sizing, M2K, algorithm alone.',
  days: [
    { date: '2026-07-27', net: 7777, trades: 3 },
    { date: '2026-07-30', net: 1111, trades: 2 },
  ],
}];

function render(options = { kind: 'week', key: '2026-07-27' }, extra = {}) {
  const period = resolvePeriod(clients, options);
  const report = buildDeskPeriodReport(clients, {
    period, benchmarkSeries: extra.benchmarkSeries || [], benchmarkRisk: 'Low',
    builtAt: '2026-09-18 14:22', builtBy: 'Pedro',
    ...extra.build,
  });
  return {
    report,
    html: renderToStaticMarkup(
      <DeskPeriodReportSheet
        report={report}
        periods={listPeriods(clients, options.kind || 'week')}
        kind={options.kind || 'week'}
        benchmarkRisk="Low"
      />,
    ),
  };
}

describe('the sheet', () => {
  const { html } = render();

  it('carries the separation sentence, in the place the Stack Playbook carries its own', () => {
    expect(html).toContain('Not comparable to My Futures Book');
    expect(html).toContain('Not the algorithms’ own track records');
  });

  it('puts coverage before results in document order', () => {
    const coverage = html.indexOf('How much of the desk this period holds');
    const results = html.indexOf('Algorithm results in this period');
    expect(coverage).toBeGreaterThan(-1);
    expect(results).toBeGreaterThan(-1);
    expect(coverage).toBeLessThan(results);
  });

  it('renders the ten section headings in the order the report fixes', () => {
    const headings = [
      'How much of the desk this period holds',
      'Desk money in this period',
      'Algorithm roster: running, new, stopped, history',
      'Algorithm results in this period',
      'This period against the period before, and against the book',
      'The stack: what combinations of algorithms did on funded client accounts',
      'What changed on the accounts in this period',
      'My Futures Book, measured separately',
      'Method, populations, and what this report refuses',
    ];
    let cursor = -1;
    for (const heading of headings) {
      const at = html.indexOf(heading);
      expect(at, heading).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('heads the page with the period, its closes and the book it was built from', () => {
    expect(html).toContain('Desk Period Report');
    expect(html).toContain('Week of 2026-07-27');
    expect(html).toContain('2026-07-27 to 2026-08-02');
    expect(html).toContain('3 closes of 5 weekdays');
    expect(html).toContain('from a book whose newest close is 2026-07-30');
    expect(html).toContain('Built 2026-09-18 14:22 by Pedro');
  });

  it('keeps the period controls out of the sheet and inside a no-print bar', () => {
    const sheet = html.slice(html.indexOf('class="report-sheet"'));
    expect(sheet).not.toContain('<select');
    expect(sheet).not.toContain('type="date"');
    expect(html).toContain('report-actions no-print');
  });
});

describe('a period that is not complete is stated as not complete', () => {
  it('names both causes in bold, above the first table', () => {
    const { html } = render();
    expect(html).toContain('This period is not complete.');
    expect(html).toContain('It runs to 2026-08-02 and the book&#x27;s newest close is 2026-07-30.');
    expect(html).toContain('2 weekdays inside it hold no close: 2026-07-29, 2026-07-31.');
    expect(html.indexOf('This period is not complete.'))
      .toBeLessThan(html.indexOf('How much of the desk this period holds'));
  });

  it('gives each weekday with no close a No close row rather than a zero', () => {
    const { html } = render();
    expect(html).toContain('>No close<');
    expect(html).toContain('2026-07-29');
  });

  it('says nothing of the kind when every weekday holds a close', () => {
    const full = [bulkClient({
      id: 'full',
      dates: ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24', '2026-07-31'],
    })];
    const period = resolvePeriod(full, { kind: 'week', key: '2026-07-20' });
    const report = buildDeskPeriodReport(full, { period });
    const html = renderToStaticMarkup(<DeskPeriodReportSheet report={report} kind="week" />);
    expect(html).not.toContain('This period is not complete.');
    expect(html).not.toContain('>No close<');
  });
});

describe('a thin period is stated as thin', () => {
  it('prints the coverage factor and the no-dollar rule under the coverage table', () => {
    const uneven = [
      bulkClient({ id: 'big', accountCount: 40, dates: ['2026-07-27'] }),
      bulkClient({ id: 'small', accountCount: 1, dates: ['2026-07-30'] }),
    ];
    const period = resolvePeriod(uneven, { kind: 'week', key: '2026-07-27' });
    const report = buildDeskPeriodReport(uneven, { period });
    const html = renderToStaticMarkup(<DeskPeriodReportSheet report={report} kind="week" />);
    expect(html).toContain('Coverage inside this period runs from 1 to 40 account rows per close');
    expect(html).toContain('a factor of 40');
    expect(html).toContain('no two periods are compared in dollars');
  });

  it('says no algorithm clears the gate instead of drawing a chart of three account days', () => {
    const thin = [bulkClient({ id: 'thin', accountCount: 3, dates: ['2026-07-27'] })];
    const period = resolvePeriod(thin, { kind: 'week', key: '2026-07-27' });
    const report = buildDeskPeriodReport(thin, { period });
    const html = renderToStaticMarkup(<DeskPeriodReportSheet report={report} kind="week" />);
    expect(html).toContain('No algorithm clears 30 reported account days and 10 accounts');
    expect(html).toContain('Not ranked');
  });

  it('warns when the states are decided on a close carrying a fraction of the desk', () => {
    const saturday = [
      bulkClient({ id: 'weekday', accountCount: 40, dates: ['2026-07-20', '2026-07-23'] }),
      bulkClient({ id: 'saturday', accountCount: 1, dates: ['2026-07-25'] }),
    ];
    const period = resolvePeriod(saturday, { kind: 'week', key: '2026-07-20' });
    const report = buildDeskPeriodReport(saturday, { period });
    const html = renderToStaticMarkup(<DeskPeriodReportSheet report={report} kind="week" />);
    expect(html).toContain('Running and Stopped are decided on 2026-07-25');
    expect(html).toContain('not from the desk');
  });

  it('states the empty period by name rather than rendering blank tables', () => {
    const period = resolvePeriod(clients, { kind: 'custom', from: '2026-09-01', to: '2026-09-07' });
    const report = buildDeskPeriodReport(clients, { period });
    const html = renderToStaticMarkup(<DeskPeriodReportSheet report={report} kind="custom" />);
    expect(html).toContain('No close inside this period. The book runs from 2026-07-20 to 2026-07-30.');
  });
});

describe('every column states its population, its window and its basis', () => {
  const { html } = render();
  const titles = [...html.matchAll(/title="([^"]+)"/g)].map((match) => match[1]);
  const headerTitles = titles.filter((title) => /Population:/.test(title));

  it('puts all three clauses on every column tooltip that carries one', () => {
    expect(headerTitles.length).toBeGreaterThan(30);
    const missing = headerTitles.filter(
      (title) => !/Window:/.test(title) || !/Basis:/.test(title),
    );
    expect(missing).toEqual([]);
  });

  it('names the account close as the money unit and the account day as the result unit', () => {
    expect(html).toContain('P&amp;L per account close');
    expect(html).toContain('P&amp;L per account day');
    expect(titles.some((title) => title.includes('the same account is counted once per close'))).toBe(true);
  });

  it('prints the prior window by name on the columns that compare with it', () => {
    expect(titles.some((title) => title.includes('Window: Week of 2026-07-20'))).toBe(true);
  });
});

describe('the benchmark never shares a table with a client figure', () => {
  const { html } = render({ kind: 'week', key: '2026-07-27' }, { benchmarkSeries: BENCHMARK });

  it('keeps every benchmark dollar after the benchmark heading', () => {
    const heading = html.indexOf('My Futures Book, measured separately');
    expect(heading).toBeGreaterThan(-1);
    expect(html.indexOf('8,888')).toBeGreaterThan(heading); // 7777 + 1111, the period's net
    expect(html.slice(0, heading)).not.toContain('8,888');
  });

  it('labels the risk level in the heading, so the paper records which file was read', () => {
    expect(html).toContain('My Futures Book, measured separately (Low risk)');
  });

  it('prints the basis sentence on the benchmark figures', () => {
    expect(html).toContain('One simulated account');
    expect(html).toContain('Low risk sizing');
  });

  it('refuses every agreement figure by name, with the count that refused it', () => {
    expect(html).toContain('No agreement figure is stated');
    expect(html).toContain('closes in common, fewer than the 20');
  });

  it('never puts a benchmark net inside a row that also carries a client rate', () => {
    const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((match) => match[1]);
    const clientRows = rows.filter((row) => row.includes('per account'));
    for (const row of clientRows) {
      expect(row).not.toContain('8,888');
      expect(row).not.toContain('simulated account');
    }
  });
});

describe('the refusals block', () => {
  it('prints every refusal with its reason, on the paper', () => {
    const { html, report } = render();
    for (const entry of report.refusals) {
      expect(html).toContain(entry.figure.replace(/&/g, '&amp;'));
    }
    expect(html).toContain('Method, populations, and what this report refuses');
  });

  it('prints the definitions with the module that owns each one', () => {
    const { html } = render();
    expect(html).toContain('Account day');
    expect(html).toContain('Evidence gate');
    expect(html).toContain('comboPerformance.js');
  });
});
