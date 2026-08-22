// What the export actually weighs, and whether the dialog's estimate of it is
// worth showing anyone.
//
// The synthetic half — that the dictionary hoists pairs, that a split carries
// every client once, that an undeliverable set blocks the button — is in
// server/tests/export/client-export-size.test.js, src/domain/clientExportPlan.test.js
// and src/components/ClientExportDialog.test.jsx, none of which are gated, so CI
// pins all of it.
//
// What needs the book is the SIZE, and it is the whole reason any of this exists:
//
//   * The busiest CAM's default 30-day pull was 3.995 MiB against a 4 MiB
//     ceiling. 99.9% — under it by 4.8 KB. The endpoint was one trading day
//     from refusing its own headline case, the same pull with trade history
//     already was a 413 at 7.11 MB, and the next-busiest CAM was at 93.9%.
//   * params_parsed + parameters_raw were 1,586 KB of that — 38.8% of the entire
//     budget — to say 42 distinct strategy configurations 1,022 times.
//   * With them hoisted, the same pull is 2.505 MiB. 62.6%.
//
// And the estimate: BYTES_PER_ROW, BYTES_PER_CLIENT and BYTES_PER_SESSION in
// clientExportPlan.js are numbers fitted against this book. They decide when the
// dialog warns and how it splits a pull into parts, and a constant that has
// rotted produces either a promised download the server refuses or a warning on
// a pull that would have been fine. Nothing but the book can tell.
//
// It runs the REAL handler over the real (redacted) rows through the same fake
// PostgREST the server suite uses, so the paging, chunking and range logic are
// the shipped ones.

import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createHandler,
  hoistStrategyParameters,
  rehydrateStrategyParameters,
} from '../../server/export/clientExport.js';
import { createFakeSupabase } from '../../server/tests/export/fakeSupabase.js';
import { buildClientExportPlan, planExportBatches } from './clientExportPlan.js';

const snapshot = JSON.parse(readFileSync(new URL('../../public/local-snapshot.json', import.meta.url), 'utf8'));
const tables = snapshot.tables;
const MIB = 1024 * 1024;
const CEILING = 4 * MIB;
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

function response() {
  return {
    headers: {},
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

// The ceiling is lifted for these runs on purpose: the point is to MEASURE what
// a pull weighs, and a 413 would replace the measurement with an error string.
function pull(actor, body = {}) {
  const admin = createFakeSupabase(tables, { inserts: [] });
  const handler = createHandler({
    createClients: () => ({ admin, auth: {} }),
    authorize: async () => actor,
    maxResponseBytes: Number.POSITIVE_INFINITY,
    // The book's last close is 2026-07-30; "today" is pinned just after it so
    // the default 30-day range lands on real sessions rather than empty days.
    now: () => new Date('2026-07-31T12:00:00.000Z'),
  });
  const res = response();
  return handler({ method: 'POST', headers: {}, body }, res).then(() => res.body);
}

// CAMs ranked by how much they actually import, from the assignment table
// rather than by name.
const importsByClient = new Map();
for (const row of tables.daily_imports) {
  importsByClient.set(row.client_id, (importsByClient.get(row.client_id) || 0) + 1);
}
const camTotals = new Map();
for (const row of tables.client_assignments) {
  const current = camTotals.get(row.cam_profile_id) || { clients: [], imports: 0 };
  current.clients.push(row.client_id);
  current.imports += importsByClient.get(row.client_id) || 0;
  camTotals.set(row.cam_profile_id, current);
}
const ranked = [...camTotals.entries()].sort((a, b) => b[1].imports - a[1].imports);
const asCam = (id) => ({ id: 'app-user-cam', role: 'CAM', cam_profile_id: id });

describe('what the dictionary is worth on the book', () => {
  it('takes the busiest CAM off the ceiling it was standing on', async () => {
    const payload = await pull(asCam(ranked[0][0]));
    const strategyRows = payload.tables.strategy_snapshots;
    const dictionary = payload.dictionaries.strategyParameters;

    // The shape of the problem: a handful of configurations, restated per
    // account per day.
    expect(strategyRows.length).toBeGreaterThan(1000);
    expect(dictionary.distinctValues).toBeLessThan(60);

    // What it cost inline: 99.9% of everything a single response can carry.
    // Not over — under by 4.8 KB, which is the point. One more trading day on
    // one more account and the endpoint's own headline case is a 413, and the
    // same pull WITH trade history already was one at 7.11 MB.
    const inline = { ...payload, tables: { ...payload.tables, strategy_snapshots: rehydrateStrategyParameters(payload) } };
    delete inline.dictionaries;
    expect(bytes(inline)).toBeGreaterThan(CEILING * 0.99);

    // What it costs hoisted. Comfortably under, with room for the book to grow.
    expect(bytes(payload)).toBeLessThan(CEILING * 0.7);
    // Worth stating as a ratio too, because the ceiling is a constant somebody
    // may raise one day and the saving is a property of the data.
    expect(bytes(payload) / bytes(inline)).toBeLessThan(0.65);
  });

  it('leaves every CAM on the desk able to export their own book in one file', async () => {
    // Two of the eight were over or within 6% of the ceiling before. The desk
    // manager's ask was more clients per export; this is the half of the answer
    // that removes the need to split at the sizes this desk has.
    for (const [camId] of ranked) {
      const payload = await pull(asCam(camId));
      expect(bytes(payload)).toBeLessThan(CEILING);
    }
  });

  it('stores the two columns as one pair, which the book is the reason for', async () => {
    // 116 distinct params_parsed and 129 distinct parameters_raw across the
    // whole table, but only 135 distinct PAIRS. Two dictionaries would be 245
    // entries and would record the pairing nowhere.
    const all = tables.strategy_snapshots;
    const parsed = new Set(all.map((row) => JSON.stringify(row.params_parsed ?? null)));
    const raw = new Set(all.map((row) => JSON.stringify(row.parameters_raw ?? null)));
    const { entries } = hoistStrategyParameters(all);
    // Count the PAIRS, not a bound around them. `>= max(parsed, raw)` is
    // satisfied at 129 by keying on parameters_raw alone, which is exactly the
    // wrong key: one raw value in this book maps to more than one parsed object
    // and 77 rows come back with somebody else's configuration.
    const pairs = new Set(all.map((row) => JSON.stringify([row.params_parsed ?? null, row.parameters_raw ?? null])));
    expect(entries.length).toBe(pairs.size);
    expect(entries.length).toBeLessThan(parsed.size + raw.size);
    expect(entries.length).toBeGreaterThan(Math.max(parsed.size, raw.size));
  });

  it('puts the whole table back byte for byte', async () => {
    // 3,805 rows, 98 of them with an empty parameters_raw. If the round trip
    // ever stops holding, an analysis reading configurations out of this export
    // is reading a different book from the CRM.
    const payload = await pull({ id: 'm', role: 'Manager', cam_profile_id: null }, {
      clientIds: tables.clients.slice(0, 50).map((row) => row.id),
    });
    const restored = rehydrateStrategyParameters(payload);
    const stored = new Map(tables.strategy_snapshots.map((row) => [row.id, row]));
    expect(restored.length).toBeGreaterThan(500);
    for (const row of restored) expect(row).toEqual(stored.get(row.id));
  });
});

describe('the estimate the dialog shows', () => {
  // The CRM's in-browser client objects, rebuilt from the same rows the export
  // reads, so the plan is fed what the app would feed it.
  function clientsForCam(camId) {
    const ids = camTotals.get(camId).clients;
    const accountsByClient = new Map();
    for (const account of tables.trading_accounts) {
      if (!accountsByClient.has(account.client_id)) accountsByClient.set(account.client_id, {});
      accountsByClient.get(account.client_id)[account.account_name] = {};
    }
    const importsFor = new Map();
    for (const row of tables.daily_imports) {
      if (!importsFor.has(row.client_id)) importsFor.set(row.client_id, []);
      importsFor.get(row.client_id).push({
        date: row.trading_date,
        sourceSummary: row.source_summary || {},
      });
    }
    const activityFor = new Map();
    for (const row of tables.activity_logs) {
      if (!activityFor.has(row.client_id)) activityFor.set(row.client_id, []);
      activityFor.get(row.client_id).push({ createdAt: row.created_at });
    }
    return ids.map((id) => ({
      id,
      uuid: id,
      name: (tables.clients.find((row) => row.id === id) || {}).name || '',
      accountRegistry: accountsByClient.get(id) || {},
      dailyImports: importsFor.get(id) || [],
      activityLog: activityFor.get(id) || [],
    }));
  }

  const RANGE = { from: '2026-07-02', to: '2026-07-31' };

  it('lands within a tenth of what the server actually returns', async () => {
    // The constants in clientExportPlan.js were fitted against this book. This
    // is the test that notices when they stop describing it — a stale
    // strategy_snapshots figure alone was 4x too high the day the dictionary
    // landed, which would have had the dialog refusing pulls the server
    // accepts. The band is deliberately tight; it is not a smoke test.
    for (const [camId] of ranked) {
      const payload = await pull(asCam(camId), RANGE);
      // Only CAMs with a real book: on a nearly dormant one the fixed envelope
      // dominates and the ratio says nothing about the row constants.
      if ((payload.tables.daily_imports || []).length < 50) continue;
      const plan = buildClientExportPlan(clientsForCam(camId), RANGE);
      const ratio = plan.estimatedBytes / bytes(payload);
      expect(ratio).toBeGreaterThan(0.9);
      expect(ratio).toBeLessThan(1.12);
    }
  });

  it('never plans a part the server would refuse', async () => {
    // The property that makes batching safe, measured end to end: take the
    // whole book, let the planner split it by its estimate, then pull each part
    // for real and check it fits. A part that 413s mid-download is the failure
    // this margin exists to prevent.
    const everyClient = tables.clients.map((row) => row.id);
    const camByClient = new Map();
    for (const [camId, cam] of ranked) for (const id of cam.clients) camByClient.set(id, camId);
    const clients = everyClient.map((id) => {
      const camId = camByClient.get(id);
      return camId ? clientsForCam(camId).find((entry) => entry.id === id) : null;
    }).filter(Boolean);

    const split = planExportBatches(clients, RANGE);
    // The whole book does not fit in one response even with the dictionary —
    // 10.1 MiB of tables and series — so this is a real split, not a no-op.
    expect(split.batchCount).toBeGreaterThan(1);
    expect(split.deliverable).toBe(true);

    for (const part of split.batches) {
      const payload = await pull({ id: 'm', role: 'Manager', cam_profile_id: null }, {
        ...RANGE,
        clientIds: part.clientIds,
      });
      expect(bytes(payload)).toBeLessThan(CEILING);
    }
  });

  it('splits the book on weight, and the weight is not the headcount', async () => {
    // The finding behind the axis change, stated against the real desk: the CAM
    // with the most clients has one of the smallest books on it.
    const byClients = [...ranked].sort((a, b) => b[1].clients.length - a[1].clients.length);
    const mostClients = byClients[0];
    const heaviest = ranked[0];
    expect(mostClients[1].clients.length).toBeGreaterThan(heaviest[1].clients.length);
    expect(bytes(await pull(asCam(mostClients[0])))).toBeLessThan(bytes(await pull(asCam(heaviest[0]))));
  });
});
