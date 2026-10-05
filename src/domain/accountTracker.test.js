/* THE STATES MATTER MORE THAN THE CODE.
 *
 * An account that is disconnected, an account whose VPS cannot be reached, an
 * account whose collector is too old to sample and an account nobody has ever
 * sampled are FOUR DIFFERENT THINGS, and a light that merges any two of them is
 * worse than no light - the desk acts on the sentence, not on the colour. Every
 * assertion below is about keeping them apart, and about the two surfaces that
 * know different amounts: the overview reads samples alone, the client workspace
 * reads samples and the device.
 */

import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_TRACKER_ATTENTION_STATES,
  accountRunStateCopy,
  accountTrackerHeadline,
  classifyAccountSample,
  classifyAccountTracker,
  summarizeAccountTracker,
} from './autoCollectionFleet';

const NOW = '2026-10-05T15:00:00.000Z';
const STALE_SECONDS = 1500;

function sample(overrides = {}) {
  return {
    accountName: 'APEX-1',
    connectionName: 'Rithmic',
    connected: true,
    status: 'Connected',
    totalPnl: 412.5,
    runState: 'running',
    sampledAt: '2026-10-05T14:56:00.000Z',
    ...overrides,
  };
}

function device(overrides = {}) {
  return {
    id: 'd1',
    status: 'active',
    healthStatus: 'online',
    agentVersion: '1.2.0',
    lastSeenAt: '2026-10-05T14:59:30.000Z',
    revokedAt: null,
    ...overrides,
  };
}

function tracker(overrides = {}) {
  return classifyAccountTracker({
    now: NOW,
    device: device(),
    sample: sample(),
    deviceHasSamples: true,
    trackerMinAgentVersion: '1.2.0',
    staleSeconds: STALE_SECONDS,
    ...overrides,
  });
}

describe('the four states a CAM has to be able to tell apart', () => {
  it('1. disconnected: the VPS is sampling and the account is not connected', () => {
    const verdict = tracker({ sample: sample({ connected: false, status: 'Disconnected' }) });
    expect(verdict.state).toBe('disconnected');
    expect(verdict.label).toBe('Disconnected');
    expect(verdict.detail).toContain('not connected');
    // The platform's own word is carried through, so the desk can name it on the
    // VPS rather than translating the CRM's paraphrase back.
    expect(tracker({ sample: sample({ connected: false, status: 'ConnectionLost' }) }).detail)
      .toContain('ConnectionLost');
    expect(verdict.attention).toBe(true);
  });

  it('2a. offline: the VPS has stopped answering heartbeats at all', () => {
    const verdict = tracker({ device: device({ lastSeenAt: '2026-10-05T14:30:00.000Z' }) });
    expect(verdict.state).toBe('offline');
    expect(verdict.detail).toBe('The VPS has stopped reporting heartbeats.');
    // The fleet view already counts an offline machine; counting it again here is
    // how a count stops being read.
    expect(verdict.attention).toBe(false);
  });

  it('2b. silent: the VPS answers heartbeats but has stopped sampling', () => {
    /* NOT THE SAME THING as 2a, and this is the distinction a browser-only read
     * could never make from the row alone - it is also the one a ten minute
     * threshold against a ten minute interval would get wrong on every jitter. */
    const verdict = tracker({ sample: sample({ sampledAt: '2026-10-05T14:20:00.000Z' }) });
    expect(verdict.state).toBe('sample_stale');
    expect(verdict.label).toBe('Silent');
    expect(verdict.detail).toContain('40 minutes ago');
    expect(verdict.attention).toBe(true);
    // Just inside the horizon is still live, which is what the 25-minute default
    // buys: one whole missed sample plus slack.
    expect(tracker({ sample: sample({ sampledAt: '2026-10-05T14:36:00.000Z' }) }).state).toBe('live');
    expect(tracker({ sample: sample({ sampledAt: '2026-10-05T14:34:00.000Z' }) }).state).toBe('sample_stale');
  });

  it('3. collector too old: a sentence about sampling, never about the close', () => {
    const verdict = tracker({ device: device({ agentVersion: '1.1.3' }), sample: null, deviceHasSamples: false });
    expect(verdict.state).toBe('tracker_unsupported');
    expect(verdict.detail).toContain('before live sampling');
    /* It says the daily close is unaffected, because it is. Reusing
     * update_required's "The Windows collector must be updated" would put the
     * header badge's sentence on screen a second time and say nothing new. */
    expect(verdict.detail).toContain('daily close is unaffected');
    expect(verdict.detail).not.toContain('must be updated');
    expect(verdict.attention).toBe(false);
  });

  it('3b. an agent that has never said its version is treated as old, not as new', () => {
    /* The collector csproj left <Version> undeclared until 1.1.3, so a build from
     * last quarter and one from today are indistinguishable on that field.
     * Assuming new would claim a machine can sample when it cannot. */
    for (const agentVersion of [null, undefined, '']) {
      expect(tracker({ device: device({ agentVersion }) }).state).toBe('tracker_unsupported');
    }
  });

  it('4. never sampled, in the two different ways that happen', () => {
    const neverAnything = tracker({ sample: null, deviceHasSamples: false });
    expect(neverAnything.state).toBe('never_sampled');
    expect(neverAnything.detail).toContain('no live sample of this account has ever arrived');

    const otherAccountsOnly = tracker({ sample: null, deviceHasSamples: true });
    expect(otherAccountsOnly.state).toBe('never_sampled');
    // A different sentence, because it is a different job: the machine IS
    // sampling and this one account is not in what it sends.
    expect(otherAccountsOnly.detail).toContain('sampling other accounts');
    expect(otherAccountsOnly.detail).not.toEqual(neverAnything.detail);
    expect(neverAnything.attention).toBe(true);
  });

  it('and all four carry different sentences, checked rather than assumed', () => {
    const sentences = [
      tracker({ sample: sample({ connected: false }) }),
      tracker({ device: device({ lastSeenAt: '2026-10-05T14:30:00.000Z' }) }),
      tracker({ sample: sample({ sampledAt: '2026-10-05T14:20:00.000Z' }) }),
      tracker({ device: device({ agentVersion: '1.1.3' }) }),
      tracker({ sample: null, deviceHasSamples: false }),
      tracker({ sample: null, deviceHasSamples: true }),
    ].map((verdict) => verdict.detail);
    expect(new Set(sentences).size).toBe(sentences.length);
    for (const sentence of sentences) expect(sentence.length).toBeGreaterThan(20);
  });
});

describe('the day this merges, with no agent in the world sampling', () => {
  it('says the neutral true thing and claims no fault against any machine', () => {
    // min_agent_version is NULL on a freshly migrated database. Nothing below it
    // can be true while no build samples, so nothing below it is reported.
    const verdict = tracker({ trackerMinAgentVersion: null, sample: null, deviceHasSamples: false });
    expect(verdict.state).toBe('tracker_off');
    expect(verdict.label).toBe('Not sampling yet');
    expect(verdict.attention).toBe(false);
    // Including for a machine that is also offline and also behind the release:
    // "fix the VPS and the light comes on" would be false.
    expect(tracker({
      trackerMinAgentVersion: null,
      device: device({ agentVersion: '1.0.0', lastSeenAt: '2026-10-01T00:00:00.000Z', healthStatus: 'error' }),
      sample: null,
    }).state).toBe('tracker_off');
  });

  it('counts nothing as needing attention', () => {
    expect([...ACCOUNT_TRACKER_ATTENTION_STATES].sort())
      .toEqual(['disconnected', 'never_sampled', 'sample_stale']);
    for (const state of ['tracker_off', 'tracker_unsupported', 'offline', 'not_installed', 'revoked', 'paused', 'live']) {
      expect(ACCOUNT_TRACKER_ATTENTION_STATES.has(state), `${state} is counted`).toBe(false);
    }
  });
});

describe('what the tracker refuses to inherit from the machine', () => {
  it('does NOT read lastErrorCode, so a capture fault cannot paint a live account red', () => {
    /* CollectorState.RecordError feeds lastErrorCode straight onto the heartbeat
     * and classifyFleetRow turns it into Failed. Both codes a tracker sample
     * would naturally produce are inside the heartbeat's accepted set, so
     * reading it here would report an operational error about a machine whose
     * daily close is working perfectly. */
    const verdict = tracker({ device: device({ healthStatus: 'error', lastErrorCode: 'capture_failed' }) });
    expect(verdict.state).toBe('live');
  });

  it('does NOT call a Saturday "no capture expected"', () => {
    // 2026-10-03 is a Saturday. A machine still beats and still samples.
    const saturday = classifyAccountTracker({
      now: '2026-10-03T15:00:00.000Z',
      device: device({ lastSeenAt: '2026-10-03T14:59:30.000Z' }),
      sample: sample({ sampledAt: '2026-10-03T14:56:00.000Z' }),
      deviceHasSamples: true,
      trackerMinAgentVersion: '1.2.0',
    });
    expect(saturday.state).toBe('live');
  });

  it('still defers to the machine for the three facts that outrank everything', () => {
    expect(tracker({ device: null }).state).toBe('not_installed');
    expect(tracker({ device: device({ status: 'revoked' }) }).state).toBe('revoked');
    expect(tracker({ device: device({ revokedAt: '2026-10-01T00:00:00Z' }) }).state).toBe('revoked');
    expect(tracker({ device: device({ status: 'pending' }) }).state).toBe('paused');
    // And they outrank tracker_off, because a revoked VPS is a deliberate act.
    expect(tracker({ device: null, trackerMinAgentVersion: null }).state).toBe('not_installed');
  });
});

describe('what the overview can honestly say from samples alone', () => {
  it('reaches live, disconnected and silent without ever seeing a device', () => {
    expect(classifyAccountSample({ now: NOW, sample: sample(), staleSeconds: STALE_SECONDS }).state).toBe('live');
    expect(classifyAccountSample({ now: NOW, sample: sample({ connected: false }), staleSeconds: STALE_SECONDS }).state)
      .toBe('disconnected');
    expect(classifyAccountSample({
      now: NOW, sample: sample({ sampledAt: '2026-10-05T14:00:00.000Z' }), staleSeconds: STALE_SECONDS,
    }).state).toBe('sample_stale');
  });

  it('makes NO claim for a client with no rows, which is the honest empty state', () => {
    expect(classifyAccountSample({ now: NOW, sample: null }).state).toBe('never_sampled');
    const empty = summarizeAccountTracker([], { now: NOW });
    expect(empty.total).toBe(0);
    expect(empty.totalPnl).toBeNull();
    expect(accountTrackerHeadline(empty)).toBe('');
  });

  it('refuses to age a row whose clock cannot be read', () => {
    for (const sampledAt of [null, undefined, '', 'yesterday', {}]) {
      expect(classifyAccountSample({ now: NOW, sample: sample({ sampledAt }) }).state).toBe('never_sampled');
    }
    expect(classifyAccountSample({ now: 'not a date', sample: sample() }).state).toBe('never_sampled');
  });

  it('falls back to a sane horizon rather than treating a bad setting as zero', () => {
    // A zero or negative horizon would make every sample stale the instant it
    // landed; step 55's CHECK keeps the stored value honest and this is the
    // reader's own floor.
    for (const staleSeconds of [0, -1, null, 'soon', undefined]) {
      expect(classifyAccountSample({ now: NOW, sample: sample(), staleSeconds }).state).toBe('live');
    }
  });

  it('reports the run state only while the reading is current', () => {
    /* A silent account's last known "running" is a claim about a machine that
     * has stopped answering, and the desk would read it as now. */
    const rows = [
      sample({ accountName: 'A', runState: 'running' }),
      sample({ accountName: 'B', runState: 'idle', totalPnl: -50 }),
      sample({ accountName: 'C', runState: 'unmeasured', totalPnl: null }),
      sample({ accountName: 'D', runState: 'running', connected: false, totalPnl: 10 }),
      sample({ accountName: 'E', runState: 'running', sampledAt: '2026-10-05T13:00:00.000Z', totalPnl: 9_999 }),
    ];
    const summary = summarizeAccountTracker(rows, { now: NOW, staleSeconds: STALE_SECONDS });
    expect(summary).toMatchObject({
      total: 5, live: 3, disconnected: 1, silent: 1,
      // D is disconnected with its strategies enabled. Its row says both, and the
      // ROLLUP counts it only as disconnected: enabled strategies on an account
      // with no broker connection cannot trade, and "N of M running" is the
      // number the desk reads to see what it is doing.
      running: 1, idle: 1, unmeasured: 1, attention: 2,
    });
    // running + idle + unmeasured is `live`, never `total`.
    expect(summary.running + summary.idle + summary.unmeasured).toBe(summary.live);
    // E is silent, so its money is not in the figure either: 412.5 - 50 + 10.
    expect(summary.totalPnl).toBeCloseTo(372.5, 6);
    expect(summary.measuredPnl).toBe(3);
    expect(summary.newestSampledAt?.toISOString()).toBe('2026-10-05T14:56:00.000Z');
  });

  it('never turns a missing P&L into a zero', () => {
    /* `Number(null)` is 0, and an account that reported no P&L counted as an
     * account that made nothing is the exact failure liveAccounts.js was written
     * to stop. measuredPnl is what lets the screen say how many accounts the
     * figure is about. */
    const summary = summarizeAccountTracker([
      sample({ accountName: 'A', totalPnl: null }),
      sample({ accountName: 'B', totalPnl: undefined }),
    ], { now: NOW, staleSeconds: STALE_SECONDS });
    expect(summary.totalPnl).toBeNull();
    expect(summary.measuredPnl).toBe(0);
    const mixed = summarizeAccountTracker([
      sample({ accountName: 'A', totalPnl: null }),
      sample({ accountName: 'B', totalPnl: 100 }),
    ], { now: NOW, staleSeconds: STALE_SECONDS });
    expect(mixed.totalPnl).toBe(100);
    expect(mixed.measuredPnl).toBe(1);
  });

  it('ignores anything in the list that is not a row', () => {
    const summary = summarizeAccountTracker([null, undefined, 'APEX-1', 7, sample()], { now: NOW, staleSeconds: STALE_SECONDS });
    expect(summary.total).toBe(1);
  });

  it('writes the headline the card and the panel header both print', () => {
    const summary = summarizeAccountTracker([
      sample({ accountName: 'A', runState: 'running' }),
      sample({ accountName: 'B', runState: 'idle' }),
      sample({ accountName: 'C', connected: false }),
      sample({ accountName: 'D', sampledAt: '2026-10-05T13:00:00.000Z' }),
      sample({ accountName: 'E', runState: 'unmeasured' }),
    ], { now: NOW, staleSeconds: STALE_SECONDS });
    expect(accountTrackerHeadline(summary))
      .toBe('5 accounts sampled: 1 running, 1 all off, 1 not measured, 1 disconnected, 1 silent.');
    expect(accountTrackerHeadline(summarizeAccountTracker([sample()], { now: NOW, staleSeconds: STALE_SECONDS })))
      .toBe('1 account sampled: 1 running.');
  });
});

describe('the run state words', () => {
  it('are the same three src/domain/liveAccounts.js already prints from a close', () => {
    expect(accountRunStateCopy('running').label).toBe('running');
    expect(accountRunStateCopy('idle').label).toBe('all off');
    expect(accountRunStateCopy('unmeasured').label).toBe('no strategy data');
  });

  it('never fold an unknown word into "all off"', () => {
    // A state the CRM has not met is "nobody measured", not "the desk switched
    // everything off": those lead to opposite actions.
    for (const value of [null, undefined, 'RUNNING', 'off', '']) {
      expect(accountRunStateCopy(value).runState).toBe('unmeasured');
    }
  });

  it('says "not measured - not zero" in so many words', () => {
    expect(accountRunStateCopy('unmeasured').detail).toContain('Not measured - not zero.');
  });
});

describe('how old a reading is, said in words a person reads', () => {
  it('counts minutes, then hours, then days', () => {
    const at = (iso) => classifyAccountSample({ now: NOW, sample: sample({ sampledAt: iso }), staleSeconds: 86_400 }).detail;
    expect(at('2026-10-05T14:59:30.000Z')).toContain('0 minutes ago');
    expect(at('2026-10-05T14:59:00.000Z')).toContain('1 minute ago');
    expect(at('2026-10-05T14:30:00.000Z')).toContain('30 minutes ago');
    expect(at('2026-10-05T13:00:00.000Z')).toContain('2 hours ago');
    expect(at('2026-10-04T14:00:00.000Z')).toContain('25 hours ago');
    expect(at('2026-10-02T15:00:00.000Z')).toContain('3 days ago');
  });

  it('never reports a negative age for a sample whose clock ran ahead', () => {
    const verdict = classifyAccountSample({ now: NOW, sample: sample({ sampledAt: '2026-10-05T15:02:00.000Z' }) });
    expect(verdict.ageMinutes).toBe(0);
    expect(verdict.state).toBe('live');
  });
});
