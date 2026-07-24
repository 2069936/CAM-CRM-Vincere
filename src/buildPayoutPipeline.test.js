import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCamPerformance, buildPayoutPipeline } from './App';

const CURRENT_MONTH = '2026-06';
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(`${CURRENT_MONTH}-25T12:00:00`)); });
afterEach(() => { vi.useRealTimers(); });

function makeCam(id, name, clientIds = []) {
  return { id, name, clientIds };
}

function makeClient({ id, name, registry = {}, snapshots = [], flags = [], extraImports = [] }) {
  return {
    id,
    name,
    accountRegistry: registry,
    dailyImports: [
      ...extraImports,
      { id: `${id}-latest`, date: '2026-06-25', accounts: {}, snapshots, flags },
    ],
  };
}

// ── buildPayoutPipeline ───────────────────────────────────────────────────────

describe('buildPayoutPipeline', () => {
  it('returns empty for clients with no payout-state accounts', () => {
    const client = makeClient({ id: 'c1', name: 'Pedro', registry: {
      ACC1: { accountName: 'ACC1', accountType: 'Funded', payoutState: 'Not requested' },
    }});
    expect(buildPayoutPipeline([client], [])).toHaveLength(0);
  });

  it('includes accounts with any active payout state', () => {
    const client = makeClient({ id: 'c1', name: 'Pedro', registry: {
      ACC1: { accountName: 'ACC1', accountType: 'Funded', payoutState: 'Payout requested', alias: 'My Account' },
      ACC2: { accountName: 'ACC2', accountType: 'Funded', payoutState: 'Not requested' },
    }});
    const rows = buildPayoutPipeline([client], []);
    expect(rows).toHaveLength(1);
    expect(rows[0].alias).toBe('My Account');
    expect(rows[0].payoutState).toBe('Payout requested');
  });

  it('resolves CAM name from camProfiles', () => {
    const cam = makeCam('cam-1', 'Maria', ['c1']);
    const client = makeClient({ id: 'c1', name: 'Pedro', registry: {
      ACC1: { accountName: 'ACC1', payoutState: 'Payout approved' },
    }});
    const rows = buildPayoutPipeline([client], [cam]);
    expect(rows[0].camName).toBe('Maria');
  });

  it('sorts by payout state priority (Request payout first)', () => {
    const client = makeClient({ id: 'c1', name: 'Pedro', registry: {
      ACC1: { accountName: 'ACC1', payoutState: 'Payout approved' },
      ACC2: { accountName: 'ACC2', payoutState: 'Request payout' },
      ACC3: { accountName: 'ACC3', payoutState: 'Clear to trade' },
    }});
    const rows = buildPayoutPipeline([client], []);
    expect(rows[0].payoutState).toBe('Request payout');
    expect(rows[rows.length - 1].payoutState).toBe('Clear to trade');
  });

  it('attaches balance from latest snapshot when available', () => {
    const client = makeClient({
      id: 'c1', name: 'Pedro',
      registry: { ACC1: { accountName: 'ACC1', payoutState: 'Payout requested', targetProfit: 53000 } },
      snapshots: [{ accountName: 'ACC1', accountBalance: 53200, grossRealizedPnl: 200 }],
    });
    const rows = buildPayoutPipeline([client], []);
    expect(rows[0].balance).toBe(53200);
    expect(rows[0].targetProfit).toBe(53000);
  });
});

// ── buildCamPerformance ───────────────────────────────────────────────────────

describe('buildCamPerformance', () => {
  it('returns empty array for empty camProfiles', () => {
    expect(buildCamPerformance([], [])).toHaveLength(0);
  });

  it('aggregates funded and eval account counts per CAM', () => {
    const cam = makeCam('cam-1', 'Maria', ['c1']);
    const client = makeClient({
      id: 'c1', name: 'Pedro',
      registry: {
        A1: { accountName: 'A1', accountType: 'Funded' },
        A2: { accountName: 'A2', accountType: 'Evaluation - Standard' },
        A3: { accountName: 'A3', accountType: 'Inactive / Ignore' },
      },
      snapshots: [
        { accountName: 'A1', grossRealizedPnl: 200, weeklyPnl: 800 },
        { accountName: 'A2', grossRealizedPnl: 100, weeklyPnl: 400 },
        { accountName: 'A3', grossRealizedPnl: 50, weeklyPnl: 200 }, // Ignore - excluded
      ],
    });
    const result = buildCamPerformance([client], [cam]);
    expect(result).toHaveLength(1);
    const camRow = result[0];
    expect(camRow.funded).toBe(1);
    expect(camRow.evaluations).toBe(1);
    expect(camRow.totalAccounts).toBe(2); // Ignore excluded
    expect(camRow.dailyPnl).toBe(300);
    expect(camRow.weeklyPnl).toBe(1200);
  });

  it('counts open flags excluding Resolved and Acknowledged', () => {
    const cam = makeCam('cam-1', 'Maria', ['c1']);
    const client = makeClient({
      id: 'c1', name: 'Pedro',
      registry: {},
      snapshots: [],
      flags: [
        { id: 'f1', severity: 'Critical', status: 'Open' },
        { id: 'f2', severity: 'Warning', status: 'Resolved' },
        { id: 'f3', severity: 'Warning', status: 'Acknowledged' },
      ],
    });
    const [camRow] = buildCamPerformance([client], [cam]);
    expect(camRow.openFlags).toBe(1);
  });

  it('sums monthly P&L only from imports in the current month', () => {
    const cam = makeCam('cam-1', 'Maria', ['c1']);
    const client = makeClient({
      id: 'c1', name: 'Pedro',
      registry: {},
      snapshots: [{ accountName: 'A1', grossRealizedPnl: 100, weeklyPnl: 0 }],
      extraImports: [
        { id: 'di-may', date: '2026-05-30', accounts: {}, snapshots: [{ accountName: 'A1', grossRealizedPnl: 999, weeklyPnl: 0 }], flags: [] },
        { id: 'di-jun1', date: '2026-06-10', accounts: {}, snapshots: [{ accountName: 'A1', grossRealizedPnl: 200, weeklyPnl: 0 }], flags: [] },
      ],
    });
    const [camRow] = buildCamPerformance([client], [cam]);
    // May import excluded; June 10 + June 25 = 200 + 100 = 300
    expect(camRow.monthlyPnl).toBe(300);
  });

  it('sorts by weeklyPnl descending', () => {
    const cams = [makeCam('cam-a', 'A', ['c1']), makeCam('cam-b', 'B', ['c2'])];
    const clients = [
      makeClient({ id: 'c1', name: 'C1', registry: {}, snapshots: [{ accountName: 'X', grossRealizedPnl: 0, weeklyPnl: 100 }] }),
      makeClient({ id: 'c2', name: 'C2', registry: {}, snapshots: [{ accountName: 'Y', grossRealizedPnl: 0, weeklyPnl: 500 }] }),
    ];
    const result = buildCamPerformance(clients, cams);
    expect(result[0].name).toBe('B');
    expect(result[1].name).toBe('A');
  });
});
