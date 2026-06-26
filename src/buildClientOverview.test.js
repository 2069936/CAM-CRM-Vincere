import { describe, expect, it } from 'vitest';
import { buildClientOverview } from './App';

function makeClient({ imports = [], registry = {} } = {}) {
  return { id: 'c1', name: 'Pedro', accountRegistry: registry, dailyImports: imports };
}

function makeImport(date, snapshots = [], flags = []) {
  return { id: `di-${date}`, date, accounts: {}, snapshots, flags };
}

function makeSnap(name, balance, pnl, strategies = []) {
  return { accountName: name, accountBalance: balance, grossRealizedPnl: pnl, weeklyPnl: 0, strategies };
}

describe('buildClientOverview', () => {
  it('returns safe defaults for client with no imports', () => {
    const result = buildClientOverview(makeClient(), null);
    expect(result.history).toHaveLength(0);
    expect(result.algorithms).toHaveLength(0);
    expect(result.passProgress).toHaveLength(0);
    expect(result.metrics.dailyPnl).toBe(0);
    expect(result.metrics.accounts).toBe(0);
    expect(result.metrics.openFlags).toBe(0);
  });

  it('sums snapshots P&L into metrics.dailyPnl', () => {
    const imp = makeImport('2026-06-25', [
      makeSnap('A1', 51200, 800),
      makeSnap('A2', 50500, 200),
    ]);
    const result = buildClientOverview(makeClient({ imports: [imp] }), imp);
    expect(result.metrics.dailyPnl).toBe(1000);
  });

  it('counts accounts from latest snapshot', () => {
    const imp = makeImport('2026-06-25', [makeSnap('A1', 51000, 100), makeSnap('A2', 52000, 200)]);
    const result = buildClientOverview(makeClient({ imports: [imp] }), imp);
    expect(result.metrics.accounts).toBe(2);
  });

  it('excludes Resolved and Acknowledged flags from openFlags count', () => {
    const imp = makeImport('2026-06-25', [], [
      { id: 'f1', status: 'Open' },
      { id: 'f2', status: 'Resolved' },
      { id: 'f3', status: 'Acknowledged' },
    ]);
    const result = buildClientOverview(makeClient({ imports: [imp] }), imp);
    expect(result.metrics.openFlags).toBe(1);
  });

  it('classifies algorithm temperature: Hot > 250 recent, Cold < -250', () => {
    const strategies = [{ strategyFamily: 'RBO', strategyName: 'RBO-1', enabled: true, realized: 300 }];
    const strategies2 = [{ strategyFamily: 'OGX', strategyName: 'OGX-1', enabled: true, realized: -300 }];
    const imp = makeImport('2026-06-25', [
      makeSnap('A1', 51000, 300, strategies),
      makeSnap('A2', 50000, -300, strategies2),
    ]);
    const result = buildClientOverview(makeClient({ imports: [imp] }), imp);
    const rbo = result.algorithms.find(a => a.name === 'RBO');
    const ogx = result.algorithms.find(a => a.name === 'OGX');
    expect(rbo?.temperature).toBe('Hot');
    expect(ogx?.temperature).toBe('Cold');
    expect(result.metrics.hotCount).toBe(1);
    expect(result.metrics.coldCount).toBe(1);
  });

  it('computes passProgress sorted by progress descending', () => {
    const registry = {
      A1: { accountName: 'A1', accountType: 'Funded', startBalance: 50000, targetProfit: 52000 },
      A2: { accountName: 'A2', accountType: 'Funded', startBalance: 50000, targetProfit: 52000 },
    };
    const imp = makeImport('2026-06-25', [
      makeSnap('A1', 51900, 0), // 95% progress
      makeSnap('A2', 51000, 0), // 50% progress
    ]);
    const result = buildClientOverview(makeClient({ imports: [imp], registry }), imp);
    expect(result.passProgress[0].accountName).toBe('A1');
    expect(result.passProgress[0].progress).toBeGreaterThan(result.passProgress[1].progress);
  });

  it('excludes Cash and Inactive/Ignore accounts from passProgress', () => {
    const registry = {
      CASH1: { accountName: 'CASH1', accountType: 'Cash' },
      IGN1:  { accountName: 'IGN1',  accountType: 'Inactive / Ignore' },
      FUND1: { accountName: 'FUND1', accountType: 'Funded', startBalance: 50000, targetProfit: 52000 },
    };
    const imp = makeImport('2026-06-25', [
      makeSnap('CASH1', 10000, 0),
      makeSnap('IGN1', 50000, 0),
      makeSnap('FUND1', 51000, 0),
    ]);
    const result = buildClientOverview(makeClient({ imports: [imp], registry }), imp);
    expect(result.passProgress).toHaveLength(1);
    expect(result.passProgress[0].accountName).toBe('FUND1');
  });

  it('reports dailyDelta as difference from prior day', () => {
    const imp1 = makeImport('2026-06-24', [makeSnap('A1', 50200, 200)]);
    const imp2 = makeImport('2026-06-25', [makeSnap('A1', 50700, 500)]);
    const result = buildClientOverview(makeClient({ imports: [imp1, imp2] }), imp2);
    expect(result.metrics.dailyDelta).toBe(300); // 500 - 200
  });

  it('positive streak label when last 4 days all positive', () => {
    const imps = ['2026-06-20','2026-06-21','2026-06-22','2026-06-23'].map((d, i) =>
      makeImport(d, [makeSnap('A1', 50000 + (i+1)*100, (i+1)*100)])
    );
    const result = buildClientOverview(makeClient({ imports: imps }), null);
    expect(result.metrics.streakLabel).toContain('positive streak');
  });
});
