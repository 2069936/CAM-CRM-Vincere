import { describe, expect, it } from 'vitest';
import { buildAlgoComboPerformance } from './StackPlaybook';

function makeClient({ id, accountName, accountType = 'Funded', strategyName = '1 - RBO-1.8', pnls = [] }) {
  return {
    id,
    accountRegistry: {
      [accountName]: { accountName, accountType, status: 'Active' },
    },
    dailyImports: pnls.map((pnl, i) => ({
      date: `2026-06-${String(i + 1).padStart(2, '0')}`,
      snapshots: [{
        accountName,
        grossRealizedPnl: pnl,
        strategies: [{ strategyName, strategyFamily: 'RBO', enabled: true }],
      }],
    })),
  };
}

describe('buildAlgoComboPerformance', () => {
  it('returns empty array when no clients provided', () => {
    expect(buildAlgoComboPerformance([])).toEqual([]);
  });

  it('aggregates funded account combos across clients', () => {
    const clients = [
      makeClient({ id: 'c1', accountName: 'ACC1', pnls: [100, 200, 150] }),
      makeClient({ id: 'c2', accountName: 'ACC2', pnls: [50, 100] }),
    ];
    const result = buildAlgoComboPerformance(clients);
    expect(result).toHaveLength(1);
    expect(result[0].totalDays).toBe(5);
    expect(result[0].accounts).toBe(2);
    expect(result[0].clients).toBe(2);
    expect(result[0].avgPnl).toBeCloseTo((100 + 200 + 150 + 50 + 100) / 5);
  });

  it('excludes non-funded account types from combo performance', () => {
    const clients = [
      makeClient({ id: 'c1', accountName: 'EVAL1', accountType: 'Evaluation - Standard', pnls: [500, 600] }),
    ];
    expect(buildAlgoComboPerformance(clients)).toEqual([]);
  });

  it('resolves account registry case-insensitively when CSV name differs from registry key', () => {
    const client = {
      id: 'c-ci',
      accountRegistry: {
        APEX1234: { accountName: 'APEX1234', accountType: 'Funded', status: 'Active' },
      },
      dailyImports: [{
        date: '2026-06-25',
        snapshots: [{ accountName: 'apex1234', grossRealizedPnl: 300, strategies: [{ strategyName: '1 - RBO-1.8', strategyFamily: 'RBO', enabled: true }] }],
      }],
    };
    const result = buildAlgoComboPerformance([client]);
    expect(result).toHaveLength(1);
    expect(result[0].totalDays).toBe(1);
  });

  it('computes the recent-window average by real date, not array position', () => {
    // 6 closes 2026-06-01..06; a 3-day window covers only the last three dates
    const clients = [makeClient({ id: 'c1', accountName: 'ACC1', pnls: [10, 20, 30, 40, 50, 60] })];
    const result = buildAlgoComboPerformance(clients, { windowDays: 3 });
    expect(result[0].recentDays).toBe(3);
    expect(result[0].recentAvg).toBeCloseTo((40 + 50 + 60) / 3);
  });

  it('aligns the window across clients with different import cadences (date, not tail)', () => {
    const c1 = makeClient({ id: 'c1', accountName: 'A1', pnls: [1, 2, 3, 4, 5, 6] }); // 06-01..06-06
    const c2 = makeClient({ id: 'c2', accountName: 'A2', pnls: [100, 200] }); // 06-01..06-02
    const result = buildAlgoComboPerformance([c1, c2], { windowDays: 2 });
    // anchor = 2026-06-06; the 2-day window is 06-05/06-06 — c2 has nothing there,
    // so its tail (100,200) must NOT leak into the recent window.
    expect(result[0].recentDays).toBe(2);
    expect(result[0].recentAvg).toBeCloseTo((5 + 6) / 2);
  });
});
