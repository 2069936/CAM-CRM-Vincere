// CAM-scoped data export.
//
// api/admin/data-export.js is Manager-only and unscoped: every row of 21 tables,
// no client filter, no date filter. A CAM had no way to get their own book out
// at all, so the only continuity story was print-to-PDF, one day at a time.
//
// This endpoint answers the two asks a CAM actually has — one client over a
// range, or all of their clients over the same range — with the range applied
// where the schema can actually express it, and with an envelope that states
// what it left out. That last part is the safety property: the payload feeds an
// analysis, and an analysis reads a missing session as "no trading happened".
// A truncated export that does not say it was truncated is worse than an error.
//
// It lives behind the api/admin/[action].js dispatcher rather than as its own
// file. Vercel Hobby caps a project at 12 serverless functions and this repo
// sits at 5; the dispatcher already fans seven ingest-* URLs into one of them,
// so /api/admin/client-export costs zero additional functions and the count
// stays at 5.

import { Buffer } from 'node:buffer';
import {
  createApiClients,
  listAssignedClientIds,
  requireAppUser,
  requireClientAssignments,
} from '../apiLib/apiAuth.js';
import { ApiError, handleApiError, readJsonBody, requireMethod, sendJson } from '../apiLib/http.js';
import { ABSENCE_REASON_TEXT } from './absentAccounts.js';
import { PNL_BASIS, PNL_BASIS_NOTE, buildClientSeries } from './clientExportSeries.js';

/**
 * The shape a client id is allowed to have before it reaches PostgREST.
 *
 * Hex and hyphens only, which is what makes every filter below injection-proof:
 * PostgrestFilterBuilder.in() renders a list as `in.(a,b,c)` and only quotes a
 * value that already contains `,()`, so a client id carrying a comma would
 * widen the filter rather than fail it. The driver is the second line, not the
 * first — this regex is the first.
 *
 * Version and variant nibbles are deliberately NOT pinned to v4. All 136 client
 * ids on the real book are gen_random_uuid() v4, but pinning them buys no
 * safety (the character class is what stops injection) and would 400 a
 * legitimate id the day a row arrives as a nil uuid or a v7.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Default range: the 30 calendar days ending today, inclusive.
 *
 * "No range" has to mean something bounded — the whole history for the largest
 * CAM is 6.33 MB raw with trade history, and it grows every close. 30 days is
 * picked from the book rather than from a round number: public/local-snapshot.json
 * spans 2026-06-25..2026-07-30, 21 distinct trading days inside 36 calendar
 * days, so 30 calendar days is ~17-18 sessions for a client who trades daily —
 * the scale of the "how have the last twenty sessions gone" question this export
 * exists to answer. It bounds the worst realistic pull, but it does not bound
 * it below what a single response can carry: the busiest CAM (28 clients) over
 * these 30 days measures 3.81 MB raw without trade history and 6.92 MB with,
 * against a 4.5 MB platform cap. MAX_RESPONSE_BYTES below is what actually
 * holds that line; this constant only sets where the analysis starts.
 */
const DEFAULT_RANGE_DAYS = 30;

/**
 * Hard ceiling on an explicit range.
 *
 * A quarter. This was originally justified as "~19 MB" for a 90-day pull; the
 * estimate was low by 5x. Replaying the book's own per-import densities over
 * the limits this file actually permits — 60 clients x 92 days — reads 263,280
 * rows and serializes to 103 MB, which is why MAX_TOTAL_ROWS and
 * MAX_RESPONSE_BYTES below exist rather than this constant carrying the load.
 * Beyond this the caller is told to narrow rather than handed a truncated
 * payload, because a hard 400 cannot be mistaken for a quiet month.
 */
const MAX_RANGE_DAYS = 92;

/**
 * Ceiling on clients per REQUEST — not on how many clients may be exported.
 *
 * This number was read as a policy ("you may not export more than 60 clients")
 * and it never was one. It is not the binding constraint and it never bound the
 * failing case: the busiest CAM carries 28 clients and 18 for the next, and BOTH
 * were at or over MAX_RESPONSE_BYTES on their default 30-day pull. A request for
 * 60 would have been refused with a 413 long before it reached this line, so
 * raising it would have bought exactly nothing and "export in batches of 60"
 * would have failed on batch one. Bytes are the axis; a client count is not.
 *
 * So it stays, as a cheap per-request bound on PostgREST round trips and URL
 * length, and the way to get more than 60 clients out is to ask for them in
 * parts — each part sized by measured bytes, each part carrying `batch` so the
 * pieces can be told apart in a downloads folder. src/domain/clientExportPlan.js
 * plans the parts and caps each at this number as well as at the byte ceiling,
 * because the two bite in opposite places: on this book a part of 60 dormant
 * clients is ~0.5 MiB and a part of six busy ones is ~2.5 MiB.
 *
 * A Manager wanting the whole 136-client book in ONE file still has
 * /api/admin/data-export.
 */
const MAX_CLIENTS = 60;

/**
 * Ceiling on the number of parts a batched export may declare.
 *
 * `batch` is a label the caller supplies and this endpoint echoes into the
 * envelope and the audit row; it changes no filter and grants no access. It is
 * still validated rather than passed through, because it is written into a
 * downloads folder and into the only detection surface this project has, and an
 * unbounded "part 1 of 10000000" is a nuisance in both. 200 is far above the
 * ~3 parts the whole book needs today.
 */
const MAX_BATCHES = 200;

const PAGE_SIZE = 1000;

/**
 * Ids per `.in(...)` filter.
 *
 * PostgREST puts `.in()` into the query string of a GET, so a filter of N uuids
 * is ~37N bytes of URL. 28 clients x 30 days is 153 daily_import ids ~ 5.6 KB,
 * already close to the usual 8 KB request-line limit, and a 92-day pull is
 * three times that. Chunking at 100 keeps every request under ~4 KB.
 */
const IN_CHUNK = 100;

/**
 * Row ceiling per table, enforced per request.
 *
 * The heaviest realistic table is orders: 4,356 rows for the busiest CAM over
 * 30 days. 60,000 is roughly an order of magnitude of headroom over that and
 * still far below the whole book (16,135 orders). Hitting it truncates, and a
 * truncation is reported in the envelope and in the audit row.
 */
const MAX_ROWS_PER_TABLE = 60000;

/**
 * Row ceiling for the WHOLE request, shared across tables.
 *
 * A per-table ceiling bounds no request. 60,000 x 14 tables is 840,000 rows,
 * and the limits above permit a request that reaches for them: 60 clients x 92
 * days, replayed at the book's own per-import densities (30 orders, 15
 * executions, 13 flags, 7 strategy rows, 6 snapshots), reads 263,280 rows and
 * serializes to 103 MB across 388 PostgREST round trips. That is the denial of
 * service — not against the caller, against this project's own Supabase quota,
 * and it is repeatable at will because nothing here rate-limits.
 *
 * 25,000 is set from the top of the real book rather than from a round number:
 * the busiest CAM's largest legitimate pull (28 clients, the whole 36-day book,
 * with trade history) is 10,767 rows, so this is ~2.3x the biggest thing anyone
 * has actually asked for and still bounds the function's memory at ~25 MB.
 */
const MAX_TOTAL_ROWS = 25000;

/**
 * Serialized-response ceiling, checked before the payload is handed back.
 *
 * Vercel caps a serverless function's response body at 4.5 MB. This export
 * blows through that on its own headline case: the busiest CAM's default
 * 30-day pull is 3.81 MB without trade history and 6.92 MB with it (10,521
 * rows at ~690 bytes each), measured against public/local-snapshot.json. Past
 * the cap the platform returns an opaque 500 AFTER every read has been paid
 * for, so the caller learns nothing and the quota is spent anyway.
 *
 * 4 MiB leaves ~11% for headers and transfer encoding. Crossing it is a 413
 * that names the measured size and what to narrow, because a payload this
 * export cannot deliver must fail loudly — the same reason an over-long range
 * is a 400 rather than a silent clamp.
 *
 * MEASURED AGAIN AFTER THE ABSENT-ACCOUNT COVERAGE LANDED, because that figure
 * left almost no room. Per-day absence adds 0.25 MB to the busiest CAM's
 * default pull, which takes it from 3.82 MB (95.5% of this ceiling) to 4.06 MB
 * — a 413 on the endpoint's own headline case. The next-busiest CAM (18
 * clients) lands at 3.81 MB and still fits. Two things are true and both should
 * be said: this feature is what tipped it, and 3.82 MB was one trading week
 * from tipping on its own.
 *
 * WHERE THE HEADROOM ACTUALLY IS, re-measured end to end through this handler
 * against public/local-snapshot.json rather than estimated, because the first
 * answer was both too small and pointed at the wrong table.
 *
 * The whole 4.12 MiB breaks down as 3.35 MiB of `tables` and 0.75 MiB of
 * `series`, and ONE table is half the response: strategy_snapshots is 2,111.8 KB
 * over 1,033 rows — 2,094 bytes a row, against 379 for account_snapshots. Two
 * columns are 77% of it, and both are the same fact written twice:
 *
 *   params_parsed   1,042.0 KB across 1,033 rows, 36 distinct values
 *   parameters_raw    580.6 KB across 1,033 rows, 43 distinct values
 *
 * 1,622.6 KB — 39.6% of this entire ceiling — to say the same three dozen
 * strategy configurations once per account per day. That is the same shape as
 * the reports.content.summary redaction above (13.92 MB of 14.25 MB), and it is
 * an order of magnitude more than anything in `series`. Neither column can
 * simply be dropped: src/domain/setFileMatch.js parses parameters_raw.
 * (strategyRiskProfile.js was the second parser and is gone — it existed only to
 * feed the exposure scatter the desk manager asked to have removed.) Hoisting the distinct
 * values into one dictionary and referencing them per row is the fix, and it is
 * a shape change to a raw-table mirror, so it wants a decision rather than a
 * quiet edit.
 *
 * THE DECISION IS TAKEN: the dictionary ships, unconditionally, and `version` is
 * 2 rather than 1 so a consumer pinned to the old shape sees the change instead
 * of reading an absent column as an absent configuration. See
 * STRATEGY_PARAMETER_COLUMNS below for the mechanics and the rehydration rule.
 * Re-measured through this handler, per CAM, default 30-day pull, no trade
 * history:
 *
 *   clients  strategy rows  before            after
 *        28           1022  3.995 MiB 99.9%   2.503 MiB 62.6%
 *        18            846  3.756 MiB 93.9%   2.597 MiB 64.9%
 *        14            572  2.588 MiB 64.7%   1.685 MiB 42.1%
 *        14            559  2.358 MiB 59.0%   1.503 MiB 37.6%
 *        13            478  2.075 MiB 51.9%   1.349 MiB 33.7%
 *        32             49  0.312 MiB  7.8%   0.263 MiB  6.6%
 *         8             99  0.373 MiB  9.3%   0.248 MiB  6.2%
 *         8             82  0.359 MiB  9.0%   0.247 MiB  6.2%
 *
 * The busiest CAM's headline case goes from 99.9% of this ceiling to 62.6% and
 * strategy_snapshots from 2,109 to 505 bytes a row. Note what the "before"
 * column says about the paragraph further down: the ~100 KB the registry
 * attributes returned is the whole reason that row reads 3.995 and not 4.06, so
 * the endpoint was inside 0.1% of refusing its own headline case.
 *
 * It is hoisted as a PAIR, one ref per row, not a ref per column. Across the
 * whole book the two columns hold 116 and 129 distinct values but only 135
 * distinct (params_parsed, parameters_raw) pairs, and they are two renderings of
 * one fact — splitting them across two dictionaries would store the pairing
 * nowhere and invite the two to be joined back together wrongly.
 *
 * WHAT IT DOES NOT FIX. The whole 136-client book over the same 30 days is
 * 15.75 MiB of tables+series before and 10.14 MiB after. A manager pulling every
 * client still cannot have it in one response, so the client list is split into
 * parts sized by MEASURED BYTES rather than by a client count — see MAX_CLIENTS
 * and `batch` below, and src/domain/clientExportPlan.js which does the sizing.
 * Per-CAM pulls no longer need parts at all, which is the sizes this desk
 * actually has.
 *
 * The trim this comment used to prescribe does NOT work. series[].days[].accounts
 * repeated six static registry attributes (accountType, accountStatus, riskLevel,
 * startBalance, targetProfit, maxDrawdownLimit) on every reported account on
 * every day, joinable on the tradingAccountId each row already carries. Measured
 * on that CAM it is 130.8 KB for all six and 77.4 KB for the four numeric ones,
 * not the 142 KB claimed here before. Getting under the ceiling needs ~123 KB, so
 * removing all six lands at 3.985 MiB: 0.4% of headroom. A cliff, not a fix.
 *
 * Five of the six were removed anyway, and NOT for size. They are current
 * registry values with no history, so stamping them on a row dated 2026-07-13
 * asserted they held that day when they did not — see the comment at the account
 * row in clientExportSeries.js. That returned about 100 KB, which does not change
 * the paragraph below.
 *
 * The real reading is that this endpoint was structurally at its ceiling before
 * per-day absence was added: the next-busiest CAM (18 clients) is at 95.6% of it
 * with the feature and 83.9% without, and the shave that would pay for the
 * feature is worth less than one week of ordinary growth.
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Never exported. Trading credentials and prop-firm logins leave the CRM through nobody. */
const EXCLUDED_TABLES = ['client_credentials', 'client_prop_firms'];

/**
 * Fields dropped from rows that ARE exported, and why.
 *
 * clients.product_key is the per-client Whop key the collector authenticates
 * with (src/domain/ingestAuth.js) — a credential living in a non-credential
 * table. This payload is built to be handed to an outside analysis tool, so it
 * goes no further than the CRM.
 *
 * reports.content.summary is a size decision, measured: across the 610 reports
 * on the real book, content.summary is 13.92 MB of 14.25 MB — 24 KB a row of
 * re-rendered day (grouped accounts, totals, flags) that this export already
 * carries as first-class rows. Dropping it took the busiest CAM's 30-day pull
 * from 7.01 MB to 3.73 MB. content.message, the text actually sent to the
 * client, is 0.01 MB across all 610 and is kept — it is the one part of a
 * report that is not derivable from the tables.
 */
const REDACTIONS = [
  {
    table: 'clients',
    drop: ['product_key'],
    reason: 'Collector authentication key for this client; a credential, not client data.',
  },
  {
    table: 'reports',
    dropWithin: { content: ['summary'] },
    reason: 'A re-render of the same day this payload already carries as rows: 13.92 MB of the 14.25 MB the reports table occupies on the real book. content.message is kept.',
  },
];

/**
 * The two strategy_snapshots columns that are stored once per payload instead of
 * once per row, and the column that replaces them.
 *
 * They are 38.8% of the busiest CAM's whole 4 MiB budget for 42 distinct values
 * repeated over 1,022 rows; the measurement and the decision are in the
 * MAX_RESPONSE_BYTES comment above.
 *
 * The columns are REMOVED from the row rather than left present with some
 * stand-in value, for the reason this payload already refuses to render an
 * absent account's P&L as a zero: `parameters_raw: ""` reads as "this strategy
 * had no configuration" to every parser in this tree, including
 * src/domain/setFileNormalise.js, which is a wrong answer arriving quietly. An
 * absent key is a wrong SHAPE, which arrives loudly. `version` goes to 2 for
 * consumers that check it instead of the shape.
 */
const STRATEGY_PARAMETER_TABLE = 'strategy_snapshots';
const STRATEGY_PARAMETER_COLUMNS = ['params_parsed', 'parameters_raw'];
const STRATEGY_PARAMETER_REF = 'parameters_ref';

/**
 * Replaces the parameter columns on every strategy row with one integer ref.
 *
 * EVERY row gets a ref, including a row whose configuration is null on both
 * columns — 98 of the book's 3,805 strategy rows carry an empty parameters_raw.
 * A missing ref would then mean two different things ("no configuration" and
 * "this payload was built before the dictionary existed") and a consumer would
 * have to guess which.
 *
 * Rows are copied, never mutated: `series` is built from the same row objects
 * and a mutation here would reach into a block that has nothing to do with this.
 */
export function hoistStrategyParameters(rows = []) {
  const refByValue = new Map();
  const entries = [];
  const hoisted = rows.map((row) => {
    const values = STRATEGY_PARAMETER_COLUMNS.map((column) => row[column] ?? null);
    const key = JSON.stringify(values);
    let ref = refByValue.get(key);
    if (ref === undefined) {
      ref = entries.length;
      refByValue.set(key, ref);
      entries.push(Object.fromEntries([
        ['ref', ref],
        ...STRATEGY_PARAMETER_COLUMNS.map((column, index) => [column, values[index]]),
      ]));
    }
    const copy = { ...row };
    for (const column of STRATEGY_PARAMETER_COLUMNS) delete copy[column];
    copy[STRATEGY_PARAMETER_REF] = ref;
    return copy;
  });
  return { rows: hoisted, entries };
}

/**
 * Puts the columns back, given a whole payload. The inverse of the above, and
 * the reference implementation of the one sentence the envelope has room for.
 *
 * Exported so the suite can assert the round trip against the real book rather
 * than describing it in prose, and so a consumer in this repo has one call
 * rather than its own copy of the join.
 */
export function rehydrateStrategyParameters(payload) {
  const rows = payload?.tables?.[STRATEGY_PARAMETER_TABLE] || [];
  const entries = payload?.dictionaries?.strategyParameters?.entries || [];
  const byRef = new Map(entries.map((entry) => [entry.ref, entry]));
  return rows.map((row) => {
    const entry = byRef.get(row[STRATEGY_PARAMETER_REF]);
    // A ref with no entry is a broken payload, not an empty configuration, so it
    // throws rather than handing back a row that looks like an unconfigured
    // strategy. Unreachable through this endpoint; reachable through a file that
    // was edited or truncated on the way here.
    if (!entry) {
      throw new Error(`strategy_snapshots row ${row.id} references parameters_ref ${row[STRATEGY_PARAMETER_REF]}, which is not in the dictionary.`);
    }
    const copy = { ...row };
    delete copy[STRATEGY_PARAMETER_REF];
    for (const column of STRATEGY_PARAMETER_COLUMNS) copy[column] = entry[column];
    return copy;
  });
}

/**
 * Tables the admin export carries that this one deliberately does not, with the
 * reason, so the difference is visible rather than looking like an oversight.
 */
const OMITTED_TABLES = [
  { table: 'app_users', reason: 'Identities of other users; not client data.' },
  { table: 'cam_profiles', reason: 'Identities of other CAMs; not client data.' },
  { table: 'audit_logs', reason: 'No client foreign key, so it cannot be scoped to a client.' },
  { table: 'sop_templates', reason: 'Desk process, not client trading data.' },
  { table: 'sop_sections', reason: 'Desk process, not client trading data.' },
  { table: 'sop_items', reason: 'Desk process, not client trading data.' },
  { table: 'daily_sop_checklists', reason: 'Desk process, not client trading data.' },
];

function badRequest(message) {
  return new ApiError(400, message);
}

function isoDay(value) {
  const text = String(value || '').slice(0, 10);
  if (!ISO_DATE.test(text)) return null;
  const at = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return null;
  return at.toISOString().slice(0, 10) === text ? text : null;
}

function shiftDays(day, delta) {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + delta);
  return at.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86400000) + 1;
}

/**
 * Resolves the range, and says where it came from.
 *
 * Half a range is accepted: `from` alone runs to today, `to` alone runs back the
 * default window. Both absent is the common case and is the documented default.
 */
export function resolveRange({ from, to } = {}, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const absent = (value) => value === undefined || value === null || value === '';
  const rawFrom = absent(from) ? null : isoDay(from);
  const rawTo = absent(to) ? null : isoDay(to);
  // Guarded on absence, not on truthiness. `from` guarded by `if (from && ...)`
  // let every falsy-but-present value through: `from: 0` and `from: false`
  // silently became the default window while `from: 20260701` — the same
  // mistake, one digit longer — was a 400. A range the caller did not ask for
  // is exactly what the rest of this module refuses to hand back quietly.
  if (!absent(from) && !rawFrom) throw badRequest('Invalid "from" date. Use YYYY-MM-DD.');
  if (!absent(to) && !rawTo) throw badRequest('Invalid "to" date. Use YYYY-MM-DD.');

  let source = 'request';
  let resolvedTo = rawTo;
  let resolvedFrom = rawFrom;
  if (!rawFrom && !rawTo) {
    source = 'default';
    resolvedTo = today;
    resolvedFrom = shiftDays(today, -(DEFAULT_RANGE_DAYS - 1));
  } else if (!rawTo) {
    source = 'partial-default-to';
    resolvedTo = today;
  } else if (!rawFrom) {
    source = 'partial-default-from';
    resolvedFrom = shiftDays(rawTo, -(DEFAULT_RANGE_DAYS - 1));
  }

  if (resolvedFrom > resolvedTo) throw badRequest('Range "from" is after "to".');
  const days = daysBetween(resolvedFrom, resolvedTo);
  if (days > MAX_RANGE_DAYS) {
    throw badRequest(`Range is ${days} days; the maximum is ${MAX_RANGE_DAYS}. Narrow the range or export in parts.`);
  }
  return { from: resolvedFrom, to: resolvedTo, days, source, defaultRangeDays: DEFAULT_RANGE_DAYS };
}

export function normalizeClientIds(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw badRequest('"clientIds" must be an array of client uuids.');
  const ids = [];
  for (const entry of value) {
    // typeof, not String(entry): coercion accepted anything with a toString,
    // so `clientIds: [["<uuid>"]]` passed validation because a one-element
    // array stringifies to its element. It authorized the same id it fetched,
    // so it was never a bypass — but "whatever coerces to a uuid" is not the
    // contract this endpoint wants to defend.
    if (typeof entry !== 'string') throw badRequest('"clientIds" must contain client uuids only.');
    const text = entry.trim();
    if (!UUID.test(text)) throw badRequest('"clientIds" must contain client uuids only.');
    ids.push(text.toLowerCase());
  }
  const unique = [...new Set(ids)];
  if (!unique.length) return null;
  if (unique.length > MAX_CLIENTS) {
    throw badRequest(`Requested ${unique.length} clients; the maximum is ${MAX_CLIENTS}.`);
  }
  return unique;
}

/**
 * The optional "this is part N of M" label on a batched export.
 *
 * It is a LABEL. It selects nothing, authorizes nothing and changes no filter —
 * the clients in a part are the clients the caller named in `clientIds`, checked
 * the same way as any other request. What it buys is that five files in a
 * downloads folder can be told apart and counted: an analysis handed parts 1, 2
 * and 4 of 5 can see that it is short, which is the same property the truncation
 * block gives a single payload. Without it, splitting an export by bytes would
 * reintroduce, across files, exactly the silent truncation this module refuses
 * to do inside one.
 *
 * Absent is the normal case and means an unbatched export.
 */
export function normalizeBatch(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('"batch" must be an object like { index, of }.');
  }
  const { index, of } = value;
  const whole = (n) => typeof n === 'number' && Number.isInteger(n);
  if (!whole(index) || !whole(of)) throw badRequest('"batch.index" and "batch.of" must be whole numbers.');
  if (of < 1 || of > MAX_BATCHES) throw badRequest(`"batch.of" must be between 1 and ${MAX_BATCHES}.`);
  if (index < 1 || index > of) throw badRequest('"batch.index" must be between 1 and "batch.of".');
  return { index, of };
}

function chunk(values, size) {
  const out = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

function isMissingTable(error) {
  return error?.code === 'PGRST205' || /Could not find the table/i.test(error?.message || '');
}

/**
 * Paged read of one filtered slice, at 1000 rows a page like the admin export.
 *
 * Ordered by id, which api/admin/data-export.js does not do. Without an order
 * PostgREST is free to return the same row on two pages and skip another, which
 * on this payload would silently drop trading days — src/domain/supabaseStore.js
 * already pages this way for the same reason.
 */
async function fetchPages(admin, table, applyFilters, remaining) {
  const rows = [];
  let truncated = false;
  for (let from = 0; ; from += PAGE_SIZE) {
    if (rows.length >= remaining) {
      truncated = true;
      break;
    }
    const query = applyFilters(admin.from(table).select('*'));
    const { data, error } = await query.order('id', { ascending: true }).range(from, from + PAGE_SIZE - 1);
    if (error) {
      if (isMissingTable(error)) return { rows: [], skipped: true, reason: error.message, truncated: false };
      throw error;
    }
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return { rows, skipped: false, truncated };
}

/**
 * Reads a table filtered by an `in` list, chunked, with a shared row ceiling.
 *
 * An empty `values` list short-circuits: `.in('x', [])` is a round trip that can
 * only return nothing, and a client with no accounts would otherwise pay for one
 * on payout_events.
 */
async function fetchInto(admin, table, column, values, { extra = (query) => query, limit = MAX_ROWS_PER_TABLE } = {}) {
  if (!values.length) return { rows: [], skipped: false, truncated: false };
  const rows = [];
  let truncated = false;
  for (const group of chunk(values, IN_CHUNK)) {
    const remaining = limit - rows.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const result = await fetchPages(admin, table, (query) => extra(query.in(column, group)), remaining);
    if (result.skipped) return result;
    rows.push(...result.rows);
    if (result.truncated) truncated = true;
  }
  // The final slice is its own truncation, and it used to be a silent one.
  // A page is 1000 rows, so a ceiling anywhere between the chunk total and the
  // page boundary is crossed INSIDE a page that fetchPages returns whole and
  // flagless: a 428-row activity_logs read against a ceiling of 250 came back
  // "complete" and 178 rows short. Absence in this payload reads downstream as
  // "nothing happened", so the count decides, not the loop that produced it.
  if (rows.length > limit) truncated = true;
  return { rows: rows.slice(0, limit), skipped: false, truncated };
}

function redact(table, rows) {
  const rule = REDACTIONS.find((entry) => entry.table === table);
  if (!rule) return rows;
  return rows.map((row) => {
    const copy = { ...row };
    for (const column of rule.drop || []) delete copy[column];
    for (const [column, keys] of Object.entries(rule.dropWithin || {})) {
      const value = copy[column];
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const nested = { ...value };
      for (const key of keys) delete nested[key];
      copy[column] = nested;
    }
    return copy;
  });
}

async function createAuditLog(admin, userId, afterData, action = 'client_data_export.create') {
  const { error } = await admin
    .from('audit_logs')
    .insert({
      user_id: userId,
      entity_type: 'client_data_export',
      action,
      after_data: afterData,
    });
  // Logged, not thrown: the export already succeeded and failing it now would
  // lose real work over a bookkeeping row. api/admin/data-export.js does the same.
  if (error) console.error('[CRM] Failed to write client export audit log:', error);
}

/**
 * A refused export is written down too.
 *
 * The success path was audited from the start; a denial was not, so a caller
 * could walk client uuids one at a time against this endpoint forever and leave
 * no row anywhere. audit_logs is the only detection surface this project has —
 * there is no rate limit here and no WAF in front of it — and "who tried" is
 * the half of "who took what" that catches an account being used by someone it
 * does not belong to.
 *
 * Only reachable once requireAppUser has already established WHO the caller is,
 * so an anonymous request cannot use this to write rows: it is turned away at
 * 401 well before this point.
 */
async function auditDenial(admin, writeAudit, actor, detail) {
  if (!actor?.id) return;
  try {
    await writeAudit(admin, actor.id, detail, 'client_data_export.denied');
  } catch (error) {
    console.error('[CRM] Failed to write client export denial audit log:', error);
  }
}

/**
 * Resolves which clients this request covers, and authorizes every one of them.
 *
 * Two paths, and both end at the same check. An explicit list is verified id by
 * id, so an id belonging to another CAM is a 403 with the same message whether
 * or not that client exists. "All my clients" is read from the assignment table
 * itself, which cannot contain a client the caller is not assigned to; a
 * Manager has no assignment rows on this book, so for a Manager it means the
 * whole client list and is labelled as such in the envelope.
 */
export async function resolveScope(admin, actor, requestedIds, {
  authorizeMany = requireClientAssignments,
  listAssigned = listAssignedClientIds,
} = {}) {
  if (requestedIds) {
    // The set that gets FETCHED is the set requireClientAssignments returned,
    // not the set that was handed in. They are equal today only because
    // normalizeClientIds already rejected anything that could differ; taking
    // the request's own list back was a standing invitation for the authorized
    // set and the fetched set to drift apart in a later edit, which is the
    // shape every broken multi-tenant export has. The equality is asserted
    // rather than assumed, and a mismatch is a denial, not a narrowing.
    const authorized = await authorizeMany(admin, actor, requestedIds);
    const cleared = new Set(authorized || []);
    if (cleared.size !== requestedIds.length || requestedIds.some((id) => !cleared.has(id))) {
      throw new ApiError(403, 'Client assignment required.');
    }
    return { clientIds: [...cleared], selection: 'explicit' };
  }
  if (actor.role !== 'Manager') {
    const assigned = await listAssigned(admin, actor.cam_profile_id);
    if (!assigned.length) throw new ApiError(403, 'Client assignment required.');
    if (assigned.length > MAX_CLIENTS) {
      throw badRequest(`You are assigned ${assigned.length} clients; the maximum per export is ${MAX_CLIENTS}. Select clients explicitly.`);
    }
    return { clientIds: assigned, selection: 'assigned' };
  }
  const assigned = await listAssigned(admin, actor.cam_profile_id);
  if (assigned.length) {
    if (assigned.length > MAX_CLIENTS) {
      throw badRequest(`You are assigned ${assigned.length} clients; the maximum per export is ${MAX_CLIENTS}. Select clients explicitly.`);
    }
    return { clientIds: assigned, selection: 'assigned' };
  }
  const { data, error } = await admin.from('clients').select('id').order('id', { ascending: true }).range(0, MAX_CLIENTS);
  if (error) throw error;
  const ids = (data || []).map((row) => row.id);
  if (ids.length > MAX_CLIENTS) {
    throw badRequest(`The book holds more than ${MAX_CLIENTS} clients. Select clients explicitly, or use /api/admin/data-export.`);
  }
  if (!ids.length) throw badRequest('No clients to export.');
  return { clientIds: ids, selection: 'all-clients' };
}

export function createClientExportStore(admin, {
  maxRowsPerTable = MAX_ROWS_PER_TABLE,
  maxTotalRows = MAX_TOTAL_ROWS,
} = {}) {
  return {
    async load({ clientIds, from, to, includeTradeHistory }) {
      const tables = {};
      const skipped = [];
      const truncation = [];

      // The request's shared row budget, spent in load order. Without it the
      // per-table ceiling bounds nothing: 14 tables x 60,000 is 840,000 rows,
      // and a 60-client 92-day pull at the book's own densities really does
      // reach 263,280 of them.
      let budget = maxTotalRows;
      const fetchIn = (table, column, values, options = {}) => (
        fetchInto(admin, table, column, values, {
          limit: Math.max(0, Math.min(maxRowsPerTable, budget)),
          ...options,
        })
      );

      const take = (table, result) => {
        if (result.skipped) {
          skipped.push({ table, reason: result.reason });
          return [];
        }
        if (result.truncated) {
          const hitBudget = budget <= maxRowsPerTable;
          truncation.push({
            table,
            limit: hitBudget ? maxTotalRows : maxRowsPerTable,
            scope: hitBudget ? 'request' : 'table',
            reason: hitBudget
              ? `Request row budget of ${maxTotalRows} exhausted; rows beyond it are NOT in this payload. Narrow the range or the client list.`
              : `Row ceiling of ${maxRowsPerTable} reached; rows beyond it are NOT in this payload.`,
          });
        }
        tables[table] = redact(table, result.rows);
        budget -= tables[table].length;
        return tables[table];
      };

      // Client identity and the account registry are never range-filtered: a
      // snapshot says "-1,240" and only trading_accounts says whether that was a
      // funded account, an evaluation or cash. Without the full registry the
      // range's own rows cannot be read.
      const clients = take('clients', await fetchIn('clients', 'id', clientIds));
      take('client_assignments', await fetchIn('client_assignments', 'client_id', clientIds));
      const accounts = take('trading_accounts', await fetchIn('trading_accounts', 'client_id', clientIds));

      // trading_date is the ONLY date the range can be expressed against for the
      // session tables — account_snapshots, strategy_snapshots, orders and
      // executions have no date column of their own, just created_at. created_at
      // is not a substitute: on the real book a backfilled import stamped
      // 2026-06-25 has child rows created 2026-07-01, six days later, so a
      // created_at range silently misfiles every backfilled session.
      const dailyImports = take('daily_imports', await fetchIn('daily_imports', 'client_id', clientIds, {
        extra: (query) => query.gte('trading_date', from).lte('trading_date', to),
      }));
      const importIds = dailyImports.map((row) => row.id);
      const accountIds = accounts.map((row) => row.id);

      const snapshots = take('account_snapshots', await fetchIn('account_snapshots', 'daily_import_id', importIds));
      const strategies = take('strategy_snapshots', await fetchIn('strategy_snapshots', 'daily_import_id', importIds));

      // orders + executions are half the bytes of a full payload (3.12 of
      // 6.25 MB for the busiest CAM over 30 days) and answer none of the
      // continuity questions, so they are opt-in.
      const orders = includeTradeHistory
        ? take('orders', await fetchIn('orders', 'daily_import_id', importIds))
        : [];
      const executions = includeTradeHistory
        ? take('executions', await fetchIn('executions', 'daily_import_id', importIds))
        : [];

      // Flags come in two shapes. Most hang off an import; operational_flags.
      // daily_import_id is nullable, and a flag raised outside a close has only
      // created_at to place it. Both are collected and de-duplicated.
      const flagsByImport = await fetchIn('operational_flags', 'daily_import_id', importIds);
      const looseFlags = flagsByImport.skipped
        ? flagsByImport
        : await fetchIn('operational_flags', 'client_id', clientIds, {
          extra: (query) => query
            .is('daily_import_id', null)
            .gte('created_at', `${from}T00:00:00Z`)
            .lt('created_at', `${shiftDays(to, 1)}T00:00:00Z`),
        });
      const flags = flagsByImport.skipped
        ? take('operational_flags', flagsByImport)
        : take('operational_flags', {
          rows: [...new Map([...flagsByImport.rows, ...looseFlags.rows].map((row) => [row.id, row])).values()],
          skipped: false,
          truncated: flagsByImport.truncated || looseFlags.truncated,
        });

      // Open work is not a dated artefact: 2 of the 8 tasks on the real book
      // have a null due_date, and a task raised last month about an account
      // still matters to this month's reading. The table is tiny, so it goes
      // out whole for the requested clients.
      take('tasks', await fetchIn('tasks', 'client_id', clientIds));

      // activity_logs is filtered on created_at, not log_date, because log_date
      // is NULL on all 1,996 rows of the real book — a .gte('log_date') returns
      // nothing at all. This is the one table whose range is a wall-clock window
      // rather than a trading-date one, and the envelope says so.
      take('activity_logs', await fetchIn('activity_logs', 'client_id', clientIds, {
        extra: (query) => query
          .gte('created_at', `${from}T00:00:00Z`)
          .lt('created_at', `${shiftDays(to, 1)}T00:00:00Z`),
      }));

      take('price_checks', await fetchIn('price_checks', 'client_id', clientIds, {
        extra: (query) => query.gte('check_date', from).lte('check_date', to),
      }));

      // payout_events has no client_id at all; it hangs off trading_account_id,
      // so the account registry has to be resolved first.
      take('payout_events', await fetchIn('payout_events', 'trading_account_id', accountIds, {
        extra: (query) => query.gte('payout_date', from).lte('payout_date', to),
      }));

      take('reports', await fetchIn('reports', 'client_id', clientIds, {
        extra: (query) => query.gte('report_date', from).lte('report_date', to),
      }));

      return {
        tables,
        skipped,
        truncation,
        series: { clients, accounts, dailyImports, snapshots, strategies, orders, executions, flags },
      };
    },
  };
}

function publicError(error) {
  if (error instanceof ApiError) return error;
  if (error?.status === 401) return new ApiError(401, 'Invalid session token.');
  if (error?.status === 403) return new ApiError(403, 'Client assignment required.');
  return new ApiError(500, 'Client export failed.');
}

export function createHandler({
  createClients = createApiClients,
  authorize = requireAppUser,
  authorizeMany = requireClientAssignments,
  listAssigned = listAssignedClientIds,
  createStore = createClientExportStore,
  maxRowsPerTable = MAX_ROWS_PER_TABLE,
  maxTotalRows = MAX_TOTAL_ROWS,
  maxResponseBytes = MAX_RESPONSE_BYTES,
  writeAudit = createAuditLog,
  now = () => new Date(),
} = {}) {
  return async function handler(req, res) {
    // Declared outside the try so a denial can be attributed. Undefined until
    // requireAppUser has returned, which is exactly the window in which there
    // is nobody to attribute a denial to.
    let actor;
    try {
      // POST, not GET. A GET would carry the client uuids in the query string,
      // which lands them in every access log and proxy trace between here and
      // the browser; 28 uuids is also ~1 KB of URL before the dates.
      requireMethod(req, ['POST']);
      res.setHeader('Cache-Control', 'private, no-store');

      // Identity first, then the request. Nobody who has not proved who they
      // are should be able to probe the limits by watching which shapes come
      // back 400 and which come back 200.
      const { admin, auth } = createClients();
      actor = await authorize(req, { admin, authClient: auth, roles: ['Manager', 'CAM'] });

      const body = await readJsonBody(req);
      const requestedIds = normalizeClientIds(body?.clientIds);
      const range = resolveRange({ from: body?.from, to: body?.to }, now());
      const includeTradeHistory = body?.includeTradeHistory === true;
      const batch = normalizeBatch(body?.batch);
      // requireClientAssignments runs requireClientAssignment over EVERY id in
      // the list — an explicit list is exactly the request where checking only
      // the first id would hand over another CAM's book.
      let scope;
      try {
        scope = await resolveScope(admin, actor, requestedIds, { authorizeMany, listAssigned });
      } catch (error) {
        if (error?.status === 403) {
          // The ids are recorded, not the verdict per id: the response tells the
          // caller nothing about which one failed (that is the enumeration
          // defence), but the audit trail has to, or a walk through the book
          // looks identical to a typo.
          await auditDenial(admin, writeAudit, actor, {
            reason: 'client_assignment_denied',
            role: actor?.role || null,
            camProfileId: actor?.cam_profile_id || null,
            requestedClientIds: requestedIds,
            requestedClientCount: requestedIds ? requestedIds.length : 0,
            selection: requestedIds ? 'explicit' : 'assigned',
            range: { from: range.from, to: range.to, days: range.days, source: range.source },
          });
        }
        throw error;
      }

      const loaded = await createStore(admin, { maxRowsPerTable, maxTotalRows }).load({
        clientIds: scope.clientIds,
        from: range.from,
        to: range.to,
        includeTradeHistory,
      });

      const series = buildClientSeries({
        clients: loaded.series.clients,
        tradingAccounts: loaded.series.accounts,
        dailyImports: loaded.series.dailyImports,
        accountSnapshots: loaded.series.snapshots,
        strategySnapshots: loaded.series.strategies,
        operationalFlags: loaded.series.flags,
        orders: loaded.series.orders,
        executions: loaded.series.executions,
        includeTradeHistory,
        rangeFrom: range.from,
      });

      // After buildClientSeries, which counts the same rows and must not see a
      // shape it does not know, and after redaction, which is about what leaves
      // the CRM rather than about what it costs to say.
      const parameters = hoistStrategyParameters(loaded.tables[STRATEGY_PARAMETER_TABLE] || []);
      const tables = STRATEGY_PARAMETER_TABLE in loaded.tables
        ? { ...loaded.tables, [STRATEGY_PARAMETER_TABLE]: parameters.rows }
        : loaded.tables;

      const rowCounts = Object.fromEntries(
        Object.entries(tables).map(([table, rows]) => [table, rows.length]),
      );
      const totalRows = Object.values(rowCounts).reduce((sum, count) => sum + count, 0);
      const truncated = loaded.truncation.length > 0;

      const payload = {
        exportedAt: now().toISOString(),
        source: 'cam-crm-supabase',
        kind: 'client-scoped-export',
        // 2, not 1: strategy_snapshots no longer carries params_parsed and
        // parameters_raw on the row. See `dictionaries` below. A consumer that
        // reads this field learns the shape changed without having to notice a
        // column that is simply not there any more.
        version: 2,
        requestedBy: { appUserId: actor.id, role: actor.role },
        scope: {
          selection: scope.selection,
          clientIds: scope.clientIds,
          requestedClientCount: scope.clientIds.length,
          // null on an ordinary export. On a batched one, which part this is and
          // how many there are, so a folder of parts can be counted.
          batch,
          // Fewer rows than ids means an id resolved to no client row. Reported,
          // not silently dropped: an analysis that expected 19 clients and got
          // 18 needs to know which one is missing.
          includedClients: loaded.series.clients.map((client) => ({ id: client.id, name: client.name || null })),
          includedClientCount: loaded.series.clients.length,
          includeTradeHistory,
        },
        range: {
          from: range.from,
          to: range.to,
          days: range.days,
          source: range.source,
          defaultRangeDays: DEFAULT_RANGE_DAYS,
          maxRangeDays: MAX_RANGE_DAYS,
          appliedBy: {
            trading_date: ['daily_imports'],
            'parent daily_import.trading_date': [
              'account_snapshots', 'strategy_snapshots', 'orders', 'executions', 'operational_flags',
            ],
            check_date: ['price_checks'],
            payout_date: ['payout_events'],
            report_date: ['reports'],
            'created_at (UTC wall clock)': ['activity_logs', 'operational_flags without a daily_import_id'],
            'not range-filtered': ['clients', 'client_assignments', 'trading_accounts', 'tasks'],
          },
        },
        limits: {
          maxClients: MAX_CLIENTS,
          maxRangeDays: MAX_RANGE_DAYS,
          maxRowsPerTable,
          maxTotalRows,
          maxResponseBytes,
          pageSize: PAGE_SIZE,
        },
        excludedTables: EXCLUDED_TABLES,
        omittedTables: includeTradeHistory ? OMITTED_TABLES : [
          ...OMITTED_TABLES,
          { table: 'orders', reason: 'includeTradeHistory was false. Per-day order counts are still in series[].days[].counts.orders, taken from daily_imports.source_summary.' },
          { table: 'executions', reason: 'includeTradeHistory was false. Per-day execution counts are still in series[].days[].counts.executions, taken from daily_imports.source_summary.' },
        ],
        redactions: REDACTIONS.map(({ table, drop, dropWithin, reason }) => ({
          table,
          fields: [
            ...(drop || []),
            ...Object.entries(dropWithin || {}).flatMap(([column, keys]) => keys.map((key) => `${column}.${key}`)),
          ],
          reason,
        })),
        // Columns moved out of the rows and stored once. Declared the same way a
        // redaction is, and in the same envelope, because from a consumer's side
        // they are the same event: a column it expected on a row is not there.
        // The difference is that this one is reversible, and `rehydrate` is the
        // whole reversal.
        dictionaries: {
          strategyParameters: {
            appliesTo: `tables.${STRATEGY_PARAMETER_TABLE}`,
            movedColumns: STRATEGY_PARAMETER_COLUMNS,
            referenceColumn: STRATEGY_PARAMETER_REF,
            rows: (tables[STRATEGY_PARAMETER_TABLE] || []).length,
            distinctValues: parameters.entries.length,
            reason: 'The same handful of strategy configurations, restated once per account per day, were 38.8% of the 4 MiB a single response can carry. Stored once here and referenced per row instead.',
            rehydrate: `For each row in tables.${STRATEGY_PARAMETER_TABLE}, find the entry whose \`ref\` equals row.${STRATEGY_PARAMETER_REF} (entries are in ref order, so entries[ref] works too) and copy ${STRATEGY_PARAMETER_COLUMNS.join(' and ')} back onto the row. Every row has a ref, including rows whose configuration is null on both columns, so a row without one is a damaged payload rather than an unconfigured strategy.`,
            entries: parameters.entries,
          },
        },
        // The legend for series[].days[].absentAccounts[].reason, emitted once.
        // Carrying the sentence on every row instead cost 67 KB on the busiest
        // CAM's default pull for five constant strings.
        absenceReasons: ABSENCE_REASON_TEXT,
        skippedTables: loaded.skipped,
        rowCounts,
        totalRows,
        truncated,
        truncation: loaded.truncation,
        caveats: [
          {
            field: 'account_snapshots.gross_realized_pnl',
            affects: ['account_snapshots', 'series[].days[].accounts[].realizedPnl', 'series[].days[].totals.realizedPnl'],
            basis: PNL_BASIS,
            note: PNL_BASIS_NOTE,
          },
          {
            field: 'account_snapshots.weekly_pnl',
            affects: ['series[].days[].week.toDateReported'],
            note: 'The platform\'s own week-to-date accumulator, net of commissions, reset every Monday. Null means the source CSV carried no such column; 0 means a measured flat week. They are not the same and are not collapsed here.',
          },
          {
            field: 'activity_logs.log_date',
            affects: ['activity_logs'],
            note: 'NULL on every row of the real book, so activity_logs is filtered on created_at (UTC) instead of on a trading date. Rows can therefore straddle the trading-date range by a few hours.',
          },
          {
            field: 'series[].days[].totals / week / cumulative / summary',
            affects: ['series'],
            note: 'Derived aggregates are rounded to cents. Per-account figures in series[].days[].accounts[] are passed through exactly as stored, so the series reconciles row by row against tables.account_snapshots.',
          },
          {
            field: 'series[].days[].absentAccounts',
            affects: ['series[].days[].coverage', 'series[].summary.coverage'],
            note: 'series[].days[].accounts is only the accounts that FILED a snapshot that day. absentAccounts is every registered account that existed and did not file, with the reason: never-reported-in-range, not-yet-reporting, absent-still-live (it exists and it did not work today), or absent-finished (its last trailing-drawdown reading on or before that day is a breach, per src/domain/accountLifecycle.js asked as of that day). "Did not report" is never rendered as a zero — an absent account carries no P&L field at all, only a dated lastReported block. Collection failures are kept out of the account counts: coverage.clientFiledNothing marks a day whose import carried no account rows at all, and summary.coverage.uncollected counts the trading dates this client produced no import for. On the real book those are 4,667 account-days against 1,209 that were absent while their siblings filed.',
          },
          {
            field: 'trading_accounts.date_added',
            affects: ['series[].days[].notYetRegisteredAccountIds', 'series[].summary.coverage.accountStarts', 'series[].days[].coverage.existedOnDay'],
            note: 'An account is only counted as absent from a day it could have filed on. The start date used is min(date_added, the first day the account was actually observed filing), because neither column is trustworthy alone: on the real book 229 of the 720 accounts that ever appear in a close carry a date_added LATER than the first close they appear in, and created_at is the CRM migration timestamp (all 764 values fall in one month, 573 of them on three days) and is later than the first observed close for 246 of them. created_at is not used. The two fields are not interchangeable: series[].days[].notYetRegisteredAccountIds is a bare array of trading_accounts.id for that one day, and the decided start date and its provenance live once per client in series[].summary.coverage.accountStarts, as { tradingAccountId, accountName, dateAdded, existsFrom, existsFromBasis }. Join the day\'s ids to that block. Accounts with no usable start date carry existsFromBasis "unknown" there and are never counted as absent; on the real book that case is 0 accounts.',
          },
          {
            field: 'strategy_snapshots.params_parsed / strategy_snapshots.parameters_raw',
            affects: ['tables.strategy_snapshots'],
            note: 'NOT on the row in version 2 of this payload. Each row carries parameters_ref instead, into dictionaries.strategyParameters.entries. Reading row.parameters_raw without rehydrating gives undefined, which every parser in the CRM would read as "this strategy had no configuration" — join the ref first. version was 1 while the columns were inline.',
          },
          {
            field: 'scope.batch',
            affects: ['the whole payload'],
            note: 'Null unless this export was taken in parts. When set, this file is part `index` of `of` and carries ONLY the clients in scope.clientIds; the other parts carry the rest. Parts are sized by measured bytes, not by client count, so they hold different numbers of clients. An analysis is only complete when it holds every part from 1 to `of` for the same range.',
          },
          {
            field: 'daily_imports.status',
            affects: ['series[].summary.closedSessions'],
            note: 'A session may be Closed, Ready to close or Needs review. Counting green sessions without reading status mixes signed-off days with unreviewed ones.',
          },
        ],
        series,
        tables,
      };

      // Measured before it is handed back, because past 4.5 MB the platform
      // returns an opaque 500 and the caller cannot tell a too-big export from
      // a broken one. This is not hypothetical on this book: the busiest CAM's
      // default 30-day pull WITH trade history serializes to 6.92 MB, so the
      // endpoint's own headline case was over the cap. A 413 that names the
      // measured size and what to narrow is the difference between "try again
      // with a shorter range" and a support ticket.
      const serialized = JSON.stringify(payload);
      const responseBytes = Buffer.byteLength(serialized, 'utf8');
      if (responseBytes > maxResponseBytes) {
        const detail = {
          reason: 'response_too_large',
          responseBytes,
          maxResponseBytes,
          clientCount: scope.clientIds.length,
          range: { from: range.from, to: range.to, days: range.days },
          includeTradeHistory,
          totalRows,
          batch,
        };
        await auditDenial(admin, writeAudit, actor, detail);
        // The remedy named first depends on whether splitting the client list
        // can possibly help. It cannot when there is one client in it: the same
        // advice on a single-client pull ("export fewer clients at a time") is
        // advice to do nothing, and this endpoint's whole point is that a
        // refusal says what to do next.
        const remedy = scope.clientIds.length > 1
          ? 'Export these clients in parts, shorten the range,'
          : 'Shorten the range';
        throw new ApiError(413, `This export is ${(responseBytes / 1048576).toFixed(2)} MB, over the ${(maxResponseBytes / 1048576).toFixed(2)} MB a single response can carry (${totalRows} rows, ${scope.clientIds.length} client${scope.clientIds.length === 1 ? '' : 's'}, ${range.days} days${includeTradeHistory ? ', with trade history' : ''}). ${remedy}${includeTradeHistory ? ' or turn trade history off.' : '.'}`);
      }

      await writeAudit(admin, actor.id, {
        // Role and cam_profile_id as they were AT THE TIME. app_users.role is
        // mutable and cam_profile_id is `on delete set null`, so reading them
        // back off the user row months later can no longer answer "was this
        // person entitled to that client when they took it".
        role: actor.role || null,
        camProfileId: actor.cam_profile_id || null,
        selection: scope.selection,
        clientIds: scope.clientIds,
        clientCount: scope.clientIds.length,
        range: { from: range.from, to: range.to, days: range.days, source: range.source },
        includeTradeHistory,
        rowCounts,
        totalRows,
        responseBytes,
        truncated,
        truncation: loaded.truncation,
        // So a batched pull reads as one intent across N rows rather than as N
        // unexplained exports minutes apart, which is the shape this log exists
        // to be able to tell apart from a walk through the book.
        batch,
      });

      return sendJson(res, 200, payload);
    } catch (error) {
      return handleApiError(res, publicError(error), { fallbackMessage: 'Client export failed.' });
    }
  };
}

export default createHandler();
