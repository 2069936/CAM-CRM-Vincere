// The open-flag queue a CAM can work from without standing on the client and
// the day the flag was raised.
//
// Every existing way to close a flag reads the client and the import from
// whatever the user is currently looking at. handleResolveFlag in App.jsx takes
// (flagId, status) and gets the rest from `selectedClient` and `dailyImport`,
// and its first line is `if (!selectedClient || !dailyImport) return;`. On the
// real book that line is not a guard, it is the normal case: the last close is
// 2026-07-30 and the date picker opens on today, so a CAM who clicks a client
// lands on a day with no import and the button does nothing. Everything here
// carries the client id and the import id with the row, so a resolution names
// the flag it means.
//
// Why the queue looks past the latest close. buildFlagAging and the manager's
// open-flags table both count the latest close only, and they are right to:
// a still-open flag is re-derived into every import, so summing history counts
// one problem once per day it survived (1,952 rows against the 253 real ones —
// the same inflation the "Critical flags" tile in CamOverview still shows). But
// counting is not working. Of the 1,699 open rows behind the latest close,
// 1,102 have no open twin on it at all: 829 distinct problems across 43 clients
// that no screen in the app can currently reach. Two CAMs — Ellis Glen and
// Oakley Ash — have zero open flags on any latest close and 315 and 269 behind
// it, so their entire flag workload is invisible and unactionable.
//
// So the queue takes every open occurrence and collapses it by problem, not by
// row: one row per client + type + account + message, carrying every open
// occurrence's (importId, flagId). Resolving the row resolves all of them. That
// is deliberate — updateSupabaseOperationalFlag patches a single uuid, so
// closing only the latest-close row leaves its 597 historical copies Open in
// Postgres, which is exactly what keeps feeding the inflated counter.

import { daysBetween, FLAG_AGE_BUCKETS } from './overviewCharts';
import { resolveFlagInImport } from './crmStateStore';
import { updateSupabaseOperationalFlag } from './supabaseStore';

/**
 * Field separator for the composite keys below.
 *
 * Not '/' and not '|'. Flag messages quote parameter values, and those contain
 * slashes — a NinjaTrader time is written `1/1/2020 4:45:00 PM` — which is the
 * defect strategyConfigDrift.js carries a comment about. '|' is what reconcile
 * and overviewCharts use and has not bitten yet, but an account alias is free
 * text typed by a human and nothing stops one containing a pipe. U+0001 cannot
 * occur in any of these fields.
 */
const SEP = '\u0001';

/** An import date the app can compare and subtract. Anything else is kept but
 * never dated — dropping such an import would hide its flags from the only
 * screen that can close them. */
const DATE = /^\d{4}-\d{2}-\d{2}/;

/** Statuses that mean the CAM still has work to do. Same rule as buildFlagAging
 * and the manager's open-flags table: a missing status is Open, and Ignored is
 * deliberately still open — it was never a triage state anyone chose here.
 *
 * 'Acknowledged' is still excluded even though nothing writes it any more. The
 * desk manager removed the Acknowledge action, not the 460 rows already carrying
 * that status (409 Warning, 51 Critical, against 4,141 Resolved and 1,952 Open on
 * the book). Every one of them was a CAM deciding he had seen the thing and it
 * needed no further work, and every read path in the app has always treated the
 * status exactly as it treats Resolved. Dropping the check here would put those
 * 460 back into this queue — the one screen that can reach flags stranded behind
 * a client's latest close — as if the work had never been done. supabase/
 * step_38_flag_acknowledged_to_resolved.sql converts them in Postgres and records
 * what they were; this line is what keeps an un-migrated database honest in the
 * meantime, and what keeps an old export (public/local-snapshot.json included)
 * readable afterwards. */
export function isFlagOpen(flag) {
  const status = flag?.status || 'Open';
  return status !== 'Resolved' && status !== 'Acknowledged';
}

/**
 * A flag's identity across days.
 *
 * reconcile re-derives every flag on every import with a fresh uuid
 * (newFlagId, reconcile.js:111), so the id cannot answer "is this the same
 * problem as yesterday". Type, account and message can — the same key
 * Recalculate uses to carry triage forward, and the same one buildFlagAging
 * uses to age a flag. The id stays on the occurrence, because the id is what
 * Postgres updates.
 *
 * The same key also collapses duplicates inside one import, and the book has
 * them: 51 imports carry 132 open rows that repeat a key they already hold —
 * Devon North's 2026-07-23 close has six identical "Strategy disabled" rows
 * with no account name. Six buttons a CAM cannot tell apart are one problem.
 *
 * Caveat when reading counts off public/local-snapshot.json: redaction replaces
 * each message with `[redacted <length>]`, so two different messages of equal
 * length are identical there and merge. On the live book they differ. The 132
 * is therefore an upper bound on same-import merging, not a measurement of it.
 */
function flagKey(flag) {
  return [flag.type || '', flag.accountName || '', flag.message || ''].join(SEP);
}

/** Critical outranks everything. A problem can be raised Warning on one close
 * and Critical on a later one; the row should read at its worst. */
function worstSeverity(a, b) {
  if (a === 'Critical' || b === 'Critical') return 'Critical';
  return a || b || 'Warning';
}

/** Descending, with "not measured" last rather than treated as zero. A null age
 * is a flag whose date could not be read; sorting it as 0 would bury it under
 * everything and quietly claim it was raised today. */
function byAgeDesc(a, b) {
  if (a.ageDays === null && b.ageDays === null) return 0;
  if (a.ageDays === null) return 1;
  if (b.ageDays === null) return -1;
  return b.ageDays - a.ageDays;
}

function bucketFor(ageDays) {
  if (ageDays === null || ageDays < 0) return 'unknown';
  return FLAG_AGE_BUCKETS.find((bucket) => ageDays <= bucket.maxAge).key;
}

/**
 * Every open flag a CAM holds, one row per problem, oldest run first.
 *
 * `today` anchors the age. Pass the same value the rest of the overview uses;
 * with the local snapshot (book ends 2026-07-30, "today" 2026-08-11) every
 * single row lands in the 14+ bucket because the export is twelve days stale.
 * That is a property of the snapshot, not of the book — read the bucket counts
 * against `asOf` and `latestClose`, both returned here for that reason.
 */
export function buildCamFlagQueue(clients = [], options = {}) {
  const { today = null, resolvedWindowDays = 7 } = options;
  const asOf = today ? String(today).slice(0, 10) : null;
  const groups = new Map();
  let latestClose = null;
  const recentlyClosed = [];
  // The most recent resolution ANYWHERE in the book, window or no window.
  //
  // Without it the panel's closing line renders "0 flags were closed in the last
  // 7 days" — a real zero for a measurement whose window does not overlap the
  // data. On this book 4,601 of the 6,553 flags are closed, 4,573 of them dated,
  // and 2,970 were closed in the seven days up to 2026-07-30; the window
  // 2026-08-04 → 2026-08-11 is empty only because the export ends twelve days
  // before "today". "Nobody is working the queue" and "the export is stale" are
  // different claims and this is what tells them apart.
  let lastClosedOn = null;
  let closedTotal = 0;
  const closedCutoff = asOf && Number.isFinite(resolvedWindowDays)
    ? new Date(Date.parse(`${asOf}T00:00:00Z`) - resolvedWindowDays * 86400000)
      .toISOString()
      .slice(0, 10)
    : null;

  for (const client of clients || []) {
    const usable = (client.dailyImports || []).filter((entry) => entry?.id && entry?.date);
    // An import whose date is not an ISO day cannot be compared to `asOf`, and
    // dropping it would hide its flags entirely — a date the app failed to read
    // is not a reason for a CAM never to see the flag. It is kept, sorted last,
    // and never allowed to be the latest close; its flags simply have no age.
    const dated = usable
      .filter((entry) => DATE.test(String(entry.date)))
      .filter((entry) => !asOf || String(entry.date).slice(0, 10) <= asOf)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const undated = usable.filter((entry) => !DATE.test(String(entry.date)));
    const imports = [...dated, ...undated];
    if (!imports.length) continue;

    const latest = dated[dated.length - 1] || null;
    if (latest && (!latestClose || String(latest.date) > latestClose)) latestClose = String(latest.date);

    const rows = new Map();
    for (const entry of imports) {
      for (const flag of entry.flags || []) {
        if (!flag?.id) continue;
        if (!isFlagOpen(flag)) {
          // Closed rows are not queue work, but they are the receipt that the
          // queue changes nothing it cannot show: status and resolvedAt stay on
          // the row, no flag is ever deleted.
          const closedOn = String(flag.resolvedAt || '').slice(0, 10);
          closedTotal += 1;
          if (closedOn && (!asOf || closedOn <= asOf) && (!lastClosedOn || closedOn > lastClosedOn)) {
            lastClosedOn = closedOn;
          }
          if (closedOn && (!closedCutoff || closedOn >= closedCutoff) && (!asOf || closedOn <= asOf)) {
            recentlyClosed.push({
              clientId: client.id,
              clientName: client.name,
              type: flag.type || '',
              accountName: flag.accountName || '',
              message: flag.message || '',
              status: flag.status,
              date: entry.date,
              closedOn,
            });
          }
          continue;
        }
        const key = flagKey(flag);
        if (!rows.has(key)) {
          rows.set(key, {
            key: [client.id, key].join(SEP),
            clientId: client.id,
            clientName: client.name || '',
            type: flag.type || '',
            severity: flag.severity || 'Warning',
            accountName: flag.accountName || '',
            message: flag.message || '',
            occurrences: [],
          });
        }
        const row = rows.get(key);
        row.severity = worstSeverity(row.severity, flag.severity);
        row.occurrences.push({
          flagId: flag.id,
          importId: entry.id,
          clientId: client.id,
          date: entry.date,
          status: flag.status || 'Open',
        });
      }
    }

    for (const row of rows.values()) {
      // Occurrences arrive in import order because `dated` is sorted ascending
      // and the undated ones are appended after it. Only the datable ones can
      // say when the problem started.
      const days = row.occurrences.map((entry) => entry.date).filter((date) => DATE.test(String(date)));
      const firstSeen = days[0] || null;
      const lastSeen = days[days.length - 1] || null;
      row.firstSeen = firstSeen;
      row.lastSeen = lastSeen;
      // Age is measured from the first close the problem appeared on, not the
      // row's own date — otherwise every flag reads zero days old, since a
      // still-open flag is rewritten into today's import. No date, no age: null,
      // which the queue prints as "not measured".
      row.ageDays = asOf && firstSeen ? daysBetween(firstSeen, asOf) : null;
      row.bucket = bucketFor(row.ageDays);
      row.onLatestClose = Boolean(latest) && row.occurrences.some((entry) => entry.importId === latest.id);
      row.clientLatestClose = latest ? latest.date : null;

      const groupKey = [row.type, client.id].join(SEP);
      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          key: groupKey,
          type: row.type,
          clientId: client.id,
          clientName: client.name || '',
          clientLatestClose: latest ? latest.date : null,
          rows: [],
        });
      }
      groups.get(groupKey).rows.push(row);
    }
  }

  const groupRows = [...groups.values()].map((group) => {
    const rows = group.rows.slice().sort((a, b) => (
      byAgeDesc(a, b)
      || (a.severity === b.severity ? 0 : a.severity === 'Critical' ? -1 : 1)
      || String(a.accountName).localeCompare(String(b.accountName))
    ));
    const ages = rows.map((row) => row.ageDays).filter((age) => age !== null);
    return {
      ...group,
      rows,
      total: rows.length,
      occurrences: rows.reduce((sum, row) => sum + row.occurrences.length, 0),
      critical: rows.filter((row) => row.severity === 'Critical').length,
      behindLatestClose: rows.filter((row) => !row.onLatestClose).length,
      // null, not 0: a group whose dates could not be read has an unknown age,
      // and "brand new" is a different claim from "cannot tell".
      oldestDays: ages.length ? Math.max(...ages) : null,
      // Null rather than an empty string when no row in the group could be
      // dated, so the header can say "not measured" instead of printing a blank
      // that reads like a missing field.
      firstSeen: rows.map((row) => row.firstSeen).filter(Boolean).sort()[0] || null,
      lastSeen: rows.map((row) => row.lastSeen).filter(Boolean).sort().at(-1) || null,
    };
  }).sort((a, b) => (
    byAgeDesc({ ageDays: a.oldestDays }, { ageDays: b.oldestDays })
    || b.total - a.total
    || String(a.clientName).localeCompare(String(b.clientName))
  ));

  const allRows = groupRows.flatMap((group) => group.rows);
  const buckets = [
    ...FLAG_AGE_BUCKETS.map((bucket) => ({ key: bucket.key, label: bucket.label, rows: 0 })),
    { key: 'unknown', label: 'Not measured', rows: 0 },
  ];
  const bucketIndex = Object.fromEntries(buckets.map((bucket) => [bucket.key, bucket]));
  for (const row of allRows) bucketIndex[row.bucket].rows += 1;

  return {
    asOf,
    latestClose,
    // The window `recentlyClosed` was actually measured over, so a zero in it
    // can be read against the dates that produced it rather than as a fact
    // about the desk. Null `from` means no window was applied.
    closedWindow: { from: closedCutoff, to: asOf },
    lastClosedOn,
    closedTotal,
    groups: groupRows,
    buckets,
    recentlyClosed: recentlyClosed.sort((a, b) => String(b.closedOn).localeCompare(String(a.closedOn))),
    totals: {
      // `rows` is problems; `occurrences` is database rows. They differ by the
      // historical copies of a problem that is still open, and reporting the
      // second as if it were the first is what put 1,900 on a header reading
      // 253.
      rows: allRows.length,
      occurrences: allRows.reduce((sum, row) => sum + row.occurrences.length, 0),
      critical: allRows.filter((row) => row.severity === 'Critical').length,
      warning: allRows.filter((row) => row.severity !== 'Critical').length,
      onLatestClose: allRows.filter((row) => row.onLatestClose).length,
      behindLatestClose: allRows.filter((row) => !row.onLatestClose).length,
      groups: groupRows.length,
      clients: new Set(allRows.map((row) => row.clientId)).size,
      oldestDays: allRows.reduce(
        (oldest, row) => (row.ageDays === null ? oldest : oldest === null || row.ageDays > oldest ? row.ageDays : oldest),
        null,
      ),
      recentlyClosed: recentlyClosed.length,
    },
  };
}

/**
 * The write calls one queue action makes: one per open occurrence, each naming
 * its own import.
 *
 * This is the whole point of the module. The manager's callback signature —
 * onResolveFlag(clientId, importId, flagId) — already takes the ids
 * explicitly; what was missing was somewhere to get them from other than the
 * screen the user happens to be on. A row that appeared on eleven closes
 * produces eleven calls with eleven different importIds, and the flagId in each
 * is the uuid of the row in that import — never the latest one's, which is what
 * a "resolve what's on screen" handler would send.
 */
export function flagResolutionPlan(row) {
  if (!row || !Array.isArray(row.occurrences)) return [];
  return row.occurrences.map((occurrence) => ({
    clientId: occurrence.clientId || row.clientId,
    importId: occurrence.importId,
    flagId: occurrence.flagId,
  }));
}

/**
 * The client-activity entry a resolution leaves behind.
 *
 * Same wording as handleResolveFlag's, so a client's log reads the same however
 * the flag was closed, plus the date it was raised: the CAM is closing this
 * from the overview and is no longer standing on that day, and a log line that
 * does not say which close it refers to is unreadable a fortnight later — which
 * is the median age here.
 */
export function flagActivityEntry(row, options = {}) {
  if (!row) return null;
  const now = options.now || new Date().toISOString();
  const raised = row.firstSeen ? ` (raised ${row.firstSeen})` : '';
  return {
    id: options.id || `act-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: 'Alert',
    text: `Flag resolved: [${row.type}] ${row.message}${raised}`,
    accountName: row.accountName || '',
    createdAt: now,
  };
}

/**
 * One summary line for a whole group, the shape handleBulkResolveFlags already
 * writes for a whole import ("Bulk resolved 7 flags").
 *
 * Groups here run to 19 rows on the real book — Harper Juniper's "Expected
 * strategy missing" — and 19 individual log lines from one click would bury the
 * client's activity log under the tool that made them. The date range is in the
 * text because the group spans closes the CAM was never standing on.
 */
export function flagGroupActivityEntry(group, options = {}) {
  if (!group || !group.rows?.length) return null;
  const count = group.rows.length;
  const span = group.lastSeen && group.lastSeen !== group.firstSeen
    ? `${group.firstSeen} → ${group.lastSeen}`
    : group.firstSeen;
  return {
    id: options.id || `act-${Date.now()}-bulk`,
    type: 'Alert',
    text: `Bulk resolved ${count} flag${count === 1 ? '' : 's'} [${group.type}] raised ${span}`,
    accountName: '',
    createdAt: options.now || new Date().toISOString(),
  };
}

/**
 * The onResolveFlag the CAM overview should be wired with.
 *
 * Deliberately the manager's callback, not the Dashboard's: same signature,
 * same two writes — the local patch through resolveFlagInImport and the single
 * uuid update through updateSupabaseOperationalFlag — so there is exactly one
 * write path for a flag resolution and the uuid guard in supabaseStore stays
 * the only gate. The one difference is the audit `source`, which reads
 * "cam-overview" instead of "manager": the two views close flags a CAM cannot
 * otherwise reach, and after the fact the audit trail is the only way to tell
 * who closed 1,102 stranded flags and from where.
 *
 * Everything is injected rather than imported so this can be tested without a
 * Supabase client, and so App.jsx keeps passing its own setState and audit
 * helper.
 */
export function createCamFlagResolver({
  setState,
  patchState = resolveFlagInImport,
  updateFlag = updateSupabaseOperationalFlag,
  audit = null,
  onError = null,
  source = 'cam-overview',
} = {}) {
  return function resolveFlag(clientId, importId, flagId) {
    if (!clientId || !importId || !flagId) {
      // Silence here would look exactly like a resolution that worked: the row
      // would vanish from the queue and come back on the next load. The three
      // ids are the whole contract of this callback.
      const error = new Error(
        `Flag resolution needs a client, an import and a flag (got ${clientId || 'null'}, ${importId || 'null'}, ${flagId || 'null'}).`,
      );
      if (onError) onError(error);
      else throw error;
      return null;
    }
    const patch = (next) => {
      if (setState && patchState) setState((current) => patchState(current, clientId, importId, flagId, next));
    };
    patch('Resolved');
    return Promise.resolve(updateFlag(flagId, 'Resolved'))
      .then((result) => {
        if (audit) {
          audit({
            entityType: 'operational_flag',
            entityId: flagId,
            action: 'flag.resolve',
            afterData: { clientId, importId, flagId, status: 'Resolved', source },
          });
        }
        return result;
      })
      .catch((error) => {
        // Put the row back. The local patch above is optimistic, and without
        // this a failed write leaves the flag Resolved on screen and Open in
        // Postgres — the row disappears from the queue, the CAM moves on, and
        // it is back on the next load with no record of the attempt. That is
        // strictly worse than the error alert, because the alert can be missed
        // and the queue is the only place these 1,102 stranded flags are
        // reachable from.
        //
        // 'Open' is exact rather than approximate here: isFlagOpen also treats
        // 'Ignored' as open, but operational_flags.status holds only Open,
        // Resolved and Acknowledged on the real book (1,952 / 4,141 / 460 of
        // 6,553), the queue only ever offers rows isFlagOpen called open, and
        // Resolved is now the only status the product writes at all.
        patch('Open');
        if (onError) onError(error);
        else throw error;
        return null;
      });
  };
}
