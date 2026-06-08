import { describe, expect, it } from 'vitest';
import { buildDailyReportSummary, summarizeAccountRows } from './report';

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
