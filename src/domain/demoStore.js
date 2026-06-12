const STORAGE_KEY = 'cam_crm_demo_state_v1';

function createId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
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

function demoClient({ id, name, registry, snapshots, executions, flags }) {
  const date = todayIsoDate();
  return {
    id,
    name,
    status: 'Active',
    accountRegistry: registry,
    dailyImports: [{
      id: `${id}-${date}`,
      clientId: id,
      date,
      importedAt: `${date}T22:00:00.000Z`,
      status: flags.length ? 'Needs review' : 'Ready to close',
      accounts: registry,
      snapshots,
      strategies: snapshots.flatMap((snapshot) => snapshot.strategies || []),
      orders: [],
      executions,
      flags,
    }],
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
  const bulletLong = demoBullet({ direction: 'Long', realized: 0 });
  const bulletShort = demoBullet({ slot: 1, direction: 'Short', realized: -1200 });

  const clients = [
    demoClient({
      id: 'client-rome',
      name: 'Rome',
      registry: {
        ROME5298: { accountName: 'ROME5298', alias: 'Live - 5298', connection: 'Live', accountType: 'Cash', status: 'Active', payoutState: 'Not requested', notes: 'Cash account: daily, weekly, balance only.' },
        ROME7045: { accountName: 'ROME7045', alias: 'BlueSky - 7045', connection: 'BlueSky', accountType: 'Funded', status: 'Active', payoutState: 'Not requested' },
        ROME8801: { accountName: 'ROME8801', alias: 'Lucid - 8801', connection: 'Lucid', accountType: 'Evaluation - Standard', status: 'Active', payoutState: 'Not requested' },
      },
      snapshots: [
        demoSnapshot({ accountName: 'ROME5298', connection: 'Live', grossRealizedPnl: 640, weeklyPnl: 1820, balance: 28450, drawdown: 0, strategies: [ogx] }),
        demoSnapshot({ accountName: 'ROME7045', connection: 'BlueSky', grossRealizedPnl: 180, weeklyPnl: 320, balance: 50500, drawdown: -1200, strategies: [rbo] }),
        demoSnapshot({ accountName: 'ROME8801', connection: 'Lucid', grossRealizedPnl: -330, weeklyPnl: -577, balance: 49670, drawdown: -1600, strategies: [ifsp] }),
      ],
      executions: [
        ...demoExecution({ accountName: 'ROME5298', strategyName: ogx.strategyName, base: 19020 }),
        ...demoExecution({ accountName: 'ROME7045', strategyName: rbo.strategyName, base: 2950 }),
        ...demoExecution({ accountName: 'ROME8801', strategyName: ifsp.strategyName, base: 3350, down: true }),
      ],
      flags: [
        demoFlag('Strategy underperforming peers', 'Warning', 'ROME8801', 'Lucid - 8801 is below peer average for IFSP 1.1. Calculation: daily realized is compared against same-family instances and flagged when below mean minus 1.5 standard deviations.'),
      ],
    }),
    demoClient({
      id: 'client-todd',
      name: 'Todd',
      registry: {
        TODD5505: { accountName: 'TODD5505', alias: 'BlueSky - 5505', connection: 'BlueSky', accountType: 'Funded', status: 'Payout Hold', payoutState: 'Payout requested', targetProfit: 52000 },
        TODD7712: { accountName: 'TODD7712', alias: 'Apex - 7712', connection: 'Apex', accountType: 'Evaluation - Bullet Bot', status: 'Active', payoutState: 'Not requested', bulletBotPassType: '1 Day Pass' },
        TODD7713: { accountName: 'TODD7713', alias: 'Apex - 7713', connection: 'Apex', accountType: 'Evaluation - Bullet Bot', status: 'Failed', payoutState: 'Not requested', bulletBotPassType: '3 Day Pass' },
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
        demoFlag('Payout hold violation', 'Critical', 'TODD5505', 'BlueSky - 5505 is in payout hold but still has an enabled strategy. Calculation: status = Payout Hold and active strategy count > 0.'),
        demoFlag('Bullet Bot failed', 'Critical', 'TODD7713', 'Apex - 7713 hit failed status after Bullet Bot loss. Calculation: account status manually set to Failed and daily PnL is negative.'),
      ],
    }),
    demoClient({
      id: 'client-amanda',
      name: 'Amanda Capital',
      registry: {
        AMAN1024: { accountName: 'AMAN1024', alias: 'MFF - 1024', connection: 'My Funded Futures', accountType: 'Funded', status: 'Active', payoutState: 'Clear to trade' },
        AMAN2048: { accountName: 'AMAN2048', alias: 'Lucid - 2048', connection: 'Lucid', accountType: 'Evaluation - Standard', status: 'Reserve', payoutState: 'Not requested' },
        AMAN9090: { accountName: 'AMAN9090', alias: 'Tradeify - 9090', connection: 'Tradeify', accountType: 'Unassigned', status: 'Active', payoutState: 'Not requested' },
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
        BLAN3301: { accountName: 'BLAN3301', alias: 'Legends - 3301', connection: 'The Legends Trading', accountType: 'Funded', status: 'Active', payoutState: 'Not requested' },
        BLAN3302: { accountName: 'BLAN3302', alias: 'Legends - 3302', connection: 'The Legends Trading', accountType: 'Evaluation - Standard', status: 'Active', payoutState: 'Not requested' },
      },
      snapshots: [
        demoSnapshot({ accountName: 'BLAN3301', connection: 'The Legends Trading', grossRealizedPnl: 140, weeklyPnl: 410, balance: 150620, drawdown: -4400, strategies: [rbo] }),
        demoSnapshot({ accountName: 'BLAN3302', connection: 'The Legends Trading', grossRealizedPnl: -90, weeklyPnl: 210, balance: 99910, drawdown: -1900, strategies: [ifsp] }),
      ],
      executions: [
        ...demoExecution({ accountName: 'BLAN3301', strategyName: rbo.strategyName, base: 2954 }),
        ...demoExecution({ accountName: 'BLAN3302', strategyName: ifsp.strategyName, base: 3354, down: true }),
      ],
      flags: [],
    }),
    demoClient({
      id: 'client-ed',
      name: 'Ed - Vincere Trading',
      registry: {
        ED6100: { accountName: 'ED6100', alias: 'Cash - 6100', connection: 'Live', accountType: 'Cash', status: 'Active', payoutState: 'Not requested' },
        ED6200: { accountName: 'ED6200', alias: 'BlueSky - 6200', connection: 'BlueSky', accountType: 'Funded', status: 'Inactive', payoutState: 'Not requested' },
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
  ];

  return {
    accountManager: {
      id: 'am-pedro',
      name: 'Pedro',
    },
    clients,
    selectedClientId: 'client-rome',
  };
}

export function createInitialState() {
  return createDemoState();
}

export function addClient(state, name) {
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
    selectedClientId: client.id,
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
    clients: data.clients,
    selectedClientId: data.selectedClientId || data.clients[0]?.id || null,
  };
}

export function loadDemoState() {
  if (typeof window === 'undefined') return createInitialState();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : createInitialState();
  } catch {
    return createInitialState();
  }
}

export function saveDemoState(state) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
