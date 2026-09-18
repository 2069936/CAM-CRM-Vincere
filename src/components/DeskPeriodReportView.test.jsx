// What the wrapper must hand the sheet, on both shells.
//
// UNGATED: no snapshot is read here. The rules below are the ones the review
// found broken and that nothing on the page shows: a CAM's copy computing the
// desk-wide sections over the CAM's own eight clients while printing "desk
// wide for everybody" underneath, and a benchmark import that exists only until
// the reader navigates away.

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// `supabaseStore` reaches for `import.meta.env` and a network client at import
// time; the saved-import read is not this file's subject, so it is stubbed to
// the empty answer the loader gives when the table is missing.
vi.mock('../domain/supabaseStore', () => ({
  loadAlgorithmBenchmarks: vi.fn(async () => []),
}));

import DeskPeriodReportView from './DeskPeriodReportView';
import { resetBenchmarkSessionCache } from '../domain/benchmarkSessionCache';

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

function bulkClient({ id, algo = 'RBO', accountCount = 12, dates = [] }) {
  const accounts = Array.from({ length: accountCount }, (_, index) => `${id}-A${index + 1}`);
  return {
    id,
    name: id,
    accountRegistry: Object.fromEntries(accounts.map((accountName) => [accountName, {
      accountName, accountType: 'Funded', status: 'Active',
    }])),
    dailyImports: dates.map((date) => ({
      id: `${id}-${date}`,
      date,
      importedAt: `${date}T22:00:00Z`,
      snapshots: accounts.map((accountName) => ({
        accountName,
        grossRealizedPnl: -100,
        weeklyPnl: 0,
        accountBalance: 50000,
        strategies: [strat(algo)],
      })),
      executions: [],
      flags: [],
    })),
  };
}

const WEEK = ['2026-07-27', '2026-07-28', '2026-07-30'];
const desk = [
  bulkClient({ id: 'mine', algo: 'RBO', accountCount: 4, dates: WEEK }),
  bulkClient({ id: 'theirs-1', algo: 'URGO', accountCount: 20, dates: WEEK }),
  bulkClient({ id: 'theirs-2', algo: 'URGO', accountCount: 20, dates: WEEK }),
];
const mine = [desk[0]];

beforeEach(() => resetBenchmarkSessionCache());

describe('the manager’s shell', () => {
  it('renders desk wide, with the desk’s own client count on the label', () => {
    const html = renderToStaticMarkup(<DeskPeriodReportView clients={desk} scope="desk" />);
    expect(html).toContain('Desk wide, 3 clients');
    expect(html).toContain('Desk Period Report');
  });
});

describe('the CAM’s shell', () => {
  const html = renderToStaticMarkup(
    <DeskPeriodReportView
      clients={desk}
      scopedClients={mine}
      scope="cam"
      camName="Ana"
      camProfileId="cam-1"
    />,
  );

  it('labels the copy as the CAM’s book', () => {
    expect(html).toContain('Your book, 1 of the desk');
    expect(html).toContain('s 3 clients');
  });

  it('ranks the DESK’s algorithms, not the CAM’s one client’s', () => {
    // Over this CAM's single client only RBO exists at all. The desk runs URGO
    // on forty accounts, and the roster, the results and the stack are desk
    // wide — which is what the sentence at the foot of the page claims and what
    // the measurement did not do before `deskClients` was passed.
    expect(html).toContain('URGO');
    expect(html).toContain('desk wide for everybody');
    expect(html).not.toContain('computed over this book alone');
  });

  it('keeps coverage on the CAM’s own book', () => {
    // 4 accounts over 3 closes, not the desk's 44.
    expect(html).toContain('12 account closes over 4 accounts and 1 client');
  });
});
