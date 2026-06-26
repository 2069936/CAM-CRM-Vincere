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
});
