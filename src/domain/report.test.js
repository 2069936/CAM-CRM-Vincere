import { describe, expect, it } from 'vitest';
import { buildDailyReportSummary, buildClientMessageReport, buildTeamWeeklyReport, buildWeeklyMessageReport, summarizeAccountRows } from './report';

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

// ── buildTeamWeeklyReport ─────────────────────────────────────────────────────

describe('buildTeamWeeklyReport', () => {
  it('returns a string for empty inputs', () => {
    expect(typeof buildTeamWeeklyReport([], [])).toBe('string');
  });

  it('excludes CAMs with no clients', () => {
    const cam = { id: 'cam1', name: 'Maria', clientIds: [] };
    const text = buildTeamWeeklyReport([], [cam]);
    expect(text).not.toContain('Maria');
  });

  it('includes CAM name and Drive Insight footer when clients exist', () => {
    const today = new Date().toISOString().slice(0, 10);
    const cam = { id: 'cam1', name: 'Maria', clientIds: ['c1'] };
    const client = {
      id: 'c1', name: 'Pedro', accountRegistry: {},
      dailyImports: [{ date: today, status: 'Closed', accounts: {}, snapshots: [{ accountName: 'A1', grossRealizedPnl: 800 }], flags: [] }],
    };
    const text = buildTeamWeeklyReport([client], [cam]);
    expect(text).toContain('Maria');
    expect(text).toContain('Drive Insight');
  });

  it('counts funded accounts per CAM, excluding Failed status', () => {
    const today = new Date().toISOString().slice(0, 10);
    const cam = { id: 'cam1', name: 'Ana', clientIds: ['c1'] };
    const client = {
      id: 'c1', name: 'Pedro',
      accountRegistry: {
        A1: { accountType: 'Funded', status: 'Active' },
        A2: { accountType: 'Funded', status: 'Failed' },
      },
      dailyImports: [{ date: today, status: 'Closed', accounts: {}, snapshots: [], flags: [] }],
    };
    const text = buildTeamWeeklyReport([client], [cam]);
    expect(text).toContain('1 funded');
  });
});
