// A fictional client shaped exactly as the store hands one over, for the
// client period report's tests and its review render.
//
// The week of Mon 2026-10-12 to Sun 2026-10-18, with the Friday before it as
// the prior close, and NO close on Monday 2026-10-12. Every figure below is
// chosen so the expected answers can be worked out by hand:
//
//   counted   Funded 01  NSTAR 2.1 + BRKOUT 1.4, limit 2,500 on record
//             Funded 02  NSTAR 2.1 alone, Lucid Flex 50k plan on record
//             Cash 04    BRKOUT 1.4 alone
//   shown     Evaluation 03 (MEANREV 3.0), never counted
//   left out  Old funded (Failed 2026-10-02), Parked (Inactive / Ignore)
//   simulated Sim101, +777.00 a close, in no figure but its own row
//
//   realized per close (counted)  Oct 13 +400, Oct 14 -100, Oct 15 +280,
//                                 Oct 16 +170, total +750
//   combined balance  prior 125,000 -> 125,400 -> 125,300 -> 125,580 -> 125,750
//   NSTAR 2.1  8 account days, 7 measured, +800.00
//   BRKOUT 1.4 8 account days, 7 measured, +150.00
//   not split  Funded 01 on Oct 14, -200.00

export const PRIOR = '2026-10-09';
export const CLOSES = ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'];
export const GAP = '2026-10-12';

const REGISTRY = {
  'APX-1001': {
    accountName: 'APX-1001', alias: 'Funded 01', accountType: 'Funded', status: 'Active',
    connection: 'Apex', maxDrawdownLimit: 2500, startBalance: 50000,
  },
  'LUC-1002': {
    accountName: 'LUC-1002', alias: 'Funded 02', accountType: 'Funded', status: 'Active',
    connection: 'Lucid', propFirmPlan: 'Flex', startBalance: 50000,
  },
  'APX-2003': {
    accountName: 'APX-2003', alias: 'Evaluation 03', accountType: 'Evaluation - Standard', status: 'Active',
    connection: 'Apex',
  },
  'CSH-4004': {
    accountName: 'CSH-4004', alias: 'Cash 04', accountType: 'Cash - Straight', status: 'Active',
    connection: 'Live',
  },
  'OLD-9001': {
    accountName: 'OLD-9001', alias: 'Old funded', accountType: 'Funded', status: 'Failed',
    dateFailed: '2026-10-02', connection: 'Apex',
  },
  'IGN-7001': {
    accountName: 'IGN-7001', alias: 'Parked', accountType: 'Inactive / Ignore', status: 'Inactive',
    connection: 'Apex',
  },
  Sim101: {
    accountName: 'Sim101', alias: 'Sim101', accountType: 'Simulation', status: 'Active',
    simulationMode: 'simulation', connection: 'Sim101',
  },
};

function strat(accountName, family, version, instrument, { enabled = true, realized = 0 } = {}) {
  return {
    accountName,
    strategyName: `0 - ${family}-${version}`,
    strategyFamily: family,
    strategyVersion: version,
    instrument,
    enabled,
    realized,
  };
}

function fills(accountName, family, version, instrument, count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${accountName}-${family}-${index}`,
    accountName,
    strategyName: `0 - ${family}-${version}`,
    instrument,
    action: index % 2 ? 'Sell' : 'Buy',
    quantity: 1,
    price: 100,
  }));
}

/**
 * Per close: [realized, balance, trailing, strategies, fills] per account.
 * Strategy figures are what the grid reported for each algorithm row.
 */
const DAYS = {
  [PRIOR]: {
    'APX-1001': [0, 50000, 400, [['NSTAR', '2.1', 'MNQ DEC26', 0], ['BRKOUT', '1.4', 'MES DEC26', 0]], []],
    'LUC-1002': [0, 50000, 1900, [['NSTAR', '2.1', 'MNQ DEC26', 0]], []],
    'CSH-4004': [0, 25000, 0, [['BRKOUT', '1.4', 'MES DEC26', 0]], []],
    'APX-2003': [0, 50000, 1500, [['MEANREV', '3.0', 'M2K DEC26', 0]], []],
  },
  '2026-10-13': {
    'APX-1001': [300, 50300, 400, [['NSTAR', '2.1', 'MNQ DEC26', 200], ['BRKOUT', '1.4', 'MES DEC26', 100]], [['NSTAR', 2], ['BRKOUT', 2]]],
    'LUC-1002': [150, 50150, 1900, [['NSTAR', '2.1', 'MNQ DEC26', 150]], [['NSTAR', 2]]],
    'CSH-4004': [-50, 24950, 0, [['BRKOUT', '1.4', 'MES DEC26', -50]], [['BRKOUT', 2]]],
    'APX-2003': [120, 50120, 1500, [['MEANREV', '3.0', 'M2K DEC26', 120]], [['MEANREV', 2]]],
  },
  '2026-10-14': {
    // -250 + 60 = -190 against an account day of -200: the figures do not add
    // up, so this account day is NOT SPLIT.
    'APX-1001': [-200, 50100, 600, [['NSTAR', '2.1', 'MNQ DEC26', -250], ['BRKOUT', '1.4', 'MES DEC26', 60]], [['NSTAR', 2], ['BRKOUT', 2]]],
    'LUC-1002': [100, 50250, 1900, [['NSTAR', '2.1', 'MNQ DEC26', 100]], [['NSTAR', 2]]],
    // Loaded, switched on, no fills and nothing realized.
    'CSH-4004': [0, 24950, 0, [['BRKOUT', '1.4', 'MES DEC26', 0]], []],
    'APX-2003': [-80, 50040, 1500, [['MEANREV', '3.0', 'M2K DEC26', -80]], [['MEANREV', 2]]],
  },
  '2026-10-15': {
    'APX-1001': [500, 50600, 600, [['NSTAR', '2.1', 'MNQ DEC26', 500], ['BRKOUT', '1.4', 'MES DEC26', 0]], [['NSTAR', 4]]],
    'LUC-1002': [-300, 49950, 1800, [['NSTAR', '2.1', 'MNQ DEC26', -300]], [['NSTAR', 2]]],
    'CSH-4004': [80, 25030, 0, [['BRKOUT', '1.4', 'MES DEC26', 80]], [['BRKOUT', 2]]],
    'APX-2003': [60, 50100, 1500, [['MEANREV', '3.0', 'M2K DEC26', 60]], [['MEANREV', 2]]],
  },
  '2026-10-16': {
    'APX-1001': [100, 50700, 600, [['NSTAR', '2.1', 'MNQ DEC26', 100], ['BRKOUT', '1.4', 'MES DEC26', 0]], [['NSTAR', 2]]],
    'LUC-1002': [50, 50000, 1800, [['NSTAR', '2.1', 'MNQ DEC26', 50]], [['NSTAR', 2]]],
    'CSH-4004': [20, 25050, 0, [['BRKOUT', '1.4', 'MES DEC26', 20]], [['BRKOUT', 2]]],
    'APX-2003': [0, 50100, 1500, [['MEANREV', '3.0', 'M2K DEC26', 0]], []],
  },
};

const VERSIONS = { NSTAR: '2.1', BRKOUT: '1.4', MEANREV: '3.0' };
const INSTRUMENTS = { NSTAR: 'MNQ DEC26', BRKOUT: 'MES DEC26', MEANREV: 'M2K DEC26' };

/**
 * The client. Options reproduce the states a login can hand over:
 *
 *   unloaded      dates whose account rows were never fetched (snapshots: [],
 *                 snapshotsLoaded: false), the way a login holds older closes
 *   noFills       dates whose orders and executions were never fetched
 *   withoutPrior  no close before the window at all
 *   failsOn       a fifth funded account, Failed on this date
 *   undetermined  an account in the close's undetermined bucket
 */
export function periodClient({
  unloaded = [],
  noFills = [],
  withoutPrior = false,
  failsOn = '',
  undetermined = false,
} = {}) {
  const registry = { ...REGISTRY };
  if (failsOn) {
    registry['APX-1005'] = {
      accountName: 'APX-1005', alias: 'Funded 05', accountType: 'Funded', status: 'Failed',
      dateFailed: failsOn, connection: 'Apex',
    };
  }
  const dates = withoutPrior ? CLOSES : [PRIOR, ...CLOSES];
  const dailyImports = dates.map((date) => {
    const rowsMissing = unloaded.includes(date);
    const fillsMissing = rowsMissing || noFills.includes(date);
    const snapshots = [];
    const strategies = [];
    const executions = [];
    for (const [accountName, [realized, balance, trailing, rows, filled]] of Object.entries(DAYS[date])) {
      const accountStrategies = rows.map(([family, version, instrument, figure]) => (
        strat(accountName, family, version, instrument, { realized: figure })
      ));
      strategies.push(...accountStrategies);
      for (const [family, count] of filled) {
        executions.push(...fills(accountName, family, VERSIONS[family], INSTRUMENTS[family], count));
      }
      snapshots.push({
        id: `${date}-${accountName}`,
        accountName,
        grossRealizedPnl: realized,
        accountBalance: balance,
        trailingMaxDrawdown: trailing,
        weeklyPnl: 0,
        unrealizedPnl: 0,
        meta: registry[accountName],
        strategies: accountStrategies,
      });
    }
    // Accounts the report must leave out, on every close, with money that
    // would show if they leaked into a figure.
    snapshots.push({
      id: `${date}-OLD-9001`, accountName: 'OLD-9001', grossRealizedPnl: -999, accountBalance: 40000,
      trailingMaxDrawdown: -100, weeklyPnl: 0, unrealizedPnl: 0, meta: registry['OLD-9001'],
      strategies: [strat('OLD-9001', 'GHOST', '9.9', 'NQ DEC26', { realized: -999 })],
    });
    snapshots.push({
      id: `${date}-IGN-7001`, accountName: 'IGN-7001', grossRealizedPnl: 5000, accountBalance: 90000,
      trailingMaxDrawdown: 0, weeklyPnl: 0, unrealizedPnl: 0, meta: registry['IGN-7001'],
      strategies: [strat('IGN-7001', 'GHOST', '9.9', 'NQ DEC26', { realized: 5000 })],
    });
    if (failsOn && date <= failsOn) {
      snapshots.push({
        id: `${date}-APX-1005`, accountName: 'APX-1005', grossRealizedPnl: -400, accountBalance: date === failsOn ? 47000 : 48000,
        trailingMaxDrawdown: 300, weeklyPnl: 0, unrealizedPnl: 0, meta: registry['APX-1005'],
        strategies: [strat('APX-1005', 'NSTAR', '2.1', 'MNQ DEC26', { realized: -400 })],
      });
    }
    const simulation = {
      snapshots: [{
        id: `${date}-Sim101`, accountName: 'Sim101', grossRealizedPnl: 777,
        accountBalance: 100000 + 777 * (dates.indexOf(date) + 1),
        trailingMaxDrawdown: 0, weeklyPnl: 0, unrealizedPnl: 0, meta: registry.Sim101,
        strategies: [strat('Sim101', 'NSTAR', '2.1', 'MNQ DEC26', { realized: 777 })],
      }],
      strategies: [strat('Sim101', 'NSTAR', '2.1', 'MNQ DEC26', { realized: 777 })],
      orders: [],
      executions: fills('Sim101', 'NSTAR', '2.1', 'MNQ DEC26', 6),
      undetermined: {
        snapshots: undetermined ? [{
          id: `${date}-PRACTICE`, accountName: 'Practice 1', grossRealizedPnl: 333, accountBalance: 10000,
          trailingMaxDrawdown: 0, weeklyPnl: 0, unrealizedPnl: 0, meta: {}, strategies: [],
        }] : [],
        strategies: [],
        orders: [],
        executions: [],
      },
    };
    return {
      id: `jordan-${date}`,
      uuid: `uuid-jordan-${date}`,
      clientId: 'jordan',
      date,
      status: 'Closed',
      accounts: registry,
      snapshots: rowsMissing ? [] : snapshots,
      strategies: rowsMissing ? [] : strategies,
      orders: [],
      executions: fillsMissing ? [] : executions,
      simulation: rowsMissing
        ? { snapshots: [], strategies: [], orders: [], executions: [], undetermined: { snapshots: [] } }
        : simulation,
      flags: [{
        id: `${date}-flag`, type: 'Strategy disabled', severity: 'Warning', status: 'Open',
        accountName: 'APX-1001', message: 'Internal desk flag that must never reach the client report',
      }],
      snapshotsLoaded: !rowsMissing,
      detailLoaded: !fillsMissing,
    };
  });
  return {
    id: 'jordan',
    uuid: 'uuid-jordan',
    name: 'Jordan Ellis',
    status: 'Active',
    accountRegistry: registry,
    dailyImports,
  };
}

export const AS_OF = '2026-10-19';
export const BUILT_AT = '2026-10-19T13:40:00Z';
