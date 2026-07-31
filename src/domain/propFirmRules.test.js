import { describe, expect, it } from 'vitest';
import {
  inferAccountSize,
  normalizePropFirm,
  plansFor,
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
  const rules = { 'Legends|Elite|50000': { trailingDrawdown: 2500, profitTarget: 3000, basis: 'end-of-day' } };
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
      { accountName: 'A1', connection: 'Legends', propFirmPlan: 'Elite', maxDrawdownLimit: 1800, startBalance: 50000 },
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

    const summary = summarizeRuleCoverage(clients, { 'Legends|Elite|50000': { trailingDrawdown: 2500 } });

    expect(summary.combos[0]).toMatchObject({ firm: 'Legends', accountSize: 50000, accounts: 2, hasRule: true });
    expect(summary.combos[1]).toMatchObject({ firm: 'Bluesky', accounts: 1, hasRule: false });
    expect(summary.resolved).toBe(2);
    expect(summary.unresolved).toBe(1);
  });
});

describe('generic profit targets', () => {
  it('falls back to the generic target when no firm rule exists', () => {
    const limits = resolveAccountLimits(
      { accountName: 'A1', connection: 'Tradeify', startBalance: 50000 },
      { rules: {} },
    );

    expect(limits.targetProfit).toBe(4000);
    expect(limits.targetSource).toBe('generic');
  });

  it('lets a firm rule beat the generic one', () => {
    const limits = resolveAccountLimits(
      { accountName: 'A1', connection: 'Legends', propFirmPlan: 'Elite', startBalance: 50000 },
      { rules: { 'Legends|Elite|50000': { profitTarget: 3000 } } },
    );

    expect(limits.targetProfit).toBe(3000);
    expect(limits.targetSource).toBe('firm-rule');
  });

  it('covers every size the desk has confirmed', () => {
    const targets = [[50000, 4000], [100000, 7000], [150000, 9000]];
    for (const [size, expected] of targets) {
      const limits = resolveAccountLimits(
        { accountName: 'A1', connection: 'Tradeify', startBalance: size },
        { rules: {} },
      );
      expect(limits.targetProfit).toBe(expected);
      expect(limits.targetSource).toBe('generic');
    }
  });

  it('reports nothing for a size with no generic target', () => {
    const limits = resolveAccountLimits(
      { accountName: 'A1', connection: 'Tradeify', startBalance: 25000 },
      { rules: {} },
    );

    expect(limits.targetProfit).toBeNull();
    expect(limits.targetSource).toBeNull();
  });
});

describe('plan-level rules', () => {
  it('uses the tightest drawdown when the plan is unknown', () => {
    // Legends sells 50k at 2,000 (Apprentice) and 2,200 (Elite). Guessing 2,200
    // on an Apprentice account raises the warning 200 dollars after it is
    // already dead; guessing 2,000 on an Elite raises it 200 early. Only one of
    // those is survivable.
    const limits = resolveAccountLimits(
      { accountName: 'A1', connection: 'Legends', startBalance: 50000 },
    );

    expect(limits.maxDrawdownLimit).toBe(2000);
    expect(limits.planKnown).toBe(false);
    expect(limits.ruleSource).toBe('tightest-for-size');
  });

  it('uses that account’s own plan once someone names it', () => {
    const limits = resolveAccountLimits(
      { accountName: 'A1', connection: 'Legends', propFirmPlan: 'Elite', startBalance: 50000 },
    );

    expect(limits.maxDrawdownLimit).toBe(2200);
    expect(limits.planKnown).toBe(true);
    expect(limits.ruleSource).toBe('plan');
  });

  it('does not carry one plan’s ladder onto another', () => {
    // Lucid Pro and Flex agree at every size; Direct does not, at the top two.
    // Quoting a single "Lucid 100K drawdown" is wrong half the time.
    const flex = resolveAccountLimits({ accountName: 'A', connection: 'Lucid', propFirmPlan: 'Flex', startBalance: 100000 });
    const direct = resolveAccountLimits({ accountName: 'A', connection: 'Lucid', propFirmPlan: 'Direct', startBalance: 100000 });

    expect(flex.maxDrawdownLimit).toBe(3000);
    expect(direct.maxDrawdownLimit).toBe(3500);
  });

  it('carries the funded-stage basis where it differs from the evaluation one', () => {
    // MFF Rapid is the only researched plan that changes basis with the stage.
    // Everything derived from stored closes assumes end-of-day, so an intraday
    // trail is understated and the account needs the reported figure.
    const rapid = resolveAccountLimits({ accountName: 'A', connection: 'MFF', propFirmPlan: 'Rapid', startBalance: 50000 });
    const pro = resolveAccountLimits({ accountName: 'A', connection: 'MFF', propFirmPlan: 'Pro', startBalance: 50000 });

    expect(rapid.basis).toBe('end-of-day');
    expect(rapid.fundedBasis).toBe('intraday');
    expect(pro.fundedBasis).toBeNull();
  });

  it('offers the plans a firm actually sells, for the classification prompt', () => {
    expect(plansFor('Legends')).toEqual(['Apprentice', 'Elite']);
    expect(plansFor('Apex')).toEqual(['EOD Trail', 'Intraday Trail']);
    expect(plansFor('Nobody')).toEqual([]);
  });

  it('knows Apex trails 4,000 at 150k where the others trail 4,500', () => {
    const apex = resolveAccountLimits({ accountName: 'A', connection: 'Apex', propFirmPlan: 'EOD Trail', startBalance: 150000 });
    const lucid = resolveAccountLimits({ accountName: 'A', connection: 'Lucid', propFirmPlan: 'Flex', startBalance: 150000 });

    expect(apex.maxDrawdownLimit).toBe(4000);
    expect(lucid.maxDrawdownLimit).toBe(4500);
  });
});

describe('the plan survives a round trip', () => {
  it('is preserved by the registry rebuild', async () => {
    // reconcile rebuilds the registry on every import. A field it does not carry
    // forward is silently dropped the next morning, so the CAM's answer would
    // last exactly one day.
    const { reconcileDailyImport } = await import('./reconcile');
    const result = reconcileDailyImport({
      clientId: 'c1',
      date: '2026-07-27',
      registry: {
        'ACC-1': { accountType: 'Funded', propFirmPlan: 'Elite', connection: 'Legends' },
      },
      parsed: {
        accounts: [{ accountName: 'ACC-1', accountBalance: 50000, connection: 'Legends' }],
        strategies: [], orders: [], executions: [],
      },
    });

    expect(result.accounts['ACC-1'].propFirmPlan).toBe('Elite');
  });
});

describe('when the breach is tested, as opposed to when the limit moves', () => {
  it('separates the two questions', () => {
    // Tradeify's help centre: "Even though EOD drawdown only UPDATES at end of
    // day, it is ENFORCED in real-time." Treating those as one thing let an
    // end-of-day label imply that stored closes could prove an account safe.
    const limits = resolveAccountLimits(
      { accountName: 'A', connection: 'Tradeify', propFirmPlan: 'Growth', startBalance: 100000 },
    );

    expect(limits.basis).toBe('end-of-day');
    expect(limits.breachTested).toBe('real-time');
    expect(limits.maxDrawdownLimit).toBe(3500);
  });

  it('keeps the Select ladder apart from Select Daily above 50k', () => {
    // Same firm, same size, 500 dollars of difference in the limit that ends
    // the account.
    const flex = resolveAccountLimits({ accountName: 'A', connection: 'Tradeify', propFirmPlan: 'Select', startBalance: 100000 });
    const daily = resolveAccountLimits({ accountName: 'A', connection: 'Tradeify', propFirmPlan: 'Select Daily', startBalance: 100000 });

    expect(flex.maxDrawdownLimit).toBe(3000);
    expect(daily.maxDrawdownLimit).toBe(2500);
  });

  it('falls back to the tightest Tradeify plan at each size', () => {
    // 100k spans 2,500 to 3,500 across Tradeify's own plans.
    const unknown = resolveAccountLimits({ accountName: 'A', connection: 'Tradeify', startBalance: 100000 });

    expect(unknown.maxDrawdownLimit).toBe(2500);
    expect(unknown.ruleSource).toBe('tightest-for-size');
  });
});

describe('firm name variants', () => {
  it('folds a misspelling into the firm it meant', () => {
    // The book holds "Tradefify" beside "Tradeify". Two accounts sat under a
    // firm with no rules while their real firm's rules were already loaded.
    expect(normalizePropFirm('Tradefify')).toBe('Tradeify');
    expect(normalizePropFirm('TakePT')).toBe('Take Profit Trader');
    expect(normalizePropFirm('FFFamily')).toBe('Funded Futures Family');
    expect(normalizePropFirm('FUNDED FUTURES')).toBe('Funded Futures Family');
    expect(normalizePropFirm('Tradeday')).toBe('TradeDay');
  });

  it('still leaves an unknown firm under its own name', () => {
    expect(normalizePropFirm('Some New Firm')).toBe('Some New Firm');
  });
});
