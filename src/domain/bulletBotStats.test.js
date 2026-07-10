import { describe, it, expect } from 'vitest';
import { buildBulletBotStats } from './bulletBotStats';

const clients = [{
  id: 'c1',
  name: 'Client 1',
  accountRegistry: {
    BB1: { accountType: 'Evaluation - Bullet Bot', targetProfit: 3000, alias: 'BB Long' },
    BB2: { accountType: 'Evaluation - Bullet Bot', targetProfit: 3000, alias: 'BB Short' },
    F1: { accountType: 'Funded', targetProfit: 5000 },
  },
  dailyImports: [
    {
      date: '2026-07-01',
      executions: [{ accountName: 'BB1' }],
      snapshots: [
        { accountName: 'BB1', accountBalance: 1200, strategies: [{ strategyFamily: 'BulletBot', direction: 'Long', realized: 1200 }] },
        { accountName: 'BB2', accountBalance: 800, strategies: [{ strategyFamily: 'BulletBot', direction: 'Short', realized: 800 }] },
        { accountName: 'F1', accountBalance: 5200, strategies: [{ strategyFamily: 'RBO', realized: 200 }] },
      ],
    },
    {
      date: '2026-07-04',
      executions: [{ accountName: 'BB1' }, { accountName: 'BB2' }],
      snapshots: [
        { accountName: 'BB1', accountBalance: 3100, strategies: [{ strategyFamily: 'BulletBot', direction: 'Long', realized: 3100 }] },
        { accountName: 'BB2', accountBalance: 1500, strategies: [{ strategyFamily: 'BulletBot', direction: 'Short', realized: 1500 }] },
      ],
    },
  ],
}];

describe('buildBulletBotStats', () => {
  it('counts only Bullet Bot eval accounts (funded excluded)', () => {
    const stats = buildBulletBotStats(clients);
    expect(stats.overall.accounts).toBe(2);
  });

  it('marks an account passed when balance reaches target, with days-to-pass', () => {
    const stats = buildBulletBotStats(clients);
    const bb1 = stats.accounts.find((a) => a.accountName === 'BB1');
    expect(bb1.passed).toBe(true);
    expect(bb1.daysToPass).toBe(3); // 2026-07-01 -> 2026-07-04
    const bb2 = stats.accounts.find((a) => a.accountName === 'BB2');
    expect(bb2.passed).toBe(false);
    expect(bb2.daysToPass).toBeNull();
  });

  it('splits pass rate by direction', () => {
    const stats = buildBulletBotStats(clients);
    expect(stats.long).toMatchObject({ accounts: 1, passed: 1, passRate: 1, avgDaysToPass: 3 });
    expect(stats.short).toMatchObject({ accounts: 1, passed: 0, passRate: 0, avgDaysToPass: null });
  });

  it('marks fired when the account traded', () => {
    const stats = buildBulletBotStats(clients);
    expect(stats.overall.fired).toBe(2);
  });

  it('handles empty input', () => {
    expect(buildBulletBotStats([]).overall.accounts).toBe(0);
    expect(() => buildBulletBotStats(undefined)).not.toThrow();
  });
});
