import { describe, expect, it } from 'vitest';
import {
  inferAccountSize,
  normalizePropFirm,
  resolveAccountLimits,
  summarizeRuleCoverage,
} from './propFirmRules';

describe('normalizePropFirm', () => {
  it('folds the spellings a real book actually held', () => {
    // 236 Legends accounts under four spellings, 132 Bluesky under five.
    // Grouping on the raw string splits one firm into five and applies any
    // per-firm rule to a fraction of the accounts it should cover.
    for (const value of ['Legends', 'LEGENDS', 'Legends Trading', 'The legends']) {
      expect(normalizePropFirm(value)).toBe('Legends');
    }
    for (const value of ['Blusky', 'Bluesky', 'BLUESKY', 'BluSky', 'BlueSky', 'Blue Sky']) {
      expect(normalizePropFirm(value)).toBe('Bluesky');
    }
    expect(normalizePropFirm('LUCID')).toBe('Lucid');
  });

  it('does not turn a platform connection into a firm', () => {
    // "Live" appeared on 53 accounts. It is NinjaTrader's own connection name,
    // and treating it as a firm invents one with rules nobody wrote.
    for (const value of ['Live', 'live', 'Sim101', 'Playback', 'Backtest']) {
      expect(normalizePropFirm(value)).toBeNull();
    }
    expect(normalizePropFirm('')).toBeNull();
    expect(normalizePropFirm(null)).toBeNull();
  });

  it('keeps an unrecognised firm rather than discarding the account', () => {
    expect(normalizePropFirm('Some New Firm')).toBe('Some New Firm');
  });
});

describe('inferAccountSize', () => {
  it('snaps a starting balance to the size that was sold', () => {
    expect(inferAccountSize(50000)).toBe(50000);
    expect(inferAccountSize(50125)).toBe(50000);
    expect(inferAccountSize(148900)).toBe(150000);
  });

  it('refuses a balance that is not near any size', () => {
    // Guessing would put an account under rules that were never its own.
    expect(inferAccountSize(61400)).toBeNull();
    expect(inferAccountSize(0)).toBeNull();
    expect(inferAccountSize(null)).toBeNull();
    expect(inferAccountSize('abc')).toBeNull();
  });
});

describe('resolveAccountLimits', () => {
  const rules = { 'Legends|50000': { trailingDrawdown: 2500, profitTarget: 3000, basis: 'end-of-day' } };
  const dailyImports = [
    { date: '2026-07-20', snapshots: [{ accountName: 'A1', accountBalance: 50000 }] },
    { date: '2026-07-27', snapshots: [{ accountName: 'A1', accountBalance: 47800 }] },
  ];

  it('derives a limit from firm and size when none was stored', () => {
    const limits = resolveAccountLimits(
      { accountName: 'A1', connection: 'LEGENDS' },
      { dailyImports, rules },
    );

    expect(limits.firm).toBe('Legends');
    expect(limits.accountSize).toBe(50000);
    expect(limits.sizeSource).toBe('inferred');
    expect(limits.maxDrawdownLimit).toBe(2500);
    expect(limits.drawdownSource).toBe('firm-rule');
    expect(limits.basis).toBe('end-of-day');
  });

  it('never overrides a number someone typed', () => {
    const limits = resolveAccountLimits(
      { accountName: 'A1', connection: 'Legends', maxDrawdownLimit: 1800, startBalance: 50000 },
      { dailyImports, rules },
    );

    expect(limits.maxDrawdownLimit).toBe(1800);
    expect(limits.drawdownSource).toBe('stored');
    expect(limits.sizeSource).toBe('stored');
  });

  it('reads the earliest close, not the latest, for the opening size', () => {
    // The later balance is 47,800, which snaps to 50,000 too. Reversing the
    // sort would still pass, so the account here drifts far enough to tell
    // the two apart.
    const drifted = [
      { date: '2026-07-20', snapshots: [{ accountName: 'A1', accountBalance: 150000 }] },
      { date: '2026-07-27', snapshots: [{ accountName: 'A1', accountBalance: 51000 }] },
    ];
    const limits = resolveAccountLimits({ accountName: 'A1', connection: 'Legends' }, { dailyImports: drifted, rules });

    expect(limits.accountSize).toBe(150000);
  });

  it('reports nothing rather than a guess when no rule exists', () => {
    const limits = resolveAccountLimits(
      { accountName: 'A1', connection: 'Tradeify' },
      { dailyImports, rules },
    );

    expect(limits.firm).toBe('Tradeify');
    expect(limits.accountSize).toBe(50000);
    expect(limits.maxDrawdownLimit).toBeNull();
    expect(limits.drawdownSource).toBeNull();
  });
});

describe('summarizeRuleCoverage', () => {
  it('ranks the firm and size pairs by how many accounts each rule would cover', () => {
    const clients = [{
      accountRegistry: {
        A1: { connection: 'Legends' },
        A2: { connection: 'LEGENDS' },
        A3: { connection: 'Blusky' },
      },
      dailyImports: [{
        date: '2026-07-20',
        snapshots: [
          { accountName: 'A1', accountBalance: 50000 },
          { accountName: 'A2', accountBalance: 50000 },
          { accountName: 'A3', accountBalance: 50000 },
        ],
      }],
    }];

    const summary = summarizeRuleCoverage(clients, { 'Legends|50000': { trailingDrawdown: 2500 } });

    expect(summary.combos[0]).toMatchObject({ firm: 'Legends', accountSize: 50000, accounts: 2, hasRule: true });
    expect(summary.combos[1]).toMatchObject({ firm: 'Bluesky', accounts: 1, hasRule: false });
    expect(summary.resolved).toBe(2);
    expect(summary.unresolved).toBe(1);
  });
});
