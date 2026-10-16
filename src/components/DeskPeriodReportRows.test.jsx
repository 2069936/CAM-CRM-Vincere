// NOT LOADED IS NOT EMPTY, on the period report.
//
// A login holds each client's latest close account by account and every older
// close with `snapshots: []` and `snapshotsLoaded: false`. On 2026-10-16 the
// month of October printed `Accounts reporting 0` on eleven of its thirteen
// closes, under 94 clients reporting on each, because the report read those
// empty arrays as closes on which nobody reported. These tests pin the three
// things that stop that: the report asks for its own rows, it prints nothing
// while they are on their way, and any close still without rows is named as
// missing rather than counted as zero.
//
// UNGATED: fixtures only.

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../domain/supabaseStore', () => ({
  loadAlgorithmBenchmarks: vi.fn(async () => []),
}));

import DeskPeriodReportSheet from './DeskPeriodReportSheet';
import DeskPeriodReportView from './DeskPeriodReportView';
import { resetBenchmarkSessionCache } from '../domain/benchmarkSessionCache';
import { buildDeskPeriodReport, closesNeedingRows } from '../domain/deskPeriodReport';
import { resolvePeriod } from '../domain/deskPeriod';

function strat(algo) {
  return {
    strategyFamily: algo,
    strategyVersion: '1.0',
    instrument: 'MNQ SEP26',
    enabled: true,
    realized: -100,
    params: { profitTargets: [100, 200, 300], stopLossTicks: 50, posSizes: [1, 1, 0] },
  };
}

/**
 * `accountCount` accounts on every date. Dates in `unloaded` arrive the way a
 * login hands them over: no rows, flagged as not fetched, with a database id.
 */
function client({ id, algo = 'RBO', accountCount = 12, dates = [], unloaded = [] }) {
  const accounts = Array.from({ length: accountCount }, (_, index) => `${id}-A${index + 1}`);
  return {
    id,
    name: id,
    accountRegistry: Object.fromEntries(accounts.map((accountName) => [accountName, {
      accountName, accountType: 'Funded', status: 'Active',
    }])),
    dailyImports: dates.map((date) => {
      const missing = unloaded.includes(date);
      return {
        id: `${id}-${date}`,
        uuid: `uuid-${id}-${date}`,
        date,
        importedAt: `${date}T22:00:00Z`,
        snapshotsLoaded: !missing,
        snapshots: missing ? [] : accounts.map((accountName) => ({
          accountName,
          grossRealizedPnl: -100,
          weeklyPnl: 0,
          accountBalance: 50000,
          strategies: [strat(algo)],
        })),
        executions: [],
        flags: [],
      };
    }),
  };
}

const PRIOR = ['2026-07-20', '2026-07-21', '2026-07-22'];
const WEEK = ['2026-07-27', '2026-07-28', '2026-07-30'];
const EARLIER = ['2026-07-13', '2026-07-14'];
const ALL = [...EARLIER, ...PRIOR, ...WEEK];

function weekPeriod(clients) {
  return resolvePeriod(clients, { kind: 'week', key: '2026-07-27' });
}

describe('closesNeedingRows', () => {
  it('lists the unfetched closes of the period and the period before it, by database id', () => {
    const clients = [client({ id: 'c1', dates: ALL, unloaded: ['2026-07-13', '2026-07-21', '2026-07-27', '2026-07-28'] })];
    expect(closesNeedingRows(clients, weekPeriod(clients)).sort()).toEqual([
      'uuid-c1-2026-07-21',
      'uuid-c1-2026-07-27',
      'uuid-c1-2026-07-28',
    ]);
  });

  it('asks for nothing when every close already holds its rows, or the flag is absent', () => {
    const loaded = [client({ id: 'c1', dates: ALL })];
    expect(closesNeedingRows(loaded, weekPeriod(loaded))).toEqual([]);
    const local = [client({ id: 'c1', dates: ALL })];
    for (const dailyImport of local[0].dailyImports) delete dailyImport.snapshotsLoaded;
    expect(closesNeedingRows(local, weekPeriod(local))).toEqual([]);
  });
});

describe('the report built over closes without rows', () => {
  it('counts them as missing, never as accounts that did not report', () => {
    const clients = [client({ id: 'c1', dates: ALL, unloaded: ['2026-07-28'] })];
    const report = buildDeskPeriodReport(clients, { period: weekPeriod(clients) });
    expect(report.coverage.totals.closesWithoutRows).toBe(1);
    const row = report.coverage.rows.find((entry) => entry.date === '2026-07-28');
    expect(row.rowsNotLoaded).toBe(1);
    expect(report.coverage.rows.find((entry) => entry.date === '2026-07-27').rowsNotLoaded).toBe(0);

    const html = renderToStaticMarkup(<DeskPeriodReportSheet report={report} kind="week" />);
    expect(html).toContain('1 close in this period could not be read account by account');
    expect(html).toContain('They are missing, not zero.');
  });

  it('says nothing about missing rows when every close holds them', () => {
    const clients = [client({ id: 'c1', dates: ALL })];
    const report = buildDeskPeriodReport(clients, { period: weekPeriod(clients) });
    expect(report.coverage.totals.closesWithoutRows).toBe(0);
    const html = renderToStaticMarkup(<DeskPeriodReportSheet report={report} kind="week" />);
    expect(html).not.toContain('could not be read account by account');
  });

  it('refuses New while the closes before the period were not read', () => {
    // RBO runs on every close. With the earlier closes unread its first
    // appearance among the rows held is this week, which is the lie.
    const unread = [client({ id: 'c1', dates: ALL, unloaded: EARLIER })];
    const refused = buildDeskPeriodReport(unread, { period: weekPeriod(unread) });
    expect(refused.roster.newMeasurable).toBe(false);
    expect(refused.roster.newRefusal).toContain('were not read for this report');
    expect(refused.summary.newInPeriod).toEqual([]);

    // Read in full, the same book decides New, and RBO is not new.
    const read = [client({ id: 'c1', dates: ALL })];
    const decided = buildDeskPeriodReport(read, { period: weekPeriod(read) });
    expect(decided.roster.newMeasurable).toBe(true);
    expect(decided.roster.newRefusal).toBeNull();
    expect(decided.summary.newInPeriod).toEqual([]);

    // And a genuinely new algorithm is still found once history is read.
    const fresh = [
      client({ id: 'c1', dates: ALL }),
      client({ id: 'c2', algo: 'URGO', dates: WEEK }),
    ];
    expect(buildDeskPeriodReport(fresh, { period: weekPeriod(fresh) }).summary.newInPeriod)
      .toContain('URGO 1.0');
  });
});

describe('the sheet while the rows are on their way', () => {
  const clients = [client({ id: 'c1', dates: ALL, unloaded: ['2026-07-28'] })];
  const report = buildDeskPeriodReport(clients, { period: weekPeriod(clients) });

  it('prints no figure and offers no download or copy while loading', () => {
    const html = renderToStaticMarkup(
      <DeskPeriodReportSheet
        report={report}
        kind="week"
        onCopySummary={() => {}}
        rowsLoad={{ status: 'loading', error: '', missing: 1, waiting: 'Reading the account rows of 1 close.' }}
      />,
    );
    expect(html).toContain('Reading the account rows of 1 close.');
    expect(html).not.toContain('Desk Period Report');
    expect(html).not.toContain('Accounts reporting');
    expect(html).not.toContain('Download PDF');
    expect(html).not.toContain('Copy summary');
    // The period can still be changed.
    expect(html).toContain('Week');
  });

  it('says what failed and offers to try again', () => {
    const html = renderToStaticMarkup(
      <DeskPeriodReportSheet
        report={report}
        kind="week"
        rowsLoad={{ status: 'error', error: 'Could not load the settings for this day: timeout', missing: 1, waiting: 'x', onRetry: () => {} }}
      />,
    );
    expect(html).toContain('timeout');
    expect(html).toContain('Try again');
    expect(html).not.toContain('Desk Period Report');
  });

  it('builds the report once the fetch has answered', () => {
    const html = renderToStaticMarkup(
      <DeskPeriodReportSheet
        report={report}
        kind="week"
        rowsLoad={{ status: 'loaded', error: '', missing: 1, waiting: 'x', onRetry: () => {} }}
      />,
    );
    expect(html).toContain('Desk Period Report');
    // Whatever the fetch did not bring is still named as missing.
    expect(html).toContain('They are missing, not zero.');
  });
});

describe('the view asks for its own rows', () => {
  beforeEach(() => resetBenchmarkSessionCache());

  it('blocks the sheet while the period has closes without rows and a loader exists', () => {
    const clients = [client({ id: 'c1', dates: ALL, unloaded: ['2026-07-27', '2026-07-28'] })];
    const html = renderToStaticMarkup(
      <DeskPeriodReportView
        clients={clients}
        onNeedCloseRows={() => Promise.resolve(null)}
        closeRowsLoadFor={() => ({ status: 'idle', error: '' })}
      />,
    );
    expect(html).toContain('Reading the account rows of 2 closes');
    expect(html).not.toContain('Desk Period Report');
  });

  it('keys the load state by period, so one period never inherits another one’s loaded', () => {
    const clients = [client({ id: 'c1', dates: ALL, unloaded: ['2026-07-28'] })];
    const asked = [];
    renderToStaticMarkup(
      <DeskPeriodReportView
        clients={clients}
        onNeedCloseRows={() => Promise.resolve(null)}
        closeRowsLoadFor={(key) => { asked.push(key); return { status: 'loaded', error: '' }; }}
      />,
    );
    expect(asked).toEqual(['period-report:2026-07-20:2026-08-02']);
  });

  it('renders straight away when every close holds its rows', () => {
    const clients = [client({ id: 'c1', dates: ALL })];
    const html = renderToStaticMarkup(
      <DeskPeriodReportView
        clients={clients}
        onNeedCloseRows={() => Promise.resolve(null)}
        closeRowsLoadFor={() => ({ status: 'idle', error: '' })}
      />,
    );
    expect(html).toContain('Desk Period Report');
  });
});
