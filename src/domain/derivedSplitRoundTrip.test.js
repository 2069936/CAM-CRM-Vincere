// The derived split has to survive a reload.
//
// Everything else about this feature is checked one layer at a time. This file
// checks the loop: reconcile the close, write it through the real persistence
// mapper, read it back through the real load mapper, and rebuild the panel's
// history from what came back. The screen the CAM sees before a refresh and the
// screen they see after it must be the same screen.
//
// It caught two ways that was false. The derived figures had nowhere to be
// stored at all, so the split simply vanished on reload; and `Number(realized
// || 0)` on the way back turned "the export did not report this" into "the
// export reported zero", which is the distinction the whole feature rests on.

import { describe, expect, it, vi } from 'vitest';
import { persistDailyImportWithClient } from './dailyImportPersistence.js';
import { reconcileDailyImport } from './reconcile.js';
import { buildAlgoAccountHistory } from './algoContribution.js';
import { buildCrmStateFromTables } from './supabaseStore.js';

const CLIENT_UUID = '00000000-0000-4000-8000-000000000001';
const ACCOUNT_UUID = '00000000-0000-4000-8000-000000000002';
const IMPORT_UUID = '00000000-0000-4000-8000-000000000003';

// One MNQ round trip, 10 points at $2 a point: the account's gross is 20, both
// legs name Alpha-1.0, and the Strategies grid reports nothing at all — the
// majority case, and the one the derivation exists for.
function closeOfOneDay() {
  return reconcileDailyImport({
    clientId: 'client-1',
    date: '2026-08-18',
    registry: {},
    parsed: {
      accounts: [{ accountName: 'ACC1', grossRealizedPnl: 20, grossRealizedPnlReported: 20, accountBalance: 50020 }],
      strategies: [{
        accountName: 'ACC1', strategyName: 'Alpha-1.0', strategyFamily: 'Alpha', strategyVersion: '1.0',
        instrument: 'MNQ SEP26', realized: null, unrealized: null, enabled: true,
      }],
      orders: [
        { id: 'O1', accountName: 'ACC1', strategyName: 'Alpha-1.0', name: '' },
        { id: 'O2', accountName: 'ACC1', strategyName: 'Alpha-1.0', name: '' },
      ],
      executions: [
        { id: '1_1', accountName: 'ACC1', instrument: 'MNQ SEP26', action: 'Buy', quantity: 1, price: 100, position: '1 L', orderId: 'O1', time: '8/18/2026 9:30:01 AM' },
        { id: '2_1', accountName: 'ACC1', instrument: 'MNQ SEP26', action: 'Sell', quantity: 1, price: 110, position: '-', orderId: 'O2', time: '8/18/2026 9:35:01 AM' },
      ],
    },
  });
}

// A database that keeps what it was given. Every row below is exactly what the
// shipped mapper produced — nothing in this file writes a column by hand, which
// is the only way the round trip proves anything about the shipped mapper.
async function persistAndReload(importResult) {
  const written = { snapshots: [], strategies: [] };
  const db = {
    transaction: vi.fn(async (work) => work(db)),
    guardDailyImportWritable: vi.fn(async () => null),
    upsertTradingAccounts: vi.fn(async () => undefined),
    listTradingAccounts: vi.fn(async () => [{ id: ACCOUNT_UUID, account_name: 'ACC1' }]),
    upsertDailyImport: vi.fn(async (row) => ({ id: IMPORT_UUID, ...row })),
    deleteDailyImportRows: vi.fn(async () => undefined),
    upsertAccountSnapshots: vi.fn(async (rows) => {
      written.snapshots = rows.map((row, index) => ({ id: `snapshot-${index + 1}`, ...row }));
      return written.snapshots;
    }),
    insertRows: vi.fn(async (table, rows) => {
      if (table === 'strategy_snapshots') written.strategies = rows.map((row, i) => ({ id: `strategy-${i + 1}`, ...row }));
    }),
  };

  await persistDailyImportWithClient({ db, clientUuid: CLIENT_UUID, importResult });

  const { clients } = buildCrmStateFromTables({
    clients: [{ id: CLIENT_UUID, legacy_key: 'client-1', name: 'Round Trip', status: 'Active' }],
    trading_accounts: [{
      id: ACCOUNT_UUID, client_id: CLIENT_UUID, account_name: 'ACC1', alias: 'ACC1',
      account_type: 'Funded', status: 'Active',
    }],
    daily_imports: [{
      id: IMPORT_UUID, client_id: CLIENT_UUID, trading_date: '2026-08-18',
      imported_at: importResult.importedAt, status: importResult.status,
    }],
    account_snapshots: written.snapshots,
    strategy_snapshots: written.strategies,
  });

  return { clients, written };
}

// Two roster rows, fills naming only one. The join publishes (it is balanced and
// unambiguous) but Beta stays null, because nobody measured a zero for it. This is
// the ordinary shape of a partial roster: on the real export 6 accounts and 21
// roster rows sit in exactly this state.
//
// It exists because the single-row fixture above cannot reach the read path's
// null-handling at all — its one row is always derived, so `derived_realized` is
// never null in it, and `Number(row.derived_realized) || 0` on the way back in
// would pass every assertion in this file. That substitution is the fabricated
// zero this whole feature was built to refuse, on the half of the round trip the
// display never re-checks.
function closeWithAnUnnamedRosterRow() {
  return reconcileDailyImport({
    clientId: 'client-1',
    date: '2026-08-18',
    registry: {},
    parsed: {
      accounts: [{ accountName: 'ACC1', grossRealizedPnl: 20, grossRealizedPnlReported: 20, accountBalance: 50020 }],
      strategies: [
        {
          accountName: 'ACC1', strategyName: 'Alpha-1.0', strategyFamily: 'Alpha', strategyVersion: '1.0',
          instrument: 'MNQ SEP26', realized: null, unrealized: null, enabled: true,
        },
        {
          accountName: 'ACC1', strategyName: 'Beta-2.0', strategyFamily: 'Beta', strategyVersion: '2.0',
          instrument: 'MES SEP26', realized: null, unrealized: null, enabled: true,
        },
      ],
      orders: [
        { id: 'O1', accountName: 'ACC1', strategyName: 'Alpha-1.0', name: '' },
        { id: 'O2', accountName: 'ACC1', strategyName: 'Alpha-1.0', name: '' },
      ],
      executions: [
        { id: '1_1', accountName: 'ACC1', instrument: 'MNQ SEP26', action: 'Buy', quantity: 1, price: 100, position: '1 L', orderId: 'O1', time: '8/18/2026 9:30:01 AM' },
        { id: '2_1', accountName: 'ACC1', instrument: 'MNQ SEP26', action: 'Sell', quantity: 1, price: 110, position: '-', orderId: 'O2', time: '8/18/2026 9:35:01 AM' },
      ],
    },
  });
}

describe('a roster row the fills never named, across a reload', () => {
  it('does not come back from the database as a measured zero', async () => {
    const importResult = closeWithAnUnnamedRosterRow();
    const before = buildAlgoAccountHistory({ dailyImports: [importResult] }, 'ACC1');
    expect(before.attribution.derivedDays).toBe(0);
    expect(before.attribution.status).toBe('unavailable');
    // `derived` on the day row is the field the read path fills. null means the
    // fills never named Beta; 0 would mean somebody measured Beta at zero.
    const beforeBeta = before.days[0].algos.find((a) => a.key.startsWith('Beta'));
    expect(beforeBeta.derived).toBe(null);

    const { written, clients } = await persistAndReload(importResult);
    // The column really did go to the database as NULL, not as 0.
    const betaRow = written.strategies.find((r) => r.strategy_name === 'Beta-2.0');
    expect(betaRow.derived_realized).toBe(null);

    const after = buildAlgoAccountHistory(clients[0], 'ACC1');
    const afterBeta = after.days[0].algos.find((a) => a.key.startsWith('Beta'));
    expect(afterBeta.derived).toBe(null);
    expect(after.attribution.derivedDays).toBe(0);
    expect(after.attribution.status).toBe('unavailable');
  });
});

describe('a derived split, written to the database and read back', () => {
  it('shows the same per-algo figures after a reload as before one', async () => {
    const importResult = closeOfOneDay();
    const before = buildAlgoAccountHistory({ dailyImports: [importResult] }, 'ACC1');
    expect(before.attribution.derivedDays).toBe(1);
    expect(before.algos[0].contributionPnl).toBe(20);

    const { clients } = await persistAndReload(importResult);
    const after = buildAlgoAccountHistory(clients[0], 'ACC1');

    expect(after.attribution.derivedDays).toBe(before.attribution.derivedDays);
    expect(after.algos[0].contributionPnl).toBe(before.algos[0].contributionPnl);
    expect(after.algos[0].derivedPnl).toBe(20);
    expect(after.attribution.status).toBe('complete');
  });

  it('keeps "the export reported nothing" from turning into "the export reported zero"', async () => {
    const importResult = closeOfOneDay();
    const { clients } = await persistAndReload(importResult);
    const strategy = clients[0].dailyImports[0].snapshots[0].strategies[0];
    // Both halves of the round trip: written as null, read back as null.
    expect(strategy.realized).toBeNull();
    expect(strategy.derivedRealized).toBe(20);
    // And the day's own evidence came back with it, or the panel would have no
    // way to check the figures it is about to show.
    const snapshot = clients[0].dailyImports[0].snapshots[0];
    expect(snapshot.derivation.status).toBe('exact');
    expect(snapshot.derivation.reportedGross).toBe(20);
    expect(snapshot.derivation.join.status).toBe('exact');
    expect(snapshot.derivation.join.published).toBe(true);
    // The row's verdict is not a column and does not come back as one. It is
    // recovered from the two things above: this row matched because the
    // account-day published and its own derived figure is not null.
    expect(strategy.derivedRealizedStatus).toBeUndefined();
    expect(strategy.derivedRealizedJoin).toBeUndefined();
  });

  it('spends one column a strategy row on the derivation, not three', async () => {
    // The deadline finding. Step 37 was drafted adding `derived_realized_status`
    // and `derived_realized_join` alongside `derived_realized`, and both were
    // the ACCOUNT-DAY's answer written out once per roster row of that account —
    // measured through this same mapper on a real ten-folder export, 35.4 B and
    // 37.1 B a row against 23.9 B for the figure itself, which is ~73 KiB of the
    // busiest CAM's export pull against a 4 MiB ceiling that pull is already
    // over. This test is what stops them coming back.
    const { written } = await persistAndReload(closeOfOneDay());
    expect(written.strategies.length).toBeGreaterThan(0);
    for (const row of written.strategies) {
      expect(row).not.toHaveProperty('derived_realized_status');
      expect(row).not.toHaveProperty('derived_realized_join');
      expect(row).toHaveProperty('derived_realized');
    }
    // Everything they said is still answerable, from one row and one blob:
    // published + a figure = matched, published + null = the fills never named
    // this row, not published = refused, no blob or a blob that is not 'exact' =
    // unavailable, and the ambiguous names are listed on the blob when there are
    // any. Nothing here is a second copy of any of it.
    const [snapshot] = written.snapshots;
    expect(snapshot.derivation.status).toBe('exact');
    expect(snapshot.derivation.join.published).toBe(true);
    expect(written.strategies[0].derived_realized).toBe(20);
    // No ambiguity on this day, so the array is absent rather than empty — an
    // empty one would be bytes spent saying nothing happened.
    expect(snapshot.derivation.join).not.toHaveProperty('ambiguousNames');
  });

  it('shows no split after a reload when the derivation was never stored', async () => {
    // Every close imported before step 37 is in this state, and so is every
    // automatically collected close until the collector's RPC carries the
    // columns. Absent has to stay absent: no derived figures, no invented ones.
    const importResult = closeOfOneDay();
    const { written } = await persistAndReload(importResult);
    const without = (row, ...columns) => Object.fromEntries(
      Object.entries(row).filter(([column]) => !columns.includes(column)),
    );
    const legacySnapshots = written.snapshots.map((row) => without(row, 'derivation'));
    const legacyStrategies = written.strategies.map((row) => without(row, 'derived_realized'));

    const { clients } = buildCrmStateFromTables({
      clients: [{ id: CLIENT_UUID, legacy_key: 'client-1', name: 'Legacy', status: 'Active' }],
      trading_accounts: [{ id: ACCOUNT_UUID, client_id: CLIENT_UUID, account_name: 'ACC1', alias: 'ACC1', account_type: 'Funded', status: 'Active' }],
      daily_imports: [{ id: IMPORT_UUID, client_id: CLIENT_UUID, trading_date: '2026-08-18', status: 'Needs review' }],
      account_snapshots: legacySnapshots,
      strategy_snapshots: legacyStrategies,
    });

    const after = buildAlgoAccountHistory(clients[0], 'ACC1');
    expect(after.attribution.derivedDays).toBe(0);
    expect(after.attribution.status).toBe('unavailable');
    expect(after.algos[0].contributionPnl).toBe(0);
  });
});
