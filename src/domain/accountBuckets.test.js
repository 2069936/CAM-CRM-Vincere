import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_OBSERVATION_DEFAULTS,
  BUCKET_KEYS,
  NOT_SHOWN_WORDS,
  STILL_LISTED_WORDS,
  bucketRegistryAccounts,
  expectedAccountNameSet,
  notShownAccounts,
  registryLights,
  retiredSampleFate,
  stillRunningWords,
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

/* ------------------------------------------------------------------------- *
 * WHAT GETS A LIGHT, AND THE ONE FOLDED LINE FOR THE REST.
 *
 * Pedro's words: the lights kept showing dead accounts as never sampled. Now
 * that the database classifies them, a light is drawn only for the accounts
 * expected to trade (the new ones among them, said as new), and one collapsed
 * line under the tile, the strip and the drawer says why the others are not
 * shown, so a CAM can tell a dead account from a new one from a missing one.
 * ------------------------------------------------------------------------- */
describe('registryLights: which accounts get a light, and the folded line for the rest', () => {
  const REGISTRY = {
    'ACC 01': meta(),
    'ACC 02': meta({ observedState: 'seen' }),
    'ACC 03': meta({ observedState: 'breached', breachedOn: '2026-10-07', breachReading: -263.5 }),
    'ACC 04': meta({ observedState: 'absent', closesMissed: 6, lastCloseSeenOn: '2026-09-29' }),
    'ACC 05': meta({ observedState: 'never_seen', lastCloseSeenOn: '', dateAdded: '2026-10-05' }),
    'ACC 06': meta({ status: 'Failed' }),
    'ACC 07': meta({ observedState: 'never_seen', lastCloseSeenOn: '', dateAdded: '2026-01-10' }),
  };

  it('lights the expected accounts, the new one among them, and folds the rest into one line', () => {
    const lights = registryLights(REGISTRY, { now: NOW });
    expect(lights.names).toEqual(['ACC 01', 'ACC 02', 'ACC 05']);
    expect([...lights.fresh.keys()]).toEqual(['ACC 05']);
    expect(lights.fresh.get('ACC 05')).toBe('Added 3 days ago, not seen in a close yet.');
    expect(lights.notShown.count).toBe(4);
    expect(lights.notShown.sentence).toBe(
      'Not shown: 1 account looks failed, breached on the close. 1 gone from the close for 6 closes. '
      + '1 registered and never seen in a close, added more than 14 days ago. 1 retired: 1 Failed.',
    );
    // Failed first, then gone, then never seen, then retired: the order of the questions.
    expect(lights.notShown.accounts.map((row) => `${row.accountName}: ${row.word}`)).toEqual([
      'ACC 03: looks failed', 'ACC 04: gone from the close', 'ACC 07: never seen in a close', 'ACC 06: Failed',
    ]);
    expect(NOT_SHOWN_WORDS.breached).toBe('looks failed');
  });

  it('says beside each hidden name what the close saw of it', () => {
    const { notShown } = registryLights(REGISTRY, { now: NOW });
    const detail = Object.fromEntries(notShown.accounts.map((row) => [row.accountName, row.detail]));
    expect(detail['ACC 03']).toBe('Breached on 2026-10-07, reading -$264, status still Active.');
    expect(detail['ACC 04']).toBe('Gone from the close for 6 closes, last seen 2026-09-29.');
    expect(detail['ACC 07']).toBe('Never seen in a close, added 2026-01-10.');
    expect(detail['ACC 06']).toBe('Status Failed.');
  });

  it('a new account is expected and says since when; added today says today', () => {
    const lights = registryLights({
      N: meta({ observedState: 'never_seen', dateAdded: '2026-10-07' }),
      T: meta({ observedState: 'never_seen', dateAdded: '2026-10-08' }),
    }, { now: NOW });
    expect(lights.names).toEqual(['N', 'T']);
    expect(lights.fresh.get('N')).toBe('Added 1 day ago, not seen in a close yet.');
    expect(lights.fresh.get('T')).toBe('Added today, not seen in a close yet.');
  });

  it('is nothing at all when every account is expected, new ones included', () => {
    const lights = registryLights({
      A: meta(),
      N: meta({ observedState: 'never_seen', dateAdded: '2026-10-07' }),
      U: { status: 'Active' },
    }, { now: NOW });
    expect(lights.names).toEqual(['A', 'N', 'U']);
    expect(lights.notShown).toBeNull();
    expect(notShownAccounts(bucketRegistryAccounts({}, { now: NOW }))).toBeNull();
  });

  it('the setting moves a new account into the folded line', () => {
    const lights = registryLights(REGISTRY, { now: NOW, settings: { newAccountDays: 2 } });
    expect(lights.names).toEqual(['ACC 01', 'ACC 02']);
    expect(lights.fresh.size).toBe(0);
    expect(lights.notShown.count).toBe(5);
    expect(lights.notShown.sentence).toContain('2 registered and never seen in a close, added more than 2 days ago');
  });

  /* A live sample, fresh at NOW (15:00Z), connected and running by default. */
  const live = (accountName, over = {}) => ({
    accountName, connectionName: 'Rithmic', connected: true, status: 'Connected', totalPnl: 120,
    strategyCount: 2, enabledStrategyCount: 2, runState: 'running', sampledAt: '2026-10-08T14:56:00Z', ...over,
  });

  it('an account the VPS samples connected and running keeps its light even when the close hid it, with the marker for a retired one', () => {
    // ACC 03 looks failed on the close and ACC 06 is Failed, and NinjaTrader
    // has both connected and running: a real question, so both keep a pill
    // (they leave the line) and say so. ACC 09 is not on the registry at all.
    const lights = registryLights(REGISTRY, { now: NOW, samples: [live('ACC 03'), live('ACC 06'), live('ACC 09')] });
    expect(lights.names).toEqual(['ACC 01', 'ACC 02', 'ACC 05']);
    expect(lights.hidden.size).toBe(0);
    expect(Object.fromEntries(lights.stillRunning)).toEqual({
      'ACC 03': { word: 'Looks failed', words: 'Looks failed on the close but still running' },
      'ACC 06': { word: 'Marked Failed', words: 'Marked Failed but still running' },
    });
    expect(lights.notShown.accounts.map((row) => row.accountName)).toEqual(['ACC 04', 'ACC 07']);
    expect(lights.notShown.sentence).toBe(
      'Not shown: 1 gone from the close for 6 closes. 1 registered and never seen in a close, added more than 14 days ago.',
    );
    // Gone and never seen keep the old rule: a sampled one has a light, whatever it says.
    const sampledAll = registryLights(REGISTRY, {
      now: NOW, samples: [live('ACC 03'), live('ACC 04', { connected: false }), live('ACC 06'), live('ACC 07', { runState: 'idle' })],
    });
    expect(sampledAll.notShown).toBeNull();
    expect(sampledAll.hidden.size).toBe(0);
  });

  it('a Failed or looks failed account NinjaTrader still lists disconnected gets no light: the line says so', () => {
    const lights = registryLights(REGISTRY, {
      now: NOW,
      samples: [live('ACC 03', { connected: false, status: 'Disconnected', runState: 'no_strategies', strategyCount: 0, enabledStrategyCount: 0 }),
        live('ACC 06', { connected: false, status: 'Disconnected' })],
    });
    expect([...lights.hidden].sort()).toEqual(['ACC 03', 'ACC 06']);
    expect(lights.stillRunning.size).toBe(0);
    expect(lights.notShown.sentence).toBe(
      'Not shown: 1 account looks failed, breached on the close. 1 gone from the close for 6 closes. '
      + '1 registered and never seen in a close, added more than 14 days ago. 1 retired: 1 Failed. '
      + '2 still listed by NinjaTrader, disconnected.',
    );
    const rows = Object.fromEntries(lights.notShown.accounts.map((row) => [row.accountName, row]));
    expect(rows['ACC 06'].word).toBe('Failed, still listed by NinjaTrader, disconnected');
    expect(rows['ACC 03'].word).toBe('looks failed, still listed by NinjaTrader, disconnected');
    expect(rows['ACC 06'].detail).toBe('Status Failed. NinjaTrader still lists it, not connected, sampled 4m ago.');
    expect(rows['ACC 03'].detail).toBe('Breached on 2026-10-07, reading -$264, status still Active. NinjaTrader still lists it, not connected, sampled 4m ago.');
    // The plain hidden rows say exactly what they said before.
    expect(rows['ACC 04'].word).toBe('gone from the close');
  });

  it('connected with nothing loaded, every strategy off or no strategy data is no light either, each said in its own words', () => {
    const registry = {
      F1: meta({ status: 'Failed' }),
      F2: meta({ status: 'Inactive' }),
      F3: meta({ status: 'Reserve' }),
      F4: meta({ accountType: 'Inactive / Ignore' }),
    };
    const lights = registryLights(registry, {
      now: NOW,
      samples: [
        live('F1', { runState: 'no_strategies', strategyCount: 0, enabledStrategyCount: 0 }),
        live('F2', { runState: 'idle', enabledStrategyCount: 0 }),
        live('F3', { runState: 'unmeasured', strategyCount: null, enabledStrategyCount: null }),
        live('F4', { connected: false }),
      ],
    });
    expect([...lights.hidden].sort()).toEqual(['F1', 'F2', 'F3', 'F4']);
    expect(lights.notShown.accounts.map((row) => `${row.accountName} ${row.word}`)).toEqual([
      'F1 Failed, still listed by NinjaTrader, connected, nothing loaded',
      'F2 Inactive, still listed by NinjaTrader, connected, all off',
      'F3 Reserve, still listed by NinjaTrader, connected, no strategy data',
      'F4 Ignored, still listed by NinjaTrader, disconnected',
    ]);
    expect(lights.notShown.sentence).toBe(
      'Not shown: 4 retired: 1 Failed, 1 Inactive, 1 Reserve, 1 Ignored. 4 still listed by NinjaTrader: '
      + '1 disconnected, 1 connected with nothing loaded, 1 connected with every strategy off, 1 connected with no strategy data.',
    );
    expect(STILL_LISTED_WORDS.no_strategies).toBe('still listed by NinjaTrader, connected, nothing loaded');
  });

  it('a stale sample of a retired account says nothing about now: no light, the plain reason word, and when it was last sampled', () => {
    // Running at its last sample, two hours ago. That is not "still running".
    const lights = registryLights(REGISTRY, { now: NOW, samples: [live('ACC 06', { sampledAt: '2026-10-08T13:00:00Z' })] });
    expect([...lights.hidden]).toEqual(['ACC 06']);
    expect(lights.stillRunning.size).toBe(0);
    const row = lights.notShown.accounts.find((entry) => entry.accountName === 'ACC 06');
    expect(row.word).toBe('Failed');
    expect(row.detail).toBe('Status Failed. The VPS last sampled it 2h ago and has not since.');
    expect(lights.notShown.sentence).not.toContain('still listed');
    // The tracker's horizon decides what stale is.
    const wide = registryLights(REGISTRY, { now: NOW, samples: [live('ACC 06', { sampledAt: '2026-10-08T13:00:00Z' })], staleSeconds: 3 * 3600 });
    expect(wide.stillRunning.get('ACC 06')).toEqual({ word: 'Marked Failed', words: 'Marked Failed but still running' });
  });

  it('retiredSampleFate keeps only a fresh sample that is connected and running', () => {
    const at = { now: NOW, staleSeconds: 1500 };
    expect(retiredSampleFate(live('X'), at)).toMatchObject({ keep: true, listed: null });
    expect(retiredSampleFate(live('X', { connected: false }), at)).toMatchObject({ keep: false, listed: 'disconnected' });
    // Disconnected with strategies enabled still cannot trade: no light.
    expect(retiredSampleFate(live('X', { connected: false, runState: 'running' }), at)).toMatchObject({ keep: false, listed: 'disconnected' });
    expect(retiredSampleFate(live('X', { runState: 'idle' }), at)).toMatchObject({ keep: false, listed: 'idle' });
    expect(retiredSampleFate(live('X', { runState: 'no_strategies' }), at)).toMatchObject({ keep: false, listed: 'no_strategies' });
    expect(retiredSampleFate(live('X', { runState: 'unmeasured' }), at)).toMatchObject({ keep: false, listed: 'unmeasured' });
    expect(retiredSampleFate(live('X', { sampledAt: '2026-10-08T13:00:00Z' }), at)).toMatchObject({ keep: false, listed: 'silent' });
    expect(retiredSampleFate(live('X', { sampledAt: '' }), at)).toMatchObject({ keep: false, listed: null });
  });

  it('the marker says the status the registry carries, so it is never "Failed" about an account that is not', () => {
    expect(stillRunningWords({ reason: 'Failed' }).words).toBe('Marked Failed but still running');
    expect(stillRunningWords({ reason: 'Inactive' })).toEqual({ word: 'Marked Inactive', words: 'Marked Inactive but still running' });
    expect(stillRunningWords({ reason: 'Reserve' }).word).toBe('Marked Reserve');
    expect(stillRunningWords({ reason: 'Ignored' })).toEqual({ word: 'Marked Ignore', words: 'Marked Inactive / Ignore but still running' });
    expect(stillRunningWords({ reason: 'breached', status: 'Active' }).words).toBe('Looks failed on the close but still running');
  });

  it('takes the samples as a Map of name to row as well as a list', () => {
    const samples = new Map([['ACC 06', live('ACC 06', { connected: false })]]);
    expect([...registryLights(REGISTRY, { now: NOW, samples }).hidden]).toEqual(['ACC 06']);
  });

  it('an empty or missing registry lights nothing and hides nothing', () => {
    expect(registryLights(null, { now: NOW })).toMatchObject({ names: [], notShown: null });
    expect(registryLights({}, { now: NOW }).fresh.size).toBe(0);
  });

  it('no line, word or detail carries a dash as punctuation', () => {
    const { notShown } = registryLights({
      ...REGISTRY,
      G: meta({ accountType: 'Inactive / Ignore' }),
      R: meta({ status: 'Reserve' }),
      U: meta({ observedState: 'never_seen', dateAdded: '' }),
      M: meta({ observedState: 'absent', closesMissed: null, lastCloseSeenOn: '' }),
      B: meta({ observedState: 'breached', breachedOn: '', breachReading: null }),
    }, {
      now: NOW,
      // Every way NinjaTrader can still list a retired account, so their words are checked too.
      samples: [
        { accountName: 'G', connected: false, runState: 'running', sampledAt: '2026-10-08T14:56:00Z' },
        { accountName: 'R', connected: true, runState: 'idle', sampledAt: '2026-10-08T14:56:00Z' },
        { accountName: 'B', connected: true, runState: 'unmeasured', sampledAt: '2026-10-08T14:56:00Z' },
        { accountName: 'ACC 06', connected: true, runState: 'running', sampledAt: '2026-10-08T10:00:00Z' },
      ],
    });
    expect(notShown.sentence).not.toMatch(/[—–]| - /);
    for (const row of notShown.accounts) {
      expect(row.word, row.accountName).not.toMatch(/[—–]| - /);
      expect(row.detail, row.accountName).not.toMatch(/[—–]| - /);
      expect(row.detail, row.accountName).toMatch(/\.$/);
    }
    const detail = Object.fromEntries(notShown.accounts.map((row) => [row.accountName, row.detail]));
    expect(detail.M).toBe('Gone from the close.');
    expect(detail.B).toBe('Breached on the close, status still Active. NinjaTrader still lists it, connected with no strategy count in the sample, sampled 4m ago.');
    expect(detail.U).toBe('Never seen in a close, no date added.');
    expect(detail.G).toBe('Account type Inactive / Ignore. NinjaTrader still lists it, not connected, sampled 4m ago.');
    for (const words of Object.values(stillRunningWords({ reason: 'Ignored' }))) expect(words).not.toMatch(/[—–]| - /);
  });
});
