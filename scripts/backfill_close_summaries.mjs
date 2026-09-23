// Fills public.close_summaries for every close already in the database.
//
// WHY THIS IS A SCRIPT AND NOT PART OF THE MIGRATION.
//
// The rows this writes say which desk segment each account close belongs to,
// and that is decided by `segmentForAccount` in
// src/domain/operationsSegments.js — a function that asks whether an account is
// simulated before it asks what it is FOR, reads the CAM's explicit override,
// and reports an account type nobody has taught it about under that type's own
// name rather than folding it into Unclassified. Writing that again in PL/pgSQL
// to backfill it would put the rule in two languages. deskMoney.js exists
// because three surfaces on one screen each had their own loop and disagreed by
// 3.1% on the day, with the weekly figure sign-flipping between two of them on
// 2026-07-24; a second segmentation is that defect with a longer fuse.
//
// So the backfill imports the same module the ingest uses, and the migration's
// `replace_close_summaries` stores what it decided.
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node scripts/backfill_close_summaries.mjs [--client <uuid>] [--dry-run]
//
// ONE CLIENT AT A TIME, with the write for that client's closes in one call.
// The instance this runs against has answered one-row reads in twenty seconds
// while eight people were signing in, and a single pass over 12,778 snapshot
// rows would hold that connection for as long as it takes. A client is about
// twelve closes and sixty snapshot rows.
//
// Safe to run twice, safe to interrupt, safe to resume: each client's rows are
// replaced wholesale, so a second run writes the same rows again and a run that
// stopped halfway leaves the clients it finished correct and the rest as they
// were.

import process from 'node:process';
import { createClient } from '@supabase/supabase-js';
import { buildCloseSummaryRows, closeSummaryToDb } from '../src/domain/closeSummary.js';

const PAGE = 1000;

function readArguments(argv) {
  const options = { clientId: null, dryRun: false };
  for (let at = 0; at < argv.length; at += 1) {
    if (argv[at] === '--dry-run') options.dryRun = true;
    else if (argv[at] === '--client') {
      options.clientId = argv[at + 1] || null;
      at += 1;
    }
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
 * The account registry the segmentation reads, in the shape
 * `buildCrmStateFromTables` hands it to `buildSegmentTotals`: keyed by account
 * name, holding the account's type and the CAM's simulation override.
 *
 * Only the fields `segmentForAccount` and `classifyAccountNature` consult are
 * mapped. A field added here that they do not read would suggest it matters.
 */
function registryFor(accountRows) {
  const registry = {};
  for (const row of accountRows) {
    registry[row.account_name] = {
      id: row.id,
      accountName: row.account_name,
      alias: row.alias || row.account_name,
      accountType: row.account_type || 'Unassigned',
      simulationMode: row.simulation_mode || '',
      connection: row.connection || '',
      status: row.status || 'Active',
    };
  }
  return registry;
}

async function backfillClient(db, client, { dryRun }) {
  const [accountRows, importRows] = await Promise.all([
    allRows(() => db.from('trading_accounts')
      .select('id, account_name, alias, account_type, simulation_mode, connection, status')
      .eq('client_id', client.id)
      .order('id', { ascending: true })),
    allRows(() => db.from('daily_imports')
      .select('id, trading_date')
      .eq('client_id', client.id)
      .order('id', { ascending: true })),
  ]);
  if (!importRows.length) return { closes: 0, rows: 0 };

  const snapshotRows = await allRows(() => db.from('account_snapshots')
    .select('daily_import_id, account_name, gross_realized_pnl, weekly_pnl, account_balance')
    .in('daily_import_id', importRows.map((row) => row.id))
    .order('id', { ascending: true }));

  const byImport = new Map();
  for (const row of snapshotRows) {
    if (!byImport.has(row.daily_import_id)) byImport.set(row.daily_import_id, []);
    byImport.get(row.daily_import_id).push({
      accountName: row.account_name,
      grossRealizedPnl: Number(row.gross_realized_pnl || 0),
      weeklyPnl: Number(row.weekly_pnl || 0),
      accountBalance: Number(row.account_balance || 0),
    });
  }

  const registry = registryFor(accountRows);
  const rows = [];
  for (const dailyImport of importRows) {
    // Every snapshot of the close in one list, with no `simulation` container.
    // Not a shortcut around the split: `segmentForAccount` classifies each
    // account's nature before it asks what the account is for, so a simulated
    // close reaches the simulated segment from this shape exactly as it does
    // from a split one.
    const summary = buildCloseSummaryRows({
      accountRegistry: registry,
      dailyImport: {
        clientId: client.id,
        date: dailyImport.trading_date,
        snapshots: byImport.get(dailyImport.id) || [],
      },
    });
    for (const row of summary) {
      rows.push(closeSummaryToDb(row, {
        dailyImportId: dailyImport.id,
        clientId: client.id,
        tradingDate: dailyImport.trading_date,
      }));
    }
  }

  if (!dryRun) {
    const { error } = await db.rpc('replace_close_summaries', {
      p_daily_import_ids: importRows.map((row) => row.id),
      p_rows: rows,
    });
    if (error) throw new Error(`${client.name || client.id}: ${error.message}`);
  }
  return { closes: importRows.length, rows: rows.length };
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
    process.exitCode = 1;
    return;
  }
  const options = readArguments(process.argv.slice(2));
  const db = createClient(url, key, { auth: { persistSession: false } });

  // Every client, including the soft-deleted and Inactive ones that
  // buildCrmStateFromTables hides. A client hidden today can be un-hidden
  // tomorrow, and a summary table with holes in it would then report a desk
  // smaller than the one on screen.
  let clientQuery = () => db.from('clients').select('id, name').order('id', { ascending: true });
  if (options.clientId) {
    clientQuery = () => db.from('clients').select('id, name').eq('id', options.clientId).order('id', { ascending: true });
  }
  const clients = await allRows(clientQuery);

  let closes = 0;
  let rows = 0;
  for (const client of clients) {
    const result = await backfillClient(db, client, options);
    closes += result.closes;
    rows += result.rows;
    console.log(`${client.name || client.id}: ${result.closes} closes, ${result.rows} summary rows`);
  }
  console.log(`\n${clients.length} clients, ${closes} closes, ${rows} summary rows${options.dryRun ? ' (dry run, nothing written)' : ''}.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
