import { describe, it, expect } from 'vitest';
import { buildBulletBotAccountRecords, buildBulletBotStats } from './bulletBotStats';

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

describe('buildBulletBotAccountRecords', () => {
  // The desk module opts into these; the per-client card must not inherit them,
  // or StackPlaybook silently changes the numbers it has always shown.
  const extra = [{
    id: 'c2',
    name: 'Client 2',
    accountRegistry: {
      // No target on the account row, first balance inside the standard 50k band.
      BB3: { accountType: 'Evaluation - Bullet Bot', status: 'Active' },
      // Never appears in an import at all.
      BB4: { accountType: 'Evaluation - Bullet Bot', status: 'Failed' },
    },
    dailyImports: [{
      date: '2026-07-01',
      snapshots: [{ accountName: 'BB3', accountBalance: 53400, strategies: [{ strategyFamily: 'BulletBot', direction: 'Long' }] }],
    }],
  }];

  it('defaults to the legacy behaviour: no inferred targets, no unobserved accounts', () => {
    const records = buildBulletBotAccountRecords(extra);
    expect(records).toHaveLength(1);
    expect(records[0].accountName).toBe('BB3');
    expect(records[0].target).toBe(0);
    expect(records[0].passed).toBe(false);
  });

  it('infers the standard Bullet Bot target on request', () => {
    const [record] = buildBulletBotAccountRecords(extra, { inferTargets: true });
    expect(record.target).toBe(53000);
    expect(record.targetSource).toBe('inferred');
    expect(record.passed).toBe(true);
    // Above target the first time it was seen: a pass with no measurable duration.
    expect(record.censored).toBe(true);
    expect(record.daysToPass).toBe(0);
  });

  it('adds accounts that carry a status but never appear in an import', () => {
    const records = buildBulletBotAccountRecords(extra, { includeUnobserved: true });
    const ghost = records.find((r) => r.accountName === 'BB4');
    expect(ghost.observedDays).toBe(0);
    expect(ghost.status).toBe('Failed');
    expect(ghost.firstDate).toBe('');
  });

  // The boundary IS the definition of "passed": an account whose balance lands
  // exactly on target has reached the target, same as a funded payout. No row on
  // the current book sits exactly on its target, so `>=` could be `>` and every
  // number would still match — the day a balance lands on the line, one pass
  // would silently disappear.
  describe('the pass boundary', () => {
    function bookAtBalance(balance) {
      return [{
        id: 'c-boundary',
        name: 'Boundary Client',
        accountRegistry: { EXACT: { accountType: 'Evaluation - Bullet Bot', targetProfit: 53000 } },
        dailyImports: [{
          date: '2026-07-01',
          snapshots: [{ accountName: 'EXACT', accountBalance: balance, strategies: [{ strategyFamily: 'BulletBot', direction: 'Long' }] }],
        }],
      }];
    }

    it('counts a balance landing exactly on target as a pass', () => {
      const [record] = buildBulletBotAccountRecords(bookAtBalance(53000));
      expect(record.target).toBe(53000);
      expect(record.passed).toBe(true);
      expect(record.passDate).toBe('2026-07-01');
    });

    it('does not count a balance one cent short of target', () => {
      const [record] = buildBulletBotAccountRecords(bookAtBalance(52999.99));
      expect(record.passed).toBe(false);
      expect(record.passDate).toBeNull();
    });
  });

  // accountMetaFor matches the registry case-insensitively, so keying the record
  // on the raw snapshot spelling would feed two records from one registry row:
  // the account's history is split, and the second half looks like a brand-new
  // account that was already at target the first day it appeared.
  it('resolves case-different spellings of one account to a single record', () => {
    const records = buildBulletBotAccountRecords([{
      id: 'c-case',
      name: 'Case Client',
      accountRegistry: {
        abc123: { accountType: 'Evaluation - Bullet Bot', targetProfit: 53000, alias: 'Case Account' },
      },
      dailyImports: [
        { date: '2026-07-01', snapshots: [{ accountName: 'abc123', accountBalance: 50000, strategies: [{ strategyFamily: 'BulletBot', direction: 'Long' }] }] },
        { date: '2026-07-02', snapshots: [{ accountName: 'ABC123', accountBalance: 53500, strategies: [{ strategyFamily: 'BulletBot', direction: 'Long' }] }] },
      ],
    }]);

    expect(records).toHaveLength(1);
    expect(records[0].observedDays).toBe(2);
    expect(records[0].firstDate).toBe('2026-07-01');
    expect(records[0].lastDate).toBe('2026-07-02');
    // Split into two records this reads as a censored pass on day two instead of
    // a one-day climb.
    expect(records[0].passed).toBe(true);
    expect(records[0].censored).toBe(false);
    expect(records[0].daysToPass).toBe(1);
  });

  it('records every direction an account ran, not just the first', () => {
    const records = buildBulletBotAccountRecords([{
      id: 'c3',
      accountRegistry: { BB5: { accountType: 'Evaluation - Bullet Bot' } },
      dailyImports: [
        { date: '2026-07-01', snapshots: [{ accountName: 'BB5', accountBalance: 50000, strategies: [{ strategyFamily: 'BulletBot', direction: 'Long' }] }] },
        { date: '2026-07-02', snapshots: [{ accountName: 'BB5', accountBalance: 50000, strategies: [{ strategyFamily: 'BulletBot', direction: 'Short' }] }] },
      ],
    }]);
    expect(records[0].direction).toBe('Long');
    expect(records[0].directionsSeen).toEqual(['Long', 'Short']);
  });
});
