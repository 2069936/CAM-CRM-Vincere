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
 * Every cover arranged for one time-off request, whatever its dates.
 *
 * Deliberately NOT filtered by date. TimeOffPanel used to list coverage with
 * `startDate <= today`, so a holiday approved three weeks out rendered an empty
 * table: the manager committed a distribution and got zero confirmation it
 * existed. Grouping by timeOffId is what makes "the distribution for request X"
 * addressable at all — the DB carries time_off_id on every coverage row for
 * exactly this (step_34_cam_time_off_and_coverage.sql:37), and coverageFromRow
 * already brings it into app state (supabaseStore.js:212).
 *
 * time_off_id is nullable ("cover arranged without a formal request behind it")
 * and arrives as '' — a falsy id must match nothing, not every loose row.
 */
export function coverageForRequest(coverage = [], timeOffId) {
  if (!timeOffId) return [];
  return (coverage || []).filter((entry) => entry.timeOffId === timeOffId);
}

/**
 * Has this window not finished yet on `date`? Inclusive of the last day.
 *
 * Goes through toDate like every other predicate here rather than comparing the
 * raw strings, so a malformed or timestamp-shaped date fails closed instead of
 * sorting arbitrarily against 'YYYY-MM-DD'. TimeOffPanel had two competing
 * implementations of "is this window live" over the same rows; this is the
 * second one folded back in.
 */
export function isCurrentOrUpcoming(entry, date) {
  const day = toDate(date);
  const start = toDate(entry?.startDate);
  if (!day || !start) return false;
  return (toDate(entry?.endDate) || start) >= day;
}

/**
 * Why this CAM cannot take a client for this request, or null when they can.
 *
 * null means "allowed" — a determined answer, not an unknown. The predicates are
 * the ones already in this file: conflictingTimeOff is precisely "approved
 * absences by *other* CAMs overlapping this window", which is the question, so
 * it is reused rather than re-derived. The absent CAM is checked separately
 * because conflictingTimeOff excludes them by construction (:71).
 */
export function coverageBlockReason(coveringCamId, request, timeOff = []) {
  if (!coveringCamId) return null;
  if (coveringCamId === request?.camProfileId) return 'is the CAM taking this time off';
  const clash = conflictingTimeOff(timeOff, request).find((other) => other.camProfileId === coveringCamId);
  if (!clash) return null;
  const end = toDate(clash.endDate) || toDate(clash.startDate);
  const window = end && end !== toDate(clash.startDate)
    ? `${toDate(clash.startDate)} → ${end}`
    : toDate(clash.startDate);
  return `is on approved ${(clash.kind || 'time off').toLowerCase()} ${window}`;
}

const accountsOf = (client) => Object.keys(client?.accountRegistry || {}).length;

/**
 * Everything a CAM is covering at ANY point in a window, not on one chosen day.
 *
 * activeCoverageFor answers "today"; this answers "during these dates". The
 * difference is not academic. Rendering the real book with two overlapping
 * absences — Reese Glen 2026-08-24 → 08-28 and Marlow Cedar 2026-08-26 → 08-30 —
 * the panel printed two chips for Ellis Glen one scroll apart: "13 → 14 clients ·
 * 114 → 115 accounts" in Reese's block and "14 → 17 clients · 115 → 146
 * accounts" in Marlow's. buildCamWorkload run on 2026-08-27, a day inside both
 * windows, says Ellis carries 17. Reese's block sampled its base on 08-24, day
 * one, so the three clients Ellis picks up on 08-26 — inside Reese's window —
 * were invisible to it. Two totals for one CAM over the same days, 3 clients and
 * 31 accounts apart, on one screen.
 *
 * Overlap is also what coverageBlockReason already uses to decide "unavailable",
 * so this makes the load figures and the refusal on the same chip answer the
 * same question.
 *
 * Deduplicated by client: two rows for one client inside the window (legal under
 * the unique key when the spans differ) is one client's worth of work, not two.
 */
export function coverageOverlappingWindow(coverage = [], camProfileId, startDate, endDate) {
  return (coverage || []).filter((entry) => (
    entry.coveringCamId === camProfileId
    && overlapsRange(entry.startDate, entry.endDate, startDate, endDate)
  ));
}

/** Is this CAM on approved leave at any point in the window? Same reason as above. */
export function awayDuringWindow(timeOff = [], camProfileId, startDate, endDate) {
  return (timeOff || []).some((request) => (
    request?.camProfileId === camProfileId
    && request.status === TIME_OFF_STATUSES.APPROVED
    && overlapsRange(request.startDate, request.endDate, startDate, endDate)
  ));
}

/**
 * The distribution made for one request, as a manager needs to judge it: which
 * client went to which CAM, and what that does to each CAM's load.
 *
 * Pass `assignments` (a draft of {clientId, coveringCamId}) to see the load the
 * manager is *about to* commit; omit it to see what is stored. Both paths run
 * through this one function so the preview shown while editing cannot disagree
 * with the result after saving.
 *
 * The base load excludes this request's own coverage rows, because those rows
 * are what the table below is already showing: counting them again would report
 * a CAM covering 3 clients here as 3 higher before the manager touched
 * anything, and 3 higher again once the plan was added on top.
 *
 * Accounts are carried alongside client counts because count-fair is not
 * fair. On the real book (public/local-snapshot.json, 2026-08-06) an even split
 * of Reese Glen's 17 clients lands 6 of them on Avery Birch, whose whole book
 * is 30 accounts, and 0 on Quinn Glen, whose book is 21 accounts — level at 14
 * clients each, nowhere near level in work. A list of names cannot show that.
 */
export function buildCoverageDistribution(request, {
  coverage = [], camProfiles = [], clients = [], timeOff = [], assignments = null, date,
} = {}) {
  const clientById = new Map((clients || []).map((client) => [client.id, client]));
  const camById = new Map((camProfiles || []).map((cam) => [cam.id, cam]));
  const absentCamId = request?.camProfileId || '';
  const startDate = toDate(request?.startDate);
  const endDate = toDate(request?.endDate) || startDate;

  const stored = coverageForRequest(coverage, request?.id);
  const storedByClient = new Map(stored.map((entry) => [entry.clientId, entry]));

  const others = (coverage || []).filter((entry) => !request?.id || entry.timeOffId !== request.id);

  // The load that matters is the load across the days of the absence, not today
  // and not day one — whoever is free this morning may already be booked the
  // week it starts, and whoever is free on day one may be buried by day three.
  // `date` is the caller's fallback for a request whose start date is unusable.
  const windowStart = startDate || toDate(date);
  const windowEnd = endDate || windowStart;

  // Not buildCamWorkload: that samples one day, which is what printed Ellis Glen
  // as "13 → 14 clients" in one block and "14 → 17" in the next for overlapping
  // windows (see coverageOverlappingWindow). Clients and accounts are both
  // accumulated over the SAME id list here, so the two figures on a chip can
  // never be measured over different sets — the failure this replaced.
  const base = (camProfiles || [])
    .filter((cam) => cam.id !== absentCamId)
    .map((cam) => {
      const ownIds = cam.clientIds || [];
      const held = [...ownIds];
      const seen = new Set(ownIds);
      for (const entry of coverageOverlappingWindow(others, cam.id, windowStart, windowEnd)) {
        if (seen.has(entry.clientId)) continue;
        seen.add(entry.clientId);
        held.push(entry.clientId);
      }
      let accounts = 0;
      // A client this app state has no row for cannot contribute an account
      // count. Counting it as 0 would quietly understate the chip; it is carried
      // as "unmeasured" so the chip can say so rather than print a clean number.
      let unmeasured = 0;
      for (const id of held) {
        const client = clientById.get(id);
        if (client) accounts += accountsOf(client);
        else unmeasured += 1;
      }
      return {
        camProfileId: cam.id,
        name: cam.name,
        away: awayDuringWindow(timeOff, cam.id, windowStart, windowEnd),
        clients: held.length,
        accounts,
        unmeasured,
      };
    });

  // A draft edit is the source of truth when given; otherwise read the stored rows.
  const plan = assignments
    ? assignments.filter((row) => row.clientId && row.coveringCamId)
    : stored.map((entry) => ({ clientId: entry.clientId, coveringCamId: entry.coveringCamId }));

  const toCover = (camById.get(absentCamId)?.clientIds || []);
  const planByClient = new Map(plan.map((row) => [row.clientId, row.coveringCamId]));

  // Clients the absent CAM owns, plus any client the plan names that they no
  // longer own — a reassignment away mid-window leaves a real row behind and
  // dropping it from the table would hide a cover that is still in force.
  const clientIds = [...toCover];
  for (const row of plan) if (!clientIds.includes(row.clientId)) clientIds.push(row.clientId);

  const rows = clientIds.map((clientId) => {
    const client = clientById.get(clientId);
    const coveringCamId = planByClient.get(clientId) || '';
    const entry = storedByClient.get(clientId) || null;
    return {
      // null, not '', when no row exists yet: "not saved" and "saved with a
      // blank id" are different claims and handleEndCoverage reads this id.
      coverageId: entry?.id || null,
      clientId,
      clientName: client?.name || clientId,
      accounts: client ? accountsOf(client) : null,
      coveringCamId,
      coveringCamName: coveringCamId ? (camById.get(coveringCamId)?.name || coveringCamId) : '',
      startDate: entry?.startDate || startDate,
      endDate: entry?.endDate || endDate,
      note: entry?.note || '',
      blockedReason: coveringCamId ? coverageBlockReason(coveringCamId, request, timeOff) : null,
    };
  });

  const addedByCam = new Map();
  for (const row of rows) {
    if (!row.coveringCamId) continue;
    const current = addedByCam.get(row.coveringCamId) || { clients: 0, accounts: 0, unmeasured: 0 };
    current.clients += 1;
    // row.accounts is null for a client with no record. `+= row.accounts || 0`
    // would turn "not measured" into "nought more work", printing a clean total
    // beside a table cell that says not measured. Counted separately instead.
    if (row.accounts === null) current.unmeasured += 1;
    else current.accounts += row.accounts;
    addedByCam.set(row.coveringCamId, current);
  }

  const byCam = base.map((row) => {
    const added = addedByCam.get(row.camProfileId) || { clients: 0, accounts: 0, unmeasured: 0 };
    return {
      camProfileId: row.camProfileId,
      name: row.name,
      away: row.away,
      blockedReason: coverageBlockReason(row.camProfileId, request, timeOff),
      baseClients: row.clients,
      baseAccounts: row.accounts,
      addedClients: added.clients,
      addedAccounts: added.accounts,
      totalClients: row.clients + added.clients,
      totalAccounts: row.accounts + added.accounts,
      // How many of the clients behind those account figures had no record to
      // count. 0 means "every one was counted", never "we did not look".
      baseUnmeasured: row.unmeasured,
      totalUnmeasured: row.unmeasured + added.unmeasured,
    };
  }).sort((a, b) => b.addedClients - a.addedClients
    || b.totalClients - a.totalClients
    || a.name.localeCompare(b.name));

  const covered = rows.filter((row) => row.coveringCamId).length;
  return {
    requestId: request?.id || '',
    absentCamId,
    absentCamName: camById.get(absentCamId)?.name || absentCamId,
    startDate,
    endDate,
    rows,
    byCam,
    clientsToCover: rows.length,
    covered,
    uncovered: rows.length - covered,
    blocked: rows.filter((row) => row.blockedReason).length,
  };
}

/**
 * Which committed rows a draft actually changes — the rows a Save would move.
 *
 * Lives here rather than inline in TimeOffPanel because that is the difference
 * between an enabled and a disabled Save button, and there is no DOM test runner
 * in this repo (no jsdom, no testing-library — renderToStaticMarkup only), so
 * anything left inside the component is unreachable by any test. A deliberately
 * broken `dirty` check survived a mutation run against the whole suite: Save
 * would have stayed greyed out forever and nothing would have said so.
 *
 * Both sides are normalised to '' so "no cover" compares equal however it is
 * spelled — a stored row is '' and an untouched entry in the plan is undefined.
 */
export function coverageDraftChanges(committedRows = [], plan = {}) {
  return (committedRows || []).filter((row) => (
    (plan?.[row.clientId] || '') !== (row.coveringCamId || '')
  ));
}

/**
 * What to tell a manager about requests nobody has decided yet.
 *
 * `pending` counts status === 'Pending' and nothing else — never a total of the
 * timeOff table, which on a desk that has been running a while is overwhelmingly
 * decided rows. `expired` is split out because a request whose dates have
 * already passed is not the same ask as one for next week, and one number would
 * hide the difference.
 *
 * When `date` is unusable the day-relative split cannot be computed, so
 * actionable/expired/soonest are null. Not 0 — "no request needs you today" and
 * "I could not work out what today is" are different claims.
 */
export function pendingTimeOffAlert(timeOff = [], date) {
  const pendingRequests = (timeOff || []).filter((request) => request?.status === TIME_OFF_STATUSES.PENDING);
  const today = toDate(date);
  if (!today) {
    return { pending: pendingRequests.length, actionable: null, expired: null, soonest: null, requests: pendingRequests };
  }
  const actionable = pendingRequests.filter((request) => (
    (toDate(request.endDate) || toDate(request.startDate)) >= today
  ));
  const soonest = actionable
    .map((request) => toDate(request.startDate))
    .filter(Boolean)
    .sort()[0] || null;
  return {
    pending: pendingRequests.length,
    actionable: actionable.length,
    expired: pendingRequests.length - actionable.length,
    soonest,
    requests: pendingRequests,
  };
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
