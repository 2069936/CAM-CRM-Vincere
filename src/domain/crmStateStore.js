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

/**
 * @param {object} state
 * @param {string} name
 * @param {string} camId
 * @param {{id?: string}} [options] `id` lets the caller name the row it is about
 *        to create. A client is added optimistically and then replaced by the
 *        saved row (see adoptSavedClient); without a known id the caller cannot
 *        find its own placeholder again — which is why the old code re-read the
 *        entire database after every client creation just to learn one uuid.
 */
export function addClient(state, name, camId = state.accountManager?.id, { id = null } = {}) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return state;

  const client = {
    id: id || createId('client'),
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

/**
 * Puts back everything removeClient took out.
 *
 * removeClient drops three things at once — the client, its entry in every
 * CAM's clientIds, and the selection if it was the selected one — so undoing a
 * refused deactivation has to put all three back or the client returns to the
 * list belonging to nobody. The position is restored too: the sidebar falls
 * back to `clients` order for anyone without a saved clientOrder, and a client
 * that reappears at the bottom of the list reads as a different bug.
 */
export function restoreClient(state, client, { index = null, camProfileIds = [], selectedClientId = null } = {}) {
  if (!client?.id) return state;
  const others = (state.clients || []).filter((c) => c.id !== client.id);
  const at = index === null || index < 0 ? others.length : Math.min(index, others.length);
  const owners = new Set(camProfileIds);
  return {
    ...state,
    clients: [...others.slice(0, at), client, ...others.slice(at)],
    camProfiles: (state.camProfiles || []).map((profile) => (
      owners.has(profile.id)
        ? { ...profile, clientIds: [...new Set([...(profile.clientIds || []), client.id])] }
        : profile
    )),
    selectedClientId: selectedClientId || state.selectedClientId,
  };
}

/**
 * Swaps an optimistically added client for the row the insert returned.
 *
 * The saved row carries the id every later write needs (the uuid, and the
 * legacy_key the app uses as `id`), so this is the local half of "an edit is
 * visible from the edit itself": the placeholder keeps whatever the user has
 * already typed into it, the ids come from the server, and nothing has to be
 * re-downloaded to learn them.
 *
 * Every reference to the placeholder id moves with it — the owning CAM's
 * clientIds and clientOrder, and the selection — because a stale id in
 * clientOrder silently drops the client out of the sidebar's ordered list.
 */
export function adoptSavedClient(state, localId, savedClient) {
  if (!savedClient?.id || !localId) return state;
  const swap = (id) => (id === localId ? savedClient.id : id);
  return {
    ...state,
    clients: (state.clients || []).map((client) => (
      client.id === localId ? { ...client, ...savedClient } : client
    )),
    camProfiles: (state.camProfiles || []).map((profile) => ({
      ...profile,
      clientIds: [...new Set((profile.clientIds || []).map(swap))],
      ...(profile.clientOrder
        ? { clientOrder: [...new Set(profile.clientOrder.map(swap))] }
        : {}),
    })),
    selectedClientId: swap(state.selectedClientId),
  };
}

export function addTimeOffRequest(state, entry) {
  if (!entry?.id) return state;
  return {
    ...state,
    timeOff: [...(state.timeOff || []).filter((row) => row.id !== entry.id), entry],
  };
}

export function updateTimeOffRequest(state, timeOffId, patch) {
  return {
    ...state,
    timeOff: (state.timeOff || []).map((row) => (
      row.id === timeOffId ? { ...row, ...patch } : row
    )),
  };
}

export function removeTimeOffRequest(state, timeOffId) {
  return {
    ...state,
    timeOff: (state.timeOff || []).filter((row) => row.id !== timeOffId),
  };
}

/**
 * Coverage is replaced per time-off request, never appended to — the write it
 * mirrors (replaceSupabaseCoverage) deletes every row carrying the time_off_id
 * and re-inserts, so re-distributing a cover must not accumulate here either.
 * An empty list is how a cover is removed outright.
 */
export function replaceCoverageForRequest(state, timeOffId, entries = []) {
  return {
    ...state,
    coverage: [
      ...(state.coverage || []).filter((row) => row.timeOffId !== timeOffId),
      ...entries,
    ],
  };
}

export function removeCoverageEntry(state, coverageId) {
  return {
    ...state,
    coverage: (state.coverage || []).filter((row) => row.id !== coverageId),
  };
}

/**
 * The exact inverse of removeCoverageEntry, so ending a cover can be undone
 * when the delete is refused. Upsert rather than push: rolling back twice must
 * not leave the client covered twice.
 */
export function upsertCoverageEntry(state, entry) {
  if (!entry?.id) return state;
  return {
    ...state,
    coverage: [...(state.coverage || []).filter((row) => row.id !== entry.id), entry],
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

/**
 * Folds the daily_imports row the write RETURNED into the day already on screen.
 *
 * The day is complete from the upload itself — every account, every fill, every
 * flag, all under ids the client generated. The one thing the client cannot
 * know is the row's uuid, and `orders`/`executions` are keyed by it when trade
 * history is merged in (see mergeSupabaseTradeHistory). Learning it from the
 * write is a field copy; learning it from a refetch was a full dashboard load.
 *
 * Matched on `date`, not on id: appendDailyImport keys a client's days by date
 * and a re-upload of the same day arrives with a fresh local id, so date is the
 * identity that survives both.
 *
 * `status` is deliberately not adopted. The screen owns it — a user who closed
 * the day in the milliseconds the write was out must not have it reopened by
 * the row that write returned.
 */
export function adoptSavedDailyImport(state, clientId, date, savedRow) {
  if (!savedRow?.id || !date) return state;
  return updateClient(state, clientId, (client) => ({
    ...client,
    dailyImports: (client.dailyImports || []).map((item) => (
      item.date === date
        ? {
          ...item,
          id: savedRow.legacy_key || item.id,
          uuid: savedRow.id,
          ...(savedRow.source_summary ? { sourceSummary: savedRow.source_summary } : {}),
        }
        : item
    )),
  }));
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

export function removeDailyImport(state, clientId, importId) {
  return updateClient(state, clientId, (client) => ({
    ...client,
    dailyImports: (client.dailyImports || []).filter((item) => item.id !== importId),
  }));
}

export function getLatestClientImport(client) {
  if (!client?.dailyImports?.length) return null;
  return [...client.dailyImports].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0];
}

export function getClientImportByDate(client, date) {
  return client?.dailyImports?.find((item) => item.date === date) || null;
}
