// Measures what ONE strategy_snapshots row costs to store, against a directory
// of real NinjaTrader exports.
//
//   node scripts/measure-strategy-row-bytes.mjs "/path/to/exports"
//
// The sibling of scripts/measure-derivation-bytes.mjs, which measures the blob
// on account_snapshots. This one measures the other half of step 37: the columns
// the derivation adds to strategy_snapshots, which is the heavier table — 1,033
// rows at 2,094 bytes each on the busiest CAM's default export pull, against 379
// bytes a row for account_snapshots. See the header of
// server/export/clientExport.js, which dumps both wholesale under a 4 MiB
// ceiling enforced as a 413 and is already over it.
//
// It goes through persistDailyImportWithClient rather than calling mapStrategy,
// because mapStrategy is not exported and a measurement of a re-implementation
// measures the re-implementation. The fake adapter below only records what the
// SHIPPED mapper handed it.
//
// The path argument is REQUIRED and no export is committed with this file.
// Nothing here writes, copies or moves anything — the export is read in place.
// Output is AGGREGATES ONLY: no account name, no client name, no per-row money.
//
// MEASURED ON THE 2026-08-18 EXPORT (10 folders, 47 strategy rows across 40
// account snapshots), before and after step 37 was cut from three derived
// columns to one.
//
//                                 before   after
//   derived_realized               23.9    23.9   B/row
//   derived_realized_status        35.4       —
//   derived_realized_join          37.1       —
//   all step-37 columns            96.4    23.9   B/row
//   distinct (status, join) pairs      4       —   across all 47 rows
//
// REPRODUCING THE "before" COLUMN TAKES TWO EDITS, NOT ONE, and doing only the
// first quietly under-reports it. Restore in dailyImportPersistence.mapStrategy:
//   derived_realized_status: strategy.derivedRealizedStatus || null,
//   derived_realized_join: strategy.derivedRealizedJoin || null,
// and ALSO in joinDerivedStrategies, where the row's copy of the account-day
// verdict was removed along with the column it fed:
//   const derivedRealizedStatus = derivation?.status || 'no-trades';
// set on each joined row as `derivedRealizedStatus`. With only the first edit the
// status column is written null on every row and measures 31.0 B/row against its
// real 35.4, and the (status, join) pairs collapse from 4 to 3 — the exact shape
// of a measurement that flatters the thing being measured. `derivedRealizedJoin`
// needs no second edit: the join still computes it, it is simply not stored.
//
// Over the busiest CAM's 1,033 strategy rows that is 97.3 KiB against 24.1 KiB.
// The four distinct pairs across forty-seven rows are the finding in one number:
// the two cut columns were the account-day's own verdict, written out once per
// roster row of that account, while account_snapshots.derivation already stored
// it once.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseNinjaTraderCsvText } from '../src/domain/csvImport.js';
import { reconcileDailyImport } from '../src/domain/reconcile.js';
import { persistDailyImportWithClient } from '../src/domain/dailyImportPersistence.js';

const root = process.argv[2];
if (!root) {
  console.error('usage: node scripts/measure-strategy-row-bytes.mjs <exports-dir>');
  process.exit(2);
}
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error(`not a directory: ${root}`);
  process.exit(2);
}

const CLIENT_UUID = '00000000-0000-4000-8000-000000000001';
// Every column step 37 was drafted to add. The two that were cut stay on this
// list on purpose: the script has to be able to say they are 0 B, or restoring
// them by accident would be invisible to it.
const COLUMNS = ['derived_realized', 'derived_realized_status', 'derived_realized_join'];
// The busiest CAM's default 30-day pull, from the clientExport.js header.
const BUSIEST_CAM_STRATEGY_ROWS = 1033;

const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const kib = (n) => `${(n / 1024).toFixed(1)} KiB`;

function readFolder(dir) {
  const grids = { accounts: [], strategies: [], orders: [], executions: [] };
  for (const name of fs.readdirSync(dir)) {
    if (!name.toLowerCase().endsWith('.csv')) continue;
    const parsed = parseNinjaTraderCsvText(fs.readFileSync(path.join(dir, name), 'utf8'), name);
    if (grids[parsed.type]) grids[parsed.type].push(...parsed.rows);
  }
  return grids;
}

// A database that keeps exactly what the shipped mapper gave it, and nothing else.
async function capture(importResult) {
  const written = { snapshots: [], strategies: [] };
  const accounts = Object.keys(importResult.accounts || {})
    .map((name, index) => ({ id: `acct-${index}`, account_name: name }));
  const db = {
    transaction: async (work) => work(db),
    guardDailyImportWritable: async () => null,
    upsertTradingAccounts: async () => undefined,
    listTradingAccounts: async () => accounts,
    upsertDailyImport: async (row) => ({ id: 'import-1', ...row }),
    deleteDailyImportRows: async () => undefined,
    upsertAccountSnapshots: async (rows) => {
      written.snapshots = rows.map((row, index) => ({ id: `snapshot-${index + 1}`, ...row }));
      return written.snapshots;
    },
    insertRows: async (table, rows) => {
      if (table === 'strategy_snapshots') written.strategies = rows;
    },
  };
  await persistDailyImportWithClient({ db, clientUuid: CLIENT_UUID, importResult });
  return written;
}

const folders = fs.readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(root, entry.name))
  .filter((dir) => fs.readdirSync(dir).some((name) => name.toLowerCase().endsWith('.csv')));

const perColumn = new Map(COLUMNS.map((column) => [column, 0]));
const pairs = new Map();
let strategyRows = 0;
let strategyBytes = 0;

for (const dir of folders) {
  const grids = readFolder(dir);
  if (!grids.accounts.length) continue;
  const importResult = reconcileDailyImport({
    clientId: 'measure', date: '2026-08-18', registry: {}, parsed: grids, history: [],
  });
  const written = await capture(importResult);
  for (const row of written.strategies) {
    strategyRows += 1;
    const full = bytes(row);
    strategyBytes += full;
    // Marginal cost of a column: the row with it, minus the row without it. That
    // counts the key, the colon, the value and the comma that separates it.
    for (const column of COLUMNS) {
      if (!(column in row)) continue;
      const rest = Object.fromEntries(Object.entries(row).filter(([key]) => key !== column));
      perColumn.set(column, perColumn.get(column) + (full - bytes(rest)));
    }
    // How many DISTINCT answers those two columns gave across the whole export.
    // A small number here against a large row count is the duplication itself.
    const key = `${row.derived_realized_status ?? 'not stored'} | ${row.derived_realized_join ?? 'not stored'}`;
    pairs.set(key, (pairs.get(key) || 0) + 1);
  }
}

const per = (n) => (strategyRows ? n / strategyRows : 0);
const derivedTotal = COLUMNS.reduce((n, column) => n + perColumn.get(column), 0);

console.log(`folders read                  ${folders.length}`);
console.log(`strategy_snapshots rows       ${strategyRows}`);
console.log(`strategy row bytes, mean      ${per(strategyBytes).toFixed(1)}`);
console.log('');
console.log('step 37 columns               B/row     total   over 1,033 rows');
for (const column of COLUMNS) {
  const total = perColumn.get(column);
  console.log(
    `  ${column.padEnd(26)} ${per(total).toFixed(1).padStart(6)} ${String(total).padStart(9)}`
    + `   ${kib(per(total) * BUSIEST_CAM_STRATEGY_ROWS).padStart(9)}`,
  );
}
console.log(
  `  ${'all of them'.padEnd(26)} ${per(derivedTotal).toFixed(1).padStart(6)} ${String(derivedTotal).padStart(9)}`
  + `   ${kib(per(derivedTotal) * BUSIEST_CAM_STRATEGY_ROWS).padStart(9)}`,
);
console.log('');
console.log(`distinct (status, join) pairs across ${strategyRows} rows: ${pairs.size}`);
for (const [key, count] of [...pairs.entries()].sort()) {
  console.log(`  ${key.padEnd(30)} ${String(count).padStart(4)}`);
}
