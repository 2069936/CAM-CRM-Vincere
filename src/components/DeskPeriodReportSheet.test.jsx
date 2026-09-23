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

  it('renders the section headings in the order the report fixes', () => {
    // THE ANSWER, THEN THE DENOMINATOR, THEN THE WORK. Coverage is still the
    // first full section, for the reason the sheet's own header argues; what
    // changed is that the page no longer opens on a six-column table of closes
    // with no verdict anywhere above it, and that Results now precedes the
    // Roster, which is the order the two questions were asked in.
    const headings = [
      'The short answer',
      'How much of the desk this period holds',
      'Desk money in this period',
      'Algorithm results in this period',
      'Algorithm roster: running, new, stopped, history',
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
    expect(html).toContain('3 of 5 weekdays hold a close');
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
    // 2026-07-31 sits AFTER the book's newest close, which the sentence above
    // already states; only 2026-07-29 is a close somebody owed and did not file.
    expect(html).toContain("1 weekday inside the book&#x27;s range holds no close: 2026-07-29.");
    expect(html).not.toContain('2026-07-29, 2026-07-31.');
    expect(html.indexOf('This period is not complete.'))
      .toBeLessThan(html.indexOf('How much of the desk this period holds'));
  });

  it('gives each weekday with no close a No close row that says WHY, rather than a zero', () => {
    const { html } = render();
    expect(html).toContain('No close. Inside the book');
    expect(html).toContain('range and no close was filed.');
    expect(html).toContain("No close. After the book&#x27;s newest close (2026-07-30).");
    expect(html).toContain('2026-07-29');
    expect(html).toContain('2026-07-31');
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
    expect(html).not.toContain('No close.');
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

  it('decides the states on a close that represents the desk, and prints which one', () => {
    // The Saturday close carries one account against the week's 40. Deciding
    // Running and Stopped on it is how a column headed State came to read
    // "Stopped" against an algorithm with 212 account days that week.
    const saturday = [
      bulkClient({ id: 'weekday', accountCount: 40, dates: ['2026-07-20', '2026-07-23'] }),
      bulkClient({ id: 'saturday', algo: 'URGO', accountCount: 1, dates: ['2026-07-25'] }),
    ];
    const period = resolvePeriod(saturday, { kind: 'week', key: '2026-07-20' });
    const report = buildDeskPeriodReport(saturday, { period });
    const html = renderToStaticMarkup(<DeskPeriodReportSheet report={report} kind="week" />);
    expect(html).toContain('Running and Stopped are decided on 2026-07-23, not on 2026-07-25');
    expect(html).toContain('not from the desk');
    // The deciding date is in the column header too, not only in the prose.
    expect(html).toContain('State on 2026-07-23');
    expect(html).toContain('Accounts on 2026-07-23');
    expect(report.roster.rows.find((row) => row.algorithm === 'RBO 1.0').state).toBe('Running');
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

/* ---------------------------------------------------------------- */
/* What the pre-merge review found in the markup.                    */

describe('the page answers before it justifies', () => {
  const { html, report } = render();

  it('puts the summary above the first denominator table', () => {
    const answer = html.indexOf('The short answer');
    const coverage = html.indexOf('How much of the desk this period holds');
    expect(answer).toBeGreaterThan(-1);
    expect(answer).toBeLessThan(coverage);
  });

  it('builds the summary from the same object the pasted line uses, so they cannot disagree', () => {
    for (const row of report.summary.money) {
      expect(html).toContain(row.label);
    }
    expect(html).toContain(report.summary.closesSentence);
    expect(html).toContain(report.summary.coverageLine);
    expect(html).toContain(`Running as of ${report.summary.stateClose}`);
  });

  it('keeps coverage the first FULL section, with the link from the summary to it', () => {
    expect(html).toContain('id="period-coverage"');
    expect(html).toContain('href="#period-coverage"');
  });
});

describe('the changes table on paper', () => {
  // 30 accounts changing combination inside the period: more than the 25 the
  // screen shows.
  const many = [{
    id: 'busy',
    name: 'busy',
    accountRegistry: Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [`B${index}`, {
        accountName: `B${index}`, accountType: 'Funded', status: 'Active',
      }]),
    ),
    dailyImports: ['2026-07-27', '2026-07-28', '2026-07-30'].map((date) => ({
      id: `busy-${date}`,
      date,
      importedAt: `${date}T22:00:00Z`,
      snapshots: Array.from({ length: 30 }, (_, index) => ({
        accountName: `B${index}`,
        grossRealizedPnl: -100,
        weeklyPnl: 0,
        accountBalance: 50000,
        strategies: [strat(date === '2026-07-27' ? 'RBO' : 'URGO', -100)],
      })),
      executions: [],
      flags: [],
    })),
  }];
  const period = resolvePeriod(many, { kind: 'week', key: '2026-07-27' });
  const report = buildDeskPeriodReport(many, { period });
  const html = renderToStaticMarkup(<DeskPeriodReportSheet report={report} kind="week" />);

  it('says on the paper that rows were cut, outside the no-print control', () => {
    expect(report.changes.rows.length).toBe(30);
    const caption = 'This screen shows the 25 most recent of 30 changes';
    expect(html).toContain(caption);
    // The sentence must not live inside the element print hides.
    const noPrintAt = html.indexOf('ghost-button no-print');
    expect(html.indexOf(caption)).toBeLessThan(noPrintAt);
  });

  it('renders the rows the screen cut into a group only print shows', () => {
    expect(html).toContain('<tbody class="print-only">');
    // Every change row is in the DOM, so the printed copy carries all 30.
    const bodyRows = [...html.matchAll(/B\d+<\/td>/g)];
    expect(bodyRows.length).toBe(30);
  });

  it('counts the accounts the listed changes touch, not the accounts of every change', () => {
    expect(html).toContain(`over ${report.changes.counts.decisionAccounts} accounts`);
    expect(report.changes.counts.decisionAccounts).toBe(30);
  });
});

describe('the two account-day counts are never one column', () => {
  const { html } = render();

  it('heads the results column with both, and prints both in every cell', () => {
    expect(html).toContain('Account days measured, of days it ran');
    expect(html).toMatch(/\d+ of \d+/);
  });

  it('gives the programmes table the population, window and basis tooltips', () => {
    const { html: withProgramme } = render();
    const titles = [...withProgramme.matchAll(/title="([^"]+)"/g)].map((match) => match[1]);
    // Every tooltip on the page that names a population also names a window and
    // a basis; the programmes table used to carry no tooltip at all.
    expect(titles.filter((title) => /Population:/.test(title)).length).toBeGreaterThan(30);
  });
});

describe('the benchmark carries its risk level and its basis on paper', () => {
  const { html } = render({ kind: 'week', key: '2026-07-27' }, { benchmarkSeries: BENCHMARK });

  it('prints the basis sentence as text, not only as a title attribute', () => {
    // A `title` renders in no print, no PDF and on no touch screen, and this
    // sheet exists to be printed. Section 3 requirement 2 of the spec makes the
    // sentence mandatory wherever an MFB number appears.
    const withoutTitles = html.replace(/title="[^"]*"/g, '');
    expect(withoutTitles).toContain('My Futures Book backtest, Low risk sizing');
    expect(withoutTitles).toContain('Not client account results');
  });

  it('prints the risk level each coverage row was measured at', () => {
    expect(html).toContain('Measured at');
  });
});
