// Time off and temporary client coverage.
//
// When a CAM is away — vacation, a medical appointment, anything — their clients
// still need someone watching them. A manager approves the time off and hands
// those clients to other CAMs for exactly that window.
//
// Coverage ADDS access, it never removes it: the CAM who is away keeps seeing
// their own clients, and the covering CAM gets them too, marked as borrowed so
// nobody confuses them with their own book. Coverage is dated, so it turns
// itself off when the window closes — nobody has to remember to undo it.

export const TIME_OFF_KINDS = ['Vacation', 'Medical', 'Personal', 'Training', 'Other'];
export const TIME_OFF_STATUSES = { PENDING: 'Pending', APPROVED: 'Approved', DENIED: 'Denied', CANCELLED: 'Cancelled' };

function toDate(value) {
  const text = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

/** Inclusive on both ends: a one-day absence has start === end. */
export function overlapsRange(aStart, aEnd, bStart, bEnd) {
  const a1 = toDate(aStart);
  const a2 = toDate(aEnd) || a1;
  const b1 = toDate(bStart);
  const b2 = toDate(bEnd) || b1;
  if (!a1 || !b1) return false;
  return a1 <= b2 && b1 <= a2;
}

export function coversDate(entry, date) {
  const day = toDate(date);
  if (!day) return false;
  return overlapsRange(entry?.startDate, entry?.endDate, day, day);
}

export function isActiveTimeOff(request, date) {
  return request?.status === TIME_OFF_STATUSES.APPROVED && coversDate(request, date);
}

/**
 * Client ids a CAM can work on for a given day: the ones they own, plus the ones
 * they are covering. Returned as a Set for a cheap membership test.
 */
export function effectiveClientIds(camProfile, coverage = [], date) {
  const ids = new Set(camProfile?.clientIds || []);
  for (const entry of coverage) {
    if (entry.coveringCamId !== camProfile?.id) continue;
    if (!coversDate(entry, date)) continue;
    ids.add(entry.clientId);
  }
  return ids;
}

/** The coverage entries in force for a CAM on a day, for badging borrowed clients. */
export function activeCoverageFor(coverage = [], camProfileId, date) {
  return coverage.filter((entry) => entry.coveringCamId === camProfileId && coversDate(entry, date));
}

/** Who is covering a given client today, if anyone. */
export function coverageForClient(coverage = [], clientId, date) {
  return coverage.find((entry) => entry.clientId === clientId && coversDate(entry, date)) || null;
}

/**
 * Other approved absences that overlap a requested window — what a manager needs
 * to see before approving, so the floor is never left thin.
 */
export function conflictingTimeOff(requests = [], request) {
  return requests.filter((other) => (
    other.id !== request?.id
    && other.camProfileId !== request?.camProfileId
    && other.status === TIME_OFF_STATUSES.APPROVED
    && overlapsRange(other.startDate, other.endDate, request?.startDate, request?.endDate)
  ));
}

/** A second request from the same CAM covering the same days. */
export function overlapsOwnTimeOff(requests = [], request) {
  return requests.some((other) => (
    other.id !== request?.id
    && other.camProfileId === request?.camProfileId
    && other.status !== TIME_OFF_STATUSES.DENIED
    && other.status !== TIME_OFF_STATUSES.CANCELLED
    && overlapsRange(other.startDate, other.endDate, request?.startDate, request?.endDate)
  ));
}

/**
 * How loaded each CAM is, so the manager distributes onto whoever has room
 * rather than guessing. Counts what they own plus what they are already
 * covering, and flags anyone who is themselves away that day.
 */
export function buildCamWorkload(camProfiles = [], clients = [], { coverage = [], timeOff = [], date } = {}) {
  const clientById = new Map((clients || []).map((client) => [client.id, client]));
  return (camProfiles || []).map((cam) => {
    const covering = activeCoverageFor(coverage, cam.id, date);
    const ownIds = cam.clientIds || [];
    const accounts = ownIds.reduce((sum, id) => (
      sum + Object.keys(clientById.get(id)?.accountRegistry || {}).length
    ), 0);
    const away = (timeOff || []).some((request) => (
      request.camProfileId === cam.id && isActiveTimeOff(request, date)
    ));
    return {
      camProfileId: cam.id,
      name: cam.name,
      ownClients: ownIds.length,
      coveringClients: covering.length,
      totalClients: ownIds.length + covering.length,
      accounts,
      away,
    };
  }).sort((a, b) => a.totalClients - b.totalClients || a.name.localeCompare(b.name));
}

/**
 * Spread clients across the available CAMs as evenly as possible, giving the
 * next client to whoever currently carries least. Deterministic, so the manager
 * sees the same proposal twice and can adjust before committing.
 */
export function distributeClientsEvenly(clientIds = [], workload = []) {
  const targets = workload.filter((row) => !row.away);
  if (!targets.length || !clientIds.length) return [];
  const load = new Map(targets.map((row) => [row.camProfileId, row.totalClients]));
  const assignments = [];
  for (const clientId of clientIds) {
    let pick = null;
    for (const row of targets) {
      const current = load.get(row.camProfileId);
      if (pick === null || current < load.get(pick)) pick = row.camProfileId;
    }
    assignments.push({ clientId, coveringCamId: pick });
    load.set(pick, load.get(pick) + 1);
  }
  return assignments;
}

/**
 * A CAM's record — the standing facts about them rather than a timeline. Sits
 * beside client lifecycle: what they carry, what is coming up, what they took.
 */
export function buildCamRecord(camProfile, clients = [], { coverage = [], timeOff = [], date } = {}) {
  const clientById = new Map((clients || []).map((client) => [client.id, client]));
  const owned = (camProfile?.clientIds || []).map((id) => clientById.get(id)).filter(Boolean);
  const mine = (timeOff || []).filter((request) => request.camProfileId === camProfile?.id);
  const today = toDate(date);
  const upcoming = mine
    .filter((request) => request.status === TIME_OFF_STATUSES.APPROVED && toDate(request.startDate) > today)
    .sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
  const daysOff = mine
    .filter((request) => request.status === TIME_OFF_STATUSES.APPROVED)
    .reduce((sum, request) => {
      const start = toDate(request.startDate);
      const end = toDate(request.endDate) || start;
      if (!start) return sum;
      const days = Math.round((Date.parse(`${end}T12:00:00`) - Date.parse(`${start}T12:00:00`)) / 86400000) + 1;
      return sum + Math.max(1, days);
    }, 0);

  return {
    camProfileId: camProfile?.id || '',
    name: camProfile?.name || '',
    role: camProfile?.role || camProfile?.roleTitle || 'CAM',
    status: camProfile?.status || 'Active',
    clients: owned.length,
    accounts: owned.reduce((sum, client) => sum + Object.keys(client.accountRegistry || {}).length, 0),
    covering: activeCoverageFor(coverage, camProfile?.id, date).length,
    away: mine.some((request) => isActiveTimeOff(request, date)),
    pendingRequests: mine.filter((request) => request.status === TIME_OFF_STATUSES.PENDING).length,
    approvedDaysOff: daysOff,
    nextTimeOff: upcoming[0] || null,
    timeOff: mine.sort((a, b) => String(b.startDate).localeCompare(String(a.startDate))),
  };
}
