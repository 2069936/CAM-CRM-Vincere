import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_OBSERVATION_DEFAULTS,
  BUCKET_KEYS,
  bucketRegistryAccounts,
  expectedAccountNameSet,
} from './accountBuckets';

/* Fictional registry rows in the shape accountMetaFromRow builds. */
function meta(over = {}) {
  return {
    accountType: 'Evaluation - Standard',
    status: 'Active',
    observedState: 'seen',
    closesMissed: 0,
    lastCloseSeenOn: '2026-10-07',
    breachedOn: '',
    breachReading: null,
    dateAdded: '2026-06-01',
    ...over,
  };
}

const NOW = '2026-10-08T15:00:00Z';

function names(bucket) {
  return bucket.accounts.map((row) => row.accountName);
}

describe('bucketRegistryAccounts', () => {
  it('files one account per bucket and prints one sentence for each', () => {
    const registry = {
      'ACC 01': meta(),
      'ACC 02': meta({ observedState: 'breached', breachedOn: '2026-10-07', breachReading: -263 }),
      'ACC 03': meta({ observedState: 'absent', closesMissed: 6, lastCloseSeenOn: '2026-09-29' }),
      'ACC 04': meta({ observedState: 'never_seen', closesMissed: 9, lastCloseSeenOn: '', dateAdded: '2026-10-05' }),
      'ACC 05': meta({ observedState: 'never_seen', closesMissed: 9, lastCloseSeenOn: '', dateAdded: '2026-01-10' }),
      'ACC 06': meta({ status: 'Failed', observedState: 'breached', breachedOn: '2026-10-07', breachReading: -1500 }),
    };
    const buckets = bucketRegistryAccounts(registry, { now: NOW });
    expect(names(buckets.expected)).toEqual(['ACC 01', 'ACC 04']);
    expect(names(buckets.looksFailed)).toEqual(['ACC 02']);
    expect(names(buckets.goneFromClose)).toEqual(['ACC 03']);
    expect(names(buckets.newNotSeen)).toEqual(['ACC 04']);
    expect(names(buckets.registeredNeverSeen)).toEqual(['ACC 05']);
    expect(names(buckets.retired)).toEqual(['ACC 06']);
    expect(buckets.total).toBe(6);

    expect(buckets.expected.sentence).toBe('2 expected on the close: 1 seen in a close, 1 new');
    expect(buckets.looksFailed.sentence).toBe('1 account looks failed, breached on the close, not shown');
    expect(buckets.goneFromClose.sentence).toBe('1 gone from the close for 6 closes');
    expect(buckets.newNotSeen.sentence).toBe('1 new, added 3 days ago, not seen in a close yet');
    expect(buckets.registeredNeverSeen.sentence).toBe('1 registered and never seen in a close, added more than 14 days ago');
    expect(buckets.retired.sentence).toBe('1 retired: 1 Failed');
  });

  it('retired is status Failed, Inactive or Reserve, or the Inactive / Ignore type, whatever the closes say', () => {
    const registry = {
      F: meta({ status: 'Failed' }),
      I: meta({ status: 'Inactive', observedState: 'absent', closesMissed: 20 }),
      R: meta({ status: 'Reserve', observedState: 'never_seen', dateAdded: '2026-10-07' }),
      G: meta({ accountType: 'Inactive / Ignore', observedState: 'breached' }),
      A: meta(),
    };
    const buckets = bucketRegistryAccounts(registry, { now: NOW });
    expect(names(buckets.retired)).toEqual(['F', 'G', 'I', 'R']);
    expect(buckets.retired.accounts.map((row) => row.reason)).toEqual(['Failed', 'Ignored', 'Inactive', 'Reserve']);
    expect(buckets.retired.sentence).toBe('4 retired: 1 Failed, 1 Inactive, 1 Reserve, 1 Ignored');
    expect(names(buckets.looksFailed)).toEqual([]);
    expect(names(buckets.goneFromClose)).toEqual([]);
    expect(names(buckets.newNotSeen)).toEqual([]);
    expect(names(buckets.expected)).toEqual(['A']);
  });

  it('looks failed is breached while still Active or Payout Hold, which is the setting off or a stale tab', () => {
    const registry = {
      A: meta({ observedState: 'breached', breachedOn: '2026-10-01', breachReading: -1 }),
      P: meta({ status: 'Payout Hold', observedState: 'breached', breachedOn: '2026-10-02', breachReading: -5 }),
      S: meta(),
    };
    const buckets = bucketRegistryAccounts(registry, { now: NOW });
    expect(names(buckets.looksFailed)).toEqual(['A', 'P']);
    expect(buckets.looksFailed.accounts[0]).toMatchObject({ breachedOn: '2026-10-01', breachReading: -1, reason: 'breached' });
    expect(buckets.looksFailed.sentence).toBe('2 accounts look failed, breached on the close, not shown');
    expect(names(buckets.expected)).toEqual(['S']);
  });

  it('gone from the close prints the range of closes missed, singular when it is one', () => {
    const several = bucketRegistryAccounts({
      A: meta({ observedState: 'absent', closesMissed: 5 }),
      B: meta({ observedState: 'absent', closesMissed: 12 }),
    }, { now: NOW });
    expect(several.goneFromClose.sentence).toBe('2 gone from the close for 5 to 12 closes');
    const one = bucketRegistryAccounts({
      A: meta({ observedState: 'absent', closesMissed: 1 }),
    }, { now: NOW, settings: { staleCloses: 1 } });
    expect(one.goneFromClose.sentence).toBe('1 gone from the close for 1 close');
  });

  it('new is never seen within new_account_days of date_added, counted in UTC days, and it is also expected', () => {
    const edge = bucketRegistryAccounts({
      ON: meta({ observedState: 'never_seen', dateAdded: '2026-09-24' }),
      PAST: meta({ observedState: 'never_seen', dateAdded: '2026-09-23' }),
      TODAY: meta({ observedState: 'never_seen', dateAdded: '2026-10-08' }),
    }, { now: NOW });
    expect(names(edge.newNotSeen)).toEqual(['ON', 'TODAY']);
    expect(names(edge.registeredNeverSeen)).toEqual(['PAST']);
    expect(names(edge.expected)).toEqual(['ON', 'TODAY']);
    expect(edge.newNotSeen.sentence).toBe('2 new, added 0 to 14 days ago, not seen in a close yet');
    expect(edge.expected.sentence).toBe('2 expected on the close: 2 new');

    const today = bucketRegistryAccounts({ T: meta({ observedState: 'never_seen', dateAdded: '2026-10-08' }) }, { now: NOW });
    expect(today.newNotSeen.sentence).toBe('1 new, added today, not seen in a close yet');
  });

  it('the setting moves the line: new_account_days 3 makes a four day old account registered and never seen', () => {
    const registry = { A: meta({ observedState: 'never_seen', dateAdded: '2026-10-04' }) };
    expect(names(bucketRegistryAccounts(registry, { now: NOW }).newNotSeen)).toEqual(['A']);
    const tight = bucketRegistryAccounts(registry, { now: NOW, settings: { newAccountDays: 3 } });
    expect(names(tight.newNotSeen)).toEqual([]);
    expect(names(tight.registeredNeverSeen)).toEqual(['A']);
    expect(tight.registeredNeverSeen.sentence).toBe('1 registered and never seen in a close, added more than 3 days ago');
    expect(tight.settings).toEqual({ newAccountDays: 3, staleCloses: ACCOUNT_OBSERVATION_DEFAULTS.staleCloses });
  });

  it('never seen with no date added cannot claim to be new', () => {
    const buckets = bucketRegistryAccounts({
      A: meta({ observedState: 'never_seen', dateAdded: '' }),
      B: meta({ observedState: 'never_seen', dateAdded: '2026-01-01' }),
    }, { now: NOW });
    expect(names(buckets.registeredNeverSeen)).toEqual(['A', 'B']);
    expect(buckets.registeredNeverSeen.sentence)
      .toBe('2 registered and never seen in a close, added more than 14 days ago or with no date added');
    const undated = bucketRegistryAccounts({ A: meta({ observedState: 'never_seen', dateAdded: '' }) }, { now: NOW });
    expect(undated.registeredNeverSeen.sentence).toBe('1 registered and never seen in a close with no date added');
  });

  it('a row with no observation stays expected and says so: not observed is not evidence', () => {
    const buckets = bucketRegistryAccounts({
      OLD: { accountType: 'Funded', status: 'Active', dateAdded: '2026-01-01' },
      NULLED: meta({ observedState: null }),
      SEEN: meta(),
    }, { now: NOW });
    expect(names(buckets.expected)).toEqual(['NULLED', 'OLD', 'SEEN']);
    expect(buckets.expected.accounts.map((row) => row.reason)).toEqual(['not observed', 'not observed', 'seen']);
    expect(buckets.expected.sentence).toBe('3 expected on the close: 1 seen in a close, 2 not observed yet');
    expect(names(buckets.registeredNeverSeen)).toEqual([]);
  });

  it('a status word with no opinion (missing) reads as Active, and a simulation account follows the same rules', () => {
    const buckets = bucketRegistryAccounts({
      NOSTATUS: { accountType: 'Funded', observedState: 'seen', status: '' },
      SIM: meta({ accountType: 'Simulation', observedState: 'absent', closesMissed: 7 }),
    }, { now: NOW });
    expect(names(buckets.expected)).toEqual(['NOSTATUS']);
    expect(buckets.expected.accounts[0].status).toBe('Active');
    expect(names(buckets.goneFromClose)).toEqual(['SIM']);
  });

  it('empty buckets carry a null sentence and a zero count, and an empty registry is six empty buckets', () => {
    const buckets = bucketRegistryAccounts({}, { now: NOW });
    expect(buckets.total).toBe(0);
    for (const key of BUCKET_KEYS) {
      expect(buckets[key]).toEqual({ key, accounts: [], count: 0, sentence: null });
    }
    expect(bucketRegistryAccounts(null, { now: NOW }).total).toBe(0);
  });

  it('carries the figures a screen prints beside a name, with PostgREST strings turned into numbers', () => {
    const buckets = bucketRegistryAccounts({
      A: meta({ observedState: 'breached', breachedOn: '2026-10-07', breachReading: '-263.5', closesMissed: '2', lastCloseSeenOn: '2026-10-07' }),
    }, { now: NOW });
    expect(buckets.looksFailed.accounts[0]).toMatchObject({
      accountName: 'A', alias: 'A', breachReading: -263.5, closesMissed: 2, lastCloseSeenOn: '2026-10-07', breachedOn: '2026-10-07',
    });
  });

  it('expectedAccountNameSet is the names a light is drawn for', () => {
    const buckets = bucketRegistryAccounts({
      A: meta(),
      N: meta({ observedState: 'never_seen', dateAdded: '2026-10-07' }),
      G: meta({ observedState: 'absent', closesMissed: 8 }),
      F: meta({ status: 'Failed' }),
    }, { now: NOW });
    expect([...expectedAccountNameSet(buckets)].sort()).toEqual(['A', 'N']);
  });

  it('no sentence carries a dash as punctuation', () => {
    const buckets = bucketRegistryAccounts({
      A: meta(),
      B: meta({ observedState: 'breached' }),
      C: meta({ observedState: 'absent', closesMissed: 5 }),
      D: meta({ observedState: 'never_seen', dateAdded: '2026-10-06' }),
      E: meta({ observedState: 'never_seen', dateAdded: '' }),
      F: meta({ status: 'Reserve' }),
      G: meta({ accountType: 'Inactive / Ignore' }),
    }, { now: NOW });
    for (const key of BUCKET_KEYS) {
      expect(buckets[key].sentence, key).not.toMatch(/[—–]| - /);
    }
  });
});
