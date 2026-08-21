/**
 * A refresh is a MERGE. It is never a replacement.
 *
 * THE TWO DEFECTS THIS EXISTS FOR
 *
 * 1. A BACKGROUND REFRESH THAT SUCCEEDS THREW AWAY AN EDIT MADE WHILE IT WAS IN
 *    FLIGHT. refreshInBackground ended in `setState(nextState)`, where
 *    nextState was built from reads that STARTED before the edit. Upload a day,
 *    resolve a flag while the refresh is still out, and the refresh lands
 *    carrying the pre-write snapshot: the flag reads Open again, with no alert
 *    and no stale notice. That is the desk manager's original symptom made
 *    silent — the old code at least showed a loading state while it did it.
 *
 *    A whole-state replacement cannot be made safe by ordering it better. The
 *    read is always older than the edits that raced it, so the only correct
 *    shape is to fold in what the refresh LEARNED and keep what the user has
 *    CHANGED. That is mergeRefreshedDays: it touches only the days the refresh
 *    was asked about, and inside those days it keeps every field the user can
 *    edit from the screen.
 *
 * 2. TRADE HISTORY WAS WIPED BY EVERY REFRESH AND NEVER CAME BACK.
 *    loadSupabaseCrmState defaults includeTradeHistory=false, so
 *    buildCrmStateFromTables rebuilds every dailyImport with `orders: []` and
 *    `executions: []`. Replacing state with that dropped ~24,000 rows off the
 *    screen on the manager Refresh button, on opening any workspace, and on
 *    every upload. The previous shape re-fetched them straight afterwards,
 *    which is the request burst this project spent a pass removing;
 *    carryTradeHistoryForward keeps them instead, so neither the rows nor the
 *    requests are paid for twice.
 *
 * WHAT IS DELIBERATELY NOT MERGED
 *
 * Only the days named by the caller. A background refresh serves the edit that
 * asked for it; it is not the mechanism by which anyone sees other people's
 * work — the manager's Refresh button is, and that one still replaces state
 * wholesale (it is a load the user asked for), with trade history carried
 * across it.
 *
 * The account registry is left alone entirely. It is user-configured metadata —
 * aliases, targets, account types — and folding a snapshot of it back over the
 * screen is the same defect this module removes, pointed at a different field.
 */

/**
 * Where a day's fills live once buildCrmStateFromTables has run its
 * live/simulated/undetermined split over them. All six, or the split half of a
 * simulated account's history silently disappears while the live half survives.
 */
function fillsOf(dailyImport) {
  return {
    orders: dailyImport?.orders || [],
    executions: dailyImport?.executions || [],
    simulationOrders: dailyImport?.simulation?.orders || [],
    simulationExecutions: dailyImport?.simulation?.executions || [],
    undeterminedOrders: dailyImport?.simulation?.undetermined?.orders || [],
    undeterminedExecutions: dailyImport?.simulation?.undetermined?.executions || [],
  };
}

function hasFills(dailyImport) {
  return Object.values(fillsOf(dailyImport)).some((rows) => rows.length > 0);
}

/**
 * Puts `source`'s fills onto `target`, and nothing else.
 *
 * The split's own bookkeeping — totals, the simulated account list, the
 * snapshots and strategies on each side — stays whatever `target` computed,
 * because that half was rebuilt from rows the refresh DID fetch and is fresher
 * than what is in memory. Only the six arrays the refresh could not have
 * fetched come across.
 */
function withFillsFrom(target, source) {
  const fills = fillsOf(source);
  const next = { ...target, orders: fills.orders, executions: fills.executions };
  const simulation = target?.simulation || source?.simulation;
  if (simulation) {
    next.simulation = {
      ...simulation,
      orders: fills.simulationOrders,
      executions: fills.simulationExecutions,
      undetermined: {
        ...(simulation.undetermined || {}),
        orders: fills.undeterminedOrders,
        executions: fills.undeterminedExecutions,
      },
    };
  }
  return next;
}

/** Every identity a day answers to, most specific first. */
function keysForDay(client, dailyImport) {
  const keys = [];
  if (dailyImport?.uuid) keys.push(`uuid:${dailyImport.uuid}`);
  if (dailyImport?.id) keys.push(`id:${dailyImport.id}`);
  if (dailyImport?.date) {
    for (const clientKey of [client?.id, client?.uuid]) {
      if (clientKey) keys.push(`date:${clientKey}:${dailyImport.date}`);
    }
  }
  return keys;
}

function indexDays(state) {
  const byKey = new Map();
  for (const client of state?.clients || []) {
    for (const dailyImport of client.dailyImports || []) {
      for (const key of keysForDay(client, dailyImport)) {
        if (!byKey.has(key)) byKey.set(key, dailyImport);
      }
    }
  }
  return byKey;
}

function lookupDay(index, client, dailyImport) {
  for (const key of keysForDay(client, dailyImport)) {
    const found = index.get(key);
    if (found) return found;
  }
  return null;
}

/**
 * Carries the fills already in memory onto a state that was loaded without
 * them, and reports which days it could not find a counterpart for.
 *
 * `missingImportIds` is the "was it ACTUALLY lost" signal, and it is deliberately
 * "this day is new to us", not "this day has no fills". A flat day and a day
 * whose every account is simulated both legitimately hold zero live orders, and
 * treating those as a loss would re-fetch 24,000 rows on every single refresh
 * forever — the exact burst the bounded gate was introduced to end.
 *
 * @returns {{state: object, missingImportIds: string[]}}
 */
export function carryTradeHistoryForward(current, next) {
  if (!next) return { state: next, missingImportIds: [] };
  const known = indexDays(current);
  const missingImportIds = [];
  const state = {
    ...next,
    clients: (next.clients || []).map((client) => ({
      ...client,
      dailyImports: (client.dailyImports || []).map((dailyImport) => {
        const previous = lookupDay(known, client, dailyImport);
        if (!previous) {
          missingImportIds.push(dailyImport.uuid || dailyImport.id);
          return dailyImport;
        }
        return hasFills(previous) ? withFillsFrom(dailyImport, previous) : dailyImport;
      }),
    })),
  };
  return { state, missingImportIds };
}

/**
 * Folds one refreshed day into the day the user is looking at.
 *
 * The rule, stated once so it is arguable rather than accidental: the server
 * owns what it alone can know, and the screen owns what the user can change
 * from it. So `uuid`, the rebuilt snapshots and strategies, and the joined flag
 * rows come from the refresh; the day's `status` and each flag's `status` stay
 * as the user left them, and the fills are carried across.
 *
 * Flag ids are client-generated uuids that are written through unchanged (see
 * mapFlag in dailyImportPersistence.js), so matching a local flag to its
 * refreshed row by id is exact, not a heuristic. A flag the refresh has not
 * seen yet — raised by a close whose write landed after the read went out — is
 * kept rather than dropped, for the same reason the status is.
 */
function mergeRefreshedDay(localDay, refreshedDay) {
  const localFlags = new Map((localDay.flags || []).map((flag) => [flag.id, flag]));
  const flags = (refreshedDay.flags || []).map((flag) => {
    const local = localFlags.get(flag.id);
    if (!local) return flag;
    return {
      ...flag,
      status: local.status,
      resolvedAt: local.resolvedAt ?? flag.resolvedAt ?? null,
    };
  });
  const seen = new Set(flags.map((flag) => flag.id));
  for (const flag of localDay.flags || []) {
    if (!seen.has(flag.id)) flags.push(flag);
  }
  return withFillsFrom(
    { ...refreshedDay, status: localDay.status, flags },
    localDay,
  );
}

/**
 * Merges the refreshed copies of specific days into current state.
 *
 * @param {object} current   State as it stands NOW, including every edit made
 *                           while the refresh was in flight.
 * @param {object} refreshed State built from the refresh's reads.
 * @param {Array<{clientId: string, date: string}>} targets The days the refresh
 *                           was asked about. Anything not named here is left
 *                           exactly as it is.
 * @returns {object} current, unchanged by identity when there is nothing to fold in.
 */
export function mergeRefreshedDays(current, refreshed, targets = []) {
  if (!current || !refreshed || !targets.length) return current;

  const datesByClient = new Map();
  for (const target of targets) {
    if (!target?.clientId || !target?.date) continue;
    if (!datesByClient.has(target.clientId)) datesByClient.set(target.clientId, new Set());
    datesByClient.get(target.clientId).add(target.date);
  }
  if (!datesByClient.size) return current;

  const refreshedClients = new Map();
  for (const client of refreshed.clients || []) {
    if (client?.id) refreshedClients.set(client.id, client);
    if (client?.uuid) refreshedClients.set(client.uuid, client);
  }

  let changedAnything = false;
  const clients = (current.clients || []).map((client) => {
    const dates = datesByClient.get(client.id) || (client.uuid ? datesByClient.get(client.uuid) : null);
    if (!dates) return client;
    const source = refreshedClients.get(client.id) || (client.uuid ? refreshedClients.get(client.uuid) : null);
    if (!source) return client;

    const refreshedByDate = new Map((source.dailyImports || []).map((day) => [day.date, day]));
    let changed = false;
    const dailyImports = (client.dailyImports || []).map((day) => {
      if (!dates.has(day.date)) return day;
      const refreshedDay = refreshedByDate.get(day.date);
      // A day the refresh did not see is a day whose write landed after the
      // read went out. Nothing to fold in, and definitely nothing to remove.
      if (!refreshedDay) return day;
      changed = true;
      return mergeRefreshedDay(day, refreshedDay);
    });
    if (!changed) return client;
    changedAnything = true;
    return { ...client, dailyImports };
  });

  return changedAnything ? { ...current, clients } : current;
}
