import { describe, it, expect } from 'vitest';
import { buildClientSegments, buildClientPropFirms } from './clientSegments';

const client = {
  id: 'c1',
  accountRegistry: {
    F1: { accountType: 'Funded', alias: 'Funded 1' },
    C1: { accountType: 'Cash', alias: 'Cash 1' },
    E1: { accountType: 'Evaluation - Standard', alias: 'Eval 1' },
    B1: { accountType: 'Evaluation - Bullet Bot', alias: 'BB 1' },
  },
};

const dailyImport = {
  date: '2026-07-13',
  snapshots: [
    { accountName: 'F1', accountBalance: 52000, grossRealizedPnl: 300, trailingMaxDrawdown: 1500, connection: 'Lucid' },
    { accountName: 'C1', accountBalance: 10000, grossRealizedPnl: -50, connection: 'Tradeify' },
    { accountName: 'E1', accountBalance: 51000, grossRealizedPnl: 200, connection: 'Lucid' },
    { accountName: 'B1', accountBalance: 3200, grossRealizedPnl: 100, connection: 'blueSky' },
  ],
};

describe('buildClientSegments', () => {
  it('accumulates weekly PnL per segment too', () => {
    const withWeekly = { ...dailyImport, snapshots: dailyImport.snapshots.map((s) => ({ ...s, weeklyPnl: 111 })) };
    const seg = buildClientSegments(client, withWeekly);
    expect(seg.funded.weeklyPnl).toBe(111);
    expect(seg.cash.weeklyPnl).toBe(111);
  });

  it('keeps balance and PnL separate per account type (no combined total)', () => {
    const seg = buildClientSegments(client, dailyImport);
    expect(seg.funded).toMatchObject({ balance: 52000, dailyPnl: 300, count: 1 });
    expect(seg.cash).toMatchObject({ balance: 10000, dailyPnl: -50, count: 1 });
    expect(seg.evalStandard).toMatchObject({ balance: 51000, dailyPnl: 200, count: 1 });
    expect(seg.bulletBot).toMatchObject({ balance: 3200, dailyPnl: 100, count: 1 });
  });

  it('exposes per-account balance and trailing for the UI', () => {
    const seg = buildClientSegments(client, dailyImport);
    expect(seg.funded.accounts[0]).toMatchObject({ accountName: 'F1', balance: 52000, trailing: 1500 });
  });
});

describe('buildClientPropFirms', () => {
  it('groups the client accounts by prop firm (connection)', () => {
    const firms = buildClientPropFirms(client, dailyImport);
    const lucid = firms.find((f) => f.firm === 'Lucid');
    expect(lucid.count).toBe(2); // F1 + E1
    expect(firms.map((f) => f.firm)).toEqual(expect.arrayContaining(['Lucid', 'Tradeify', 'blueSky']));
    expect(firms[0].firm).toBe('Lucid'); // sorted by count desc
  });
});
