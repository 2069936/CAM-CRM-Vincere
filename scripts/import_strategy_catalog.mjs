// Loads a machine's strategy template library into public.strategy_templates.
//
// WHY THE CATALOGUE HAS TO BE HERE AT ALL.
//
// NinjaTrader records which strategy placed an order in Strategy2Order and
// deletes that record by cascade the moment the strategy leaves the workspace.
// Measured on a real VPS on 2026-09-24: 29 surviving links against 18,827
// orders across seven months, on 5 of 129 accounts. The trades survive; the
// label does not.
//
// src/domain/orderAttribution.js recovers the label by comparing the geometry a
// trade exhibits against the geometry a template declares. The CRM already
// holds the orders. This puts the templates beside them, so the answer can be
// computed for the whole desk without waiting for anyone to take an export.
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node scripts/import_strategy_catalog.mjs --export <deep-export-dir> [--dry-run]
//
// The file it reads is attribution/catalog.jsonl, written by agent 1.0.9's Deep
// Export. Earlier agents do not write it; against a 1.0.8 export this says so
// and stops rather than importing an empty catalogue over a good one.
//
// A TEMPLATE IS A PROPERTY OF THE ALGORITHM, NOT OF A MACHINE. OGX v3 on MNQ at
// Medium risk is the same configuration wherever it runs, so importing a second
// machine's library converges on the same rows instead of doubling them, and
// this holds roughly 900 rows for the whole desk however many machines report.
//
// WHAT IT REFUSES TO DO QUIETLY. If a template keeps its identity but its
// geometry has changed - somebody edited the .xml without bumping the version -
// that silently invalidates every past attribution made under that name. This
// prints those, and writes them only when told to with --accept-changes.
//
// Safe to run twice, safe to interrupt.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const GEOMETRY = ['size_1', 'size_2', 'size_3', 'stop_ticks', 'target_1_ticks', 'target_2_ticks', 'target_3_ticks'];

function readArguments(argv) {
  const options = { exportDir: null, dryRun: false, acceptChanges: false };
  for (let at = 0; at < argv.length; at += 1) {
    if (argv[at] === '--dry-run') options.dryRun = true;
    else if (argv[at] === '--accept-changes') options.acceptChanges = true;
    else if (argv[at] === '--export') {
      options.exportDir = argv[at + 1] || null;
      at += 1;
    }
  }
  return options;
}

/** One line per template, as AttributionExport writes it. */
export function readCatalog(file) {
  const rows = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const [at, line] of lines.entries()) {
    const text = line.trim();
    if (!text) continue;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${file}:${at + 1} is not JSON`);
    }
    rows.push(parsed);
  }
  return rows;
}

/**
 * A catalogue line as a database row.
 *
 * Null for a version or a risk the export did not carry, never '' - the
 * identity index folds nulls with coalesce, and an empty string would sit
 * beside a null as a second row for the same template.
 */
export function toRow(line, machineId, exportedAt) {
  const sizes = Array.isArray(line.sizes) ? line.sizes : [];
  const targets = Array.isArray(line.targetTicks) ? line.targetTicks : [];
  const text = (value) => {
    const trimmed = String(value ?? '').trim();
    return trimmed ? trimmed : null;
  };
  const count = (value) => Math.max(0, Math.round(Number(value) || 0));
  return {
    family: String(line.family || '').trim(),
    version: text(line.version),
    risk: text(line.risk),
    instrument: String(line.instrument || '').trim(),
    prop_firm: Boolean(line.propFirm),
    size_1: count(sizes[0]), size_2: count(sizes[1]), size_3: count(sizes[2]),
    stop_ticks: count(line.stopTicks),
    target_1_ticks: count(targets[0]),
    target_2_ticks: count(targets[1]),
    target_3_ticks: count(targets[2]),
    source_machine_id: machineId,
    source_export_at: exportedAt,
  };
}

export const identityOf = (row) => [
  row.family, row.version || '', row.risk || '', row.instrument, row.prop_firm ? 'PF' : '',
].join('\u0000');

export const sameGeometry = (a, b) => GEOMETRY.every((column) => Number(a[column]) === Number(b[column]));

/**
 * The migration's own CHECK refuses a row with no geometry at all, because such
 * a row matches every trade. Dropping those here names them instead of failing
 * the whole import on one unparsed template.
 */
export function usable(row) {
  if (!row.family || !row.instrument) return false;
  return GEOMETRY.slice(3).some((column) => row[column] > 0);
}

async function main() {
  const options = readArguments(process.argv.slice(2));
  if (!options.exportDir) {
    console.error('usage: node scripts/import_strategy_catalog.mjs --export <deep-export-dir> [--dry-run] [--accept-changes]');
    process.exit(2);
  }

  const catalogFile = path.join(options.exportDir, 'attribution', 'catalog.jsonl');
  if (!fs.existsSync(catalogFile)) {
    console.error(`No attribution/catalog.jsonl in ${options.exportDir}.`);
    console.error('Only agent 1.0.9 and later write it. An older export carries no catalogue,');
    console.error('and importing nothing over a good catalogue would be worse than not running.');
    process.exit(1);
  }

  // Identity of the machine, for tracing a catalogue that disagrees with
  // another one. Absent in an export that predates it, which is not fatal.
  let machineId = null;
  let exportedAt = null;
  const manifestFile = path.join(options.exportDir, 'manifest.json');
  if (fs.existsSync(manifestFile)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      machineId = manifest.machineId || manifest.machine_id || null;
      exportedAt = manifest.createdAtUtc || manifest.created_at || null;
    } catch {
      console.warn('manifest.json is unreadable; importing without a source machine.');
    }
  }

  const lines = readCatalog(catalogFile);
  const all = lines.map((line) => toRow(line, machineId, exportedAt));
  const rows = all.filter(usable);
  const dropped = all.length - rows.length;

  // Two machines can hold the same template. Last one in the file wins; they
  // are identical by construction.
  const incoming = new Map();
  for (const row of rows) incoming.set(identityOf(row), row);

  console.log(`Read ${all.length} template(s) from ${catalogFile}`);
  if (dropped) console.log(`  ${dropped} skipped: no family, no instrument, or no geometry to match on`);
  console.log(`  ${incoming.size} distinct template identities`);

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    // Reading and checking a catalogue is worth doing on its own - it is how
    // you find out whether an export carries one before you go looking for a
    // key - so --dry-run stops here rather than refusing.
    if (options.dryRun) {
      console.log('\nNo SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY set, so nothing was compared.');
      return;
    }
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
    process.exit(2);
  }
  const admin = createClient(url, key, { auth: { persistSession: false } });

  const { data: existingRows, error } = await admin
    .from('strategy_templates')
    .select(`id, family, version, risk, instrument, prop_firm, ${GEOMETRY.join(', ')}`);
  if (error) throw new Error(error.message);

  const existing = new Map();
  for (const row of existingRows || []) existing.set(identityOf(row), row);

  const inserts = [];
  const changed = [];
  let unchanged = 0;
  for (const [identity, row] of incoming) {
    const before = existing.get(identity);
    if (!before) inserts.push(row);
    else if (sameGeometry(before, row)) unchanged += 1;
    else changed.push({ before, after: row });
  }

  console.log(`\n  new          ${inserts.length}`);
  console.log(`  unchanged    ${unchanged}`);
  console.log(`  CHANGED      ${changed.length}`);

  if (changed.length) {
    console.log('\nThese templates kept their name and version but moved their geometry.');
    console.log('Every past attribution made under these names was made against the old');
    console.log('numbers, so accepting them means re-running the attribution afterwards.\n');
    for (const { before, after } of changed) {
      const name = [after.family, after.version, after.risk, after.instrument].filter(Boolean).join(' ');
      const show = (row) => `${row.size_1}/${row.size_2}/${row.size_3} stop ${row.stop_ticks} targets ${row.target_1_ticks}/${row.target_2_ticks}/${row.target_3_ticks}`;
      console.log(`  ${name}\n    was ${show(before)}\n    now ${show(after)}`);
    }
    if (!options.acceptChanges) console.log('\nNot writing these. Re-run with --accept-changes to take them.');
  }

  if (options.dryRun) {
    console.log('\n--dry-run: nothing written.');
    return;
  }

  if (inserts.length) {
    for (let at = 0; at < inserts.length; at += 500) {
      const batch = inserts.slice(at, at + 500);
      const { error: insertError } = await admin.from('strategy_templates').insert(batch);
      if (insertError) throw new Error(insertError.message);
    }
    console.log(`\nInserted ${inserts.length} template(s).`);
  }

  if (changed.length && options.acceptChanges) {
    for (const { before, after } of changed) {
      const patch = { ...after };
      delete patch.family; delete patch.version; delete patch.risk;
      delete patch.instrument; delete patch.prop_firm;
      const { error: updateError } = await admin
        .from('strategy_templates').update(patch).eq('id', before.id);
      if (updateError) throw new Error(updateError.message);
    }
    console.log(`Updated ${changed.length} template(s). Re-run scripts/attribute_orders.mjs.`);
  }

  if (!inserts.length && !(changed.length && options.acceptChanges)) {
    console.log('\nNothing to write; the catalogue already matches.');
  }
}

// Importable for tests; runs only when invoked as a command.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((problem) => {
    console.error(problem.message);
    process.exit(1);
  });
}
