const STORAGE_KEY = 'cam_crm_demo_state_v1';
const DEMO_STATE_VERSION = 6;

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
      return {
        ...deepClone(snapshot),
        grossRealizedPnl,
        weeklyPnl: Math.round((Number(snapshot.weeklyPnl || 0) * multiplier) + (dailyShift * (index + 1))),
        accountBalance: Math.round(Number(snapshot.accountBalance || 0) + grossRealizedPnl),
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

function demoClient({ id, name, registry, snapshots, executions, flags }) {
  return {
    id,
    name,
    status: 'Active',
    accountRegistry: registry,
    dailyImports: buildHistoricalImports({ id, registry, snapshots, executions, flags }),
    credentials: {
      ip: 'VPS demo',
      username: 'demo-user',
      password: '••••••••',
      notes: '',
    },
    priceChecks: [],
    notes: `${name} demo account set for manager review.`,
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
        ROME7045: { accountName: 'ROME7045', alias: 'BlueSky - 7045', connection: 'BlueSky', accountType: 'Funded', status: 'Active', payoutState: 'Not requested', targetProfit: 52000, maxDrawdownLimit: 2500, dateAdded: '2026-02-10', dateFunded: '2026-02-24', payoutCount: 2, dateLastPayout: '2026-05-12' },
        ROME8801: { accountName: 'ROME8801', alias: 'Lucid - 8801', connection: 'Lucid', accountType: 'Evaluation - Standard', status: 'Active', payoutState: 'Not requested', targetProfit: 53000, maxDrawdownLimit: 2000, dateAdded: '2026-05-20' },
        ROME9002: { accountName: 'ROME9002', alias: 'Tradovate - 9002', connection: 'Tradovate', accountType: 'Funded', status: 'Active', payoutState: 'Not requested', targetProfit: 52500, maxDrawdownLimit: 4000, dateAdded: '2026-04-01', dateFunded: '2026-04-15' },
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
    }),
    demoClient({
      id: 'client-todd',
      name: 'Todd',
      registry: {
        TODD5505: { accountName: 'TODD5505', alias: 'BlueSky - 5505', connection: 'BlueSky', accountType: 'Funded', status: 'Payout Hold', payoutState: 'Payout requested', targetProfit: 52000, maxDrawdownLimit: 2500, dateAdded: '2026-03-05', dateFunded: '2026-03-18', payoutCount: 1, dateLastPayout: '2026-04-20' },
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
    }),
    demoClient({
      id: 'client-amanda',
      name: 'Amanda Capital',
      registry: {
        AMAN1024: { accountName: 'AMAN1024', alias: 'MFF - 1024', connection: 'My Funded Futures', accountType: 'Funded', status: 'Active', payoutState: 'Clear to trade', targetProfit: 102000, maxDrawdownLimit: 4000, dateAdded: '2026-01-08', dateFunded: '2026-01-22', payoutCount: 3, dateLastPayout: '2026-06-01' },
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
        BLAN3301: { accountName: 'BLAN3301', alias: 'Legends - 3301', connection: 'The Legends Trading', accountType: 'Funded', status: 'Active', payoutState: 'Not requested', targetProfit: 153000, maxDrawdownLimit: 6000, dateAdded: '2026-01-05', dateFunded: '2026-01-20', payoutCount: 4, dateLastPayout: '2026-05-28' },
        BLAN3302: { accountName: 'BLAN3302', alias: 'Legends - 3302', connection: 'The Legends Trading', accountType: 'Evaluation - Standard', status: 'Active', payoutState: 'Not requested', targetProfit: 103000, maxDrawdownLimit: 3000, dateAdded: '2026-05-10' },
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
        SARH4101: { accountName: 'SARH4101', alias: 'Apex - 4101', connection: 'Apex', accountType: 'Evaluation - Standard', status: 'Active', payoutState: 'Not requested', targetProfit: 53000, maxDrawdownLimit: 2000, dateAdded: '2026-06-10' },
        SARH4102: { accountName: 'SARH4102', alias: 'Lucid - 4102', connection: 'Lucid', accountType: 'Funded', status: 'Active', payoutState: 'Clear to trade', targetProfit: 52000, maxDrawdownLimit: 2500, dateAdded: '2026-04-20', dateFunded: '2026-05-05', payoutCount: 1, dateLastPayout: '2026-06-05' },
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

export function upsertAccountMeta(state, clientId, accountName, patch) {
  return updateClient(state, clientId, (client) => {
    const existing = client.accountRegistry[accountName] || { accountName };
    return {
      ...client,
      accountRegistry: {
        ...client.accountRegistry,
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
  return updateClient(state, clientId, (client) => ({
    ...client,
    accountRegistry: {
      ...client.accountRegistry,
      ...importResult.accounts,
    },
    dailyImports: [...client.dailyImports.filter((item) => item.id !== importResult.id), importResult].sort((a, b) => {
      return String(a.importedAt || '').localeCompare(String(b.importedAt || ''));
    }),
  }));
}

export function updateClientDetails(state, clientId, patch) {
  return updateClient(state, clientId, (client) => ({
    ...client,
    ...patch,
  }));
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
  return [...client.dailyImports].sort((a, b) => String(b.importedAt || '').localeCompare(String(a.importedAt || '')))[0];
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
  return {
    accountManager: data.accountManager,
    demoVersion: data.demoVersion || 0,
    camProfiles: data.camProfiles || [],
    clients: data.clients,
    selectedClientId: data.selectedClientId || data.clients[0]?.id || null,
  };
}

function isStaleDemoState(state) {
  if (!state || typeof state !== 'object') return true;
  if (state.demoVersion !== DEMO_STATE_VERSION) return true;
  if (!Array.isArray(state.clients) || !state.clients.length) return true;
  if (!Array.isArray(state.camProfiles) || !state.camProfiles.length) return true;
  return state.camProfiles.some((profile) => !Array.isArray(profile.clientIds));
}

export function loadDemoState() {
  if (typeof window === 'undefined') return createInitialState();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return createInitialState();
    const parsed = JSON.parse(raw);
    return isStaleDemoState(parsed) ? createInitialState() : parsed;
  } catch {
    return createInitialState();
  }
}

export function saveDemoState(state) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
