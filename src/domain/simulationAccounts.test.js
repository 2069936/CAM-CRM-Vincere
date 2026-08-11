import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_NATURES,
  MONEY_ACCOUNT_TYPES,
  SIMULATION_ACCOUNT_TYPE,
  classifyAccountNature,
  mergeSimulationRows,
  splitSimulationRows,
  summarizeSimulationSplit,
} from './simulationAccounts';
import { ACCOUNT_TYPES } from './reconcile';

const snapshot = (accountName, over = {}) => ({
  accountName,
  connection: 'Legends',
  accountBalance: 100000,
  grossRealizedPnl: 0,
  weeklyPnl: 0,
  ...over,
});

describe('MONEY_ACCOUNT_TYPES stays in step with ACCOUNT_TYPES', () => {
  // simulationAccounts.js deliberately declares the money types itself rather
  // than importing ACCOUNT_TYPES, so it stays a leaf module and reconcile.js can
  // import the classifier without a cycle. This test is the price of that: add
  // an account type in reconcile.js without deciding whether it holds money and
  // the suite says so here, instead of the new type silently defaulting to live
  // in every total.
  it('covers every account type exactly once', () => {
    const all = Object.values(ACCOUNT_TYPES);
    const notMoney = [ACCOUNT_TYPES.UNASSIGNED, ACCOUNT_TYPES.IGNORE, ACCOUNT_TYPES.SIMULATION];
    expect([...MONEY_ACCOUNT_TYPES].sort())
      .toEqual(all.filter((type) => !notMoney.includes(type)).sort());
    expect(SIMULATION_ACCOUNT_TYPE).toBe(ACCOUNT_TYPES.SIMULATION);
  });
});

describe('classifyAccountNature', () => {
  it('recognises NinjaTrader Sim<number> naming and says why', () => {
    // All 11 simulation accounts across the 11 real client exports are named
    // exactly this.
    const result = classifyAccountNature({}, { accountName: 'Sim101' });
    expect(result.nature).toBe(ACCOUNT_NATURES.SIMULATION);
    expect(result.source).toBe('name');
    expect(result.heuristic).toBe(true);
    expect(result.reason).toContain('named Sim101');
  });

  it.each(['Sim101', 'sim102', 'SIM 103', 'Sim-104', 'Sim_105'])(
    'treats %s as the platform naming',
    (name) => {
      expect(classifyAccountNature({}, { accountName: name }).nature)
        .toBe(ACCOUNT_NATURES.SIMULATION);
    },
  );

  it.each(['Simmons - Main', 'Simon 01', 'Simba'])(
    'does NOT delete a real account merely because its name starts with sim: %s',
    (name) => {
      // The old startsWith('sim') filter dropped these from every close with no
      // flag, no warning and no count. They are live money and read as such.
      const result = classifyAccountNature({}, { accountName: name });
      expect(result.nature).toBe(ACCOUNT_NATURES.LIVE);
      expect(result.source).toBe('default');
    },
  );

  it.each(['Sim', 'Sim - Craig test', 'Demo', 'Practice account', 'Simulator 2'])(
    'reports %s as undetermined rather than guessing',
    (name) => {
      const result = classifyAccountNature({}, { accountName: name });
      expect(result.nature).toBe(ACCOUNT_NATURES.UNDETERMINED);
      expect(result.reason).toBeTruthy();
    },
  );

  it('lets the CAM override the heuristic in both directions', () => {
    expect(classifyAccountNature({ simulationMode: 'live' }, { accountName: 'Sim101' }))
      .toMatchObject({ nature: ACCOUNT_NATURES.LIVE, source: 'registry', heuristic: false });
    expect(classifyAccountNature({ simulationMode: 'simulation' }, { accountName: 'LTATALEST500004585512' }))
      .toMatchObject({ nature: ACCOUNT_NATURES.SIMULATION, source: 'registry', heuristic: false });
  });

  it('treats a declared account type as a determination, not a heuristic', () => {
    expect(classifyAccountNature({ accountType: ACCOUNT_TYPES.SIMULATION }, { accountName: 'anything' }))
      .toMatchObject({ nature: ACCOUNT_NATURES.SIMULATION, source: 'accountType', heuristic: false });
    expect(classifyAccountNature({ accountType: ACCOUNT_TYPES.FUNDED }, { accountName: 'FTDFYL100156567922' }))
      .toMatchObject({ nature: ACCOUNT_NATURES.LIVE, source: 'accountType' });
  });

  it('reports a contradiction as undetermined instead of picking a winner', () => {
    // 'Funded' says real money, the name says NinjaTrader simulator. One of the
    // two is wrong and nothing in the data says which, so neither total gets it.
    const result = classifyAccountNature({ accountType: ACCOUNT_TYPES.FUNDED }, { accountName: 'Sim101' });
    expect(result.nature).toBe(ACCOUNT_NATURES.UNDETERMINED);
    expect(result.source).toBe('conflict');
    expect(result.reason).toContain('disagree');
  });

  it('takes the platform flag over the name, and a missing flag as no opinion', () => {
    expect(classifyAccountNature({}, { accountName: 'Sim101', isSimulated: false }).nature)
      .toBe(ACCOUNT_NATURES.LIVE);
    expect(classifyAccountNature({}, { accountName: 'FTDFYL100156567922', isSimulated: true }).nature)
      .toBe(ACCOUNT_NATURES.SIMULATION);
    // undefined is NOT false. A collector that does not report the flag must
    // leave the name test in charge.
    expect(classifyAccountNature({}, { accountName: 'Sim101', isSimulated: undefined }).nature)
      .toBe(ACCOUNT_NATURES.SIMULATION);
  });

  it('leaves an unremarkable account alone', () => {
    expect(classifyAccountNature({ accountType: ACCOUNT_TYPES.UNASSIGNED }, { accountName: 'BSKELAUNCHTODD81952' })
      .nature).toBe(ACCOUNT_NATURES.LIVE);
  });
});

describe('splitSimulationRows', () => {
  const close = {
    accounts: {
      Sim101: { accountName: 'Sim101', alias: 'Sim', accountType: ACCOUNT_TYPES.SIMULATION },
      'Craig - Main': { accountName: 'Craig - Main', alias: 'Live - Main', accountType: ACCOUNT_TYPES.CASH_STRAIGHT },
      Demo: { accountName: 'Demo', alias: 'Demo', accountType: ACCOUNT_TYPES.UNASSIGNED },
    },
    // Craig Weschke's real 2026-08-06 figures.
    snapshots: [
      snapshot('Sim101', { accountBalance: 99590, grossRealizedPnl: -1297.9999999 }),
      snapshot('Craig - Main', { accountBalance: 55893.06, grossRealizedPnl: 0 }),
      snapshot('Demo', { accountBalance: 1234 }),
    ],
    strategies: [
      { accountName: 'Sim101', strategyName: '0 - URGO-4.5 MNQ SEP26', enabled: true },
      { accountName: 'Sim101', strategyName: '0 - IFSP-1.1 NG SEP26', enabled: true },
      { accountName: 'Craig - Main', strategyName: '0 - RBO-1.8', enabled: false },
    ],
    orders: [{ accountName: 'Sim101', id: 'O1' }, { accountName: 'Craig - Main', id: 'O2' }],
    executions: [{ accountName: 'Sim101', orderId: 'O1' }],
  };

  it('keeps the live arrays free of anything that is not real money', () => {
    const { live } = splitSimulationRows(close);
    expect(live.snapshots.map((s) => s.accountName)).toEqual(['Craig - Main']);
    expect(live.strategies.map((s) => s.accountName)).toEqual(['Craig - Main']);
    expect(live.orders.map((o) => o.accountName)).toEqual(['Craig - Main']);
    expect(live.executions).toEqual([]);
  });

  it('carries the simulated work through with its own totals', () => {
    const { simulation } = splitSimulationRows(close);
    expect(simulation.totals.accounts).toBe(1);
    expect(simulation.totals.balance).toBe(99590);
    expect(simulation.totals.dailyPnl).toBeCloseTo(-1297.9999999, 6);
    expect(simulation.orders).toHaveLength(1);
    expect(simulation.executions).toHaveLength(1);
    expect(simulation.strategies).toHaveLength(2);
  });

  it('counts an undetermined account in neither total', () => {
    const { simulation } = splitSimulationRows(close);
    expect(simulation.undetermined.totals.accounts).toBe(1);
    expect(simulation.undetermined.totals.balance).toBe(1234);
    // Not in the live arrays and not in the simulated totals.
    expect(simulation.totals.balance).toBe(99590);
    expect(splitSimulationRows(close).live.snapshots.map((s) => s.accountName)).not.toContain('Demo');
  });

  it('carries a denominator with every count', () => {
    const { simulation } = splitSimulationRows(close);
    expect(simulation.denominator.accountsInClose).toBe(3);
    expect(simulation.denominator.accountsOnRecord).toBe(3);
  });

  it('answers "is this close simulation-free" with null while anything is undetermined', () => {
    // Not false. A value that cannot be determined is null.
    expect(splitSimulationRows(close).simulation.hasSimulation).toBeNull();
    const resolved = {
      ...close,
      accounts: { ...close.accounts, Demo: { accountName: 'Demo', accountType: ACCOUNT_TYPES.CASH_IRA, simulationMode: 'live' } },
    };
    expect(splitSimulationRows(resolved).simulation.hasSimulation).toBe(true);
  });

  it('matches registry keys case-insensitively', () => {
    const mixed = {
      accounts: { SIM101: { accountName: 'SIM101', accountType: ACCOUNT_TYPES.SIMULATION } },
      snapshots: [snapshot('sim101')],
      strategies: [], orders: [], executions: [],
    };
    expect(splitSimulationRows(mixed).live.snapshots).toEqual([]);
    expect(splitSimulationRows(mixed).simulation.snapshots).toHaveLength(1);
  });

  it('classifies a simulated close whose account was never registered', () => {
    const orphan = {
      accounts: {},
      snapshots: [snapshot('Sim101', { accountBalance: 100000 })],
      strategies: [], orders: [], executions: [],
    };
    expect(splitSimulationRows(orphan).live.snapshots).toEqual([]);
    expect(splitSimulationRows(orphan).simulation.totals.balance).toBe(100000);
  });
});

describe('mergeSimulationRows', () => {
  it('reassembles the whole close for persistence', () => {
    const split = splitSimulationRows({
      accounts: {
        Sim101: { accountName: 'Sim101', accountType: ACCOUNT_TYPES.SIMULATION },
        ACC1: { accountName: 'ACC1', accountType: ACCOUNT_TYPES.FUNDED },
      },
      snapshots: [snapshot('Sim101'), snapshot('ACC1')],
      strategies: [{ accountName: 'Sim101' }],
      orders: [{ accountName: 'ACC1', id: 'O1' }],
      executions: [],
    });
    const whole = mergeSimulationRows({ ...split.live, simulation: split.simulation });
    expect(whole.snapshots.map((s) => s.accountName).sort()).toEqual(['ACC1', 'Sim101']);
    expect(whole.strategies).toHaveLength(1);
    expect(whole.orders).toHaveLength(1);
  });
});

describe('summarizeSimulationSplit', () => {
  it('reports every count against its denominator', () => {
    const { simulation } = splitSimulationRows({
      accounts: { Sim101: { accountName: 'Sim101', accountType: ACCOUNT_TYPES.SIMULATION } },
      snapshots: [snapshot('Sim101', { accountBalance: 99590, grossRealizedPnl: -1298 }), snapshot('ACC1')],
      strategies: [], orders: [], executions: [],
    });
    expect(summarizeSimulationSplit(simulation)).toMatchObject({
      simulatedAccounts: 1,
      simulatedBalance: 99590,
      simulatedDailyPnl: -1298,
      undeterminedAccounts: 0,
      ofAccountsInClose: 2,
    });
  });

  it('returns null when there is no split to describe', () => {
    expect(summarizeSimulationSplit(null)).toBeNull();
  });
});
