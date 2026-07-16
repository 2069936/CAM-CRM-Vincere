import { describe, it, expect } from 'vitest';
import { buildAccountLifecycle, buildLifecycleByAlgo } from './accountLifecycle';

describe('buildAccountLifecycle', () => {
  it('builds phases from algoHistory and marks the outcome', () => {
    const account = {
      accountName: 'A1',
      accountType: 'Funded',
      dateAdded: '2026-06-01',
      dateFunded: '2026-06-20',
      algoStack: 'URGO x2',
      algoHistory: [
        { date: '2026-06-10', from: 'URGO', to: 'URGO x2' },
      ],
    };
    const lc = buildAccountLifecycle(account, { asOf: '2026-06-25' });
    expect(lc.outcome).toBe('funded');
    expect(lc.daysAlive).toBe(24); // 06-01 -> 06-25
    expect(lc.phases).toHaveLength(2);
    expect(lc.phases[0]).toMatchObject({ algo: 'URGO', start: '2026-06-01', end: '2026-06-10', days: 9 });
    expect(lc.phases[1]).toMatchObject({ algo: 'URGO x2', end: '2026-06-25' });
    expect(lc.currentAlgo).toBe('URGO x2');
  });

  it('marks a failed account and stops the clock at death', () => {
    const lc = buildAccountLifecycle({ accountName: 'A2', accountType: 'Evaluation - Standard', dateAdded: '2026-06-01', dateFailed: '2026-06-03', algoStack: 'IFSP' }, { asOf: '2026-06-30' });
    expect(lc.outcome).toBe('failed');
    expect(lc.daysAlive).toBe(2); // dies 06-03, not 06-30
  });
});

describe('buildLifecycleByAlgo', () => {
  it('aggregates funded rate + lifespan by algo combo', () => {
    const clients = [{
      accountRegistry: {
        A1: { accountType: 'Funded', algoStack: 'URGO', dateAdded: '2026-06-01', dateFunded: '2026-06-15' },
        A2: { accountType: 'Evaluation - Standard', algoStack: 'URGO', dateAdded: '2026-06-01', dateFailed: '2026-06-05' },
        A3: { accountType: 'Funded', algoStack: 'IFSP', dateAdded: '2026-06-01', dateFunded: '2026-06-10' },
      },
    }];
    const rows = buildLifecycleByAlgo(clients, { asOf: '2026-06-20' });
    const urgo = rows.find((r) => r.combo === 'URGO');
    expect(urgo).toMatchObject({ accounts: 2, funded: 1, failed: 1, fundedRate: 50 });
    const ifsp = rows.find((r) => r.combo === 'IFSP');
    expect(ifsp.fundedRate).toBe(100);
    expect(rows[0].combo).toBe('IFSP'); // sorted by funded rate desc
  });
});
