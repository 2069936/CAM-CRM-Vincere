import { describe, expect, it } from 'vitest';
import { offlineRegistryProjection, offlineRegistryVersion } from '../../apiLib/autoImportStore.js';

/* The payload the CRM hands a client machine so the collector can classify
 * accounts when the CRM is unreachable. It leaves the desk's network and lands
 * on a VPS a client can reach, so what is NOT in it matters as much as what is. */

const row = (over = {}) => ({
  account_name: 'ACC1',
  account_type: 'Funded',
  status: 'Active',
  alias: 'Lucid - ACC1',
  date_failed: null,
  simulation_mode: null,
  start_balance: 50000,
  target_profit: 3000,
  max_drawdown_limit: 2000,
  // Everything below is in registryFromRows and must not be here.
  notes: 'client is nervous about the drawdown',
  payout_count: 3,
  date_last_payout: '2026-08-12',
  algo_stack: 'OGX, G4M',
  daily_loss_limit: 900,
  risk_level: 'Medium',
  connection: 'Tradovate',
  ...over,
});

describe('what the agent is given', () => {
  it('carries what report.js reads and nothing else', () => {
    // THE POINT OF THE PROJECTION. registryFromRows carries twenty-one fields
    // including the CAM's notes and the client's payout history, none of which
    // has any business sitting on a machine in a client's hands.
    expect(offlineRegistryProjection([row()])).toEqual({
      ACC1: {
        accountType: 'Funded',
        status: 'Active',
        alias: 'Lucid - ACC1',
        startBalance: 50000,
        targetProfit: 3000,
        maxDrawdownLimit: 2000,
      },
    });
  });

  it('never ships notes or payout history', () => {
    const [account] = Object.values(offlineRegistryProjection([row()]));
    for (const leaked of ['notes', 'payoutCount', 'dateLastPayout', 'algoStack', 'dailyLossLimit', 'riskLevel', 'connection']) {
      expect(account).not.toHaveProperty(leaked);
    }
  });

  it('keeps the two fields that decide whether an account counts', () => {
    // accountType is how report.js buckets, and a Failed account only belongs
    // on the day it failed. Both change the client's headline.
    const [account] = Object.values(offlineRegistryProjection([
      row({ account_type: 'Evaluation - Standard', date_failed: '2026-09-22', simulation_mode: 'Simulated' }),
    ]));
    expect(account.accountType).toBe('Evaluation - Standard');
    expect(account.dateFailed).toBe('2026-09-22');
    expect(account.simulationMode).toBe('Simulated');
  });

  it('omits empty values rather than sending nulls', () => {
    // This rides on every upload response. A null tells the agent nothing a
    // missing key does not.
    const [account] = Object.values(offlineRegistryProjection([
      row({ alias: null, target_profit: null, max_drawdown_limit: '' }),
    ]));
    expect(account).not.toHaveProperty('alias');
    expect(account).not.toHaveProperty('targetProfit');
    expect(account).not.toHaveProperty('maxDrawdownLimit');
  });

  it('drops a row with no account name rather than keying on undefined', () => {
    expect(offlineRegistryProjection([row({ account_name: null }), row()])).toEqual({
      ACC1: expect.any(Object),
    });
    expect(offlineRegistryProjection()).toEqual({});
  });
});

describe('the version that says whether it changed', () => {
  it('moves when the answer moves', () => {
    const before = offlineRegistryProjection([row()]);
    const after = offlineRegistryProjection([row({ account_type: 'Cash - Straight' })]);
    expect(offlineRegistryVersion(before)).not.toBe(offlineRegistryVersion(after));
  });

  it('does not move when nothing the agent can see changed', () => {
    // NOT max(updated_at). persist_auto_daily_import_v3 rewrites updated_at on
    // every account on every ingest, so a timestamp version says "this changed"
    // every single day and therefore says nothing. Here a row whose notes were
    // edited produces the same version, because the agent never receives notes.
    const before = offlineRegistryProjection([row()]);
    const after = offlineRegistryProjection([row({ notes: 'rewritten', payout_count: 9 })]);
    expect(offlineRegistryVersion(before)).toBe(offlineRegistryVersion(after));
  });

  it('does not move when the rows arrive in a different order', () => {
    // Supabase does not promise an order and this must not churn because of it.
    const a = offlineRegistryProjection([row(), row({ account_name: 'ACC2' })]);
    const b = offlineRegistryProjection([row({ account_name: 'ACC2' }), row()]);
    expect(offlineRegistryVersion(a)).toBe(offlineRegistryVersion(b));
  });
});
