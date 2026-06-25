const STORAGE_KEY = 'cam_crm_demo_state_v1';
const DEMO_STATE_VERSION = 13;

function createId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function isoDateOffset(daysBack) {
  const date = new Date();
  date.setDate(date.getDate() - daysBack);
  return date.toISOString().slice(0, 10);
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function demoStrategy({ slot = 2, family = 'RBO_PF', version = '1.8', realized = 0, enabled = true, stop = 105, targets = [155, 175, 250], sizes = [2, 2, 2], direction = 'Both', instrument = 'M2K JUN26' }) {
  const displayFamily = family.replace('_', '-');
  return {
    strategyName: `${slot} - ${displayFamily}-${version}`,
    strategyFamily: family,
    strategyVersion: version,
    instrument,
    enabled,
    realized,
    unrealized: 0,
    direction,
    params: {
      parsed: true,
      direction,
      posSizes: sizes,
      profitTargets: targets,
      stopLossTicks: stop,
    },
  };
}

function demoBullet({ slot = 0, direction = 'Long', realized = 0, enabled = true }) {
  return demoStrategy({
    slot,
    family: 'Bullet Bot',
    version: '1.1',
    realized,
    enabled,
    direction,
    sizes: [direction === 'Long' ? 4 : 1],
    targets: [155],
    stop: 125,
    instrument: 'NQ JUN26',
  });
}

function demoSnapshot({ accountName, connection, grossRealizedPnl, weeklyPnl, balance, drawdown, strategies = [] }) {
  return {
    accountName,
    connection,
    grossRealizedPnl,
    trailingMaxDrawdown: drawdown,
    accountBalance: balance,
    weeklyPnl,
    unrealizedPnl: 0,
    strategies,
  };
}

function demoExecution({ accountName, strategyName, base = 2950, down = false }) {
  return [
    { accountName, strategyName, time: '9:35 AM', price: base, action: 'Buy', entryExit: 'Entry', quantity: 2, orderId: `${accountName}-E1` },
    { accountName, strategyName, time: '10:22 AM', price: down ? base - 8 : base + 11, action: 'Sell', entryExit: 'Exit', quantity: 2, orderId: `${accountName}-X1` },
  ];
}

function demoFlag(type, severity, accountName, message) {
  return {
    id: `demo-${type}-${accountName}`,
    type,
    severity,
    accountName,
    message,
    status: 'Open',
  };
}

function buildHistoricalImports({ id, registry, snapshots, executions, flags }) {
  return [6, 5, 4, 3, 2, 1, 0].map((daysBack, index) => {
    const date = isoDateOffset(daysBack);
    const isLatest = daysBack === 0;
    const multiplier = 0.62 + (index * 0.08);
    const dailyShift = index % 2 === 0 ? 35 : -45;
    const historicalSnapshots = isLatest ? snapshots : snapshots.map((snapshot) => {
      const strategies = (snapshot.strategies || []).map((strategy) => ({
        ...deepClone(strategy),
        realized: Math.round((Number(strategy.realized || 0) * multiplier) + dailyShift),
      }));
      const strategyTotal = strategies.reduce((total, strategy) => total + Number(strategy.realized || 0), 0);
      const grossRealizedPnl = strategies.length ? strategyTotal : Math.round((Number(snapshot.grossRealizedPnl || 0) * multiplier) + dailyShift);
      // Simulate slowly declining drawdown buffer for funded accounts (creates drawdown velocity signal)
      const baseDrawdown = Number(snapshot.trailingMaxDrawdown || 0);
      const drawdownTrend = baseDrawdown > 0 ? Math.round(baseDrawdown + (daysBack * 95)) : baseDrawdown;
      return {
        ...deepClone(snapshot),
        grossRealizedPnl,
        weeklyPnl: Math.round((Number(snapshot.weeklyPnl || 0) * multiplier) + (dailyShift * (index + 1))),
        accountBalance: Math.round(Number(snapshot.accountBalance || 0) + grossRealizedPnl),
        trailingMaxDrawdown: drawdownTrend,
        strategies,
      };
    });

    return {
      id: `${id}-${date}`,
      clientId: id,
      date,
      importedAt: `${date}T22:00:00.000Z`,
      status: isLatest && flags.length ? 'Needs review' : 'Closed',
      accounts: registry,
      snapshots: historicalSnapshots,
      strategies: historicalSnapshots.flatMap((snapshot) => snapshot.strategies || []),
      orders: [],
      executions: isLatest ? executions : executions.map((execution) => ({
        ...deepClone(execution),
        price: Number(execution.price || 0) + (index * 3) - 8,
      })),
      flags: isLatest ? flags : [],
    };
  });
}

function demoActivityEntry(type, text, daysBack = 0, accountName = '') {
  const date = new Date();
  date.setDate(date.getDate() - daysBack);
  return {
    id: `act-${type}-${daysBack}-${accountName || 'general'}`,
    type,
    text,
    accountName,
    createdAt: date.toISOString(),
  };
}

function demoClient({ id, name, registry, snapshots, executions, flags, activityLog = [], tasks = [] }) {
  return {
    id,
    name,
    status: 'Active',
    accountRegistry: registry,
    dailyImports: buildHistoricalImports({ id, registry, snapshots, executions, flags }),
    credentials: {
      ip: '',
      username: '',
      password: '',
      ntLogin: '',
      firmLogin: '',
      firmPassword: '',
    },
    profile: {
      fullName: name + ' (demo)',
      email: name.toLowerCase().replace(/\s+/g, '.') + '@vinceretrading.com',
      phone: '+1 (312) 555-0100',
      timezone: 'America/Chicago',
      propFirm: 'Apex Trader Funding',
      messenger: '@' + name.toLowerCase().replace(/\s+/g, '_') + '_trading',
    },
    priceChecks: [],
    notes: `${name} demo account set for manager review.`,
    activityLog,
    tasks,
  };
}

export function createDemoState() {
  const rbo = demoStrategy({ family: 'RBO_PF', realized: 180 });
  const rboWeak = demoStrategy({ family: 'RBO_PF', realized: -430 });
  const ifsp = demoStrategy({ family: 'IFSP', version: '1.1', realized: -330, stop: 100, targets: [125, 150, 200], sizes: [3, 3, 2], instrument: 'GC AUG26' });
  const ogx = demoStrategy({ family: 'OGX_PF', version: '2.4', realized: 220, stop: 90, targets: [100, 125, 175], sizes: [2, 2, 1], instrument: 'MNQ JUN26' });
  const b2x = demoStrategy({ family: 'B2X', version: '1.3', realized: 310, stop: 95, targets: [110, 135, 190], sizes: [2, 2, 2], instrument: 'MGC AUG26' });
  const urgo = demoStrategy({ family: 'URGO', version: '2.0', realized: -70, stop: 80, targets: [95, 120, 160], sizes: [1, 1, 1], instrument: 'MES JUN26' });
  const bulletLong = demoBullet({ direction: 'Long', realized: 0 });
  const bulletShort = demoBullet({ slot: 1, direction: 'Short', realized: -1200 });

  const clients = [
    demoClient({
      id: 'client-rome',
      name: 'Rome',
      registry: {
        ROME5298: { accountName: 'ROME5298', alias: 'Live - 5298', connection: 'Live', accountType: 'Cash', status: 'Active', payoutState: 'Not requested', notes: 'Cash account: daily, weekly, balance only.', dateAdded: '2026-01-15' },
        ROME7045: { accountName: 'ROME7045', alias: 'BlueSky - 7045', connection: 'BlueSky', accountType: 'Funded', status: 'Active', payoutState: 'Not requested', targetProfit: 52000, startBalance: 50000, maxDrawdownLimit: 2500, dateAdded: '2026-02-10', dateFunded: '2026-02-24', payoutCount: 2, dateLastPayout: '2026-05-12', payoutHistory: [{ date: '2026-03-28', amount: 1800, note: 'First payout' }, { date: '2026-05-12', amount: 2100, note: 'Second payout' }] },
        ROME8801: { accountName: 'ROME8801', alias: 'Lucid - 8801', connection: 'Lucid', accountType: 'Evaluation - Standard', status: 'Active', payoutState: 'Not requested', targetProfit: 53000, startBalance: 50000, maxDrawdownLimit: 2000, dateAdded: '2026-05-20' },
        ROME9002: { accountName: 'ROME9002', alias: 'Tradovate - 9002', connection: 'Tradovate', accountType: 'Funded', status: 'Active', payoutState: 'Not requested', targetProfit: 52500, startBalance: 50000, maxDrawdownLimit: 4000, dateAdded: '2026-04-01', dateFunded: '2026-04-15' },
      },
      snapshots: [
        demoSnapshot({ accountName: 'ROME5298', connection: 'Live', grossRealizedPnl: 640, weeklyPnl: 1820, balance: 28450, drawdown: 0, strategies: [ogx] }),
        demoSnapshot({ accountName: 'ROME7045', connection: 'BlueSky', grossRealizedPnl: 180, weeklyPnl: 320, balance: 50500, drawdown: -1200, strategies: [rbo] }),
        demoSnapshot({ accountName: 'ROME8801', connection: 'Lucid', grossRealizedPnl: -330, weeklyPnl: -577, balance: 49670, drawdown: -1600, strategies: [ifsp] }),
        demoSnapshot({ accountName: 'ROME9002', connection: 'Tradovate', grossRealizedPnl: 0, weeklyPnl: 860, balance: 51840, drawdown: -650, strategies: [demoStrategy({ family: 'OGX_PF', version: '2.4', realized: 220, enabled: true, instrument: 'MNQ JUN26' })] }),
      ],
      executions: [
        ...demoExecution({ accountName: 'ROME5298', strategyName: ogx.strategyName, base: 19020 }),
        ...demoExecution({ accountName: 'ROME7045', strategyName: rbo.strategyName, base: 2950 }),
        ...demoExecution({ accountName: 'ROME8801', strategyName: ifsp.strategyName, base: 3350, down: true }),
      ],
      flags: [
        demoFlag('Drawdown near limit', 'Critical', 'ROME8801', 'Lucid - 8801 is $400 from its $2,000 max drawdown limit. Calculation: max_dd_limit - abs(trailing_drawdown) = 2000 - 1600 = 400. Immediate action required.'),
        demoFlag('Strategy underperforming peers', 'Warning', 'ROME8801', 'Lucid - 8801 is below peer average for IFSP 1.1. Calculation: daily realized is compared against same-family instances and flagged when below mean minus 1.5 standard deviations.'),
      ],
      activityLog: [
        demoActivityEntry('Call', 'Called client. Reviewed IFSP underperformance on Lucid-8801. Client wants to leave strategy running through end of week before switching. Agreed to monitor daily.', 0, 'ROME8801'),
        demoActivityEntry('Note', 'Tradovate-9002 showing $0 P&L despite OGX_PF enabled. Checked VPS — connection dropped around 9:15am. Strategy was flat all day. VPS rebooted and confirmed reconnected.', 1, 'ROME9002'),
        demoActivityEntry('Payout', 'BlueSky-7045 second payout approved: $2,500. Client confirmed receipt. Account cleared to trade.', 10, 'ROME7045'),
        demoActivityEntry('Call', 'Onboarding call. Explained evaluation rules, drawdown limits, and daily reporting schedule. Client prefers evening updates via WhatsApp.', 74, ''),
      ],
      tasks: [
        { id: 'task-rome-1', text: 'Request payout for BlueSky-7045 — second payout cycle approved, submit to firm portal by end of week.', dueDate: '2026-06-26', priority: 'High', accountName: 'ROME7045', done: false, createdAt: new Date(Date.now() - 86400000).toISOString() },
        { id: 'task-rome-2', text: 'Verify Tradovate-9002 strategy reconnected and running after VPS reboot. Confirm no missed sessions.', dueDate: '', priority: 'Normal', accountName: 'ROME9002', done: false, createdAt: new Date(Date.now() - 2 * 86400000).toISOString() },
        { id: 'task-rome-3', text: 'Onboarding complete — review IFSP performance with client next Monday after full week of data.', dueDate: '2026-06-29', priority: 'Low', accountName: '', done: false, createdAt: new Date(Date.now() - 3 * 86400000).toISOString() },
      ],
    }),
    demoClient({
      id: 'client-todd',
      name: 'Todd',
      registry: {
        TODD5505: { accountName: 'TODD5505', alias: 'BlueSky - 5505', connection: 'BlueSky', accountType: 'Funded', status: 'Payout Hold', payoutState: 'Payout requested', targetProfit: 52000, startBalance: 50000, maxDrawdownLimit: 2500, dateAdded: '2026-03-05', dateFunded: '2026-03-18', payoutCount: 1, dateLastPayout: '2026-04-20', payoutHistory: [{ date: '2026-04-20', amount: 1600, note: 'First payout' }] },
        TODD7712: { accountName: 'TODD7712', alias: 'Apex - 7712', connection: 'Apex', accountType: 'Evaluation - Bullet Bot', status: 'Active', payoutState: 'Not requested', bulletBotPassType: '1 Day Pass', bulletBotDirection: 'Long', maxDrawdownLimit: 1000, dateAdded: '2026-06-20' },
        TODD7713: { accountName: 'TODD7713', alias: 'Apex - 7713', connection: 'Apex', accountType: 'Evaluation - Bullet Bot', status: 'Failed', payoutState: 'Not requested', bulletBotPassType: '3 Day Pass', bulletBotDirection: 'Short', maxDrawdownLimit: 1500, dateAdded: '2026-06-15', dateFailed: '2026-06-24' },
      },
      snapshots: [
        demoSnapshot({ accountName: 'TODD5505', connection: 'BlueSky', grossRealizedPnl: -430, weeklyPnl: -341, balance: 51980, drawdown: -2200, strategies: [rboWeak] }),
        demoSnapshot({ accountName: 'TODD7712', connection: 'Apex', grossRealizedPnl: 0, weeklyPnl: 0, balance: 50000, drawdown: -500, strategies: [bulletLong] }),
        demoSnapshot({ accountName: 'TODD7713', connection: 'Apex', grossRealizedPnl: -1200, weeklyPnl: -1200, balance: 48800, drawdown: -3000, strategies: [bulletShort] }),
      ],
      executions: [
        ...demoExecution({ accountName: 'TODD5505', strategyName: rboWeak.strategyName, base: 2948, down: true }),
        ...demoExecution({ accountName: 'TODD7712', strategyName: bulletLong.strategyName, base: 19000 }),
        ...demoExecution({ accountName: 'TODD7713', strategyName: bulletShort.strategyName, base: 18980, down: true }),
      ],
      flags: [
        demoFlag('Drawdown near limit', 'Critical', 'TODD5505', 'BlueSky - 5505 is $300 from its $2,500 max drawdown limit. Calculation: max_dd_limit - abs(trailing_drawdown) = 2500 - 2200 = 300. Immediate action required.'),
        demoFlag('Payout hold violation', 'Critical', 'TODD5505', 'BlueSky - 5505 is in payout hold but still has an enabled strategy. Calculation: status = Payout Hold and active strategy count > 0.'),
        demoFlag('Bullet Bot failed', 'Critical', 'TODD7713', 'Apex - 7713 hit failed status after Bullet Bot loss. Calculation: account status manually set to Failed and daily PnL is negative.'),
      ],
      activityLog: [
        demoActivityEntry('Alert', 'CRITICAL: BlueSky-5505 drawdown at $300 remaining. Disabled RBO_PF strategy immediately. Client notified via WhatsApp. Waiting for payout approval before re-enabling.', 0, 'TODD5505'),
        demoActivityEntry('Payout', 'BlueSky-5505 payout requested: $1,980. Submitted to prop firm portal. Account moved to Payout Hold status. Strategy disabled.', 4, 'TODD5505'),
        demoActivityEntry('Note', 'Apex-7713 (Bullet Bot Short) hit max loss on gap up open. Account marked Failed. Will open new eval next cycle.', 9, 'TODD7713'),
        demoActivityEntry('Call', 'Weekly review call with client. Discussed Bullet Bot performance — Long side profitable, Short side underperforming. Client approved switching Short to reserve after this eval.', 14, ''),
      ],
      tasks: [
        { id: 'task-todd-1', text: 'Monitor BlueSky-5505 drawdown — only $300 remaining. If no payout approval by Friday, call prop firm directly.', dueDate: '2026-06-26', priority: 'High', accountName: 'TODD5505', done: false, createdAt: new Date(Date.now() - 86400000).toISOString() },
        { id: 'task-todd-2', text: 'Process BlueSky-5505 payout request — confirm submission to prop firm portal, track approval status.', dueDate: '2026-06-25', priority: 'High', accountName: 'TODD5505', done: false, createdAt: new Date(Date.now() - 2 * 86400000).toISOString() },
        { id: 'task-todd-3', text: 'Open new Apex evaluation (Short side) for next Bullet Bot cycle after Apex-7713 failed.', dueDate: '2026-07-01', priority: 'Normal', accountName: '', done: false, createdAt: new Date(Date.now() - 3 * 86400000).toISOString() },
        { id: 'task-todd-4', text: 'Review Apex-7712 Long side Bullet Bot results after eval passes — determine if strategy performance justifies full funding.', dueDate: '', priority: 'Low', accountName: 'TODD7712', done: true, createdAt: new Date(Date.now() - 14 * 86400000).toISOString() },
      ],
    }),
    demoClient({
      id: 'client-amanda',
      name: 'Amanda Capital',
      registry: {
        AMAN1024: { accountName: 'AMAN1024', alias: 'MFF - 1024', connection: 'My Funded Futures', accountType: 'Funded', status: 'Active', payoutState: 'Clear to trade', targetProfit: 102000, startBalance: 100000, maxDrawdownLimit: 4000, dateAdded: '2026-01-08', dateFunded: '2026-01-22', payoutCount: 3, dateLastPayout: '2026-06-01', payoutHistory: [{ date: '2026-03-10', amount: 2500, note: 'First payout' }, { date: '2026-04-22', amount: 3200, note: 'Second payout' }, { date: '2026-06-01', amount: 2800, note: 'Third payout' }] },
        AMAN2048: { accountName: 'AMAN2048', alias: 'Lucid - 2048', connection: 'Lucid', accountType: 'Evaluation - Standard', status: 'Reserve', payoutState: 'Not requested', maxDrawdownLimit: 2000, dateAdded: '2026-06-01' },
        AMAN9090: { accountName: 'AMAN9090', alias: 'Tradeify - 9090', connection: 'Tradeify', accountType: 'Unassigned', status: 'Active', payoutState: 'Not requested', dateAdded: '2026-06-22' },
      },
      snapshots: [
        demoSnapshot({ accountName: 'AMAN1024', connection: 'My Funded Futures', grossRealizedPnl: 220, weeklyPnl: 980, balance: 100850, drawdown: -3100, strategies: [ogx] }),
        demoSnapshot({ accountName: 'AMAN2048', connection: 'Lucid', grossRealizedPnl: 0, weeklyPnl: 0, balance: 50000, drawdown: -400, strategies: [] }),
        demoSnapshot({ accountName: 'AMAN9090', connection: 'Tradeify', grossRealizedPnl: 0, weeklyPnl: 0, balance: 50000, drawdown: 0, strategies: [] }),
      ],
      executions: demoExecution({ accountName: 'AMAN1024', strategyName: ogx.strategyName, base: 19030 }),
      flags: [
        demoFlag('Unassigned account', 'Warning', 'AMAN9090', 'Tradeify - 9090 needs account type classification. Calculation: accountType = Unassigned after import.'),
        demoFlag('Expected strategy missing', 'Critical', 'AMAN2048', 'Lucid - 2048 is reserved and has no enabled strategy. Calculation: status reserve excludes expectation, so this is a demo review item for account rotation.'),
      ],
    }),
    demoClient({
      id: 'client-blanco',
      name: 'Blanco Family',
      registry: {
        BLAN3301: { accountName: 'BLAN3301', alias: 'Legends - 3301', connection: 'The Legends Trading', accountType: 'Funded', status: 'Active', payoutState: 'Not requested', targetProfit: 153000, startBalance: 150000, maxDrawdownLimit: 6000, dateAdded: '2026-01-05', dateFunded: '2026-01-20', payoutCount: 4, dateLastPayout: '2026-05-28', payoutHistory: [{ date: '2026-02-15', amount: 3000, note: 'First payout' }, { date: '2026-03-22', amount: 3500, note: 'Second payout' }, { date: '2026-04-30', amount: 4000, note: 'Third payout' }, { date: '2026-05-28', amount: 4200, note: 'Fourth payout' }] },
        BLAN3302: { accountName: 'BLAN3302', alias: 'Legends - 3302', connection: 'The Legends Trading', accountType: 'Evaluation - Standard', status: 'Active', payoutState: 'Not requested', targetProfit: 103000, startBalance: 100000, maxDrawdownLimit: 3000, dateAdded: '2026-05-10' },
      },
      snapshots: [
        demoSnapshot({ accountName: 'BLAN3301', connection: 'The Legends Trading', grossRealizedPnl: 140, weeklyPnl: 410, balance: 150620, drawdown: -4400, strategies: [rbo] }),
        demoSnapshot({ accountName: 'BLAN3302', connection: 'The Legends Trading', grossRealizedPnl: -90, weeklyPnl: 210, balance: 99910, drawdown: -1900, strategies: [ifsp] }),
      ],
      executions: [
        ...demoExecution({ accountName: 'BLAN3301', strategyName: rbo.strategyName, base: 2954 }),
        ...demoExecution({ accountName: 'BLAN3302', strategyName: ifsp.strategyName, base: 3354, down: true }),
      ],
      flags: [
        demoFlag('Drawdown approaching limit', 'Warning', 'BLAN3302', 'Legends - 3302 has $1,100 remaining before its $3,000 max drawdown limit. Calculation: max_dd_limit - abs(trailing_drawdown) = 3000 - 1900 = 1100.'),
      ],
    }),
    demoClient({
      id: 'client-ed',
      name: 'Ed - Vincere Trading',
      registry: {
        ED6100: { accountName: 'ED6100', alias: 'Cash - 6100', connection: 'Live', accountType: 'Cash', status: 'Active', payoutState: 'Not requested', dateAdded: '2026-02-01' },
        ED6200: { accountName: 'ED6200', alias: 'BlueSky - 6200', connection: 'BlueSky', accountType: 'Funded', status: 'Inactive', payoutState: 'Not requested', maxDrawdownLimit: 2500, dateAdded: '2026-03-15', dateFunded: '2026-04-02', dateFailed: '2026-06-10' },
      },
      snapshots: [
        demoSnapshot({ accountName: 'ED6100', connection: 'Live', grossRealizedPnl: 720, weeklyPnl: 2140, balance: 41200, drawdown: 0, strategies: [ogx] }),
        demoSnapshot({ accountName: 'ED6200', connection: 'BlueSky', grossRealizedPnl: 0, weeklyPnl: -120, balance: 50000, drawdown: -800, strategies: [rbo] }),
      ],
      executions: [
        ...demoExecution({ accountName: 'ED6100', strategyName: ogx.strategyName, base: 19040 }),
        ...demoExecution({ accountName: 'ED6200', strategyName: rbo.strategyName, base: 2958 }),
      ],
      flags: [
        demoFlag('Unexpected strategy active', 'Critical', 'ED6200', 'BlueSky - 6200 is inactive but has an enabled strategy. Calculation: status in Inactive/Reserve/Failed and active strategy count > 0.'),
      ],
    }),
    demoClient({
      id: 'client-sarah-training',
      name: 'Sarah Training Pool',
      registry: {
        SARH4101: { accountName: 'SARH4101', alias: 'Apex - 4101', connection: 'Apex', accountType: 'Evaluation - Standard', status: 'Active', payoutState: 'Not requested', targetProfit: 53000, startBalance: 50000, maxDrawdownLimit: 2000, dateAdded: '2026-06-10' },
        SARH4102: { accountName: 'SARH4102', alias: 'Lucid - 4102', connection: 'Lucid', accountType: 'Funded', status: 'Active', payoutState: 'Clear to trade', targetProfit: 52000, startBalance: 50000, maxDrawdownLimit: 2500, dateAdded: '2026-04-20', dateFunded: '2026-05-05', payoutCount: 1, dateLastPayout: '2026-06-05', payoutHistory: [{ date: '2026-06-05', amount: 1500, note: 'First payout' }] },
        SARH4103: { accountName: 'SARH4103', alias: 'BlueSky - 4103', connection: 'BlueSky', accountType: 'Evaluation - Bullet Bot', status: 'Reserve', payoutState: 'Not requested', bulletBotPassType: '2 Day Pass', bulletBotDirection: '', maxDrawdownLimit: 1200, dateAdded: '2026-06-18' },
      },
      snapshots: [
        demoSnapshot({ accountName: 'SARH4101', connection: 'Apex', grossRealizedPnl: 310, weeklyPnl: 760, balance: 50310, drawdown: -870, strategies: [b2x] }),
        demoSnapshot({ accountName: 'SARH4102', connection: 'Lucid', grossRealizedPnl: -70, weeklyPnl: -140, balance: 49930, drawdown: -1200, strategies: [urgo] }),
        demoSnapshot({ accountName: 'SARH4103', connection: 'BlueSky', grossRealizedPnl: 0, weeklyPnl: 0, balance: 50000, drawdown: -300, strategies: [] }),
      ],
      executions: [
        ...demoExecution({ accountName: 'SARH4101', strategyName: b2x.strategyName, base: 3210 }),
        ...demoExecution({ accountName: 'SARH4102', strategyName: urgo.strategyName, base: 6120, down: true }),
      ],
      flags: [
        demoFlag('Rotation reserve', 'Warning', 'SARH4103', 'BlueSky - 4103 is reserved for Bullet Bot rotation and should stay flat until assigned. Calculation: account status = Reserve and enabled strategy count = 0.'),
      ],
    }),
  ];

  return {
    demoVersion: DEMO_STATE_VERSION,
    accountManager: {
      id: 'am-pedro',
      name: 'Pedro',
    },
    camProfiles: [
      { id: 'am-pedro', name: 'Pedro', role: 'Senior CAM', status: 'Active', live: true, clientIds: ['client-rome', 'client-todd', 'client-blanco'] },
      { id: 'am-amanda', name: 'Amanda', role: 'CAM', status: 'Active', live: true, clientIds: ['client-amanda'] },
      { id: 'am-juan', name: 'Juan Pablo', role: 'CAM', status: 'Active', live: true, clientIds: ['client-blanco'] },
      { id: 'am-ed', name: 'Ed', role: 'CAM', status: 'Active', live: true, clientIds: ['client-ed'] },
      { id: 'am-sarah', name: 'Sarah', role: 'Junior CAM', status: 'Training', live: true, clientIds: ['client-sarah-training'] },
    ],
    clients,
    selectedClientId: 'client-rome',
  };
}

export function createInitialState() {
  return createDemoState();
}

export function addClient(state, name, camId = state.accountManager?.id) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return state;

  const client = {
    id: createId('client'),
    name: trimmed,
    status: 'Active',
    accountRegistry: {},
    dailyImports: [],
    activityLog: [],
    tasks: [],
    profile: {},
    credentials: {
      ip: '',
      username: '',
      password: '',
      notes: '',
    },
    priceChecks: [],
    notes: '',
  };

  return {
    ...state,
    clients: [...state.clients, client],
    camProfiles: (state.camProfiles || []).map((profile) => (
      profile.id === camId
        ? { ...profile, clientIds: [...new Set([...(profile.clientIds || []), client.id])], live: true }
        : profile
    )),
    selectedClientId: client.id,
  };
}

export function removeClient(state, clientId) {
  const remaining = (state.clients || []).filter(c => c.id !== clientId);
  const newSelectedId = remaining[0]?.id || null;
  return {
    ...state,
    clients: remaining,
    camProfiles: (state.camProfiles || []).map(p => ({
      ...p,
      clientIds: (p.clientIds || []).filter(id => id !== clientId),
    })),
    selectedClientId: state.selectedClientId === clientId ? newSelectedId : state.selectedClientId,
  };
}

export function transferClient(state, clientId, toCamId) {
  return {
    ...state,
    camProfiles: (state.camProfiles || []).map(p => {
      if (p.id === toCamId) return { ...p, clientIds: [...new Set([...(p.clientIds || []), clientId])] };
      return { ...p, clientIds: (p.clientIds || []).filter(id => id !== clientId) };
    }),
  };
}

export function addCamProfile(state, name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return state;
  const existingProfiles = state.camProfiles || [];
  return {
    ...state,
    camProfiles: [
      ...existingProfiles,
      {
        id: createId('am'),
        name: trimmed,
        role: 'CAM',
        status: 'New',
        live: true,
        clientIds: [],
      },
    ],
  };
}

export function selectCam(state, camId) {
  const profile = (state.camProfiles || []).find((cam) => cam.id === camId);
  const firstClientId = profile?.clientIds?.[0] || null;
  return {
    ...state,
    accountManager: {
      id: profile?.id || camId,
      name: profile?.name || 'CAM',
    },
    selectedClientId: firstClientId,
  };
}

function updateClient(state, clientId, updater) {
  return {
    ...state,
    clients: state.clients.map((client) => (client.id === clientId ? updater(client) : client)),
  };
}

export function selectClient(state, clientId) {
  return {
    ...state,
    selectedClientId: clientId,
  };
}

export function resolveFlagInImport(state, clientId, importId, flagId, status = 'Resolved') {
  return updateClient(state, clientId, (client) => ({
    ...client,
    dailyImports: (client.dailyImports || []).map((di) =>
      di.id === importId
        ? { ...di, flags: di.flags.map((f) => f.id === flagId ? { ...f, status, resolvedAt: new Date().toISOString() } : f) }
        : di
    ),
  }));
}

export function addTask(state, clientId, task) {
  return updateClient(state, clientId, (client) => ({
    ...client,
    tasks: [...(client.tasks || []), task],
  }));
}

export function updateTask(state, clientId, taskId, patch) {
  return updateClient(state, clientId, (client) => ({
    ...client,
    tasks: (client.tasks || []).map((t) => t.id === taskId ? { ...t, ...patch } : t),
  }));
}

export function deleteTask(state, clientId, taskId) {
  return updateClient(state, clientId, (client) => ({
    ...client,
    tasks: (client.tasks || []).filter((t) => t.id !== taskId),
  }));
}

export function addActivityEntry(state, clientId, entry) {
  return updateClient(state, clientId, (client) => ({
    ...client,
    activityLog: [entry, ...(client.activityLog || [])],
  }));
}

export function deleteActivityEntry(state, clientId, entryId) {
  return updateClient(state, clientId, (client) => ({
    ...client,
    activityLog: (client.activityLog || []).filter((e) => e.id !== entryId),
  }));
}

export function removeAccountFromRegistry(state, clientId, accountName) {
  return updateClient(state, clientId, (client) => {
    const registry = client.accountRegistry || {};
    const existingKey = Object.keys(registry).find(k => k.toLowerCase() === accountName.toLowerCase()) || accountName;
    const { [existingKey]: _, ...rest } = registry;
    return { ...client, accountRegistry: rest };
  });
}

export function upsertAccountMeta(state, clientId, accountName, patch) {
  return updateClient(state, clientId, (client) => {
    // Case-insensitive key lookup to prevent duplicate registry entries
    const registry = client.accountRegistry || {};
    const existingKey = Object.keys(registry).find(k => k.toLowerCase() === accountName.toLowerCase()) || accountName;
    const existing = registry[existingKey] || { accountName };
    const newRegistry = { ...registry };
    if (existingKey !== accountName) delete newRegistry[existingKey];
    return {
      ...client,
      accountRegistry: {
        ...newRegistry,
        [accountName]: {
          ...existing,
          ...patch,
          accountName,
        },
      },
    };
  });
}

export function appendDailyImport(state, clientId, importResult) {
  return updateClient(state, clientId, (client) => {
    const existing = client.dailyImports.find(d => d.date === importResult.date);
    const status = existing?.status === 'Closed' ? existing.status : (importResult.status || 'Needs review');
    const merged = { ...importResult, status };
    return {
      ...client,
      accountRegistry: (() => {
        // Merge import accounts into registry with case-insensitive key matching
        // to prevent duplicate entries when NT CSV casing differs from stored registry keys
        const base = { ...client.accountRegistry };
        for (const [importKey, importVal] of Object.entries(importResult.accounts || {})) {
          const existingKey = Object.keys(base).find(k => k.toLowerCase() === importKey.toLowerCase()) || importKey;
          const existingVal = base[existingKey];
          if (existingKey !== importKey) delete base[existingKey];
          // Registry metadata (user-configured: alias, accountType, targets) takes precedence over import
          base[importKey] = { ...importVal, ...existingVal };
        }
        return base;
      })(),
      dailyImports: [
        ...client.dailyImports.filter(d => d.date !== importResult.date),
        merged,
      ].sort((a, b) => String(a.date).localeCompare(String(b.date))),
    };
  });
}

export function updateClientDetails(state, clientId, patch) {
  return updateClient(state, clientId, (client) => ({
    ...client,
    ...patch,
  }));
}

export function updateCamProfile(state, camId, patch) {
  return {
    ...state,
    camProfiles: (state.camProfiles || []).map(p => p.id === camId ? { ...p, ...patch } : p),
  };
}

export function togglePinClient(state, clientId) {
  return updateClient(state, clientId, (client) => ({ ...client, pinned: !client.pinned }));
}

export function updateImportStatus(state, clientId, importId, status) {
  return updateClient(state, clientId, (client) => ({
    ...client,
    dailyImports: client.dailyImports.map((item) => (item.id === importId ? { ...item, status } : item)),
  }));
}

export function replaceDailyImport(state, clientId, importResult) {
  return updateClient(state, clientId, (client) => ({
    ...client,
    accountRegistry: {
      ...client.accountRegistry,
      ...importResult.accounts,
    },
    dailyImports: client.dailyImports.map((item) => (item.id === importResult.id ? importResult : item)),
  }));
}

export function getLatestClientImport(client) {
  if (!client?.dailyImports?.length) return null;
  return [...client.dailyImports].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0];
}

export function getClientImportByDate(client, date) {
  return client?.dailyImports?.find((item) => item.date === date) || null;
}

export function exportFileName() {
  return `cam-backup-${todayIsoDate()}.json`;
}

export function parseImportedState(text) {
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || !Array.isArray(data.clients) || !data.accountManager) {
    throw new Error('File is not a valid CAM backup.');
  }
  // eslint-disable-next-line no-unused-vars
  const { _sopStreak, ...rest } = data;
  return {
    ...rest,
    accountManager: data.accountManager,
    demoVersion: data.demoVersion || 0,
    camProfiles: data.camProfiles || [],
    clients: data.clients,
    selectedClientId: data.selectedClientId || data.clients[0]?.id || null,
  };
}

function isStaleDemoState(state) {
  if (!state || typeof state !== 'object') return true;
  // If state has valid clients and CAM profiles, preserve it regardless of version.
  // Only reset if structurally broken (missing required arrays).
  if (!Array.isArray(state.clients) || !state.clients.length) return true;
  if (!Array.isArray(state.camProfiles) || !state.camProfiles.length) return true;
  if (state.camProfiles.some((profile) => !Array.isArray(profile.clientIds))) return true;
  return false;
}

export function isLikelyDemoData(state) {
  // Heuristic: if all client names match the original demo names, assume demo data
  const DEMO_NAMES = new Set(['Carlos M.', 'Ana P.', 'John D.', 'Maria L.', 'Robert K.', 'Sofia R.', 'James W.']);
  const clients = state?.clients || [];
  return clients.length > 0 && clients.every(c => DEMO_NAMES.has(c.name));
}

export function loadDemoState() {
  if (typeof window === 'undefined') return createInitialState();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return createInitialState();
    const parsed = JSON.parse(raw);
    if (isStaleDemoState(parsed)) return createInitialState();
    // Stamp current version so the check passes on next load
    return { ...parsed, demoVersion: DEMO_STATE_VERSION };
  } catch {
    return createInitialState();
  }
}

export function saveDemoState(state) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    if (e.name === 'QuotaExceededError' || e.code === 22) {
      console.error('[CRM] localStorage quota exceeded — data not saved!', e);
      alert('⚠️ Storage full: your browser\'s local storage is full. Export a backup now (sidebar → Export JSON), then delete old data to free space. Changes since last save may be lost.');
    } else {
      console.error('[CRM] Failed to save state:', e);
    }
  }
}

export function getStorageUsageKB() {
  if (typeof window === 'undefined') return 0;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY) || '';
    return Math.round((raw.length * 2) / 1024);
  } catch { return 0; }
}
