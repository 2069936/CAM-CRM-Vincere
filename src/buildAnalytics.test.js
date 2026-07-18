import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildConsistencyWarnings, buildDisconnectAlerts, buildPayoutAlerts, buildTodayActions, buildPnlVarianceAnalysis } from './App';

// ── buildConsistencyWarnings ──────────────────────────────────────────────────

function makeClientWithPnls(accountName, pnls, accountType = 'Funded') {
  return {
    accountRegistry: {
      [accountName]: { accountName, accountType, status: 'Active' },
    },
    dailyImports: pnls.map((pnl, i) => ({
      date: `2026-06-${String(i + 1).padStart(2, '0')}`,
      snapshots: [{ accountName, grossRealizedPnl: pnl }],
    })),
  };
}

describe('buildConsistencyWarnings', () => {
  it('returns empty for client with fewer than 3 days of data', () => {
    const client = makeClientWithPnls('ACC1', [500, 300]);
    expect(buildConsistencyWarnings(client)).toHaveLength(0);
  });

  it('returns empty when best day is ≤30% of total positive PnL', () => {
    // Best day 300 out of 300+300+300+300 = 1200 → 25% - below threshold
    const client = makeClientWithPnls('ACC1', [300, 300, 300, 300]);
    expect(buildConsistencyWarnings(client)).toHaveLength(0);
  });

  it('flags Warning when best day is 31–50% of total positive PnL', () => {
    // Best day 400 out of 400+300+300+300 = 1300 → ~31%
    const client = makeClientWithPnls('ACC1', [400, 300, 300, 300]);
    const warnings = buildConsistencyWarnings(client);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].severity).toBe('Warning');
  });

  it('flags Critical when best day exceeds 50% of total positive PnL', () => {
    // Best day 600 out of 600+100+100 = 800 → 75%
    const client = makeClientWithPnls('ACC1', [600, 100, 100]);
    const warnings = buildConsistencyWarnings(client);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].severity).toBe('Critical');
    expect(warnings[0].ratio).toBe(75);
  });

  it('skips non-funded accounts', () => {
    const client = makeClientWithPnls('EVAL1', [600, 100, 100], 'Evaluation - Standard');
    expect(buildConsistencyWarnings(client)).toHaveLength(0);
  });

  it('skips Failed accounts', () => {
    const client = {
      accountRegistry: {
        ACC1: { accountName: 'ACC1', accountType: 'Funded', status: 'Failed' },
      },
      dailyImports: [600, 100, 100].map((pnl, i) => ({
        date: `2026-06-0${i + 1}`,
        snapshots: [{ accountName: 'ACC1', grossRealizedPnl: pnl }],
      })),
    };
    expect(buildConsistencyWarnings(client)).toHaveLength(0);
  });
});

// ── buildPayoutAlerts ─────────────────────────────────────────────────────────

function makeDailyImport(accounts) {
  return {
    id: 'di-1',
    date: '2026-06-25',
    accounts: {},
    snapshots: accounts.map(a => ({ accountName: a.name, accountBalance: a.balance })),
    flags: [],
  };
}

describe('buildPayoutAlerts', () => {
  it('returns empty when client or dailyImport is null', () => {
    expect(buildPayoutAlerts(null, null)).toHaveLength(0);
    expect(buildPayoutAlerts({ accountRegistry: {} }, null)).toHaveLength(0);
  });

  it('alerts within 10% of the profit target, measured from the start balance', () => {
    const client = {
      accountRegistry: {
        MFF1: { accountName: 'MFF1', accountType: 'Funded', status: 'Active', startBalance: 50000, targetProfit: 54000, payoutState: 'Not requested' },
      },
    };
    // profit 3700 of 4000 needed = 92.5% -> 93%
    const di = makeDailyImport([{ name: 'MFF1', balance: 53700 }]);
    const alerts = buildPayoutAlerts(client, di);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].pct).toBe(93);
    expect(alerts[0].profit).toBe(3700);
    expect(alerts[0].ready).toBe(false); // not fully at target yet
  });

  it('does NOT alert for an account below its start balance (progress from start, not zero)', () => {
    const client = {
      accountRegistry: {
        MFF1: { accountName: 'MFF1', accountType: 'Funded', status: 'Active', startBalance: 50000, targetProfit: 54000, payoutState: 'Not requested' },
      },
    };
    // 49k on a 50k->54k account is -25% of target, not 91%.
    const di = makeDailyImport([{ name: 'MFF1', balance: 49000 }]);
    expect(buildPayoutAlerts(client, di)).toHaveLength(0);
  });

  it('marks ready=true when balance meets or exceeds the absolute target', () => {
    const client = {
      accountRegistry: {
        MFF1: { accountName: 'MFF1', accountType: 'Funded', status: 'Active', startBalance: 50000, targetProfit: 53000, payoutState: 'Not requested' },
      },
    };
    const di = makeDailyImport([{ name: 'MFF1', balance: 53500 }]);
    const alerts = buildPayoutAlerts(client, di);
    expect(alerts[0].ready).toBe(true);
  });

  it('suppresses alert when payout already requested', () => {
    const client = {
      accountRegistry: {
        MFF1: { accountName: 'MFF1', accountType: 'Funded', status: 'Active', startBalance: 50000, targetProfit: 53000, payoutState: 'Payout requested' },
      },
    };
    const di = makeDailyImport([{ name: 'MFF1', balance: 54000 }]);
    expect(buildPayoutAlerts(client, di)).toHaveLength(0);
  });

  it('suppresses alert for Failed accounts', () => {
    const client = {
      accountRegistry: {
        MFF1: { accountName: 'MFF1', accountType: 'Funded', status: 'Failed', startBalance: 50000, targetProfit: 53000, payoutState: 'Not requested' },
      },
    };
    const di = makeDailyImport([{ name: 'MFF1', balance: 54000 }]);
    expect(buildPayoutAlerts(client, di)).toHaveLength(0);
  });

  it('sorts results by pct descending', () => {
    const client = {
      accountRegistry: {
        ACC1: { accountName: 'ACC1', accountType: 'Funded', status: 'Active', startBalance: 50000, targetProfit: 54000, payoutState: 'Not requested' },
        ACC2: { accountName: 'ACC2', accountType: 'Funded', status: 'Active', startBalance: 50000, targetProfit: 54000, payoutState: 'Not requested' },
      },
    };
    const di = makeDailyImport([
      { name: 'ACC1', balance: 53600 }, // profit 3600/4000 = 90%
      { name: 'ACC2', balance: 53900 }, // profit 3900/4000 = 98%
    ]);
    const alerts = buildPayoutAlerts(client, di);
    expect(alerts[0].accountName).toBe('ACC2');
    expect(alerts[1].accountName).toBe('ACC1');
  });
});

// ── buildDisconnectAlerts ─────────────────────────────────────────────────────

// Pin clock to a known Thursday so "today" and "prevTrading" are deterministic
const FAKE_TODAY = '2026-06-25'; // Thursday
const FAKE_PREV  = '2026-06-24'; // Wednesday (prev trading day)

function makePriorImports(accountName, pnls) {
  return pnls.map((pnl, i) => ({
    date: `2026-06-${String(i + 1).padStart(2, '0')}`,
    snapshots: [{ accountName, grossRealizedPnl: pnl }],
  }));
}

function makeDisconnectClient({ importDate = FAKE_TODAY, pnlToday = 0, priorPnls = [200, 300, 250, 180, 220], accountType = 'Funded', status = 'Active' } = {}) {
  const accountName = 'APEX1';
  return {
    accountRegistry: {
      [accountName]: { accountName, alias: 'Apex Main', accountType, status },
    },
    dailyImports: [
      ...makePriorImports(accountName, priorPnls),
      {
        date: importDate,
        accounts: {},
        snapshots: [{
          accountName,
          grossRealizedPnl: pnlToday,
          strategies: [{ strategyFamily: 'RBO', enabled: true }],
        }],
      },
    ],
  };
}

describe('buildDisconnectAlerts', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(`${FAKE_TODAY}T12:00:00`)); });
  afterEach(() => { vi.useRealTimers(); });

  it('fires alert when active strategies + $0 P&L + strong prior avg', () => {
    const alerts = buildDisconnectAlerts(makeDisconnectClient());
    expect(alerts).toHaveLength(1);
    expect(alerts[0].accountName).toBe('APEX1');
    expect(alerts[0].message).toContain('Verify VPS');
  });

  it('fires alert when import is from prev trading day', () => {
    const alerts = buildDisconnectAlerts(makeDisconnectClient({ importDate: FAKE_PREV }));
    expect(alerts).toHaveLength(1);
  });

  it('no alert when import is older than prev trading day', () => {
    const alerts = buildDisconnectAlerts(makeDisconnectClient({ importDate: '2026-06-20' }));
    expect(alerts).toHaveLength(0);
  });

  it('no alert when today P&L is non-zero', () => {
    const alerts = buildDisconnectAlerts(makeDisconnectClient({ pnlToday: 150 }));
    expect(alerts).toHaveLength(0);
  });

  it('no alert when prior avg is ≤ $50 (not historically active)', () => {
    const alerts = buildDisconnectAlerts(makeDisconnectClient({ priorPnls: [30, 20, 40, 10, 50] }));
    expect(alerts).toHaveLength(0);
  });

  it('no alert when fewer than 3 prior data points', () => {
    const alerts = buildDisconnectAlerts(makeDisconnectClient({ priorPnls: [300, 400] }));
    expect(alerts).toHaveLength(0);
  });

  it('no alert for Inactive / Ignore account type', () => {
    const alerts = buildDisconnectAlerts(makeDisconnectClient({ accountType: 'Inactive / Ignore' }));
    expect(alerts).toHaveLength(0);
  });

  it('no alert for Failed account status', () => {
    const alerts = buildDisconnectAlerts(makeDisconnectClient({ status: 'Failed' }));
    expect(alerts).toHaveLength(0);
  });

  it('returns empty for client with no imports', () => {
    expect(buildDisconnectAlerts({ dailyImports: [] })).toHaveLength(0);
  });
});

// ── buildTodayActions ─────────────────────────────────────────────────────────

describe('buildTodayActions', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-06-25T12:00:00')); });
  afterEach(() => { vi.useRealTimers(); });

  it('adds critical action for overdue task', () => {
    const client = { tasks: [{ id: 't1', text: 'Call client', done: false, dueDate: '2026-06-20' }] };
    const actions = buildTodayActions(client, null);
    const overdue = actions.filter(a => a.severity === 'critical' && a.text.startsWith('Overdue'));
    expect(overdue).toHaveLength(1);
  });

  it('adds warning action for task due today', () => {
    const client = { tasks: [{ id: 't1', text: 'Send report', done: false, dueDate: '2026-06-25' }] };
    const actions = buildTodayActions(client, null);
    const dueToday = actions.filter(a => a.severity === 'warning' && a.text.startsWith('Due today'));
    expect(dueToday).toHaveLength(1);
  });

  it('does not include done tasks', () => {
    const client = { tasks: [{ id: 't1', text: 'Done task', done: true, dueDate: '2026-06-20' }] };
    const actions = buildTodayActions(client, null);
    expect(actions.filter(a => a.text.includes('Done task'))).toHaveLength(0);
  });

  it('adds critical action for unresolved critical flag', () => {
    const di = { snapshots: [], accounts: {}, flags: [{ id: 'f1', severity: 'Critical', status: 'Open', message: 'Drawdown breached' }] };
    const actions = buildTodayActions({ tasks: [], accountRegistry: {} }, di);
    const flagActions = actions.filter(a => a.text.startsWith('Flag:'));
    expect(flagActions).toHaveLength(1);
    expect(flagActions[0].severity).toBe('critical');
  });

  it('excludes acknowledged critical flags from banner', () => {
    const di = { snapshots: [], accounts: {}, flags: [{ id: 'f1', severity: 'Critical', status: 'Acknowledged', message: 'X' }] };
    const actions = buildTodayActions({ tasks: [], accountRegistry: {} }, di);
    expect(actions.filter(a => a.text.startsWith('Flag:'))).toHaveLength(0);
  });

  it('adds warning when no daily import provided', () => {
    const actions = buildTodayActions({ tasks: [] }, null);
    expect(actions.some(a => a.text.includes('No daily close uploaded'))).toBe(true);
  });

  it('caps overdue tasks at 3 and due-today at 2', () => {
    const tasks = [
      { id: '1', text: 'A', done: false, dueDate: '2026-06-10' },
      { id: '2', text: 'B', done: false, dueDate: '2026-06-11' },
      { id: '3', text: 'C', done: false, dueDate: '2026-06-12' },
      { id: '4', text: 'D', done: false, dueDate: '2026-06-13' },
      { id: '5', text: 'E', done: false, dueDate: '2026-06-25' },
      { id: '6', text: 'F', done: false, dueDate: '2026-06-25' },
      { id: '7', text: 'G', done: false, dueDate: '2026-06-25' },
    ];
    const actions = buildTodayActions({ tasks }, null);
    expect(actions.filter(a => a.text.startsWith('Overdue'))).toHaveLength(3);
    expect(actions.filter(a => a.text.startsWith('Due today'))).toHaveLength(2);
  });
});

// ── buildPnlVarianceAnalysis ──────────────────────────────────────────────────

function makeVarianceClient(accountName, dailyPnls, stratName = 'RBO') {
  return {
    accountRegistry: {
      [accountName]: { accountName, accountType: 'Funded', status: 'Active' },
    },
    dailyImports: dailyPnls.map((pnl, i) => ({
      date: `2026-06-${String(i + 1).padStart(2, '0')}`,
      snapshots: [{
        accountName,
        grossRealizedPnl: pnl,
        strategies: [{ strategyFamily: stratName, enabled: true, realized: pnl }],
      }],
    })),
  };
}

describe('buildPnlVarianceAnalysis', () => {
  it('returns empty when client is null', () => {
    expect(buildPnlVarianceAnalysis(null, [])).toHaveLength(0);
  });

  it('filters out accounts with fewer than 2 days of data', () => {
    const client = makeVarianceClient('ACC1', [300]);
    expect(buildPnlVarianceAnalysis(client, [client])).toHaveLength(0);
  });

  it('marks status good when actual exceeds cross-client avg by ≥10%', () => {
    // Same client is all clients → avg = actual → variancePct = 0 → average
    // To get good: need actual > expected by 10%
    // Use two clients: cross-avg from peer = 100/day, focal client = 130/day
    const peer = makeVarianceClient('B1', [100, 100, 100]);
    const focal = makeVarianceClient('A1', [130, 130, 130]);
    const results = buildPnlVarianceAnalysis(focal, [focal, peer]);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('good');
  });

  it('marks status review when actual is ≥15% below cross-client avg', () => {
    const peer = makeVarianceClient('B1', [300, 300, 300]);
    const focal = makeVarianceClient('A1', [200, 200, 200]); // ~33% below
    const results = buildPnlVarianceAnalysis(focal, [focal, peer]);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('review');
  });

  it('sorts results by variancePct descending', () => {
    const peer = makeVarianceClient('B1', [200, 200, 200]);
    const focal = {
      accountRegistry: {
        ACC1: { accountName: 'ACC1', accountType: 'Funded', status: 'Active' },
        ACC2: { accountName: 'ACC2', accountType: 'Funded', status: 'Active' },
      },
      dailyImports: [1, 2, 3].map((i) => ({
        date: `2026-06-0${i}`,
        snapshots: [
          { accountName: 'ACC1', grossRealizedPnl: 250, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: 250 }] },
          { accountName: 'ACC2', grossRealizedPnl: 150, strategies: [{ strategyFamily: 'RBO', enabled: true, realized: 150 }] },
        ],
      })),
    };
    const results = buildPnlVarianceAnalysis(focal, [focal, peer]);
    expect(results[0].variancePct).toBeGreaterThanOrEqual(results[1].variancePct);
  });
});
