// Charts for the three overviews.
//
// Each view asks a different question, so none of these repeat the P&L curve
// that already lives on the client page. A CAM wants to know who is slipping; a
// manager wants to know where the problem is and whose it is. Answering both
// with "how much did we make" would be a chart nobody acts on.
//
// Every function here is pure: state in, plain data out. The components draw.

import { isCashType } from './reconcile';
import { drawdownThresholds } from './derivedAccountMetrics';

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function camIndex(camProfiles = []) {
  const clientCam = {};
  for (const cam of camProfiles) {
    for (const id of cam.clientIds || []) clientCam[id] = cam.id;
  }
  return clientCam;
}

function latestImport(client) {
  const imports = (client?.dailyImports || [])
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return imports[imports.length - 1] || null;
}

/** Whole days between two ISO dates, ignoring clock time. */
export function daysBetween(fromIso, toIso) {
  const from = Date.parse(`${String(fromIso).slice(0, 10)}T00:00:00Z`);
  const to = Date.parse(`${String(toIso).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / 86400000);
}

/* ── Client view ──────────────────────────────────────────────────────────── */

/**
 * How much room each prop account has left before its trailing limit.
 *
 * Today this only exists per account, one chart at a time, so the number that
 * actually ends accounts is the one a CAM has to go looking for. Ranked
 * ascending puts the account closest to breaching at the top.
 *
 * Cash accounts are absent by construction, not filtered as an afterthought:
 * trailing is a prop-firm rule and a cash account has none, so a buffer for one
 * would be a distance to a limit that does not exist.
 */
export function buildTrailingBuffer(client, dailyImport = null) {
  const target = dailyImport || latestImport(client);
  if (!target) return [];
  const registry = client?.accountRegistry || {};

  return (target.snapshots || [])
    .map((snapshot) => {
      const meta = registry[snapshot.accountName] || {};
      if (isCashType(meta.accountType)) return null;
      const limit = numeric(meta.maxDrawdownLimit);
      if (limit === null || limit <= 0) return null;

      const used = Math.abs(numeric(snapshot.trailingMaxDrawdown) ?? 0);
      const buffer = limit - used;
      // A derived trailing figure is a lower bound, so its thresholds sit wider:
      // treating it like a reported one would call an account safe on evidence
      // that cannot support it.
      const thresholds = drawdownThresholds(snapshot.trailingSource);

      let status = 'ok';
      if (buffer <= thresholds.critical) status = 'critical';
      else if (buffer <= thresholds.warning) status = 'warning';

      return {
        accountName: snapshot.accountName,
        alias: meta.alias || snapshot.accountName,
        limit,
        used,
        buffer,
        usedPct: Math.max(0, Math.min(100, (used / limit) * 100)),
        status,
        isLowerBound: snapshot.trailingSource === 'derived',
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.buffer - b.buffer);
}

/**
 * Which algorithms made and lost money.
 *
 * The first question after a bad day is "which one did that", and the answer is
 * currently spread across a strategies table. Losers are kept, not dropped:
 * a chart of only the winners would answer the opposite question.
 */
export function buildAlgoContribution(client, dailyImport = null) {
  const target = dailyImport || latestImport(client);
  if (!target) return [];

  const totals = new Map();
  for (const strategy of target.strategies || []) {
    const name = String(strategy.strategyName || '').trim();
    if (!name) continue;
    const realized = numeric(strategy.realized) ?? 0;
    const current = totals.get(name) || { name, realized: 0, accounts: new Set() };
    current.realized += realized;
    if (strategy.accountName) current.accounts.add(strategy.accountName);
    totals.set(name, current);
  }

  const rows = [...totals.values()].map((row) => ({
    name: row.name,
    realized: row.realized,
    accounts: row.accounts.size,
  }));

  // Scaled against the largest absolute move so a chart of only-losses still
  // has a full-width bar rather than collapsing to nothing.
  const peak = rows.reduce((max, row) => Math.max(max, Math.abs(row.realized)), 0) || 1;
  return rows
    .map((row) => ({ ...row, share: (Math.abs(row.realized) / peak) * 100 }))
    .sort((a, b) => b.realized - a.realized);
}

/* ── CAM view ─────────────────────────────────────────────────────────────── */

/** Trading days ending on `today`, most recent last. Weekends are not days. */
export function recentTradingDays(today, count = 10) {
  const days = [];
  const cursor = new Date(`${String(today).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime())) return days;
  while (days.length < count) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) days.unshift(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return days;
}

/**
 * Which clients have been uploaded on each of the last trading days.
 *
 * A CAM with forty clients cannot see a gap by reading a list. Ranked by misses
 * so the client who has been skipped most is first, which is the one that
 * actually needs attention.
 */
export function buildUploadCoverage(clients = [], today, days = 10) {
  const window = recentTradingDays(today, days);
  const windowSet = new Set(window);

  const rows = clients.map((client) => {
    const uploaded = new Set(
      (client.dailyImports || [])
        .map((entry) => String(entry.date).slice(0, 10))
        .filter((date) => windowSet.has(date)),
    );
    const cells = window.map((date) => ({ date, uploaded: uploaded.has(date) }));
    return {
      clientId: client.id,
      clientName: client.name,
      cells,
      missed: cells.filter((cell) => !cell.uploaded).length,
    };
  });

  return { days: window, rows: rows.sort((a, b) => b.missed - a.missed) };
}

/**
 * The shape of a CAM's book by account type.
 *
 * Counts accounts, not clients: a client with one evaluation and eight funded
 * accounts is not the same workload as one with a single cash account, and
 * counting heads hides that.
 */
export function buildBookMix(clients = []) {
  const counts = new Map();
  for (const client of clients) {
    for (const meta of Object.values(client.accountRegistry || {})) {
      const type = String(meta.accountType || 'Unclassified').trim() || 'Unclassified';
      counts.set(type, (counts.get(type) || 0) + 1);
    }
  }
  const rows = [...counts.entries()].map(([type, count]) => ({ type, count }));
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return rows
    .map((row) => ({ ...row, share: total ? (row.count / total) * 100 : 0 }))
    .sort((a, b) => b.count - a.count);
}

/* ── Manager view ─────────────────────────────────────────────────────────── */

export const FLAG_AGE_BUCKETS = [
  { key: 'today', label: 'Today', maxAge: 0 },
  { key: 'week', label: '1-6 days', maxAge: 6 },
  { key: 'stale', label: '7-13 days', maxAge: 13 },
  { key: 'rotten', label: '14+ days', maxAge: Infinity },
];

/**
 * Open flags per CAM, bucketed by how long they have been open.
 *
 * Counting flags alone ranks a CAM who caught five things this morning below
 * one sitting on two from a fortnight ago, which inverts the thing a manager
 * needs to see. Sorted by the oldest bucket first for the same reason.
 */
export function buildFlagAging(clients = [], camProfiles = [], today) {
  const clientCam = camIndex(camProfiles);
  const byCam = new Map();
  const ensure = (camId, name) => {
    if (!byCam.has(camId)) {
      byCam.set(camId, {
        camId,
        camName: name,
        buckets: Object.fromEntries(FLAG_AGE_BUCKETS.map((bucket) => [bucket.key, 0])),
        total: 0,
        oldestDays: 0,
      });
    }
    return byCam.get(camId);
  };
  const camName = Object.fromEntries(camProfiles.map((cam) => [cam.id, cam.name]));

  for (const client of clients) {
    const camId = clientCam[client.id] || 'unassigned';
    for (const dailyImport of client.dailyImports || []) {
      for (const flag of dailyImport.flags || []) {
        if ((flag.status || 'Open') !== 'Open') continue;
        const age = daysBetween(dailyImport.date, today);
        if (age === null || age < 0) continue;
        const row = ensure(camId, camName[camId] || 'Unassigned');
        const bucket = FLAG_AGE_BUCKETS.find((entry) => age <= entry.maxAge);
        row.buckets[bucket.key] += 1;
        row.total += 1;
        if (age > row.oldestDays) row.oldestDays = age;
      }
    }
  }

  return [...byCam.values()].sort((a, b) => (
    b.oldestDays - a.oldestDays || b.total - a.total
  ));
}

// Coverage load is not built here on purpose. buildCamWorkload in camCoverage.js
// already answers it, and it is the same figure the manager sees when
// distributing an absent CAM's clients. A second implementation would drift
// from the one the distribution actually uses.
