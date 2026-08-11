// Runs the CAM-scoped export handler against the redacted copy of the real book
// and prints the envelope, so the payload is read rather than inferred from a
// green test suite.
//
//   node scripts/verify-client-export.mjs
//
// public/local-snapshot.json is untracked and holds real (redacted) client data;
// nothing here writes it back out.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createHandler } from '../server/export/clientExport.js';
import { createFakeSupabase } from '../server/tests/export/fakeSupabase.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const snapshotPath = path.join(root, 'public/local-snapshot.json');
if (!fs.existsSync(snapshotPath)) {
  console.error(`Missing ${snapshotPath}. This script needs the local snapshot of the book.`);
  process.exit(1);
}

const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
const tables = snapshot.tables;

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function run({ actor, body, missingTables = [], maxRowsPerTable }) {
  const inserts = [];
  const admin = createFakeSupabase(tables, { missingTables, inserts });
  const handler = createHandler({
    createClients: () => ({ admin, auth: {} }),
    authorize: async () => actor,
    ...(maxRowsPerTable ? { maxRowsPerTable } : {}),
    // The book's last close is 2026-07-30; "today" is pinned just after it so
    // the default range lands on real sessions instead of on empty days.
    now: () => new Date('2026-07-31T12:00:00.000Z'),
  });
  const res = response();
  return handler({ method: 'POST', headers: { authorization: 'Bearer x' }, body }, res)
    .then(() => ({ res, inserts }));
}

const bytes = (value) => `${(Buffer.byteLength(JSON.stringify(value), 'utf8') / 1024 / 1024).toFixed(2)} MB`;

// The busiest CAM by row volume, found from the assignment table rather than by name.
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
const [busiestCamId, busiest] = [...camTotals.entries()].sort((a, b) => b[1].imports - a[1].imports)[0];
const busiestClient = [...importsByClient.entries()].sort((a, b) => b[1] - a[1])[0][0];

const cam = { id: 'app-user-cam', role: 'CAM', cam_profile_id: busiestCamId };
const manager = { id: 'app-user-manager', role: 'Manager', cam_profile_id: null };

console.log(`book: ${tables.clients.length} clients, ${tables.daily_imports.length} imports, ${tables.orders.length} orders`);
console.log(`busiest CAM ${busiestCamId}: ${busiest.clients.length} clients, ${busiest.imports} imports`);
console.log(`busiest client ${busiestClient}: ${importsByClient.get(busiestClient)} imports\n`);

const cases = [
  {
    label: 'A. one client, one day (2026-07-13)',
    actor: manager,
    body: { clientIds: [busiestClient], from: '2026-07-13', to: '2026-07-13', includeTradeHistory: true },
  },
  {
    label: 'B. one client, one week (2026-07-24..2026-07-30)',
    actor: manager,
    body: { clientIds: [busiestClient], from: '2026-07-24', to: '2026-07-30', includeTradeHistory: true },
  },
  {
    label: 'C. one client, default range (no from/to)',
    actor: manager,
    body: { clientIds: [busiestClient] },
  },
  {
    label: 'D. busiest CAM, all their clients, default range, no trade history',
    actor: cam,
    body: {},
  },
  {
    label: 'E. busiest CAM, all their clients, default range, WITH trade history',
    actor: cam,
    body: { includeTradeHistory: true },
  },
  {
    label: 'F. busiest CAM, all their clients, whole book window (2026-06-25..2026-07-30), with trades',
    actor: cam,
    body: { from: '2026-06-25', to: '2026-07-30', includeTradeHistory: true },
  },
];

for (const testCase of cases) {
  const { res, inserts } = await run(testCase);
  const body = res.body;
  console.log(`── ${testCase.label}`);
  if (res.statusCode !== 200) {
    console.log(`   ${res.statusCode} ${body.error}\n`);
    continue;
  }
  console.log(`   status ${res.statusCode}  payload ${bytes(body)}  selection=${body.scope.selection} clients=${body.scope.includedClientCount}`);
  console.log(`   range ${body.range.from}..${body.range.to} (${body.range.days}d, source=${body.range.source})  truncated=${body.truncated}`);
  console.log(`   rows ${JSON.stringify(body.rowCounts)}  total=${body.totalRows}`);
  const withDays = body.series.filter((entry) => entry.days.length);
  console.log(`   series: ${body.series.length} clients, ${withDays.length} with sessions, ${body.series.reduce((sum, e) => sum + e.days.length, 0)} sessions total`);
  const sample = withDays.sort((a, b) => b.days.length - a.days.length)[0];
  if (sample) {
    console.log(`   sample ${sample.clientName}: ${JSON.stringify(sample.summary)}`);
    const day = sample.days[sample.days.length - 1];
    console.log(`   last day ${day.date} status=${day.status} totals=${JSON.stringify(day.totals)}`);
    console.log(`            week=${JSON.stringify(day.week)}`);
    console.log(`            counts=${JSON.stringify(day.counts)}`);
    console.log(`            cumulative=${JSON.stringify(day.cumulative)}`);
    console.log(`            account[0]=${JSON.stringify(day.accounts[0])}`);
  }
  console.log(`   audit ${JSON.stringify(inserts.map((entry) => ({ table: entry.table, action: entry.row.action, clients: entry.row.after_data.clientCount, total: entry.row.after_data.totalRows })))}`);
  // Only the data blocks: the envelope legitimately names product_key and
  // client_credentials in its own redaction/exclusion notes.
  const payload = JSON.stringify({ tables: body.tables, series: body.series });
  console.log(`   leak check on tables+series: ${/product_key|password_encrypted|firm_password|"login"|client_credentials/.test(payload) ? 'LEAK' : 'clean'}`);
  console.log('');
}

// Authorization, the two that matter.
const otherCamId = [...camTotals.keys()].find((id) => id !== busiestCamId);
const foreignClient = camTotals.get(otherCamId).clients.find((id) => !busiest.clients.includes(id));
const denied = await run({ actor: cam, body: { clientIds: [busiest.clients[0], foreignClient] } });
console.log(`── G. CAM asks for one of theirs + one of another CAM's -> ${denied.res.statusCode} ${denied.res.body.error}`);
const allowed = await run({ actor: manager, body: { clientIds: [foreignClient] } });
console.log(`── H. Manager asks for that same foreign client -> ${allowed.res.statusCode} clients=${allowed.res.body.scope?.includedClientCount}`);
const ghost = await run({ actor: cam, body: { clientIds: ['00000000-0000-4000-8000-000000000000'] } });
console.log(`── I. CAM asks for a client that does not exist -> ${ghost.res.statusCode} ${ghost.res.body.error} (same message as G, no existence leak)`);
const tooLong = await run({ actor: cam, body: { from: '2026-01-01', to: '2026-07-30' } });
console.log(`── J. 211-day range -> ${tooLong.res.statusCode} ${tooLong.res.body.error}`);
const missing = await run({ actor: manager, body: { clientIds: [busiestClient], from: '2026-07-24', to: '2026-07-30' }, missingTables: ['price_checks'] });
console.log(`── K. price_checks table absent -> ${missing.res.statusCode} skippedTables=${JSON.stringify(missing.res.body.skippedTables?.map((entry) => entry.table))}`);

// Truncation, forced by dropping the row ceiling to something this book exceeds.
const capped = await run({
  actor: cam,
  body: { from: '2026-06-25', to: '2026-07-30', includeTradeHistory: true },
  maxRowsPerTable: 250,
});
console.log(`── L. row ceiling 250 -> truncated=${capped.res.body.truncated} ${JSON.stringify(capped.res.body.truncation.map((entry) => entry.table))}`);
console.log(`      rowCounts ${JSON.stringify(capped.res.body.rowCounts)}`);
console.log(`      audit truncated=${capped.inserts[0].row.after_data.truncated}`);

const envelope = (await run({ actor: manager, body: { clientIds: [busiestClient], from: '2026-07-24', to: '2026-07-30' } })).res.body;
const { series, tables: _tables, ...rest } = envelope;
console.log('\n── full envelope (tables and series omitted) ──');
console.log(JSON.stringify(rest, null, 2));
