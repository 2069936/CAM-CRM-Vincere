import { describe, expect, it } from 'vitest';
import { buildClientExportPlan, formatBytes } from './clientExportPlan';

function client(id, name, dailyImports = [], extra = {}) {
  return {
    id,
    uuid: id,
    name,
    accountRegistry: { 'ACC-1': {}, 'ACC-2': {} },
    activityLog: [],
    dailyImports,
    ...extra,
  };
}

const busyDay = {
  date: '2026-07-21',
  sourceSummary: { accounts: 4, strategies: 6, orders: 120, executions: 58, flags: 9 },
  snapshots: [],
  strategies: [],
  flags: [],
  orders: [],
  executions: [],
};

describe('buildClientExportPlan', () => {
  it('counts only the sessions inside the range', () => {
    const plan = buildClientExportPlan(
      [client('c1', 'A', [
        { ...busyDay, date: '2026-07-10' },
        { ...busyDay, date: '2026-07-21' },
        { ...busyDay, date: '2026-08-02' },
      ])],
      { from: '2026-07-15', to: '2026-07-31' },
    );
    expect(plan.sessions).toBe(1);
    expect(plan.rows.daily_imports).toBe(1);
    expect(plan.clientsWithSessions).toBe(1);
  });

  it('reads the importer counts rather than the loaded arrays for trade rows', () => {
    // The CRM does not load orders or executions on a normal session, so
    // dailyImport.orders is [] even on a 120-order day. Reading that as zero
    // would promise a small download and deliver a large one.
    const plan = buildClientExportPlan(
      [client('c1', 'A', [busyDay])],
      { from: '2026-07-01', to: '2026-07-31', includeTradeHistory: true },
    );
    expect(plan.rows.orders).toBe(120);
    expect(plan.rows.executions).toBe(58);
  });

  it('leaves trade tables out of the row count but still reports what is being skipped', () => {
    const plan = buildClientExportPlan(
      [client('c1', 'A', [busyDay])],
      { from: '2026-07-01', to: '2026-07-31' },
    );
    expect(plan.rows.orders).toBeUndefined();
    expect(plan.excludedTradeRows).toBe(178);
  });

  it('grows with the number of clients and keeps quiet clients visible', () => {
    const plan = buildClientExportPlan(
      [client('c1', 'A', [busyDay]), client('c2', 'B', [])],
      { from: '2026-07-01', to: '2026-07-31' },
    );
    expect(plan.clients).toBe(2);
    expect(plan.clientsWithSessions).toBe(1);
    expect(plan.rows.trading_accounts).toBe(4);
  });

  it('estimates a download that is a fraction of the raw size', () => {
    const plan = buildClientExportPlan(
      [client('c1', 'A', [busyDay])],
      { from: '2026-07-01', to: '2026-07-31', includeTradeHistory: true },
    );
    expect(plan.estimatedBytes).toBeGreaterThan(0);
    expect(plan.estimatedDownloadBytes).toBeLessThan(plan.estimatedBytes);
  });

  it('windows activity notes on the date they were written', () => {
    const plan = buildClientExportPlan(
      [client('c1', 'A', [], {
        activityLog: [
          { createdAt: '2026-07-20T10:00:00Z', text: 'in' },
          { createdAt: '2026-05-01T10:00:00Z', text: 'out' },
        ],
      })],
      { from: '2026-07-01', to: '2026-07-31' },
    );
    expect(plan.rows.activity_logs).toBe(1);
  });
});

describe('formatBytes', () => {
  it('reads as a size a person recognises', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(3_500_000)).toBe('3.3 MB');
  });
});

describe('response-limit preview', () => {
  it('flags an estimate the server would refuse, so the warning lands before the request', () => {
    // The server measures the real payload and 413s past 4 MiB. On the real
    // book that is not a corner case: the busiest CAM's default 30-day pull
    // with trade history is 6.92 MB.
    const heavy = Array.from({ length: 40 }, (_, index) => ({
      uuid: `c${index}`,
      accountRegistry: {},
      activityLog: [],
      dailyImports: Array.from({ length: 20 }, (_, day) => ({
        date: `2026-07-${String((day % 28) + 1).padStart(2, '0')}`,
        sourceSummary: { accounts: 6, strategies: 7, orders: 30, executions: 15, flags: 13 },
      })),
    }));
    const plan = buildClientExportPlan(heavy, { from: '2026-07-01', to: '2026-07-31', includeTradeHistory: true });
    expect(plan.estimatedBytes).toBeGreaterThan(plan.maxResponseBytes);
    expect(plan.exceedsResponseLimit).toBe(true);
  });

  it('does not flag a single client over a week', () => {
    const light = [{
      uuid: 'c1',
      accountRegistry: { a: {} },
      activityLog: [],
      dailyImports: [{ date: '2026-07-20', sourceSummary: { accounts: 5, strategies: 5, orders: 13, executions: 6, flags: 10 } }],
    }];
    const plan = buildClientExportPlan(light, { from: '2026-07-20', to: '2026-07-26', includeTradeHistory: true });
    expect(plan.exceedsResponseLimit).toBe(false);
  });
});
