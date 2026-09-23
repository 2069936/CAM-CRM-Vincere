import { describe, expect, it } from 'vitest';
import { buildDailyReportSummary, buildClientMessageReport, buildWeeklyMessageReport, summarizeAccountRows, buildCamDayReport } from './report';

describe('buildDailyReportSummary', () => {
  it('uses current account registry metadata over stale import metadata', () => {
    const client = {
      name: 'Amanda',
      accountRegistry: {
        ACC1: {
          accountName: 'ACC1',
          alias: 'Lucid - ACC1',
          accountType: 'Funded',
          status: 'Active',
        },
      },
    };
    const dailyImport = {
      date: '2026-06-08',
      status: 'Needs review',
      accounts: {
        ACC1: {
          accountName: 'ACC1',
          alias: 'Lucid - ACC1',
          accountType: 'Unassigned',
          status: 'Active',
        },
      },
      snapshots: [{ accountName: 'ACC1', accountBalance: 50100, grossRealizedPnl: 100, weeklyPnl: 100 }],
      flags: [],
    };

    const report = buildDailyReportSummary(client, dailyImport);

    expect(report.grouped.funded).toHaveLength(1);
    expect(report.grouped.evaluations).toHaveLength(0);
  });

  it('groups snapshots into funded even when registry key casing differs from snapshot accountName', () => {
    const client = {
      name: 'Amanda',
      accountRegistry: {
        APEX1234: { accountName: 'APEX1234', alias: 'My Account', accountType: 'Funded', status: 'Active' },
      },
    };
    const dailyImport = {
      date: '2026-06-25',
      status: 'Needs review',
      accounts: {},
      snapshots: [{ accountName: 'apex1234', accountBalance: 52000, grossRealizedPnl: 200, weeklyPnl: 400 }],
      flags: [],
    };

    const report = buildDailyReportSummary(client, dailyImport);

    expect(report.grouped.funded).toHaveLength(1);
    expect(report.grouped.funded[0].meta.alias).toBe('My Account');
  });

  it('exposes balance + PnL split by account type (segments), never combined', () => {
    const client = {
      name: 'Pedro',
      accountRegistry: {
        F1: { accountName: 'F1', accountType: 'Funded', status: 'Active' },
        C1: { accountName: 'C1', accountType: 'Cash', status: 'Active' },
        E1: { accountName: 'E1', accountType: 'Evaluation - Standard', status: 'Active' },
        B1: { accountName: 'B1', accountType: 'Evaluation - Bullet Bot', status: 'Active' },
      },
    };
    const dailyImport = {
      date: '2026-07-13',
      accounts: {},
      snapshots: [
        { accountName: 'F1', accountBalance: 52000, grossRealizedPnl: 300 },
        { accountName: 'C1', accountBalance: 10000, grossRealizedPnl: -50 },
        { accountName: 'E1', accountBalance: 51000, grossRealizedPnl: 200 },
        { accountName: 'B1', accountBalance: 3200, grossRealizedPnl: 100 },
      ],
      flags: [],
    };

    const report = buildDailyReportSummary(client, dailyImport);

    // Each pool separate — a Funded $52k, Cash $10k and Eval $51k are not $113k.
    expect(report.segments.funded).toMatchObject({ balance: 52000, dailyPnl: 300 });
    expect(report.segments.cash).toMatchObject({ balance: 10000, dailyPnl: -50 });
    expect(report.segments.evalStandard).toMatchObject({ balance: 51000, dailyPnl: 200 });
    // Bullet-bot kept out of the eval-standard pool (pass/fail, not balance).
    expect(report.segments.bulletBot).toMatchObject({ balance: 3200, dailyPnl: 100 });
    expect(report.segments.evalStandard.count).toBe(1);
  });
});

describe('summarizeAccountRows', () => {
  it('summarizes only the rows provided by the active tab', () => {
    const rows = [
      { accountName: 'CASH1', grossRealizedPnl: 10, weeklyPnl: 20, accountBalance: 1000 },
    ];

    const summary = summarizeAccountRows(rows);

    expect(summary.counts.accounts).toBe(1);
    expect(summary.totals.aggregateBalance).toBe(1000);
    expect(summary.totals.grossRealizedPnl).toBe(10);
  });
});

describe('buildClientMessageReport', () => {
  const client = {
    name: 'Pedro',
    accountRegistry: {
      APEX1: { accountName: 'APEX1', alias: 'Apex Main', accountType: 'Funded', status: 'Active' },
      EVAL1: { accountName: 'EVAL1', alias: 'Eval 1', accountType: 'Evaluation - Standard', status: 'Active' },
    },
  };
  const dailyImport = {
    date: '2026-06-25',
    accounts: {},
    snapshots: [
      { accountName: 'APEX1', grossRealizedPnl: 450, weeklyPnl: 1200, trailingMaxDrawdown: 3200, strategies: [{ strategyFamily: 'RBO', enabled: true }] },
      { accountName: 'EVAL1', grossRealizedPnl: -80, weeklyPnl: 320, strategies: [] },
    ],
    flags: [],
  };

  it('includes client name and date in the header', () => {
    const text = buildClientMessageReport(client, dailyImport);
    expect(text).toContain('Pedro');
    expect(text).toContain('2026-06-25');
  });

  it('shows daily and weekly P&L totals', () => {
    const text = buildClientMessageReport(client, dailyImport);
    expect(text).toContain('Daily P&L');
    expect(text).toContain('Weekly P&L');
  });

  it('lists funded accounts in the Funded Accounts section', () => {
    const text = buildClientMessageReport(client, dailyImport);
    expect(text).toContain('Funded Accounts');
    expect(text).toContain('Apex Main');
  });

  it('lists evaluation accounts in the Evaluations section', () => {
    const text = buildClientMessageReport(client, dailyImport);
    expect(text).toContain('Evaluations');
    expect(text).toContain('Eval 1');
  });

  it('returns a string with no account sections when dailyImport is null', () => {
    const text = buildClientMessageReport(client, null);
    expect(typeof text).toBe('string');
    expect(text).not.toContain('Funded Accounts');
    expect(text).not.toContain('Evaluations');
  });

  it('names an algorithm the grid had switched off that the fills say ran', () => {
    // THIS IS THE MESSAGE A CLIENT ACTUALLY RECEIVES. The exports are taken
    // after the desk switches the algos off, so `enabled` is the state of a
    // checkbox and not an answer about the day. The on-screen report sheet
    // moved onto strategyRan and this did not, so over the stored book 38
    // funded account lines told a client nothing had run on a day something
    // had, while the manager's table beside it named the algorithms.
    const ran = {
      ...dailyImport,
      snapshots: [{
        accountName: 'APEX1',
        grossRealizedPnl: 450,
        weeklyPnl: 1200,
        trailingMaxDrawdown: 3200,
        strategies: [{ strategyFamily: 'RBO', enabled: false, ran: true, ranBasis: 'fills' }],
      }],
    };

    expect(buildClientMessageReport(client, ran)).toContain('RBO');
  });

  it('still says nothing about an algorithm that really did not run', () => {
    const quiet = {
      ...dailyImport,
      snapshots: [{
        accountName: 'APEX1',
        grossRealizedPnl: 0,
        weeklyPnl: 0,
        strategies: [{ strategyFamily: 'RBO', enabled: false, ran: false, ranBasis: 'none' }],
      }],
    };

    expect(buildClientMessageReport(client, quiet)).not.toContain('RBO');
  });
});

describe('buildWeeklyMessageReport', () => {
  const makeImport = (date, pnl) => ({
    date,
    status: 'Closed',
    snapshots: [{ accountName: 'APEX1', grossRealizedPnl: pnl, weeklyPnl: pnl }],
    flags: [],
  });

  const client = {
    name: 'Pedro',
    accountRegistry: {
      APEX1: { accountName: 'APEX1', alias: 'Apex Main', accountType: 'Funded', status: 'Active' },
    },
    dailyImports: [
      makeImport('2026-06-23', 300),
      makeImport('2026-06-24', 150),
      makeImport('2026-06-25', -50),
    ],
  };

  it('includes client name and week range', () => {
    const text = buildWeeklyMessageReport(client);
    expect(text).toContain('Pedro');
    expect(text).toContain('2026-06-23');
    expect(text).toContain('2026-06-25');
  });

  it('shows net weekly P&L', () => {
    const text = buildWeeklyMessageReport(client);
    expect(text).toContain('Net P&L');
    expect(text).toContain('+$400'); // 300+150-50
  });

  it('omits worst day line when only one trading day', () => {
    const single = { ...client, dailyImports: [makeImport('2026-06-25', 200)] };
    const text = buildWeeklyMessageReport(single);
    expect(text).not.toContain('Worst day');
  });

  it('returns empty string when client has no imports', () => {
    expect(buildWeeklyMessageReport({ name: 'X', dailyImports: [] })).toBe('');
  });

  it('names what ran in the week, not what the checkbox said at export time', () => {
    // Same rule as the daily message, and the same reader: this is copied into
    // WhatsApp and sent.
    const withRan = {
      ...client,
      dailyImports: [{
        date: '2026-06-25',
        status: 'Closed',
        snapshots: [{
          accountName: 'APEX1',
          grossRealizedPnl: 120,
          weeklyPnl: 120,
          strategies: [{ strategyFamily: 'OGX', enabled: false, ran: true, ranBasis: 'fills' }],
        }],
        flags: [],
      }],
    };

    expect(buildWeeklyMessageReport(withRan)).toContain('OGX');
  });
});

// ── buildDailyReportSummary - flag counting ───────────────────────────────────

describe('buildDailyReportSummary flag counts', () => {
  const client = { name: 'Pedro', dailyImports: [], accountRegistry: {} };

  it('counts only Open flags (excludes Resolved and Acknowledged)', () => {
    const di = {
      date: '2026-06-25', status: 'Closed', accounts: {}, snapshots: [],
      flags: [
        { id: 'f1', severity: 'Critical', status: 'Open' },
        { id: 'f2', severity: 'Warning', status: 'Resolved' },
        { id: 'f3', severity: 'Critical', status: 'Acknowledged' },
        { id: 'f4', severity: 'Warning', status: 'Open' },
      ],
    };
    const r = buildDailyReportSummary(client, di);
    expect(r.counts.openFlags).toBe(2);
    expect(r.counts.criticalFlags).toBe(1);
  });

  it('returns zero flag counts when no flags present', () => {
    const di = { date: '2026-06-25', status: 'Closed', accounts: {}, snapshots: [], flags: [] };
    const r = buildDailyReportSummary(client, di);
    expect(r.counts.openFlags).toBe(0);
    expect(r.counts.criticalFlags).toBe(0);
  });

  it('segments snapshots into correct groups by accountType', () => {
    const reg = {
      A1: { accountType: 'Funded' },
      A2: { accountType: 'Evaluation - Standard' },
      A3: { accountType: 'Cash' },
      A4: { accountType: 'Inactive / Ignore' },
    };
    const di = {
      date: '2026-06-25', status: 'Closed', accounts: {},
      snapshots: [
        { accountName: 'A1', grossRealizedPnl: 200, weeklyPnl: 0, accountBalance: 51000 },
        { accountName: 'A2', grossRealizedPnl: 100, weeklyPnl: 0, accountBalance: 50100 },
        { accountName: 'A3', grossRealizedPnl: 10,  weeklyPnl: 0, accountBalance: 10000 },
        { accountName: 'A4', grossRealizedPnl: 5,   weeklyPnl: 0, accountBalance: 50005 },
      ],
      flags: [],
    };
    const c = { name: 'Pedro', dailyImports: [], accountRegistry: reg };
    const r = buildDailyReportSummary(c, di);
    expect(r.counts.funded).toBe(1);
    expect(r.counts.evaluations).toBe(1);
    expect(r.counts.cash).toBe(1);
    expect(r.counts.accounts).toBe(3); // Ignore excluded from allVisible
  });

  it('computes priorDailyPnl from the previous import', () => {
    const prior  = { date: '2026-06-24', status: 'Closed', accounts: {}, snapshots: [{ accountName: 'A1', grossRealizedPnl: 300 }], flags: [] };
    const latest = { date: '2026-06-25', status: 'Closed', accounts: {}, snapshots: [{ accountName: 'A1', grossRealizedPnl: 500 }], flags: [] };
    const c = { name: 'Pedro', dailyImports: [prior, latest], accountRegistry: {} };
    const r = buildDailyReportSummary(c, latest);
    expect(r.priorDailyPnl).toBe(300);
  });
});

// buildTeamWeeklyReport's tests used to be here. The function is gone: it was a
// fourth independent computation of the desk's money, on a wall-clock week, with
// no segment filter and one headline that added cash to prop. Its replacement is
// formatDeskReport() in deskMoney.js, covered by deskMoney.test.js (synthetic,
// ungated) and deskMoney.book.test.js (the real book).

describe('buildCamDayReport', () => {
  it('collects each client that has a close on the date, sorted by daily PnL', () => {
    const clients = [
      { id: 'c1', name: 'A', accountRegistry: { X: { accountName: 'X', accountType: 'Funded' } }, dailyImports: [{ date: '2026-07-13', accounts: {}, snapshots: [{ accountName: 'X', grossRealizedPnl: 100 }], flags: [] }] },
      { id: 'c2', name: 'B', accountRegistry: { Y: { accountName: 'Y', accountType: 'Funded' } }, dailyImports: [{ date: '2026-07-13', accounts: {}, snapshots: [{ accountName: 'Y', grossRealizedPnl: 500 }], flags: [] }] },
      { id: 'c3', name: 'C', accountRegistry: {}, dailyImports: [{ date: '2026-07-12', accounts: {}, snapshots: [], flags: [] }] },
    ];
    const rows = buildCamDayReport(clients, '2026-07-13');
    expect(rows).toHaveLength(2); // C has no close on that date
    expect(rows[0].client.name).toBe('B'); // higher PnL first
    expect(rows[0].report.totals.grossRealizedPnl).toBe(500);
  });
});

/* AN EVALUATION'S PROFIT AND LOSS IS NOT THE CLIENT'S MONEY.
 *
 * It is a challenge account: passing or failing is the outcome that matters,
 * and the number moves on funded capital the client does not have. Folding it
 * into "Daily realized PnL" made the headline answer a question nobody asked.
 *
 * Observed on 2026-09-08: a report headlined -$1,319 where -$810 of it was a
 * Failed evaluation. Nothing pinned this either way, which is how a policy
 * change of this size passed 3,014 tests without one going red. */
describe('what counts towards the daily PnL', () => {
  const build = () => {
    const client = {
      name: 'Pete',
      accountRegistry: {
        FUND1: { accountName: 'FUND1', accountType: 'Funded', status: 'Active' },
        EVAL1: { accountName: 'EVAL1', accountType: 'Evaluation - Standard', status: 'Active' },
      },
    };
    const dailyImport = {
      date: '2026-09-08',
      status: 'Needs review',
      accounts: client.accountRegistry,
      snapshots: [
        { accountName: 'FUND1', accountBalance: 50436, grossRealizedPnl: -509, weeklyPnl: -555 },
        { accountName: 'EVAL1', accountBalance: 48102, grossRealizedPnl: -810, weeklyPnl: -817 },
      ],
      flags: [],
    };
    return buildDailyReportSummary(client, dailyImport);
  };

  it('leaves the evaluation out of the headline number', () => {
    expect(build().totals.grossRealizedPnl).toBe(-509);
  });

  it('still reports what the evaluations did, beside it and not inside it', () => {
    // Not hidden. A reader has to see the -810 without it moving the client's
    // daily number.
    expect(build().evaluationTotals.grossRealizedPnl).toBe(-810);
  });

  it('keeps the evaluation on the report with its own row', () => {
    const report = build();
    expect(report.grouped.evaluations).toHaveLength(1);
    expect(report.counts.evaluations).toBe(1);
  });

  it('counts funded, cash and unclassified exactly as before', () => {
    const client = {
      name: 'Pete',
      accountRegistry: {
        FUND1: { accountName: 'FUND1', accountType: 'Funded', status: 'Active' },
        CASH1: { accountName: 'CASH1', accountType: 'Cash - Straight', status: 'Active' },
        NEW1: { accountName: 'NEW1', accountType: 'Unassigned', status: 'Active' },
      },
    };
    const dailyImport = {
      date: '2026-09-08',
      status: 'Needs review',
      accounts: client.accountRegistry,
      snapshots: [
        { accountName: 'FUND1', accountBalance: 1, grossRealizedPnl: 100 },
        { accountName: 'CASH1', accountBalance: 1, grossRealizedPnl: 30 },
        { accountName: 'NEW1', accountBalance: 1, grossRealizedPnl: 7 },
      ],
      flags: [],
    };
    expect(buildDailyReportSummary(client, dailyImport).totals.grossRealizedPnl).toBe(137);
  });

  it('reports zero rather than nothing when a client has only evaluations', () => {
    // The headline must read $0, not blank: "no real money moved today" is a
    // fact, and it is a different fact from "no data".
    const client = {
      name: 'Pete',
      accountRegistry: { EVAL1: { accountName: 'EVAL1', accountType: 'Evaluation - Standard', status: 'Active' } },
    };
    const dailyImport = {
      date: '2026-09-08',
      status: 'Needs review',
      accounts: client.accountRegistry,
      snapshots: [{ accountName: 'EVAL1', accountBalance: 48102, grossRealizedPnl: -810 }],
      flags: [],
    };
    const report = buildDailyReportSummary(client, dailyImport);
    expect(report.totals.grossRealizedPnl).toBe(0);
    expect(report.evaluationTotals.grossRealizedPnl).toBe(-810);
  });
});

/* ------------------------------------------------------------------------- *
 * AN ACCOUNT THAT BREACHED WEEKS AGO IS NOT TODAY'S NEWS.
 *
 * Raised on Todd's report: a prop account that had breached and been
 * classified Failed was still printed on every daily close after it died, with
 * its dead balance inside the section subtotal. The day it fails is the day it
 * belongs on, because that is when the loss happened and when the client has
 * to be told. Every day after that it is history.
 * ------------------------------------------------------------------------- */
describe('accounts that failed before this close', () => {
  const CLOSE = '2026-09-23';

  function build({ status = 'Failed', dateFailed = '2026-07-15' } = {}) {
    const client = {
      name: 'Todd',
      accountRegistry: {
        LIVE: { accountName: 'LIVE', accountType: 'Funded', status: 'Active' },
        DEAD: { accountName: 'DEAD', accountType: 'Funded', status, dateFailed },
      },
    };
    const dailyImport = {
      date: CLOSE,
      status: 'Needs review',
      snapshots: [
        { accountName: 'LIVE', accountBalance: 51000, grossRealizedPnl: 250 },
        { accountName: 'DEAD', accountBalance: 47500, grossRealizedPnl: 0 },
      ],
    };
    return buildDailyReportSummary(client, dailyImport);
  }

  it('leaves it off the report and out of the totals', () => {
    const report = build();
    expect(report.grouped.funded.map((r) => r.accountName)).toEqual(['LIVE']);
    expect(report.grouped.retired.map((r) => r.accountName)).toEqual(['DEAD']);
    expect(report.counts.retired).toBe(1);
    // The dead balance is the point: $47,500 of an account the client lost in
    // July was being added to what they hold today.
    expect(report.totals.aggregateBalance).toBe(51000);
  });

  it('keeps it on the close it failed on, which is the one that has to say so', () => {
    const report = build({ dateFailed: CLOSE });
    expect(report.grouped.funded.map((r) => r.accountName)).toEqual(['LIVE', 'DEAD']);
    expect(report.counts.retired).toBe(0);
  });

  it('keeps an account nobody has marked Failed', () => {
    const report = build({ status: 'Active', dateFailed: '' });
    expect(report.grouped.retired).toEqual([]);
    expect(report.grouped.funded).toHaveLength(2);
  });

  it('does not need the stamp, because almost nothing has it', () => {
    // Measured on the stored book: 48 accounts are Failed and exactly ONE
    // carries a dateFailed, because the stamp was added after most of them
    // were classified. A rule that required it would have hidden nothing and
    // left the report exactly as it was, which is the bug being fixed.
    const report = build({ dateFailed: '' });
    expect(report.counts.retired).toBe(1);
    expect(report.grouped.funded.map((r) => r.accountName)).toEqual(['LIVE']);
  });

  it('keeps an unstamped account on the close whose own flags say it died', () => {
    // Reconcile raises a Critical "Drawdown breached" naming the account on
    // the day the buffer reaches zero. That is the day it died and the day the
    // client has to be told, stamp or no stamp.
    const client = {
      name: 'Todd',
      accountRegistry: {
        DEAD: { accountName: 'DEAD', accountType: 'Funded', status: 'Failed', dateFailed: '' },
      },
    };
    const dailyImport = {
      date: CLOSE,
      snapshots: [{ accountName: 'DEAD', accountBalance: 47500, grossRealizedPnl: -2100 }],
      flags: [{ type: 'Drawdown breached', severity: 'Critical', accountName: 'DEAD', status: 'Open' }],
    };
    const report = buildDailyReportSummary(client, dailyImport);
    expect(report.counts.retired).toBe(0);
    expect(report.grouped.funded.map((r) => r.accountName)).toEqual(['DEAD']);
    // And the day's loss is in the day's number, which is the point of keeping it.
    expect(report.totals.grossRealizedPnl).toBe(-2100);
  });

  it('matches the flag to the account whatever the casing', () => {
    const client = {
      name: 'Todd',
      accountRegistry: { Dead: { accountName: 'Dead', accountType: 'Funded', status: 'Failed' } },
    };
    const report = buildDailyReportSummary(client, {
      date: CLOSE,
      snapshots: [{ accountName: 'Dead', accountBalance: 1, grossRealizedPnl: 0 }],
      flags: [{ type: 'Drawdown breached', accountName: 'DEAD' }],
    });
    expect(report.counts.retired).toBe(0);
  });

  it('is not fooled by a warning that is not a breach', () => {
    const client = {
      name: 'Todd',
      accountRegistry: { DEAD: { accountName: 'DEAD', accountType: 'Funded', status: 'Failed' } },
    };
    const report = buildDailyReportSummary(client, {
      date: CLOSE,
      snapshots: [{ accountName: 'DEAD', accountBalance: 1, grossRealizedPnl: 0 }],
      flags: [{ type: 'Drawdown approaching limit', accountName: 'DEAD' }],
    });
    expect(report.counts.retired).toBe(1);
  });

  it('reads a timestamped date the same as a plain one', () => {
    const report = build({ dateFailed: '2026-07-15T20:30:00Z' });
    expect(report.counts.retired).toBe(1);
  });

  it('applies to every pool, not just funded', () => {
    const client = {
      name: 'Todd',
      accountRegistry: {
        EVAL: { accountName: 'EVAL', accountType: 'Evaluation - standard', status: 'Failed', dateFailed: '2026-08-01' },
        CASH: { accountName: 'CASH', accountType: 'Cash - Straight', status: 'Failed', dateFailed: '2026-08-01' },
      },
    };
    const report = buildDailyReportSummary(client, {
      date: CLOSE,
      snapshots: [
        { accountName: 'EVAL', accountBalance: 100, grossRealizedPnl: 0 },
        { accountName: 'CASH', accountBalance: 200, grossRealizedPnl: 0 },
      ],
    });
    expect(report.counts.retired).toBe(2);
    expect(report.grouped.evaluations).toEqual([]);
    expect(report.grouped.cash).toEqual([]);
  });
});
