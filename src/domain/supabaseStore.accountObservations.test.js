import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_OBSERVATION_SETTINGS_COLUMNS,
  LOGIN_COLUMNS,
  accountMetaFromRow,
  isMissingAccountObservations,
  loadSupabaseAccountObservationSettings,
  mapAccountObservationSettings,
} from './supabaseStore';
import { ACCOUNT_OBSERVATION_DEFAULTS } from './accountBuckets';

/* A fake PostgREST client that answers the one read and records what was asked. */
function fakeClient(answer) {
  const asked = { from: null, select: null, limit: null };
  return {
    asked,
    from(table) {
      asked.from = table;
      return {
        select(columns) {
          asked.select = columns;
          return {
            limit(n) {
              asked.limit = n;
              return Promise.resolve(answer);
            },
          };
        },
      };
    },
  };
}

describe('accountMetaFromRow carries the observation the database wrote', () => {
  const base = { id: 'a1', account_name: 'ACC 01', account_type: 'Funded', status: 'Active' };

  it('maps the six columns in the meta naming style, with the numeric reading as a number', () => {
    const meta = accountMetaFromRow({
      ...base,
      observed_state: 'breached',
      last_close_seen_on: '2026-10-07',
      closes_missed: 2,
      breached_on: '2026-10-05',
      breach_reading: '-263.50',
      observed_at: '2026-10-07T21:31:00+00:00',
    });
    expect(meta).toMatchObject({
      observedState: 'breached',
      lastCloseSeenOn: '2026-10-07',
      closesMissed: 2,
      breachedOn: '2026-10-05',
      breachReading: -263.5,
      observedAt: '2026-10-07T21:31:00+00:00',
    });
  });

  it('a row read from a database before step 65 has no observation: null state, null numbers, empty dates', () => {
    const meta = accountMetaFromRow(base);
    expect(meta).toMatchObject({
      observedState: null, lastCloseSeenOn: '', closesMissed: null, breachedOn: '', breachReading: null, observedAt: '',
    });
    // And nothing else moved.
    expect(meta).toMatchObject({ accountName: 'ACC 01', accountType: 'Funded', status: 'Active', payoutHistory: [] });
  });

  it('closes_missed 0 is 0, not null, and a string count from PostgREST is a number', () => {
    expect(accountMetaFromRow({ ...base, closes_missed: 0 }).closesMissed).toBe(0);
    expect(accountMetaFromRow({ ...base, closes_missed: '7' }).closesMissed).toBe(7);
    expect(accountMetaFromRow({ ...base, closes_missed: null }).closesMissed).toBeNull();
    expect(accountMetaFromRow({ ...base, breach_reading: null }).breachReading).toBeNull();
    expect(accountMetaFromRow({ ...base, breach_reading: '' }).breachReading).toBeNull();
  });

  it('the login selects the six columns on trading_accounts', () => {
    for (const column of ['observed_state', 'last_close_seen_on', 'closes_missed', 'breached_on', 'breach_reading', 'observed_at']) {
      expect(LOGIN_COLUMNS.trading_accounts.split(/,\s*/)).toContain(column);
    }
    // The flag id is the database's own bookkeeping; the browser has no use for it.
    expect(LOGIN_COLUMNS.trading_accounts).not.toContain('auto_fail_flag_id');
  });
});

describe('the account observation settings', () => {
  it('reads the one row and maps it', async () => {
    const client = fakeClient({ data: [{ stale_closes: 7, auto_fail_on_breach: false, new_account_days: 21 }], error: null });
    const settings = await loadSupabaseAccountObservationSettings({ client });
    expect(settings).toEqual({ available: true, staleCloses: 7, autoFailOnBreach: false, newAccountDays: 21 });
    expect(client.asked).toEqual({ from: 'account_observation_settings', select: ACCOUNT_OBSERVATION_SETTINGS_COLUMNS, limit: 1 });
  });

  it('answers the defaults, unavailable, when step 65 has not run or there is no database', async () => {
    for (const error of [
      { code: 'PGRST205', message: "Could not find the table 'public.account_observation_settings' in the schema cache" },
      { code: '42P01', message: 'relation "public.account_observation_settings" does not exist' },
    ]) {
      expect(await loadSupabaseAccountObservationSettings({ client: fakeClient({ data: null, error }) }))
        .toEqual({ available: false, ...ACCOUNT_OBSERVATION_DEFAULTS });
    }
    expect(await loadSupabaseAccountObservationSettings({ client: null })).toEqual({ available: false, ...ACCOUNT_OBSERVATION_DEFAULTS });
  });

  it('THROWS on any other failure, so a screen never prints a default as if it were the setting', async () => {
    const error = { code: '57014', message: 'canceling statement due to statement timeout' };
    await expect(loadSupabaseAccountObservationSettings({ client: fakeClient({ data: null, error }) }))
      .rejects.toThrow(/statement timeout/);
  });

  it('a missing row, or a value outside the bounds the table refuses, falls back column by column', () => {
    expect(mapAccountObservationSettings(undefined)).toEqual(ACCOUNT_OBSERVATION_DEFAULTS);
    expect(mapAccountObservationSettings({ stale_closes: 0, auto_fail_on_breach: 'yes', new_account_days: 91 }))
      .toEqual(ACCOUNT_OBSERVATION_DEFAULTS);
    expect(mapAccountObservationSettings({ stale_closes: '3', auto_fail_on_breach: false, new_account_days: 0 }))
      .toEqual({ staleCloses: 3, autoFailOnBreach: false, newAccountDays: 0 });
  });

  it('recognises the three ways the table can be missing and nothing else', () => {
    expect(isMissingAccountObservations({ code: 'PGRST205', message: '' })).toBe(true);
    expect(isMissingAccountObservations({ code: '42P01', message: '' })).toBe(true);
    expect(isMissingAccountObservations({ code: '500', message: 'relation "public.account_observation_settings" does not exist' })).toBe(true);
    expect(isMissingAccountObservations({ code: '500', message: 'boom' })).toBe(false);
  });
});
