const STORAGE_KEY = 'cam_crm_demo_state_v1';

function createId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

export function createInitialState() {
  return {
    accountManager: {
      id: 'am-pedro',
      name: 'Pedro',
    },
    clients: [],
    selectedClientId: null,
  };
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
