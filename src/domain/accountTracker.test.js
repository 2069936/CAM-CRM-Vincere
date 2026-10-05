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
  ACCOUNT_TRACKER_STATES,
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
     * Assuming new would claim a machine can sample when it cannot.
     *
     * ASKED OF A MACHINE THAT HAS SENT NOTHING, because that is the only state the
     * sentence can be true of. "This VPS runs a collector build from before live
     * sampling" is a claim about the absence of sampling, and a reading from that
     * same machine disproves it whatever the version field says. */
    for (const agentVersion of [null, undefined, '']) {
      expect(tracker({ device: device({ agentVersion }), sample: null, deviceHasSamples: false }).state)
        .toBe('tracker_unsupported');
    }
  });

  it('3c. and NEVER about a machine whose readings are in the table', () => {
    /* The two tracker_* words are both claims about the absence of sampling, so a
     * row is what refutes them. Measured both ways: an old version field with a
     * current reading is a machine that is sampling, and a machine sending other
     * accounts is a machine whose build samples. */
    expect(tracker({ device: device({ agentVersion: '1.1.3' }) }).state).toBe('live');
    expect(tracker({ device: device({ agentVersion: null }) }).state).toBe('live');
    const otherAccounts = tracker({
      device: device({ agentVersion: '1.1.3' }), sample: null, deviceHasSamples: true,
    });
    expect(otherAccounts.state).toBe('never_sampled');
    expect(otherAccounts.detail).toContain('sampling other accounts');
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
      tracker({ device: device({ agentVersion: '1.1.3' }), sample: null, deviceHasSamples: false }),
      tracker({ sample: null, deviceHasSamples: false }),
      tracker({ sample: null, deviceHasSamples: true }),
    ].map((verdict) => verdict.detail);
    expect(new Set(sentences).size).toBe(sentences.length);
    for (const sentence of sentences) expect(sentence.length).toBeGreaterThan(20);
  });
});

describe('the day this merges, with no agent in the world sampling', () => {
  it('says the neutral true thing and claims no fault against any machine', () => {
    // min_agent_version is NULL on a freshly migrated database, and NOTHING is
    // sampling, which is the whole of the inert state.
    const verdict = tracker({ trackerMinAgentVersion: null, sample: null, deviceHasSamples: false });
    expect(verdict.state).toBe('tracker_off');
    expect(verdict.label).toBe('Not sampling yet');
    expect(verdict.attention).toBe(false);
    // Including for a machine that is also offline and also behind the release:
    // "fix the VPS and the light comes on" would be false while nothing in the
    // world is expected to sample. This is why the gate is asked ABOVE `offline`.
    expect(tracker({
      trackerMinAgentVersion: null,
      device: device({ agentVersion: '1.0.0', lastSeenAt: '2026-10-01T00:00:00.000Z', healthStatus: 'error' }),
      sample: null,
      deviceHasSamples: false,
    }).state).toBe('tracker_off');
  });

  /* ── THE DEFECT THIS DESCRIBE BLOCK DID NOT COVER ──────────────────────────
   *
   * The gate used to be the FIRST question in classifyAccountTracker, so for the
   * whole window between installing the sampler and Pedro editing one column -
   * which is precisely the path the design routes through - the client page said
   * "No collector build sends live samples yet, so nothing here is live" about a
   * row the overview was printing as Live with $1,024 against it. Measured
   * verbatim before the fix.
   *
   * THE SENTENCE IS WHAT DECIDES IT, not a preference about ordering. "No
   * collector build sends live samples yet" is a claim about the ABSENCE of
   * sampling, and a reading in the table is proof of its presence. So the gate may
   * only speak when nothing is sampling, and the reading always wins. */
  it('yields to a reading, because a row in the table disproves its own sentence', () => {
    const live = tracker({ trackerMinAgentVersion: null });
    expect(live.state).toBe('live');
    expect(live.detail).not.toContain('No collector build');
    // Including for the stale and disconnected shapes: it is the EXISTENCE of the
    // reading that refutes the gate, not the reading being good news.
    expect(tracker({ trackerMinAgentVersion: null, sample: sample({ connected: false }) }).state)
      .toBe('disconnected');
    expect(tracker({ trackerMinAgentVersion: null, sample: sample({ sampledAt: '2026-10-05T14:20:00.000Z' }) }).state)
      .toBe('sample_stale');
  });

  it('yields to a reading on ANY account of the machine, not only this one', () => {
    /* deviceHasSamples is the same evidence one step out: a machine sending other
     * accounts is a machine that samples, so "no collector build sends live
     * samples yet" is false about it even with nothing for this account. */
    const verdict = tracker({ trackerMinAgentVersion: null, sample: null, deviceHasSamples: true });
    expect(verdict.state).toBe('never_sampled');
    expect(verdict.detail).toContain('sampling other accounts');
  });

  /* ── AND THE TEST THAT IS THE FIX ──────────────────────────────────────────
   *
   * The same row, rendered through BOTH screens, asserted to agree. The client
   * page has the device and the overview does not, so the only honest invariant is
   * this one: when the machine is answering, the two screens must return the same
   * state, the same label and the same sentence, for every row shape and at every
   * value of min_agent_version - including the NULL this ships with. */
  it('renders the same row identically on both screens, at every min_agent_version', () => {
    const rows = [
      sample(),
      sample({ connected: false, status: 'ConnectionLost' }),
      sample({ sampledAt: '2026-10-05T14:20:00.000Z' }),
      sample({ runState: 'idle' }),
      sample({ runState: 'no_strategies' }),
      sample({ runState: 'unmeasured', totalPnl: null }),
    ];
    const versions = [null, undefined, '', '1.0.0', '1.2.0', '9.9.9'];
    for (const row of rows) {
      for (const trackerMinAgentVersion of versions) {
        for (const deviceHasSamples of [true, false]) {
          const clientPage = classifyAccountTracker({
            now: NOW,
            device: device(),
            sample: row,
            deviceHasSamples,
            trackerMinAgentVersion,
            staleSeconds: STALE_SECONDS,
          });
          const overview = classifyAccountSample({ now: NOW, sample: row, staleSeconds: STALE_SECONDS });
          const where = `${row.accountName} ${row.runState} min=${trackerMinAgentVersion} has=${deviceHasSamples}`;
          expect(clientPage.state, where).toBe(overview.state);
          expect(clientPage.label, where).toBe(overview.label);
          expect(clientPage.detail, where).toBe(overview.detail);
          expect(clientPage.runState, where).toBe(overview.runState);
          expect(clientPage.ageMinutes, where).toBe(overview.ageMinutes);
        }
      }
    }
  });

  it('and no row that exists can ever be answered with a sentence about absence', () => {
    /* The three states whose sentences claim nothing has been sampled. A row that
     * exists must be unable to reach any of them from either screen, whatever the
     * machine's version field says and whatever min_agent_version is. */
    const absence = ['tracker_off', 'tracker_unsupported', 'never_sampled'];
    for (const agentVersion of [null, '', '1.0.0', '1.2.0', '9.9.9']) {
      for (const trackerMinAgentVersion of [null, '1.2.0', '9.9.9']) {
        const verdict = tracker({
          device: device({ agentVersion }),
          trackerMinAgentVersion,
        });
        expect(absence, `${agentVersion} / ${trackerMinAgentVersion}`).not.toContain(verdict.state);
      }
    }
  });

  /* ── EVERY STATE, NOT THE ONES THAT WERE BROKEN ─────────────────────────────
   *
   * THE DEFECT, AND IT IS THE SAME DEFECT AS BEFORE ARRIVING AT THE STATES THE
   * LAST FIX DID NOT TRY. `offline` and `revoked` were returned as
   * `trackerResult('offline')` with no extra, so `ageMinutes`, `sampledAt` and
   * `runState` all came back null - while AccountTrackerPanel's row reads the money
   * off `sample.totalPnl`, which is a different path and does not go through the
   * verdict at all. One row therefore printed, on one line:
   *
   *   CLIENT PAGE  Offline   $1,024   never      "The VPS has stopped reporting heartbeats."
   *   OVERVIEW     Live      $1,024   4m ago     "Sampled 4 minutes ago."
   *
   * `never` and `$1,024` about the same sample, on the same line, with a reading
   * four minutes old sitting in the table. The test that was supposed to make this
   * impossible existed and was green: it tried six row shapes against six values of
   * min_agent_version, all with a healthy device, so it covered the state the last
   * round had just fixed and none of the three it had not.
   *
   * WHICH IS WHY THIS ONE IS DRIVEN OFF ACCOUNT_TRACKER_STATES. The scenario table
   * must cover every state the classifier can return, asserted as a set equality,
   * so a state added later with no scenario fails here by name instead of shipping
   * behind a green test named for the invariant it breaks.
   *
   * THE INVARIANT, AND WHY IT IS NOT "THE TWO SCREENS AGREE ON EVERYTHING". They
   * must not. `state`, `label` and `detail` are the client page's to decide and it
   * is right that they differ - the machine not answering outranks the reading it
   * left behind, and that extra fact is what having the device is for. What may
   * never differ is WHEN THE SAMPLE WAS READ, because that is a property of the
   * sample. A screen holding the row cannot answer "never" about a row it is
   * printing money from. */
  it('agrees with the overview about the READING in every one of its states', () => {
    const readable = sample();
    const scenarios = {
      live: { device: device(), sample: readable, deviceHasSamples: true, trackerMinAgentVersion: '1.2.0' },
      disconnected: {
        device: device(),
        sample: sample({ connected: false, status: 'ConnectionLost' }),
        deviceHasSamples: true,
        trackerMinAgentVersion: '1.2.0',
      },
      sample_stale: {
        device: device(),
        sample: sample({ sampledAt: '2026-10-05T14:20:00.000Z' }),
        deviceHasSamples: true,
        trackerMinAgentVersion: '1.2.0',
      },
      /* THE TWO THAT WERE WRONG. Both carry a readable, four-minute-old sample:
         that is the whole point, because a state reached WITHOUT a reading cannot
         expose this and the committed cases all had healthy devices. */
      offline: {
        device: device({ lastSeenAt: '2026-10-05T14:20:00.000Z' }),
        sample: readable,
        deviceHasSamples: true,
        trackerMinAgentVersion: '1.2.0',
      },
      revoked: {
        device: device({ status: 'revoked', revokedAt: '2026-10-04T00:00:00.000Z' }),
        sample: readable,
        deviceHasSamples: true,
        trackerMinAgentVersion: '1.2.0',
      },
      /* And the two beside them that have the same shape and were never asked
         either - a paused VPS and a client whose VPS has been unpaired while its
         last readings are still in the table. */
      paused: {
        device: device({ status: 'paused' }),
        sample: readable,
        deviceHasSamples: true,
        trackerMinAgentVersion: '1.2.0',
      },
      not_installed: {
        device: null, sample: readable, deviceHasSamples: true, trackerMinAgentVersion: '1.2.0',
      },
      /* The four where there is genuinely no reading, so null is the true answer
         and the assertion below checks that it is null on BOTH screens rather than
         skipping them. */
      tracker_off: {
        device: device(), sample: null, deviceHasSamples: false, trackerMinAgentVersion: null,
      },
      tracker_unsupported: {
        device: device({ agentVersion: '1.0.0' }),
        sample: null,
        deviceHasSamples: false,
        trackerMinAgentVersion: '1.2.0',
      },
      never_sampled: {
        device: device(), sample: null, deviceHasSamples: true, trackerMinAgentVersion: '1.2.0',
      },
    };

    // Exhaustive BY CONSTRUCTION: a state added to the classifier and not here
    // fails this line, which is the only version that does not rely on memory.
    expect(Object.keys(scenarios).sort()).toEqual([...ACCOUNT_TRACKER_STATES].sort());

    for (const [state, input] of Object.entries(scenarios)) {
      const clientPage = classifyAccountTracker({ now: NOW, staleSeconds: STALE_SECONDS, ...input });
      const overview = classifyAccountSample({
        now: NOW, sample: input.sample, staleSeconds: STALE_SECONDS,
      });
      // The scenario reaches the state it is named for, or it is proving nothing.
      expect(clientPage.state, `${state} scenario`).toBe(state);

      /* THE THREE FACTS THAT BELONG TO THE SAMPLE, on every state. When there is a
         reading both screens must report the same one; when there is none both must
         say null, and `sampledAt` null is what the panel renders as "never". */
      for (const fact of ['ageMinutes', 'sampledAt', 'runState']) {
        expect(clientPage[fact], `${state}.${fact}`).toBe(overview[fact]);
      }

      /* AND THE ONE THAT MAKES IT A CONTRADICTION RATHER THAN A DISCREPANCY: a
         sample readable enough to price is readable enough to date. This is the
         exact line the panel prints - money off `sample.totalPnl`, age off
         `verdict.sampledAt` - so a null age beside a figure is the bug itself. */
      if (typeof input.sample?.totalPnl === 'number') {
        expect(clientPage.sampledAt, `${state} prints money, so it must print an age`)
          .toBe(input.sample.sampledAt);
        expect(Number.isFinite(clientPage.ageMinutes), `${state} age is a number`).toBe(true);
        expect(clientPage.runState, `${state} run state`).toBe(input.sample.runState);
      }
    }
  });

  /* THE ONE PLACE THE TWO SCREENS MAY DIFFER, said out loud so it is a decision
   * and not a leftover. A machine that has stopped answering is a fact the row
   * cannot carry, and both sentences are true at once. */
  it('differs from the overview only about the MACHINE, and both sentences stay true', () => {
    const dark = device({ lastSeenAt: '2026-10-05T14:20:00.000Z' });
    for (const trackerMinAgentVersion of [null, '1.2.0']) {
      const clientPage = tracker({ device: dark, trackerMinAgentVersion });
      const overview = classifyAccountSample({ now: NOW, sample: sample(), staleSeconds: STALE_SECONDS });
      expect(clientPage.state).toBe('offline');
      expect(clientPage.detail).toBe('The VPS has stopped reporting heartbeats.');
      expect(overview.state).toBe('live');
      // Neither claims the thing the other denies: the client page says nothing
      // about whether a sample arrived, and the overview says nothing about the
      // heartbeat.
      expect(clientPage.detail).not.toContain('sample');
      expect(overview.detail).not.toContain('heartbeat');
    }
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
  it('are the three src/domain/liveAccounts.js already prints from a close, plus one', () => {
    expect(accountRunStateCopy('running').label).toBe('running');
    expect(accountRunStateCopy('idle').label).toBe('all off');
    expect(accountRunStateCopy('unmeasured').label).toBe('no strategy data');
    /* THE FOURTH IS THE ONE A CLOSE CANNOT HAVE. By 16:45 the desk has switched
     * the algos off and NinjaTrader has removed them from the account, so every
     * account looks empty and "measured and empty" is not a distinction a close
     * can draw. A mid-day sample can. */
    expect(accountRunStateCopy('no_strategies').label).toBe('none loaded');
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

  /* ── THE DEFECT: TWO STATES THAT READ THE SAME, AND ONE SENTENCE THAT LIED ──
   *
   * `no_strategies` and `unmeasured` used to be one word. An account the VPS HAD
   * measured and found empty got `unmeasured`'s sentence - "the sample carried no
   * strategy count" - which is FALSE about a sample that carried (0, 0). The
   * collector is explicit that it sends the difference: StrategyLiveCount returns
   * (0, 0) for a collection it read and found empty, (null, null) for one it could
   * not read, "so the wire says which of the two happened".
   *
   * AND IT IS NOT A RARE ROW. The agent's own measurement on one machine in one
   * day is "14 at 09:21, 9 at 16:30, 0 at 18:28", because NinjaTrader removes a
   * strategy from the account when it is disabled. Every account on the fleet
   * reports (0, 0) overnight and before the open, so a flat desk read "2 with no
   * strategy count" on the briefing card every morning. */
  it('keeps "measured and empty" apart from "nobody measured", in both sentences', () => {
    const empty = accountRunStateCopy('no_strategies');
    const unknown = accountRunStateCopy('unmeasured');

    expect(empty.runState).toBe('no_strategies');
    expect(unknown.runState).toBe('unmeasured');
    expect(empty.label).not.toBe(unknown.label);
    expect(empty.detail).not.toBe(unknown.detail);

    // AND BOTH SENTENCES ARE TRUE OF THEIR OWN ROW, which is the actual bar: one
    // says the VPS looked, the other says it did not.
    expect(empty.detail).toContain('read this account');
    expect(empty.detail).toContain('no strategies loaded');
    expect(empty.detail).toContain('Measured');
    expect(unknown.detail).toContain('carried no strategy count');
    // And neither borrows the other's claim.
    expect(empty.detail).not.toContain('carried no strategy count');
    expect(unknown.detail).not.toContain('Measured,');
  });

  it('does NOT reuse idle, whose sentence is false about an account with nothing loaded', () => {
    /* `idle` says "strategies are loaded and every one of them is switched off".
     * Nothing is loaded, so that is a third false sentence and not the fix. */
    const empty = accountRunStateCopy('no_strategies');
    expect(empty.runState).not.toBe('idle');
    expect(accountRunStateCopy('idle').detail).toContain('are loaded');
    expect(empty.detail).not.toContain('switched off');
  });

  it('all four sentences are distinct, checked rather than assumed', () => {
    const words = ['running', 'idle', 'no_strategies', 'unmeasured'];
    const copies = words.map((word) => accountRunStateCopy(word));
    expect(new Set(copies.map((copy) => copy.label)).size).toBe(words.length);
    expect(new Set(copies.map((copy) => copy.detail)).size).toBe(words.length);
    expect(copies.map((copy) => copy.runState)).toEqual(words);
  });

  it('counts a flat desk as flat and not as unmeasured, on the rollup and the headline', () => {
    /* The rollup is where the merge did its damage: both words landed in one
     * counter, so the briefing card said "2 with no strategy count" about a desk
     * that had been measured twice and found quiet. */
    const summary = summarizeAccountTracker([
      sample({ accountName: 'A', runState: 'no_strategies' }),
      sample({ accountName: 'B', runState: 'no_strategies' }),
      sample({ accountName: 'C', runState: 'unmeasured' }),
    ], { now: NOW, staleSeconds: STALE_SECONDS });

    expect(summary.no_strategies).toBe(2);
    expect(summary.unmeasured).toBe(1);
    expect(summary.running).toBe(0);
    expect(summary.idle).toBe(0);
    // Still exactly the live accounts, with the fourth counter inside the sum.
    expect(summary.running + summary.idle + summary.no_strategies + summary.unmeasured)
      .toBe(summary.live);
    expect(accountTrackerHeadline(summary))
      .toBe('3 accounts sampled: 2 with nothing loaded, 1 not measured.');
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
