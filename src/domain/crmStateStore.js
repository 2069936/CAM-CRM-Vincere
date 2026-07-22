function createId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function todayIsoDate() {
  // Local calendar date, NOT UTC. new Date().toISOString() is UTC, so for a user
  // behind UTC (e.g. UTC-5) it rolls to "tomorrow" in the evening — which made the
  // daily close default to the wrong day. Build the date from local components.
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function createInitialState() {
  return {
    accountManager: {
      id: '',
      name: '',
    },
    camProfiles: [],
    clients: [],
    selectedClientId: null,
  };
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
        ? { ...di, flags: (di.flags || []).map((f) => f.id === flagId ? { ...f, status, resolvedAt: new Date().toISOString() } : f) }
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
    activityLog: [entry, ...(client.activityLog || [])].slice(0, 500),
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
    const rest = { ...registry };
    delete rest[existingKey];
    return { ...client, accountRegistry: rest };
  });
}

const NUMERIC_ACCOUNT_FIELDS = ['targetProfit', 'maxDrawdownLimit', 'startBalance', 'payoutCount'];

export function upsertAccountMeta(state, clientId, accountName, patch) {
  return updateClient(state, clientId, (client) => {
    // Case-insensitive key lookup to prevent duplicate registry entries
    const registry = client.accountRegistry || {};
    const existingKey = Object.keys(registry).find(k => k.toLowerCase() === accountName.toLowerCase()) || accountName;
    const existing = registry[existingKey] || { accountName };
    const newRegistry = { ...registry };
    if (existingKey !== accountName) delete newRegistry[existingKey];
    // Coerce numeric fields so stored values are always numbers, not input strings
    const coerced = { ...patch };
    for (const field of NUMERIC_ACCOUNT_FIELDS) {
      if (field in coerced && coerced[field] !== '' && coerced[field] !== null) {
        const n = Number(coerced[field]);
        if (!Number.isNaN(n)) coerced[field] = n;
      }
    }
    return {
      ...client,
      accountRegistry: {
        ...newRegistry,
        [accountName]: {
          ...existing,
          ...coerced,
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
      ].sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(-180),
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
  return updateClient(state, clientId, (client) => {
    const base = { ...client.accountRegistry };
    for (const [importKey, importVal] of Object.entries(importResult.accounts || {})) {
      const existingKey = Object.keys(base).find(k => k.toLowerCase() === importKey.toLowerCase()) || importKey;
      const existingVal = base[existingKey];
      if (existingKey !== importKey) delete base[existingKey];
      base[importKey] = { ...importVal, ...existingVal };
    }
    return {
      ...client,
      accountRegistry: base,
      dailyImports: client.dailyImports.map((item) => (item.id === importResult.id ? importResult : item)),
    };
  });
}

export function getLatestClientImport(client) {
  if (!client?.dailyImports?.length) return null;
  return [...client.dailyImports].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0];
}

export function getClientImportByDate(client, date) {
  return client?.dailyImports?.find((item) => item.date === date) || null;
}
