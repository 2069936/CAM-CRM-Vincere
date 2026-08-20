// Measures what the derivation costs to STORE, per account snapshot, against a
// directory of real NinjaTrader exports.
//
//   node scripts/measure-derivation-bytes.mjs "/path/to/exports"
//
// Why this exists. reconcileDailyImport attaches a `derivation` object to every
// account snapshot it produces, and dailyImportPersistence writes it verbatim
// into account_snapshots.derivation (jsonb, step 37). Two consumers then read
// those rows with `select '*'`: server/export/clientExport.js, which is already
// over its own 4 MiB ceiling on its headline case, and supabaseStore.loadTable
// on every CRM state load. So the size of this blob is a product decision, not
// an implementation detail, and it needs a number rather than an intuition.
//
// The path argument is REQUIRED and no export is committed with this file.
// Nothing here writes, copies or moves anything — the export is read in place.
// Output is AGGREGATES ONLY: no account name, no client name, no per-row money.
//
// It imports src/domain/csvImport.js and src/domain/reconcile.js DIRECTLY, for
// the same reason scripts/verify-derived-pnl.mjs does: a measurement of a
// reimplementation measures the reimplementation. What it prints is therefore
// what reconcile actually attaches today, not a model of it.
//
// MEASURED ON THE 2026-08-18 EXPORT (10 folders, 40 account snapshots), before
// and after reconcile.storableDerivation was introduced. Reproduce the "before"
// column by making createSnapshot store `derivation` verbatim again — it is a
// one-line revert — and re-running this script.
//
//                                  before      after
//   snapshots carrying a blob      40 of 40    21 of 40
//   derivation bytes, total        24,253      3,855
//   bytes per account_snapshot     606         96
//   mean of the blobs kept         606         184
//   largest single blob            730         206
//   'no-trades' rows               19 @ 560 B  not stored
//
// Against the 3,100-row book that is ~1,835 KB of jsonb before and ~292 KB
// after. account_snapshots is 379 B a row in the client export today, so the
// derivation takes that row to ~985 B before and ~475 B after.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseNinjaTraderCsvText } from '../src/domain/csvImport.js';
import { reconcileDailyImport } from '../src/domain/reconcile.js';

const root = process.argv[2];
if (!root) {
  console.error('usage: node scripts/measure-derivation-bytes.mjs <exports-dir>');
  process.exit(2);
}
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error(`not a directory: ${root}`);
  process.exit(2);
}

const bytes = (value) => (value == null ? 0 : Buffer.byteLength(JSON.stringify(value), 'utf8'));
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

function readFolder(dir) {
  const grids = { accounts: [], strategies: [], orders: [], executions: [] };
  for (const name of fs.readdirSync(dir)) {
    if (!name.toLowerCase().endsWith('.csv')) continue;
    const parsed = parseNinjaTraderCsvText(fs.readFileSync(path.join(dir, name), 'utf8'), name);
    if (grids[parsed.type]) grids[parsed.type].push(...parsed.rows);
  }
  return grids;
}

const folders = fs.readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(root, entry.name))
  .filter((dir) => fs.readdirSync(dir).some((name) => name.toLowerCase().endsWith('.csv')));

const byStatus = new Map();
const sizes = [];
let snapshots = 0;
let withDerivation = 0;
let snapshotBytesTotal = 0;

for (const dir of folders) {
  const grids = readFolder(dir);
  if (!grids.accounts.length) continue;
  const result = reconcileDailyImport({
    clientId: 'measure',
    date: '2026-08-18',
    registry: {},
    parsed: grids,
    history: [],
  });
  for (const snapshot of result.snapshots || []) {
    snapshots += 1;
    // The stored row is not the whole snapshot — mapAccountSnapshot writes eight
    // scalars plus this blob — so the blob is measured on its own and the rest
    // of the row is reported separately for scale.
    snapshotBytesTotal += bytes({ ...snapshot, derivation: undefined, strategies: undefined });
    const derivation = snapshot.derivation || null;
    if (!derivation) continue;
    withDerivation += 1;
    const size = bytes(derivation);
    sizes.push(size);
    const status = derivation.status || 'unknown';
    const row = byStatus.get(status) || { count: 0, total: 0, max: 0 };
    row.count += 1;
    row.total += size;
    row.max = Math.max(row.max, size);
    byStatus.set(status, row);
  }
}

const total = sizes.reduce((n, v) => n + v, 0);
const mean = sizes.length ? total / sizes.length : 0;
const max = sizes.reduce((n, v) => Math.max(n, v), 0);

const perSnapshot = snapshots ? total / snapshots : 0;

console.log(`folders read                 ${folders.length}`);
console.log(`account snapshots            ${snapshots}`);
console.log(`carrying a derivation        ${withDerivation}`);
console.log(`derivation bytes, total      ${total} (${kb(total)})`);
// The number the export ceiling cares about: every account_snapshots row pays
// this, including the rows that store no blob at all.
console.log(`bytes per stored row         ${perSnapshot.toFixed(0)}`);
console.log(`mean of the blobs kept       ${mean.toFixed(0)}`);
console.log(`largest single blob          ${max}`);
console.log(`rest of the stored row, mean ${snapshots ? (snapshotBytesTotal / snapshots).toFixed(0) : 0}`);
console.log('');
console.log('by status                    count    mean     max     total');
for (const [status, row] of [...byStatus.entries()].sort()) {
  console.log(
    `  ${status.padEnd(26)} ${String(row.count).padStart(5)} `
    + `${(row.total / row.count).toFixed(0).padStart(7)} ${String(row.max).padStart(7)} `
    + `${String(row.total).padStart(9)}`,
  );
}
console.log('');
// The projection the export ceiling actually cares about. 3,100 stored
// account_snapshots rows is the book's current size; the busiest CAM's default
// 30-day pull is a subset of it, and clientExport.js selects '*'.
const BOOK_ROWS = 3100;
console.log(`projected over ${BOOK_ROWS} stored rows: ${kb(perSnapshot * BOOK_ROWS)}`);
// account_snapshots measured 379 B a row through the client export handler; the
// derivation is what this feature adds on top of that.
console.log(`account_snapshots row, 379 B + derivation: ${(379 + perSnapshot).toFixed(0)} B`);
