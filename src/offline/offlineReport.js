/* ---------------------------------------------------------------------------
 * A CLIENT'S DAILY REPORT, BUILT ON THE MACHINE, WITH NO CRM.
 *
 * On 2026-09-25 the database stopped answering at 16:30 and did not come back
 * for three days. Six of eleven client reports had been sent; five had not, and
 * the rest of the desk could not export at all. The captures existed the whole
 * time - the agent had queued them on disk, which is what the queue is for -
 * and there was no way to turn them into the thing the desk sells.
 *
 * THIS RUNS THE SAME PIPELINE THE SERVER RUNS. Not a re-implementation, not an
 * approximation: the same three functions, in the same order, from the same
 * files the ingest imports.
 *
 *   normalizeAutoImportSnapshot   src/domain/autoImport.js
 *   reconcileDailyImport          src/domain/reconcile.js
 *   buildDailyReportSummary       src/domain/report.js
 *
 * So the numbers cannot drift from the CRM's, because there is only one set of
 * numbers. What differs is where the roster comes from and what is done about
 * the accounts it cannot explain.
 *
 * THE ROSTER IS THE ONLY THING THE CAPTURE CANNOT SUPPLY. NinjaTrader knows
 * balances and P&L; it does not know that an account is an evaluation. The CRM
 * sends the classification down on every upload response and the agent keeps
 * the last copy. An account opened since that copy was taken is not in it.
 *
 * Those are marked PENDING_CLASSIFICATION, which report.js shows and does not
 * count. That rule is the whole reason this is safe to put in front of a
 * client: on a real capture from 2026-09-22, counting the unknown accounts
 * reads +$1,565 against a true $0.00, because the money moved in two evaluation
 * accounts holding challenge capital the client does not own. Even five of six
 * accounts correctly typed still reads +$1,548.28. Mostly classified is worth
 * nothing here.
 * ------------------------------------------------------------------------- */

import { normalizeAutoImportSnapshot } from '../domain/autoImport.js';
import { ACCOUNT_TYPES, reconcileDailyImport } from '../domain/reconcile.js';
import { buildDailyReportSummary } from '../domain/report.js';

/** Beyond this, the roster has been wrong often enough to say so on the page. */
export const ROSTER_STALE_DAYS = 7;

function lowerKeyed(roster = {}) {
  const out = new Map();
  for (const [name, account] of Object.entries(roster || {})) {
    if (name) out.set(String(name).toLowerCase(), { ...account, accountName: name });
  }
  return out;
}

function daysBetween(fromIso, toIso) {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.floor((to - from) / 86400000);
}

/**
 * The registry the report reads, with every account the capture holds.
 *
 * An account the roster explains keeps its classification. One it does not is
 * named rather than guessed at, and `report.js` keeps it out of the total.
 */
export function registryForCapture(parsed, roster = {}) {
  const byLower = lowerKeyed(roster);
  const registry = {};
  const pending = [];
  for (const account of parsed?.accounts || []) {
    const name = account?.accountName;
    if (!name) continue;
    const known = byLower.get(String(name).toLowerCase());
    if (known && known.accountType) {
      registry[name] = { ...known, accountName: name };
    } else {
      registry[name] = { accountName: name, accountType: ACCOUNT_TYPES.PENDING_CLASSIFICATION };
      pending.push(name);
    }
  }
  return { registry, pending };
}

/**
 * Everything the page needs, from one capture and one cached roster.
 *
 * `warnings` are for the reader, not for the log. Each one is a sentence the
 * page prints, because a report that quietly rests on a week-old roster is
 * worse than one that says it does.
 */
export function buildOfflineDailyReport({
  capture,
  roster = {},
  rosterFetchedAt = null,
  clientName = '',
} = {}) {
  if (!capture) throw new Error('No capture was given.');
  // { date, parsed, metadata } - the same three the ingest destructures.
  const { date, parsed, metadata } = normalizeAutoImportSnapshot(capture);
  if (!date) throw new Error('The capture does not say which trading day it is.');

  const { registry, pending } = registryForCapture(parsed, roster);

  const dailyImport = reconcileDailyImport({
    clientId: 'offline',
    date,
    registry,
    parsed,
    history: [],
    priorImports: [],
    // The capture carries the day's fills, which is the whole point of it.
    fillsLoaded: true,
  });

  const client = {
    name: clientName || 'Client',
    accountRegistry: registry,
    dailyImports: [{ ...dailyImport, date }],
  };

  const warnings = [];

  /* A CAPTURE TAKEN WHILE THE TRADES WERE STILL OPEN IS NOT A CLOSE.
   *
   * autoImport.js records the day this was learned: on 2026-09-08 the scheduled
   * capture fired at 16:30:00 and reported -$2,064 for the day, when the real
   * number was -$1,319. The $745 difference was still unrealized on three
   * accounts whose closing fills landed at 16:32.
   *
   * The CRM has the whole evening to notice and recapture. A report printed on
   * the machine has whatever capture is on disk, so this goes on the page.
   */
  const open = metadata?.openPositions;
  if (open?.open) {
    const names = Array.isArray(open.accounts) ? open.accounts : [];
    const n = names.length;
    warnings.push(
      `${n || 'Some'} account${n === 1 ? ' had a position' : 's had positions'} still open when this`
      + ' capture was taken, so the day is not settled and the realized figures are short by whatever'
      + ` those positions closed at${names.length ? `: ${names.join(', ')}` : ''}.`,
    );
  }
  if (metadata?.isComplete === false && (metadata.emptySections || []).length) {
    warnings.push(
      `The capture carried nothing in: ${metadata.emptySections.join(', ')}.`,
    );
  }

  if (!Object.keys(roster || {}).length) {
    warnings.push(
      'This machine has never received an account roster from the CRM, so no account could be'
      + ' classified. Every figure below is per account; there is no total.',
    );
  }
  const age = rosterFetchedAt ? daysBetween(rosterFetchedAt, `${date}T00:00:00Z`) : null;
  if (age !== null && age >= ROSTER_STALE_DAYS) {
    warnings.push(
      `The account roster on this machine is ${age} days old. Accounts opened since then are`
      + ' listed separately and are not in the total.',
    );
  }
  if (pending.length) {
    const verb = pending.length === 1 ? 'is' : 'are';
    warnings.push(
      `${pending.length} account${pending.length === 1 ? '' : 's'} could not be classified from`
      + ` this machine and ${verb} shown separately, not in the total: ${pending.join(', ')}.`,
    );
  }

  return {
    metadata,
    report: buildDailyReportSummary(client, { ...dailyImport, date }),
    client,
    dailyImport: { ...dailyImport, date },
    pending,
    rosterAgeDays: age,
    warnings,
  };
}
