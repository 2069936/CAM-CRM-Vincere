// Account lifecycle: born (dateAdded) -> algos it ran (from algoHistory) ->
// outcome (funded / failed / still active). Built from the CSV-driven account
// meta (not logs). Two views: one account's timeline, and per-algo aggregates
// (which combo gets accounts funded, lasts longer, survives) so a CAM/manager can
// see which configuration makes accounts win.

import { isCashType } from './reconcile';

function toDate(value) {
  return value ? new Date(`${value}T00:00:00Z`) : null;
}

function daysBetween(a, b) {
  const da = toDate(a);
  const db = toDate(b);
  if (!da || !db) return null;
  const d = Math.round((db - da) / 86400000);
  return d >= 0 ? d : null;
}

// The lifecycle timeline for one account. asOf (YYYY-MM-DD) dates the "still
// alive" end; defaults to the account's last known date.
export function buildAccountLifecycle(account = {}, { asOf = '' } = {}) {
  const born = account.dateAdded || '';
  const funded = account.dateFunded || '';
  const died = account.dateFailed || '';
  const outcome = died ? 'failed' : funded || account.accountType === 'Funded' ? 'funded' : 'active';
  const end = died || asOf || funded || born;
  const daysAlive = born ? daysBetween(born, end) : null;

  const history = [...(account.algoHistory || [])].sort((a, b) =>
    String(a.date || '').localeCompare(String(b.date || '')),
  );
  const phases = [];
  let cursor = born;
  let algo = history.length ? history[0].from || account.algoStack || '' : account.algoStack || '';
  for (const change of history) {
    if (cursor && change.date) {
      phases.push({ algo: algo || '-', start: cursor, end: change.date, days: daysBetween(cursor, change.date) });
    }
    cursor = change.date;
    algo = change.to;
  }
  if (cursor && end) {
    phases.push({ algo: algo || account.algoStack || '-', start: cursor, end, days: daysBetween(cursor, end) });
  }

  return {
    accountName: account.accountName,
    alias: account.alias || account.accountName,
    born,
    funded,
    died,
    outcome,
    daysAlive,
    currentAlgo: account.algoStack || algo || '',
    phases,
  };
}

// Per-algo (algoStack combo) lifecycle aggregates across clients: funded rate,
// average lifespan, average days-to-fund. Cash / ignored accounts excluded.
export function buildLifecycleByAlgo(clients = [], { asOf = '' } = {}) {
  const byCombo = {};
  for (const client of clients || []) {
    for (const meta of Object.values(client.accountRegistry || {})) {
      if (isCashType(meta.accountType) || meta.accountType === 'Inactive / Ignore') continue;
      const combo = meta.algoStack || 'Unassigned';
      if (!byCombo[combo]) {
        byCombo[combo] = { combo, accounts: 0, funded: 0, failed: 0, active: 0, lifespans: [], daysToFund: [] };
      }
      const g = byCombo[combo];
      g.accounts += 1;
      if (meta.dateFailed) g.failed += 1;
      else if (meta.dateFunded || meta.accountType === 'Funded') g.funded += 1;
      else g.active += 1;

      const end = meta.dateFailed || asOf || meta.dateFunded || meta.dateAdded;
      const life = meta.dateAdded ? daysBetween(meta.dateAdded, end) : null;
      if (life != null) g.lifespans.push(life);
      const ttf = meta.dateAdded && meta.dateFunded ? daysBetween(meta.dateAdded, meta.dateFunded) : null;
      if (ttf != null) g.daysToFund.push(ttf);
    }
  }
  const avg = (arr) => (arr.length ? Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 10) / 10 : null);
  return Object.values(byCombo)
    .map((g) => ({
      combo: g.combo,
      accounts: g.accounts,
      funded: g.funded,
      failed: g.failed,
      active: g.active,
      fundedRate: g.accounts ? Math.round((g.funded / g.accounts) * 100) : 0,
      avgLifespan: avg(g.lifespans),
      avgDaysToFund: avg(g.daysToFund),
    }))
    .sort((a, b) => b.fundedRate - a.fundedRate || b.accounts - a.accounts);
}
