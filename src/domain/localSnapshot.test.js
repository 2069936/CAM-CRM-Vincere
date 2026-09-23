import { describe, expect, it } from 'vitest';
import { normalizeSnapshot } from './localSnapshot';
import { buildCrmStateFromTables, CRM_STATE_TABLES, DERIVABLE_STATE_TABLES } from './supabaseStore';

describe('normalizeSnapshot', () => {
  it('accepts the raw export body', () => {
    const { tables } = normalizeSnapshot({ tables: { clients: [{ id: 'c1' }] } });

    expect(tables.clients).toEqual([{ id: 'c1' }]);
  });

  it('accepts a bare table map', () => {
    const { tables } = normalizeSnapshot({ clients: [{ id: 'c1' }] });

    expect(tables.clients).toEqual([{ id: 'c1' }]);
  });

  it('names absent tables instead of failing the whole load', () => {
    // An export taken before a migration ran is still worth looking at, and
    // refusing it over one missing table hides the eighteen that are present.
    const { tables, missing } = normalizeSnapshot({ clients: [] });

    expect(missing).toContain('cam_time_off');
    expect(missing).not.toContain('clients');
    for (const table of CRM_STATE_TABLES) expect(Array.isArray(tables[table])).toBe(true);
  });

  it('does not report a table the state builder can derive as missing', () => {
    // `close_summaries` (step 48) is one row per close per segment and every
    // export predates it. buildCrmStateFromTables derives those rows from the
    // closes the file already holds, so local mode reads the SAME summary path
    // production reads rather than the whole-book walk production no longer
    // does — which is the entire reason this file exists. Naming it in the
    // status line would read as data loss.
    const { missing } = normalizeSnapshot({ clients: [] });

    expect(missing).not.toContain('close_summaries');
    expect([...DERIVABLE_STATE_TABLES]).toEqual(['close_summaries']);
  });

  it('derives the summary rows a production login would have fetched', () => {
    const state = buildCrmStateFromTables({
      clients: [{ id: 'c-uuid', legacy_key: 'c1', name: 'Client', status: 'Active' }],
      trading_accounts: [
        { id: 'a1', client_id: 'c-uuid', account_name: 'CASH-1', account_type: 'Cash' },
      ],
      daily_imports: [
        { id: 'i1', client_id: 'c-uuid', trading_date: '2026-09-22', status: 'Closed' },
      ],
      account_snapshots: [
        {
          id: 's1', daily_import_id: 'i1', trading_account_id: 'a1',
          account_name: 'CASH-1', gross_realized_pnl: 10.5, weekly_pnl: 20, account_balance: 1000,
        },
      ],
    });

    expect(state.closeSummaries).toEqual([
      expect.objectContaining({
        dailyImportId: 'i1',
        segment: 'Cash',
        accounts: 1,
        dailyPnl: 10.5,
        countedInTotal: true,
        accountNames: ['CASH-1'],
        clientIdForRegistry: 'c1',
      }),
    ]);
  });

  it('leaves the stored rows alone when the export has them', () => {
    // A future export WILL carry the table. Deriving over the top of it would
    // hide a disagreement between what the ingest stored and what the closes
    // say, which is the one thing a local snapshot is for.
    const state = buildCrmStateFromTables({
      clients: [{ id: 'c-uuid', legacy_key: 'c1', name: 'Client', status: 'Active' }],
      daily_imports: [{ id: 'i1', client_id: 'c-uuid', trading_date: '2026-09-22' }],
      close_summaries: [{
        daily_import_id: 'i1', client_id: 'c-uuid', trading_date: '2026-09-22',
        segment: 'Funded', accounts: 3, daily_pnl: -5, weekly_pnl: -9, balance: 7,
        counted_in_total: true, account_names: ['F-1'],
      }],
    });

    expect(state.closeSummaries).toHaveLength(1);
    expect(state.closeSummaries[0].segment).toBe('Funded');
    expect(state.closeSummaries[0].accounts).toBe(3);
  });

  it('rejects a file that is not an export', () => {
    expect(() => normalizeSnapshot(null)).toThrow(/does not look like/);
    expect(() => normalizeSnapshot('nonsense')).toThrow(/does not look like/);
  });

  it('ignores a table that is present but not an array', () => {
    const { tables, missing } = normalizeSnapshot({ clients: { id: 'c1' } });

    expect(tables.clients).toEqual([]);
    expect(missing).toContain('clients');
  });
});
