import { describe, expect, it } from 'vitest';
import { classifyAccountSample, classifyAccountTracker } from './autoCollectionFleet';
import {
  NO_CONNECTION_WORD,
  buildAccountPill,
  differsWords,
  withCloseDiffers,
  withDiffers,
  withDisconnectedSince,
} from './accountPill';

/* ------------------------------------------------------------------------- *
 * THE PILL, ONE SHAPE FOR BOTH SCREENS.
 *
 * Pedro's words: the dot on the client page says more things, the account,
 * what kind of connection it is, and whether it is active; the overview's dots
 * should say the same. These fields are built once, here, from a verdict and
 * the sample, so the client page strip and the overview tile cannot drift.
 * ------------------------------------------------------------------------- */

const NOW = '2026-10-08T15:00:00.000Z';

function sample(overrides = {}) {
  return {
    accountName: 'ACC 01',
    connectionName: 'Bluesky',
    connected: true,
    status: 'Connected',
    realizedPnl: 120,
    unrealizedPnl: -20,
    totalPnl: 100,
    strategyCount: 2,
    enabledStrategyCount: 2,
    runState: 'running',
    sampledAt: '2026-10-08T14:56:00.000Z',
    ...overrides,
  };
}

function pill(overrides = {}, extra = {}) {
  const row = sample(overrides);
  const verdict = classifyAccountSample({ now: NOW, sample: row, staleSeconds: 1500 });
  return buildAccountPill({ accountName: row.accountName, sample: row, verdict, ...extra });
}

describe('the three things the pill says, plus what the account is doing', () => {
  it('carries the account, the connection and the state in words', () => {
    const live = pill();
    expect(live).toMatchObject({
      accountName: 'ACC 01',
      connectionName: 'Bluesky',
      connectionWord: 'Bluesky',
      hasConnection: true,
      state: 'live',
      tone: 'live',
      label: 'Live',
      runLabel: 'running',
    });
  });

  it('says "No connection name" for a sample without one, as a normal state and not a fault', () => {
    const anonymous = pill({ connectionName: null });
    expect(anonymous.connectionName).toBeNull();
    expect(anonymous.connectionWord).toBe(NO_CONNECTION_WORD);
    expect(anonymous.hasConnection).toBe(false);
    expect(NO_CONNECTION_WORD).toBe('No connection name');
    // Still live, still green: the connection name is a label, not a health signal.
    expect(anonymous.state).toBe('live');
    expect(anonymous.tone).toBe('live');
    expect(pill({ connectionName: '' }).connectionWord).toBe(NO_CONNECTION_WORD);
  });

  it('says the run state only under a current reading', () => {
    expect(pill().runLabel).toBe('running');
    expect(pill({ runState: 'idle' }).runLabel).toBe('all off');
    expect(pill({ runState: 'no_strategies' }).runLabel).toBe('none loaded');
    expect(pill({ connected: false, status: 'ConnectionLost' })).toMatchObject({ label: 'Disconnected', runLabel: 'running', tone: 'attention' });
    // A silent account's last known "running" is a claim about a machine that stopped answering.
    expect(pill({ sampledAt: '2026-10-08T13:00:00.000Z' })).toMatchObject({ label: 'Silent', runLabel: null, tone: 'attention' });
  });

  it('gives a registered account nobody has sampled a pill with no connection and the honest sentence', () => {
    const verdict = classifyAccountSample({ now: NOW, sample: null, staleSeconds: 1500 });
    const never = buildAccountPill({ accountName: 'ACC 09', sample: null, verdict, inRegistry: true });
    expect(never).toMatchObject({
      accountName: 'ACC 09',
      connectionName: null,
      connectionWord: NO_CONNECTION_WORD,
      state: 'never_sampled',
      tone: 'faint',
      label: 'Never sampled',
      runLabel: null,
      inRegistry: true,
    });
    expect(never.detail).toContain('Open the client to see whether a VPS is paired');
  });

  it('keeps the device states the client page can see, with a grey tone', () => {
    const verdict = classifyAccountTracker({
      now: NOW,
      device: { id: 'd', status: 'active', healthStatus: 'online', agentVersion: '1.2.0', lastSeenAt: '2026-10-08T13:00:00.000Z', revokedAt: null },
      sample: sample(),
      deviceHasSamples: true,
      trackerMinAgentVersion: '1.2.0',
      staleSeconds: 1500,
    });
    const offline = buildAccountPill({ accountName: 'ACC 01', sample: sample(), verdict });
    expect(offline).toMatchObject({ state: 'offline', label: 'Offline', tone: 'none', connectionWord: 'Bluesky', runLabel: null });
  });
});

describe('the hover title', () => {
  it('names the account, the state, the connection, the sentence and the strategies', () => {
    expect(pill().title).toBe('ACC 01: Live. Connection Bluesky. Sampled 4 minutes ago. Strategies: running.');
  });

  it('says there is no connection name instead of inventing one', () => {
    expect(pill({ connectionName: null }).title).toBe('ACC 01: Live. No connection name. Sampled 4 minutes ago. Strategies: running.');
  });

  it('keeps the platform word on a disconnected account', () => {
    const title = pill({ connected: false, status: 'ConnectionLost' }).title;
    expect(title).toContain('ACC 01: Disconnected.');
    expect(title).toContain('Connection Bluesky.');
    expect(title).toContain('not connected to its broker');
    expect(title).toContain('ConnectionLost');
  });

  it('never prints a dash', () => {
    for (const row of [pill(), pill({ connectionName: null }), pill({ connected: false }), pill({ sampledAt: '2026-10-08T13:00:00.000Z' })]) {
      expect(row.title).not.toMatch(/[–—]| - /);
    }
  });
});

describe('the amber marker for an algorithm that differs from the desk', () => {
  it('is absent until something differs', () => {
    expect(pill()).toMatchObject({ differsCount: 0, differsWords: null });
    expect(withDiffers(pill(), 0)).toMatchObject({ differsCount: 0, differsWords: null });
  });

  it('counts algorithms, singular and plural, and says it in the title', () => {
    expect(differsWords(1)).toBe('1 algorithm differs from the desk');
    expect(differsWords(2)).toBe('2 algorithms differ from the desk');
    expect(differsWords(0)).toBeNull();
    const marked = withDiffers(pill(), 1);
    expect(marked.differsCount).toBe(1);
    expect(marked.differsWords).toBe('1 algorithm differs from the desk');
    expect(marked.title).toBe('ACC 01: Live. Connection Bluesky. Sampled 4 minutes ago. Strategies: running. 1 algorithm differs from the desk.');
    // Everything else on the pill is untouched: the marker is never the colour.
    expect(marked.tone).toBe('live');
    expect(marked.state).toBe('live');
  });

  it('is the word "differs" and nothing stronger', () => {
    expect(differsWords(3)).not.toMatch(/wrong|outlier|worse|fault/i);
  });
});

/* ------------------------------------------------------------------------- *
 * TWO MORE THINGS A PILL CAN SAY, AND NO BUILDER MAY DROP THEM.
 *
 * withDiffers and withCloseDiffers rebuild the title; the marker for a retired
 * account still running and "Disconnected since" are pill fields, so the title
 * carries them whichever builder ran last.
 * ------------------------------------------------------------------------- */
describe('the marker for a retired account still running', () => {
  const MARKED = { word: 'Marked Failed', words: 'Marked Failed but still running' };

  it('is a badge word and a sentence in the title, and leaves the colour, the state and the label alone', () => {
    const marked = pill({}, { marked: MARKED });
    expect(marked).toMatchObject({ marked: true, markedWord: 'Marked Failed', markedWords: 'Marked Failed but still running', state: 'live', tone: 'live', label: 'Live' });
    expect(marked.title).toBe('ACC 01: Live. Marked Failed but still running. Connection Bluesky. Sampled 4 minutes ago. Strategies: running.');
    expect(pill()).toMatchObject({ marked: false, markedWord: null, markedWords: null });
  });

  it('survives the desk marker and the close badge, in either order', () => {
    const marked = pill({}, { marked: MARKED });
    const both = withCloseDiffers(withDiffers(marked, 1), 'differs');
    expect(both.title).toContain('Marked Failed but still running.');
    expect(both.title).toContain('1 algorithm differs from the desk.');
    expect(both.title).toContain('Close differs: the realized figures differ.');
    expect(withDiffers(withCloseDiffers(marked, 'differs'), 2).title).toContain('Marked Failed but still running.');
  });
});

describe('since when a pill has been disconnected', () => {
  it('heads the title of a disconnected pill and keeps the pill word short', () => {
    const down = withDisconnectedSince(pill({ connected: false, status: 'ConnectionLost' }), 'Disconnected since 09:40');
    expect(down.label).toBe('Disconnected');
    expect(down.sinceWords).toBe('Disconnected since 09:40');
    expect(down.title.startsWith('ACC 01: Disconnected since 09:40. Connection Bluesky.')).toBe(true);
    expect(down.title).toContain('NinjaTrader reports it as ConnectionLost.');
  });

  it('is kept by the desk marker and the close badge', () => {
    const down = withDisconnectedSince(pill({ connected: false }), 'Disconnected since before 06:30');
    expect(withCloseDiffers(withDiffers(down, 1), 'tracker_only').title).toContain('ACC 01: Disconnected since before 06:30.');
  });

  it('is never put on a pill that is not disconnected, and no words leave a pill untouched', () => {
    const live = pill();
    expect(withDisconnectedSince(live, 'Disconnected since 09:40')).toBe(live);
    const silent = pill({ connected: false, sampledAt: '2026-10-08T13:00:00.000Z' });
    expect(withDisconnectedSince(silent, 'Disconnected since 09:40')).toBe(silent);
    const down = pill({ connected: false });
    expect(withDisconnectedSince(down, null)).toBe(down);
  });
});
