// Fills orders.attributed_family / attributed_version / attribution_basis for
// every order the CRM holds, from the catalogue in public.strategy_templates.
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node scripts/attribute_orders.mjs [--client <uuid>] [--since <yyyy-mm-dd>] [--dry-run]
//
// WHY THIS IS A SCRIPT AND NOT PART OF THE MIGRATION. The rule lives in
// src/domain/orderAttribution.js, which the collector's C# engine mirrors line
// for line. Writing it a third time in PL/pgSQL to backfill would put one
// decision in three languages, and the decision is the delicate part: a wrong
// algorithm name silently moves a day's losses onto an algorithm that never
// traded them, so a geometry two algorithms share attributes to neither. That
// refusal is worth exactly as much as it is consistent.
//
// ONE ACCOUNT-DAY AT A TIME, AND THAT GROUPING IS NOT AN OPTIMISATION.
// Reconstruction walks orders in sequence and gives each exit to the oldest
// open entry with room for it. Orders from two accounts in one walk cross-
// attach: account A's stop closes account B's entry, and the geometry that
// comes out belongs to neither. `time_text` is a clock, not a date, so two days
// in one walk do the same thing. The pair (daily_import_id, trading_account_id)
// is one account on one day, which is the only unit where the walk means
// anything.
//
// IDEMPOTENT BY REWRITING, NOT BY SKIPPING. Every order in a group it processes
// is written - its answer, or nulls. So a re-run after the catalogue changed
// removes attributions that are no longer supported instead of leaving them to
// rot, and a run that stopped halfway leaves what it finished correct.

import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { attributeOrders } from '../src/domain/orderAttribution.js';
import { parseExecutionTime } from '../src/domain/deriveStrategyPnl.js';

const PAGE = 1000;
const WRITE_BATCH = 500;

function readArguments(argv) {
  const options = { clientId: null, since: null, dryRun: false };
  for (let at = 0; at < argv.length; at += 1) {
    if (argv[at] === '--dry-run') options.dryRun = true;
    else if (argv[at] === '--client') { options.clientId = argv[at + 1] || null; at += 1; }
    else if (argv[at] === '--since') { options.since = argv[at + 1] || null; at += 1; }
  }
  return options;
}

async function allRows(query) {
  const rows = [];
  for (let page = 0; ; page += 1) {
    const from = page * PAGE;
    const { data, error } = await query().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if ((data || []).length < PAGE) return rows;
  }
}

/**
 * A catalogue row in the shape the matcher reads.
 *
 * The matcher asks `template.target2Ticks`; the column is `target_2_ticks`.
 * Renaming happens here rather than in the module, so the module stays the same
 * code the collector runs against NinjaTrader's own tables.
 */
export const toTemplate = (row) => ({
  family: row.family,
  version: row.version,
  risk: row.risk,
  instrument: row.instrument,
  propFirm: row.prop_firm,
  size1: row.size_1, size2: row.size_2, size3: row.size_3,
  stopTicks: row.stop_ticks,
  target1Ticks: row.target_1_ticks,
  target2Ticks: row.target_2_ticks,
  target3Ticks: row.target_3_ticks,
});

/**
 * A CRM order row in the shape the engine reads.
 *
 * THE SCRIPT DECIDES THE ORDER, because only the script knows what the columns
 * mean. NinjaTrader's grid writes two clock formats in one export ("9:35 AM"
 * and "7/13/2026 4:30:52 PM"), and sorting either as text puts 10am before 9am,
 * which reorders a morning and hands the first trade's targets to the second.
 * `parseExecutionTime` reads both, and is the same reader deriveStrategyPnl
 * uses for the same reason. Same-second ties break on external_order_id, which
 * NinjaTrader issues monotonically, and then on the row's own uuid so that a
 * run is reproducible even where both are absent.
 */
export function toOrders(rows) {
  const ordered = rows
    .map((row) => ({ row, at: parseExecutionTime(row.time_text) ?? 0, seq: Number(row.external_order_id) || 0 }))
    .sort((a, b) => a.at - b.at || a.seq - b.seq || String(a.row.id).localeCompare(String(b.row.id)));
  return ordered.map(({ row }, position) => ({
    id: row.id,
    name: row.name,
    instrument: row.instrument,
    quantity: row.quantity,
    limitPrice: row.limit_price,
    stopPrice: row.stop_price,
    avgPrice: row.avg_price,
    strategyName: row.strategy_name,
    // The position in the sequence decided above, so the engine's own sort
    // preserves it rather than re-deriving it from a column it cannot read.
    time: position,
  }));
}

async function main() {
  const options = readArguments(process.argv.slice(2));
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
    process.exit(2);
  }
  const admin = createClient(url, key, { auth: { persistSession: false } });

  const templateRows = await allRows(() => admin.from('strategy_templates')
    .select('family, version, risk, instrument, prop_firm, size_1, size_2, size_3, stop_ticks, target_1_ticks, target_2_ticks, target_3_ticks')
    .order('family'));
  const templates = templateRows.map(toTemplate);
  if (!templates.length) {
    console.error('public.strategy_templates is empty. Run scripts/import_strategy_catalog.mjs first.');
    console.error('With no catalogue this would write nulls over every attribution in the table.');
    process.exit(1);
  }
  console.log(`Catalogue: ${templates.length} template(s), ${new Set(templates.map((t) => t.family)).size} algorithm(s).`);

  const days = await allRows(() => {
    let query = admin.from('daily_imports').select('id, client_id, trading_date').order('trading_date');
    if (options.clientId) query = query.eq('client_id', options.clientId);
    if (options.since) query = query.gte('trading_date', options.since);
    return query;
  });
  console.log(`Days to walk: ${days.length}\n`);

  const totals = { orders: 0, written: 0, record: 0, inferred: 0, cleared: 0, unattributed: 0, orphaned: 0 };
  const byFamily = new Map();

  for (const [at, day] of days.entries()) {
    const orders = await allRows(() => admin.from('orders')
      .select('id, daily_import_id, trading_account_id, external_order_id, strategy_name, instrument, quantity, limit_price, stop_price, avg_price, name, time_text, attribution_basis')
      .eq('daily_import_id', day.id));
    if (!orders.length) continue;
    totals.orders += orders.length;

    // An order nobody can place with an account cannot be reconstructed against
    // the other orders of that account, and guessing which account it belongs
    // to is exactly the cross-attachment this grouping exists to prevent.
    const placed = orders.filter((row) => row.trading_account_id);
    totals.orphaned += orders.length - placed.length;

    const groups = new Map();
    for (const row of placed) {
      const list = groups.get(row.trading_account_id) || [];
      list.push(row);
      groups.set(row.trading_account_id, list);
    }

    const answers = new Map();
    for (const group of groups.values()) {
      for (const answer of attributeOrders(toOrders(group), templates)) {
        answers.set(answer.id, answer);
      }
    }

    const stamp = new Date().toISOString();
    const writes = placed.map((row) => {
      const answer = answers.get(row.id);
      if (!answer) {
        if (row.attribution_basis) totals.cleared += 1;
        totals.unattributed += 1;
        return {
          id: row.id, daily_import_id: row.daily_import_id,
          attributed_family: null, attributed_version: null,
          attribution_basis: null, attributed_at: null,
        };
      }
      totals[answer.basis] += 1;
      byFamily.set(answer.family, (byFamily.get(answer.family) || 0) + 1);
      return {
        id: row.id, daily_import_id: row.daily_import_id,
        attributed_family: answer.family,
        attributed_version: answer.version,
        attribution_basis: answer.basis,
        attributed_at: stamp,
      };
    });

    if (!options.dryRun) {
      for (let from = 0; from < writes.length; from += WRITE_BATCH) {
        const { error } = await admin.from('orders')
          .upsert(writes.slice(from, from + WRITE_BATCH), { onConflict: 'id' });
        if (error) throw new Error(`${day.trading_date}: ${error.message}`);
      }
    }
    totals.written += writes.length;

    if ((at + 1) % 25 === 0 || at === days.length - 1) {
      console.log(`  ${at + 1}/${days.length} days, ${totals.orders} orders read`);
    }
  }

  const answered = totals.record + totals.inferred;
  const pct = (n) => (totals.orders ? Math.round((n / totals.orders) * 100) : 0);
  console.log(`\n${options.dryRun ? '--dry-run, nothing written' : `Wrote ${totals.written} order(s)`}`);
  console.log(`  orders read        ${totals.orders}`);
  console.log(`  answered           ${answered} (${pct(answered)}%)`);
  console.log(`    from the record  ${totals.record}`);
  console.log(`    from geometry    ${totals.inferred}`);
  console.log(`  left unattributed  ${totals.unattributed} (${pct(totals.unattributed)}%)`);
  if (totals.cleared) console.log(`  cleared as no longer supported  ${totals.cleared}`);
  if (totals.orphaned) console.log(`  skipped, no trading account     ${totals.orphaned}`);

  if (byFamily.size) {
    console.log('\nBy algorithm:');
    for (const [family, count] of [...byFamily].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(7)}  ${family}`);
    }
  }
}

// Importable for tests; runs only when invoked as a command.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((problem) => {
    console.error(problem.message);
    process.exit(1);
  });
}
