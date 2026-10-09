import { describe, expect, it } from 'vitest';
import { createAutoImportStore, offlineRegistryProjection } from '../../apiLib/autoImportStore.js';
import { reconcileDailyImport } from '../../../src/domain/reconcile.js';

/* THE AUTOMATIC CLOSE READS THE REGISTRY HERE, AND STEP 67 NEEDS ONE MORE FIELD
 * OF IT.
 *
 * reconcileDailyImport stops raising the five live account flags (Missing
 * account, Strategy disabled, Expected strategy missing, Drawdown approaching
 * limit, Drawdown near limit) for an account whose closes say breached or
 * absent. The browser's registry has carried observedState since step 65
 * (supabaseStore accountMetaFromRow); this one selected '*' and dropped it, so
 * the automatic route, the one that writes most closes, could not see it.
 *
 * The rows are fictional; the column names are trading_accounts'.
 */

function adminReturning(rows) {
  const calls = [];
  return {
    calls,
    from(table) {
      return {
        select(columns) {
          return {
            async eq(column, value) {
              calls.push({ table, columns, column, value });
              return { data: rows, error: null };
            },
          };
        },
      };
    },
  };
}

const row = (over = {}) => ({
  account_name: 'ACC 01',
  alias: 'ACC 01',
  account_type: 'Funded',
  status: 'Active',
  max_drawdown_limit: null,
  observed_state: 'seen',
  ...over,
});

describe('registryFromRows carries the observation', () => {
  it('loadRegistryForIngest hands reconcile observedState', async () => {
    const store = createAutoImportStore(adminReturning([row({ observed_state: 'absent' })]));
    const { registry } = await store.loadRegistryForIngest('client-1');
    expect(registry['ACC 01'].observedState).toBe('absent');
  });

  it('loadRegistry (the reprocess path) does too', async () => {
    const store = createAutoImportStore(adminReturning([row({ observed_state: 'breached' })]));
    const registry = await store.loadRegistry('client-1');
    expect(registry['ACC 01'].observedState).toBe('breached');
  });

  it('a database before step 65 has no column, and that is no observation rather than a word', async () => {
    const pre65 = row();
    delete pre65.observed_state;
    const store = createAutoImportStore(adminReturning([pre65]));
    const registry = await store.loadRegistry('client-1');
    expect(registry['ACC 01'].observedState).toBeNull();
  });

  it('the machine copy is unchanged, so its version hash does not move', async () => {
    const rows = [row({ observed_state: 'breached' })];
    const { offlineRegistry } = await createAutoImportStore(adminReturning(rows)).loadRegistryForIngest('client-1');
    expect(offlineRegistry).toEqual(offlineRegistryProjection(rows));
    expect(offlineRegistry['ACC 01']).not.toHaveProperty('observedState');
  });
});

describe('end to end on the automatic route: the registry read here decides the flags', () => {
  it('an absent Active account raises no Missing account; a seen one still does', async () => {
    const store = createAutoImportStore(adminReturning([
      row({ account_name: 'ACC 01', observed_state: 'absent' }),
      row({ account_name: 'ACC 02', observed_state: 'seen' }),
    ]));
    const { registry } = await store.loadRegistryForIngest('client-1');
    const result = reconcileDailyImport({
      clientId: 'client-1',
      date: '2026-10-08',
      registry,
      parsed: { accounts: [], strategies: [], orders: [], executions: [] },
    });
    expect(result.flags.filter((flag) => flag.type === 'Missing account').map((flag) => flag.accountName))
      .toEqual(['ACC 02']);
  });
});
