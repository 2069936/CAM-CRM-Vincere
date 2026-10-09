import { describe, expect, it } from 'vitest';
import {
  BULB_TONES,
  BULB_WORDS,
  DESK_LEGEND,
  ONLY_RETIRED_LEGEND,
  buildDeskClientLight,
  buildDeskClientLights,
  compareBulbs,
  deskWords,
  groupByConnection,
} from './deskClientLights';

/* ------------------------------------------------------------------------- *
 * ONE BULB PER CLIENT ON THE DESK VIEW.
 *
 * Pedro's words: the Manager's semáforo shows every client at once and that is
 * too much to read; one light per client instead, is NinjaTrader up and are the
 * connections active, amber when some connections are up and others that should
 * be are not, and a click for the breakdown. These assertions are about the
 * six states a bulb can be in, the sentence beside each, the order of the
 * grid, the counts line, the grouping by connection under a bulb, and the two
 * identity keys a client can carry.
 *
 * RED IS EVIDENCE, NOT ABSENCE. A client whose samples have merely gone stale
 * is silent, amber: the sampler has not reported, which is not the same as a
 * lost connection. Red needs the heartbeat to say NinjaTrader is down, or a
 * fresh sample to say disconnected. Before the open and after the close every
 * sampled client is stale, and painting the whole desk red twice a day was the
 * bug this distinction exists for.
 * ------------------------------------------------------------------------- */

const NOW = new Date('2026-10-08T15:00:00.000Z');
const FRESH = '2026-10-08T14:56:00.000Z';
const STALE = '2026-10-08T14:18:00.000Z';
const UUID = '4b0e5c8f-8c3f-4b2a-9d2e-1b2c3d4e5f60';

function sample(accountName, overrides = {}) {
  return {
    accountName,
    connectionName: 'Live',
    connected: true,
    status: 'Connected',
    realizedPnl: 100,
    unrealizedPnl: 0,
    totalPnl: 100,
    strategyCount: 2,
    enabledStrategyCount: 2,
    runState: 'running',
    sampledAt: FRESH,
    ...overrides,
  };
}
const disconnected = (name, extra = {}) => sample(name, { connected: false, status: 'ConnectionLost', ...extra });
const silent = (name, extra = {}) => sample(name, { sampledAt: STALE, ...extra });

function client(id, name, accounts = [], extra = {}) {
  return {
    id,
    name,
    profile: { stage: 'Active' },
    accountRegistry: Object.fromEntries(accounts.map((accountName) => [accountName, { accountName, status: 'Active' }])),
    ...extra,
  };
}

function device(overrides = {}) {
  return {
    id: 'dev-1',
    status: 'active',
    healthStatus: 'online',
    lastSeenAt: '2026-10-08T14:59:30.000Z',
    lastErrorCode: null,
    revokedAt: null,
    ...overrides,
  };
}

function bulb(samples, devices = [device()], overrides = {}) {
  return buildDeskClientLight(client('c-1', 'Client A', ['ACC 01', 'ACC 02']), {
    samples,
    devices,
    deviceAware: devices !== null,
    now: NOW,
    staleSeconds: 1500,
    ...overrides,
  });
}

describe('the six states of a bulb', () => {
  it('is live when every fresh account is connected and the VPS reports no error', () => {
    const view = bulb([sample('ACC 01'), sample('ACC 02', { connectionName: 'Bluesky' })]);
    expect(view.state).toBe('live');
    expect(view.tone).toBe(BULB_TONES.live);
    expect(view.word).toBe('Live');
    expect(view.sentence).toBe('Live, 2 accounts connected on 2 connections.');
  });

  it('is partly live when some accounts are connected and others are disconnected or silent', () => {
    const view = bulb([sample('ACC 01'), sample('ACC 02'), sample('ACC 03'), disconnected('ACC 04'), silent('ACC 05')]);
    expect(view.state).toBe('partly');
    expect(view.tone).toBe('partly');
    expect(view.sentence).toBe('Partly live, 3 connected, 1 disconnected, 1 silent.');
  });

  it('is partly live on a silent account alone, beside a live one, with nothing disconnected and the VPS fine', () => {
    // Silence is the only thing wrong here, so silence alone must be what makes
    // the bulb amber: a rule that needed a disconnected account or a VPS error
    // beside it would paint this client green.
    const view = buildDeskClientLight(client('c-1', 'Client A', ['ACC 01', 'ACC 02']), { samples: [sample('ACC 01'), silent('ACC 02')], devices: [device()], deviceAware: true, now: NOW, staleSeconds: 1500 });
    expect(view.state).toBe('partly');
    expect(view.tone).toBe('partly');
    expect(view.sentence).toBe('Partly live, 1 connected, 1 silent.');
  });

  it('is partly live when the accounts are connected but the VPS reports an error', () => {
    const view = bulb([sample('ACC 01'), sample('ACC 02')], [device({ healthStatus: 'error', lastErrorCode: 'capture_failed' })]);
    expect(view.state).toBe('partly');
    expect(view.sentence).toBe('Partly live, 2 connected, VPS reports capture failed.');
  });

  it('is off when the VPS reports NinjaTrader not running and nothing is fresh and connected', () => {
    const view = bulb([silent('ACC 01'), silent('ACC 02')], [device({ healthStatus: 'error', lastErrorCode: 'ninjatrader_not_running' })]);
    expect(view.state).toBe('off');
    expect(view.tone).toBe('off');
    expect(view.sentence).toMatch(/^Off, NinjaTrader not running since \d\d:\d\d\.$/);
  });

  it('is off when the VPS reports NinjaTrader not running and nothing has ever been sampled', () => {
    // The bulb's answer to "is NinjaTrader up" for a paired VPS that has sent
    // no sample, which is the shape of most of the desk today.
    const view = bulb([], [device({ healthStatus: 'error', lastErrorCode: 'ninjatrader_not_running' })]);
    expect(view.state).toBe('off');
    expect(view.tone).toBe('off');
    expect(view.word).toBe('Off');
    expect(view.sentence).toBe('Off, NinjaTrader not running.');
    expect(view.title).toBe('Client A: Off, NinjaTrader not running.');
  });

  it('is silent, amber, when every sample is stale and the VPS reports nothing wrong', () => {
    const view = bulb([silent('ACC 01'), silent('ACC 02')]);
    expect(view.state).toBe('silent');
    expect(view.tone).toBe(BULB_TONES.silent);
    expect(view.tone).not.toBe(BULB_TONES.off);
    expect(view.word).toBe('Silent');
    expect(view.sentence).toBe('Silent, no sample for 42 minutes.');
    expect(view.counts.silent).toBe(2);
  });

  it('stays silent, not off, when the samples are hours old and the heartbeat is online with no error', () => {
    // Before the open and after the close: the sampler has not reported since
    // yesterday, the VPS is up. The data shows no lost connection, so no red.
    const fourteenHoursAgo = new Date(NOW.getTime() - 14 * 60 * 60_000).toISOString();
    const view = bulb(
      [silent('ACC 01', { sampledAt: fourteenHoursAgo }), silent('ACC 02', { sampledAt: fourteenHoursAgo })],
      [device({ healthStatus: 'online', lastErrorCode: null })],
    );
    expect(view.state).toBe('silent');
    expect(view.tone).not.toBe('off');
    expect(view.sentence).toBe('Silent, no sample for 14 hours.');
    expect(view.sentence).not.toMatch(/connection/);
  });

  it('is silent and names the VPS error when the samples are stale and the heartbeat reports a fault other than NinjaTrader down', () => {
    const view = bulb([silent('ACC 01')], [device({ healthStatus: 'error', lastErrorCode: 'capture_failed' })]);
    expect(view.state).toBe('silent');
    expect(view.sentence).toBe('Silent, no sample for 42 minutes, VPS reports capture failed.');
  });

  it('is off when every fresh account is disconnected', () => {
    expect(bulb([disconnected('ACC 01'), disconnected('ACC 02')]).sentence).toBe('Off, 2 accounts disconnected.');
    expect(bulb([disconnected('ACC 01')]).sentence).toBe('Off, 1 account disconnected.');
  });

  it('is off, naming both, when a fresh account is disconnected beside a silent one and none is live', () => {
    // The fresh sample is the evidence: it says disconnected, so red holds.
    const view = bulb([disconnected('ACC 01'), silent('ACC 02')]);
    expect(view.state).toBe('off');
    expect(view.sentence).toBe('Off, 1 disconnected, 1 silent.');
  });

  it('is never sampled when a VPS is paired and no account has ever been sampled', () => {
    const view = buildDeskClientLight(client('c-1', 'Client A', Array.from({ length: 45 }, (_, i) => `ACC ${i + 1}`)), {
      samples: [], devices: [device()], deviceAware: true, now: NOW, staleSeconds: 1500,
    });
    expect(view.state).toBe('never_sampled');
    expect(view.tone).toBe(BULB_TONES.never_sampled);
    expect(view.sentence).toBe('Never sampled, VPS paired, 45 accounts on the registry.');
  });

  it('has no VPS when there is no device and no sample, whatever the registry says', () => {
    const view = bulb([], []);
    expect(view.state).toBe('no_vps');
    expect(view.tone).toBe('none');
    expect(view.sentence).toBe('No VPS paired and no sample.');
  });

  it('does not count a revoked device as paired', () => {
    expect(bulb([], [device({ status: 'revoked', revokedAt: '2026-10-01T00:00:00.000Z' })]).state).toBe('no_vps');
  });
});

describe('without the devices (a role that cannot read them)', () => {
  it('derives never sampled from the registry alone, as the tile does', () => {
    const view = bulb([], null);
    expect(view.deviceAware).toBe(false);
    expect(view.state).toBe('never_sampled');
    expect(view.sentence).toBe('Never sampled, 2 accounts on the registry and no sample yet.');
  });

  it('has no VPS when there is no sample and nothing on the registry', () => {
    const view = buildDeskClientLight(client('c-1', 'Client A', []), { samples: [], devices: null, deviceAware: false, now: NOW, staleSeconds: 1500 });
    expect(view.state).toBe('no_vps');
  });

  it('still reads live, partly, silent and off from the samples', () => {
    expect(bulb([sample('ACC 01')], null).state).toBe('live');
    expect(bulb([sample('ACC 01'), disconnected('ACC 02')], null).state).toBe('partly');
    expect(bulb([silent('ACC 01')], null).state).toBe('silent');
    expect(bulb([disconnected('ACC 01')], null).state).toBe('off');
  });

  it('cannot see NinjaTrader without the device, so no sample and a registry is never sampled, not off', () => {
    expect(bulb([], null).state).toBe('never_sampled');
  });
});

describe('stale against fresh, with a fixed clock', () => {
  it('uses the tracker horizon: a sample just inside is fresh, one just past it is silent', () => {
    const inside = new Date(NOW.getTime() - 1499 * 1000).toISOString();
    const past = new Date(NOW.getTime() - 1501 * 1000).toISOString();
    expect(bulb([sample('ACC 01', { sampledAt: inside })]).state).toBe('live');
    const stale = bulb([sample('ACC 01', { sampledAt: past })]);
    expect(stale.state).toBe('silent');
    expect(stale.counts.silent).toBe(1);
  });

  it('honours a different horizon from the settings', () => {
    const view = bulb([sample('ACC 01', { sampledAt: STALE })], [device()], { staleSeconds: 3600 });
    expect(view.state).toBe('live');
  });
});

describe('the breakdown under a bulb: connections, then accounts', () => {
  it('groups the account pills by connection, no connection name last, and counts the connected', () => {
    const view = bulb([
      sample('ACC 03', { connectionName: 'Bluesky' }),
      disconnected('ACC 01', { connectionName: 'Bluesky' }),
      sample('ACC 02', { connectionName: 'Live' }),
      sample('ACC 04', { connectionName: null }),
      silent('ACC 05', { connectionName: 'Live' }),
    ]);
    expect(view.connections.map((group) => group.name)).toEqual(['Bluesky', 'Live', 'No connection name']);
    expect(view.connections.map((group) => group.accounts.map((pill) => pill.accountName))).toEqual([
      ['ACC 01', 'ACC 03'],
      ['ACC 02', 'ACC 05'],
      ['ACC 04'],
    ]);
    expect(view.connections[0].words).toBe('1 of 2 connected');
    expect(view.connections[1].words).toBe('1 of 2 connected, 1 silent');
    expect(view.connections[2].words).toBe('1 of 1 connected');
    expect(view.connections[2].hasName).toBe(false);
    // Each pill is the shared pill: the connection and the state in words.
    expect(view.connections[0].accounts[0]).toMatchObject({ accountName: 'ACC 01', connectionName: 'Bluesky', state: 'disconnected', label: 'Disconnected' });
    expect(view.connections[0].accounts[1]).toMatchObject({ connectionName: 'Bluesky', state: 'live', label: 'Live', runLabel: 'running' });
  });

  it('puts the registry accounts nobody has sampled in their own group, after the connections', () => {
    const view = buildDeskClientLight(client('c-1', 'Client A', ['ACC 01', 'ACC 02', 'ACC 03']), {
      samples: [sample('ACC 01')], devices: [device()], deviceAware: true, now: NOW, staleSeconds: 1500,
    });
    expect(view.connections.map((group) => group.name)).toEqual(['Live', 'Never sampled']);
    const never = view.connections[1];
    expect(never.neverSampled).toBe(true);
    expect(never.accounts.map((pill) => pill.accountName)).toEqual(['ACC 02', 'ACC 03']);
    expect(never.words).toBe('2 on the registry, no sample yet');
    expect(never.accounts[0]).toMatchObject({ state: 'never_sampled', label: 'Never sampled' });
  });

  it('leaves retired, failed and reserve registry accounts out, as the tiles do', () => {
    const entry = client('c-1', 'Client A', []);
    entry.accountRegistry = {
      'ACC 01': { accountName: 'ACC 01', status: 'Active' },
      'ACC 02': { accountName: 'ACC 02', status: 'Inactive' },
      'ACC 03': { accountName: 'ACC 03', status: 'Failed' },
    };
    const view = buildDeskClientLight(entry, { samples: [], devices: [device()], deviceAware: true, now: NOW, staleSeconds: 1500 });
    expect(view.counts.registry).toBe(1);
    expect(view.sentence).toBe('Never sampled, VPS paired, 1 account on the registry.');
  });

  it('groupByConnection is pure and keeps a group per name', () => {
    const groups = groupByConnection([
      { accountName: 'B', connectionName: 'Live', state: 'live' },
      { accountName: 'A', connectionName: 'Live', state: 'disconnected' },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].accounts.map((pill) => pill.accountName)).toEqual(['A', 'B']);
    expect(groups[0]).toMatchObject({ total: 2, live: 1, disconnected: 1, silent: 0 });
  });
});

describe('the order of the grid', () => {
  it('is off, then partly, then silent, then never sampled, then live, alphabetical inside each group', () => {
    const list = [
      { state: 'live', clientName: 'Zed' },
      { state: 'never_sampled', clientName: 'Maple Ridge' },
      { state: 'silent', clientName: 'Willow' },
      { state: 'off', clientName: 'Northwind' },
      { state: 'partly', clientName: 'Client B' },
      { state: 'live', clientName: 'Alder' },
      { state: 'silent', clientName: 'Elm' },
      { state: 'off', clientName: 'Client A' },
      { state: 'partly', clientName: 'Birch' },
    ].sort(compareBulbs);
    expect(list.map((entry) => `${entry.state}:${entry.clientName}`)).toEqual([
      'off:Client A', 'off:Northwind',
      'partly:Birch', 'partly:Client B',
      'silent:Elm', 'silent:Willow',
      'never_sampled:Maple Ridge',
      'live:Alder', 'live:Zed',
    ]);
  });
});

describe('the whole desk', () => {
  const CLIENTS = [
    client('c-live', 'Green Oak', ['G-1']),
    client('c-partly', 'Amber Pine', ['A-1', 'A-2']),
    client('c-off', 'Red Cedar', ['R-1']),
    client('c-silent', 'Silent Elm', ['S-1']),
    // A paired VPS whose heartbeat says NinjaTrader is down, and no sample ever.
    client('c-down', 'Dark Fir', ['D-1']),
    client('c-never', 'Brown Elm', ['E-1', 'E-2']),
    client('c-none-1', 'Grey Birch', ['B-1']),
    client('c-none-2', 'Grey Ash', []),
  ];
  const SAMPLES = new Map([
    ['c-live', [sample('G-1')]],
    ['c-partly', [sample('A-1'), disconnected('A-2')]],
    ['c-off', [disconnected('R-1')]],
    ['c-silent', [silent('S-1')]],
  ]);
  const DEVICES = new Map([
    ['c-live', [device()]],
    ['c-partly', [device()]],
    ['c-off', [device()]],
    ['c-silent', [device()]],
    ['c-down', [device({ healthStatus: 'error', lastErrorCode: 'ninjatrader_not_running' })]],
    ['c-never', [device()]],
  ]);
  const tracker = (overrides = {}) => ({ available: true, staleSeconds: 1500, minAgentVersion: '1.2.0', samplesByClientId: SAMPLES, ...overrides });
  const devices = () => ({ available: true, byClientId: DEVICES });

  it('is one bulb per client with a VPS or a sample, the rest on one hidden line, in order', () => {
    const view = buildDeskClientLights({ clients: CLIENTS, tracker: tracker(), devices: devices(), now: NOW });
    expect(view.kind).toBe('ready');
    expect(view.deviceAware).toBe(true);
    expect(view.bulbs.map((entry) => `${entry.state}:${entry.clientName}`)).toEqual([
      'off:Dark Fir', 'off:Red Cedar', 'partly:Amber Pine', 'silent:Silent Elm', 'never_sampled:Brown Elm', 'live:Green Oak',
    ]);
    expect(view.hidden.map((entry) => entry.clientName)).toEqual(['Grey Ash', 'Grey Birch']);
    expect(view.counts).toEqual({ live: 1, partly: 1, silent: 1, off: 2, never_sampled: 1, only_retired: 0, no_vps: 2 });
    // Red on evidence only: the heartbeat for Dark Fir, the fresh disconnected sample for Red Cedar.
    expect(view.bulbs.find((entry) => entry.clientName === 'Dark Fir').sentence).toBe('Off, NinjaTrader not running.');
    expect(view.bulbs.find((entry) => entry.clientName === 'Red Cedar').sentence).toBe('Off, 1 account disconnected.');
    expect(view.bulbs.find((entry) => entry.clientName === 'Silent Elm').sentence).toBe('Silent, no sample for 42 minutes.');
  });

  it('says the counts and the latest sample in one line', () => {
    const view = buildDeskClientLights({ clients: CLIENTS, tracker: tracker(), devices: devices(), now: NOW });
    expect(view.ageMinutes).toBe(4);
    expect(view.words).toBe('1 live, 1 partly live, 1 silent, 2 off, 1 never sampled, 2 without a VPS. Latest sample 4m ago.');
    expect(deskWords({ live: 12, partly: 3, silent: 2, off: 1, never_sampled: 2, no_vps: 91 }, 2))
      .toBe('12 live, 3 partly live, 2 silent, 1 off, 2 never sampled, 91 without a VPS. Latest sample 2m ago.');
  });

  it('falls back to samples and registry when the devices are not readable', () => {
    const view = buildDeskClientLights({ clients: CLIENTS, tracker: tracker(), devices: null, now: NOW });
    expect(view.deviceAware).toBe(false);
    // Grey Birch has a registry and no sample: never sampled without the device; Grey Ash has nothing.
    // Dark Fir too: without the heartbeat nothing says NinjaTrader is down.
    expect(view.bulbs.map((entry) => `${entry.state}:${entry.clientName}`)).toEqual([
      'off:Red Cedar', 'partly:Amber Pine', 'silent:Silent Elm',
      'never_sampled:Brown Elm', 'never_sampled:Dark Fir', 'never_sampled:Grey Birch',
      'live:Green Oak',
    ]);
    expect(view.hidden.map((entry) => entry.clientName)).toEqual(['Grey Ash']);
    expect(buildDeskClientLights({ clients: CLIENTS, tracker: tracker(), devices: { available: false }, now: NOW }).deviceAware).toBe(false);
  });

  it('looks samples and devices up by the uuid first and the legacy id second', () => {
    const legacy = client('act-1700000000-northwind', 'Northwind', ['N-1'], { uuid: UUID });
    const view = buildDeskClientLights({
      clients: [legacy],
      tracker: tracker({ samplesByClientId: new Map([[UUID, [sample('N-1')]]]) }),
      devices: { available: true, byClientId: new Map([[UUID, [device()]]]) },
      now: NOW,
    });
    expect(view.bulbs).toHaveLength(1);
    expect(view.bulbs[0]).toMatchObject({ state: 'live', clientId: 'act-1700000000-northwind', clientKey: UUID });
    // The device alone decides between never sampled and no VPS, so it too must
    // be found by the uuid for a client the app names by its legacy key.
    const paired = buildDeskClientLights({
      clients: [legacy],
      tracker: tracker({ samplesByClientId: new Map() }),
      devices: { available: true, byClientId: new Map([[UUID, [device()]]]) },
      now: NOW,
    });
    expect(paired.kind).toBe('ready');
    expect(paired.bulbs.map((entry) => entry.state)).toEqual(['never_sampled']);
    expect(paired.hidden).toHaveLength(0);
    // And by the id when a client has no uuid.
    const plain = buildDeskClientLights({
      clients: [client('c-plain', 'Plain', ['P-1'])],
      tracker: tracker({ samplesByClientId: new Map([['c-plain', [sample('P-1')]]]) }),
      devices: { available: true, byClientId: new Map([['c-plain', [device()]]]) },
      now: NOW,
    });
    expect(plain.bulbs[0]).toMatchObject({ state: 'live', clientKey: 'c-plain' });
  });

  it('has the three honest empty states and is ready as soon as a VPS is paired', () => {
    expect(buildDeskClientLights({ clients: CLIENTS, tracker: null, now: NOW }).kind).toBe('unavailable');
    expect(buildDeskClientLights({ clients: CLIENTS, tracker: { available: false }, now: NOW }).kind).toBe('unavailable');
    expect(buildDeskClientLights({ clients: [], tracker: tracker(), now: NOW }).kind).toBe('no_clients');
    const empty = buildDeskClientLights({ clients: CLIENTS, tracker: tracker({ samplesByClientId: new Map() }), devices: null, now: NOW });
    expect(empty.kind).toBe('no_samples');
    expect(empty.minAgentVersion).toBe('1.2.0');
    const paired = buildDeskClientLights({ clients: CLIENTS, tracker: tracker({ samplesByClientId: new Map() }), devices: devices(), now: NOW });
    expect(paired.kind).toBe('ready');
    // With no sample anywhere, the one red bulb is the heartbeat that says NinjaTrader is down.
    expect(paired.words).toBe('0 live, 0 partly live, 0 silent, 1 off, 5 never sampled, 2 without a VPS. Latest sample never.');
    expect(paired.bulbs[0]).toMatchObject({ state: 'off', clientName: 'Dark Fir', sentence: 'Off, NinjaTrader not running.' });
  });
});

describe('the words beside every colour', () => {
  it('names every bulb tone in the legend, and red is only ever the off bulb', () => {
    expect(DESK_LEGEND.map((entry) => entry.state)).toEqual(['live', 'partly', 'silent', 'off', 'never_sampled', 'no_vps']);
    expect(DESK_LEGEND.map((entry) => entry.word)).toEqual(['Live', 'Partly live', 'Silent', 'Off', 'Never sampled', 'No VPS paired']);
    expect(BULB_WORDS.partly).toBe('Partly live');
    expect(BULB_WORDS.silent).toBe('Silent');
    expect(BULB_TONES.partly).not.toBe(BULB_TONES.off);
    expect(BULB_TONES.silent).not.toBe(BULB_TONES.off);
    expect(Object.values(BULB_TONES).filter((tone) => tone === 'off')).toEqual(['off']);
  });
});

/* ------------------------------------------------------------------------- *
 * A DEAD ACCOUNT NINJATRADER STILL LISTS.
 *
 * Measured in production: accounts the database marked Failed after the close
 * are still in NinjaTrader's Accounts tab, disconnected with nothing loaded,
 * so the VPS keeps sampling them. On the desk that made a bulb red ("Off, 1
 * account disconnected") about an account nobody expects to trade. Now such an
 * account is out of the pills and out of every count, and the drawer's folded
 * line says NinjaTrader still lists it. One that is still running stays.
 * ------------------------------------------------------------------------- */
describe('a retired account NinjaTrader still lists', () => {
  function withRegistry(registry) {
    return { ...client('c-1', 'Client A'), accountRegistry: registry };
  }
  const REGISTRY = {
    'ACC 01': { accountName: 'ACC 01', status: 'Active' },
    'ACC 06': { accountName: 'ACC 06', status: 'Failed' },
  };

  it('a Failed account sampled disconnected is no pill and no count, so it cannot turn the bulb red', () => {
    const view = buildDeskClientLight(withRegistry(REGISTRY), {
      samples: [sample('ACC 01'), disconnected('ACC 06', { runState: 'no_strategies', strategyCount: 0, enabledStrategyCount: 0 })],
      devices: [device()], deviceAware: true, now: NOW, staleSeconds: 1500,
    });
    expect(view.state).toBe('live');
    expect(view.counts).toMatchObject({ sampled: 1, live: 1, disconnected: 0 });
    expect(view.dots.map((pill) => pill.accountName)).toEqual(['ACC 01']);
    expect(view.notShown.sentence).toBe('Not shown: 1 retired: 1 Failed. 1 still listed by NinjaTrader, disconnected.');
    expect(view.notShown.accounts[0].word).toBe('Failed, still listed by NinjaTrader, disconnected');
    // Alone, it was "Off, 1 account disconnected"; now the bulb is what the device says.
    const alone = buildDeskClientLight(withRegistry({ 'ACC 06': REGISTRY['ACC 06'] }), {
      samples: [disconnected('ACC 06')], devices: [device()], deviceAware: true, now: NOW, staleSeconds: 1500,
    });
    expect(alone.state).not.toBe('off');
    expect(alone.counts.disconnected).toBe(0);
  });

  it('a Failed account sampled connected with nothing loaded is no pill either', () => {
    const view = buildDeskClientLight(withRegistry(REGISTRY), {
      samples: [sample('ACC 01'), sample('ACC 06', { runState: 'no_strategies', strategyCount: 0, enabledStrategyCount: 0 })],
      devices: [device()], deviceAware: true, now: NOW, staleSeconds: 1500,
    });
    expect(view.dots.map((pill) => pill.accountName)).toEqual(['ACC 01']);
    expect(view.notShown.accounts[0].word).toBe('Failed, still listed by NinjaTrader, connected, nothing loaded');
  });

  it('a Failed account still connected and running keeps its pill, with the marker in its title', () => {
    const view = buildDeskClientLight(withRegistry(REGISTRY), {
      samples: [sample('ACC 01'), sample('ACC 06')], devices: [device()], deviceAware: true, now: NOW, staleSeconds: 1500,
    });
    const marked = view.dots.find((pill) => pill.accountName === 'ACC 06');
    expect(marked).toMatchObject({ state: 'live', marked: true, markedWord: 'Marked Failed' });
    expect(marked.title).toContain('Marked Failed but still running.');
    expect(view.notShown).toBeNull();
  });

  it('an account the registry does not have keeps its pill as before, disconnected or not', () => {
    const view = buildDeskClientLight(withRegistry(REGISTRY), {
      samples: [sample('ACC 01'), disconnected('ACC 09')], devices: [device()], deviceAware: true, now: NOW, staleSeconds: 1500,
    });
    expect(view.dots.map((pill) => `${pill.accountName}:${pill.state}:${pill.inRegistry}`)).toEqual(['ACC 01:live:true', 'ACC 09:disconnected:false']);
    expect(view.state).toBe('partly');
  });
});

/* ------------------------------------------------------------------------- *
 * A VPS THAT SAMPLES ONLY RETIRED ACCOUNTS.
 *
 * The tile said "Only retired accounts sampled"; the desk did not. Without the
 * devices the client was folded into "without a VPS paired", with them its
 * bulb said "Never sampled, VPS paired, 0 accounts on the registry.", and a
 * desk where that was the only client said no collector sends samples at all.
 * The VPS IS sampling: every account it sends is retired and not running. The
 * fixture is the one the review found: ACC 41 marked Failed, sampled a few
 * minutes ago, not connected, nothing loaded.
 * ------------------------------------------------------------------------- */
describe('a VPS that samples only retired accounts', () => {
  const RETIRED = { 'ACC 41': { status: 'Failed' } };
  const dead = () => sample('ACC 41', { connected: false, status: 'Disconnected', runState: 'no_strategies', strategyCount: 0, enabledStrategyCount: 0 });
  const quiet = (registry = RETIRED) => ({ ...client('c-quiet', 'Quiet Larch'), accountRegistry: registry });
  const ONLY_RETIRED_SENTENCE = 'Only retired accounts sampled. NinjaTrader lists only accounts not expected to trade, in the line below.';

  it('without the devices, is its own bulb with the tile\'s word, never a client without a VPS', () => {
    const light = buildDeskClientLight(quiet(), { samples: [dead()], devices: null, deviceAware: false, now: NOW, staleSeconds: 1500 });
    expect(light).toMatchObject({ state: 'only_retired', tone: 'retired', word: 'Only retired accounts sampled', sentence: ONLY_RETIRED_SENTENCE });
    expect(light.title).toBe(`Quiet Larch: ${ONLY_RETIRED_SENTENCE}`);
    expect(light.counts).toMatchObject({ sampled: 0, retiredSampled: 1, disconnected: 0, registry: 0 });
    expect(light.dots).toEqual([]);
    // The folded line names what the VPS sends.
    expect(light.notShown.accounts.map((row) => `${row.accountName} ${row.word}`)).toEqual(['ACC 41 Failed, still listed by NinjaTrader, disconnected']);

    const view = buildDeskClientLights({ clients: [quiet()], tracker: { available: true, staleSeconds: 1500, samplesByClientId: new Map([['c-quiet', [dead()]]]) }, now: NOW });
    expect(view.kind).toBe('ready');
    expect(view.bulbs.map((entry) => entry.clientName)).toEqual(['Quiet Larch']);
    expect(view.hidden).toEqual([]);
    expect(view.counts).toMatchObject({ only_retired: 1, no_vps: 0, never_sampled: 0 });
    expect(view.words).toBe('0 live, 0 partly live, 0 silent, 0 off, 0 never sampled, 1 with only retired accounts sampled, 0 without a VPS. Latest sample 4m ago.');
  });

  it('with a paired VPS, says only retired accounts are sampled, not "Never sampled, VPS paired, 0 accounts on the registry"', () => {
    const light = buildDeskClientLight(quiet(), { samples: [dead()], devices: [device()], deviceAware: true, now: NOW, staleSeconds: 1500 });
    expect(light.state).toBe('only_retired');
    expect(light.sentence).toBe(ONLY_RETIRED_SENTENCE);
    expect(light.sentence).not.toMatch(/Never sampled|0 accounts/);
    // And with a VPS the fleet does not list (a device revoked since), the samples still prove one.
    expect(buildDeskClientLight(quiet(), { samples: [dead()], devices: [], deviceAware: true, now: NOW, staleSeconds: 1500 }).state).toBe('only_retired');
  });

  it('counts the expected accounts nobody sampled in its sentence, and lists them under the connections', () => {
    const light = buildDeskClientLight(quiet({ ...RETIRED, 'ACC 42': { status: 'Active' } }), { samples: [dead()], devices: null, deviceAware: false, now: NOW, staleSeconds: 1500 });
    expect(light.state).toBe('only_retired');
    expect(light.sentence).toBe('Only retired accounts sampled. 1 account on the registry, none sampled. NinjaTrader lists only accounts not expected to trade, in the line below.');
    expect(light.connections.map((group) => `${group.name}: ${group.accounts.map((pill) => pill.accountName).join(', ')}`)).toEqual(['Never sampled: ACC 42']);
  });

  it('is off when the heartbeat says NinjaTrader is down: evidence outranks a dead account\'s sample', () => {
    const light = buildDeskClientLight(quiet(), {
      samples: [dead()], devices: [device({ healthStatus: 'error', lastErrorCode: 'ninjatrader_not_running' })], deviceAware: true, now: NOW, staleSeconds: 1500,
    });
    expect(light.state).toBe('off');
  });

  it('sorts after never sampled and before live, and is named in the legend only by its own entry', () => {
    const lights = [
      buildDeskClientLight(client('c-live', 'Aspen', ['G-1']), { samples: [sample('G-1')], devices: null, deviceAware: false, now: NOW, staleSeconds: 1500 }),
      buildDeskClientLight(quiet(), { samples: [dead()], devices: null, deviceAware: false, now: NOW, staleSeconds: 1500 }),
      buildDeskClientLight(client('c-never', 'Zelkova', ['Z-1']), { samples: [], devices: null, deviceAware: false, now: NOW, staleSeconds: 1500 }),
    ];
    expect([...lights].sort(compareBulbs).map((entry) => entry.state)).toEqual(['never_sampled', 'only_retired', 'live']);
    expect(ONLY_RETIRED_LEGEND).toEqual({ state: 'only_retired', tone: 'retired', word: 'Only retired accounts sampled' });
    // Its look is its own: not the grey of no VPS, not an amber, never red.
    expect(BULB_TONES.only_retired).not.toBe(BULB_TONES.no_vps);
    expect(DESK_LEGEND.map((entry) => entry.tone)).not.toContain(BULB_TONES.only_retired);
  });
});
