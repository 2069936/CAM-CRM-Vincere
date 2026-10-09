// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AccountTrackerPanel from './AccountTrackerPanel';
import { resetClientLiveStrategiesCache } from './useClientLiveStrategies';
import { resetAccountObservationSettingsCache } from './useAccountObservationSettings';
import { ACCOUNT_TRACKER_STATES } from '../domain/autoCollectionFleet';
import { historyWindowStart } from '../domain/disconnectedSince';
import AutoCollectionCard from './AutoCollectionCard';

/* WHAT A CAM MUST BE ABLE TO TELL APART WITHOUT LEAVING THE SCREEN.
 *
 * An account that is disconnected, an account whose VPS cannot be reached, an
 * account whose collector is too old to sample and an account nobody has ever
 * sampled are four different jobs. The assertions below are mostly about the
 * SENTENCES, because the sentence is what the desk acts on: a panel that got all
 * four dots right and printed one sentence for all of them would be worse than no
 * panel.
 */
const NOW = new Date('2026-10-05T15:00:00.000Z');

function sample(overrides = {}) {
  return {
    accountName: 'APEX-1',
    connectionName: 'Rithmic',
    connected: true,
    status: 'Connected',
    realizedPnl: 412.5,
    unrealizedPnl: -120,
    totalPnl: 292.5,
    strategyCount: 3,
    enabledStrategyCount: 2,
    runState: 'running',
    sampledAt: '2026-10-05T14:56:00.000Z',
    ...overrides,
  };
}

function tracker(overrides = {}) {
  return {
    staleSeconds: 1500,
    sampleIntervalSeconds: 600,
    minAgentVersion: '1.2.0',
    deviceHasSamples: true,
    accounts: [sample()],
    ...overrides,
  };
}

function device(overrides = {}) {
  return {
    id: 'device-1',
    status: 'active',
    healthStatus: 'online',
    agentVersion: '1.2.0',
    lastSeenAt: '2026-10-05T14:59:30.000Z',
    revokedAt: null,
    ...overrides,
  };
}

/* Named `markup` and not `render`: @testing-library's own `render` is imported
 * below for the refresh assertions, and a second binding of that name silently
 * won the hoist and turned every assertion in this file into a comparison
 * against an empty array. */
/* THE ROWS ARE OPENED FOR THESE ASSERTIONS. The panel now leads with a traffic
 * light strip and keeps the rows (every sentence) behind "Details", closed by
 * default; the describe at the end of this file holds the strip and the toggle
 * to account. Everything in between is about the sentences, so it asks for the
 * rows to be open and reads them as before. */
function markup(props = {}) {
  return renderToStaticMarkup(<AccountTrackerPanel
    tracker={tracker()}
    device={device()}
    accountNames={['APEX-1']}
    now={() => NOW}
    defaultDetailsOpen
    {...props}
  />);
}

describe('the four states, each with its own sentence on screen', () => {
  it('live: the state in words, the run state in words, and the age on the row', () => {
    const html = markup();
    expect(html).toContain('tracker-live');
    expect(html).toContain('Live');
    expect(html).toContain('running');
    expect(html).toContain('4m ago');
    expect(html).toContain('Sampled 4 minutes ago.');
    // $293 to the nearest dollar: the cents on a live number are noise.
    expect(html).toContain('$293');
  });

  it('disconnected: says the account is not connected and names the platform word', () => {
    const html = markup({ tracker: tracker({ accounts: [sample({ connected: false, status: 'ConnectionLost' })] }) });
    expect(html).toContain('tracker-disconnected');
    expect(html).toContain('not connected to its broker');
    expect(html).toContain('ConnectionLost');
  });

  it('the VPS cannot be reached: offline says heartbeats, silent says sampling', () => {
    const offline = markup({ device: device({ lastSeenAt: '2026-10-05T14:00:00.000Z' }) });
    expect(offline).toContain('tracker-offline');
    expect(offline).toContain('stopped reporting heartbeats');

    const silent = markup({ tracker: tracker({ accounts: [sample({ sampledAt: '2026-10-05T14:00:00.000Z' })] }) });
    expect(silent).toContain('tracker-sample_stale');
    expect(silent).toContain('Silent');
    // An hour at sixty minutes, not "60 minutes ago": the sentence is read by a
    // person, and the row's own `1h ago` says the same thing in the same words.
    expect(silent).toContain('1 hour ago');
    expect(silent).toContain('1h ago');
    // Two different sentences for two different jobs: one is the machine, one is
    // the sampling on a machine that is answering.
    expect(silent).not.toContain('stopped reporting heartbeats');
  });

  it('collector too old: names the sampling and says the close is unaffected', () => {
    /* deviceHasSamples FALSE, because the sentence is "this VPS runs a collector
     * build from before live sampling" and a reading from that same VPS - for this
     * account or any other - disproves it. The panel may only say this about a
     * machine that has sent nothing. */
    const html = markup({
      device: device({ agentVersion: '1.1.3' }),
      tracker: tracker({ accounts: [], deviceHasSamples: false }),
    });
    expect(html).toContain('tracker-tracker_unsupported');
    expect(html).toContain('before live sampling');
    expect(html).toContain('daily close is unaffected');
    // Not the collector card's own sentence, which is already on this page.
    expect(html).not.toContain('must be updated');
  });

  it('and NEVER says a collector is too old above a row it is sampling', () => {
    /* THE DEFECT, ON THE SCREEN. With min_agent_version unset - the value step 55
     * ships with - this panel said "No collector build sends live samples yet, so
     * nothing below is live" in its header and then printed a row saying Live, $293
     * and 4m ago directly beneath it. The same shape with an old version field said
     * "Collector too old to sample" about a machine whose reading was on the row. */
    const old = markup({ device: device({ agentVersion: '1.0.0' }) });
    expect(old).toContain('tracker-live');
    expect(old).not.toContain('before live sampling');

    const unnamed = markup({ tracker: tracker({ minAgentVersion: null }) });
    expect(unnamed).toContain('tracker-live');
    expect(unnamed).toContain('$293');
    expect(unnamed).not.toContain('tracker-tracker_off');
    // And the HEADING above those rows does not deny them either. It used to read
    // "nothing below is live" over a row that said Live.
    expect(unnamed).not.toContain('nothing below is live');
    expect(unnamed).toContain('A collector is already sampling, and no build is named yet');
    expect(unnamed).toContain('account_tracker_settings.min_agent_version');
  });

  it('never sampled: the registry account appears, rather than simply being absent', () => {
    /* An account the desk knows about and the VPS has never mentioned has to be
     * VISIBLE. A list built from the samples alone would show nothing at all,
     * which on screen reads as "this client has no accounts". */
    const html = markup({
      tracker: tracker({ accounts: [sample({ accountName: 'APEX-1' })], deviceHasSamples: true }),
      accountNames: ['APEX-1', 'APEX-2'],
    });
    expect(html).toContain('APEX-2');
    expect(html).toContain('tracker-never_sampled');
    expect(html).toContain('sampling other accounts and has never sent this one');
  });

  it('and a machine that has never sampled anything says that instead', () => {
    const html = markup({
      tracker: tracker({ accounts: [], deviceHasSamples: false }),
      accountNames: ['APEX-1'],
    });
    expect(html).toContain('no live sample of this account has ever arrived');
    expect(html).not.toContain('sampling other accounts');
  });

  it('shows an account the registry does not have yet, marked as new', () => {
    // NinjaTrader naming an account the registry has not classified is the
    // existing new-account flow; hiding it here would hide what starts it.
    const html = markup({ accountNames: [] });
    expect(html).toContain('APEX-1');
    expect(html).toContain('new</abbr>');
    expect(html).toContain('the registry does not have it yet');
  });
});

describe('the day this merges, with no collector sampling anywhere', () => {
  it('says the neutral true thing and names the column that turns it on', () => {
    const html = markup({ tracker: tracker({ minAgentVersion: null, accounts: [], deviceHasSamples: false }) });
    expect(html).toContain('No collector build sends live samples yet');
    expect(html).toContain('account_tracker_settings.min_agent_version');
    expect(html).toContain('tracker-tracker_off');
    expect(html).toContain('Not sampling yet');
  });

  it('distinguishes "step 55 has not run" from "nothing has been sampled"', () => {
    /* Two absences, two sentences. A panel that said "nothing sampled" about an
     * un-migrated CRM would send a CAM to look at a VPS that is fine. */
    const absent = renderToStaticMarkup(<AccountTrackerPanel tracker={null} device={device()} now={() => NOW} />);
    expect(absent).toContain('Migration step 55 has not been run');
    expect(absent).not.toContain('No collector build sends live samples yet');
  });
});

/* ── THE ROW ITSELF, IN EVERY STATE, BECAUSE THIS IS WHERE IT WAS VISIBLE ─────
 *
 * The domain test asserts that the two screens agree about the reading. This one
 * asserts the thing a CAM would have seen, which is narrower and more damning: the
 * row prints the money off `sample.totalPnl` and the age off `verdict.sampledAt`,
 * two different paths, so for `offline`, `revoked`, `paused` and `not_installed`
 * one line read
 *
 *   APEX-1   Offline   running-badge-suppressed   $1,024   never
 *
 * `never` beside `$1,024`, from a sample four minutes old. Measured through this
 * component before the fix, all four states.
 *
 * DRIVEN OFF ACCOUNT_TRACKER_STATES so it cannot go stale the way the last one
 * did: a state added to the classifier with no scenario here fails by name. */
describe('every state, rendered, with one readable sample in the table', () => {
  const scenarios = {
    live: {},
    disconnected: { tracker: tracker({ accounts: [sample({ connected: false, status: 'ConnectionLost' })] }) },
    sample_stale: { tracker: tracker({ accounts: [sample({ sampledAt: '2026-10-05T14:20:00.000Z' })] }) },
    // The four that were wrong, each with a four-minute-old sample sitting in the
    // table - which is the condition the committed cases never set up.
    offline: { device: device({ lastSeenAt: '2026-10-05T14:20:00.000Z' }) },
    revoked: { device: device({ status: 'revoked', revokedAt: '2026-10-04T00:00:00.000Z' }) },
    paused: { device: device({ status: 'paused' }) },
    not_installed: { device: null },
    // And the three where there is genuinely no reading, so `never` is correct and
    // no figure is printed either.
    tracker_off: { tracker: tracker({ accounts: [], deviceHasSamples: false, minAgentVersion: null }) },
    tracker_unsupported: {
      tracker: tracker({ accounts: [], deviceHasSamples: false }),
      device: device({ agentVersion: '1.0.0' }),
    },
    never_sampled: { tracker: tracker({ accounts: [], deviceHasSamples: true }) },
  };

  it('covers every state the classifier can return', () => {
    expect(Object.keys(scenarios).sort()).toEqual([...ACCOUNT_TRACKER_STATES].sort());
  });

  it('never prints a figure and "never" on the same row', () => {
    for (const [state, props] of Object.entries(scenarios)) {
      const html = markup(props);
      expect(html, state).toContain(`tracker-${state}`);
      const printsAFigure = html.includes('$293');
      if (printsAFigure) {
        /* The row is pricing a sample, so it knows when that sample was read. A
           screen cannot answer "never" about a row it is printing money from. */
        expect(html, `${state} prints $293 and "never"`).not.toContain('>never<');
        expect(html, `${state} age`).toMatch(/>(just now|\d+[mhd] ago)</);
      } else {
        // No reading, so "never" is the true answer and the panel says it.
        expect(html, `${state} has no figure, so it says never`).toContain('>never<');
      }
    }
  });

  it('keeps each state\'s own sentence, which is the half that is allowed to differ', () => {
    /* The reading travelling with the verdict must not have flattened the words.
       The machine not answering outranks the reading it left behind, and that is
       the one thing the client page says that the overview cannot. */
    expect(markup(scenarios.offline)).toContain('stopped reporting heartbeats');
    expect(markup(scenarios.revoked)).toContain('access was revoked');
    expect(markup(scenarios.paused)).toContain('intentionally paused');
    expect(markup(scenarios.not_installed)).toContain('No VPS is paired');
    // And none of them claims the sample is current, which would be the opposite
    // error: carrying the age must not turn an offline machine into a live one.
    for (const state of ['offline', 'revoked', 'paused', 'not_installed']) {
      expect(markup(scenarios[state]), state).not.toContain('Sampled 4 minutes ago');
    }
  });

  it('still refuses to show a run state for a machine that has stopped answering', () => {
    /* The run badge is shown only for `live` and `disconnected`, deliberately: a
       silent account's last known "running" is a claim about a machine that has
       stopped answering and the desk would read it as now. Carrying `runState`
       through on the verdict must not have switched that badge back on. */
    expect(markup(scenarios.live)).toContain('running');
    for (const state of ['offline', 'revoked', 'paused', 'not_installed', 'sample_stale']) {
      expect(markup(scenarios[state]), state).not.toMatch(/badge [a-z-]*">running</);
    }
  });
});

describe('what the panel refuses to print', () => {
  it('prints a different chip and a different tooltip for empty and unmeasured', () => {
    /* THE DEFECT, ON THE SCREEN. These two were one word, so an account the VPS had
     * measured and found empty got the chip "no strategy data" and the tooltip "the
     * sample carried no strategy count" - about a sample that carried (0, 0). Every
     * account on the fleet reports (0, 0) overnight and before the open. */
    const emptyHtml = markup({
      tracker: tracker({
        accounts: [sample({ runState: 'no_strategies', strategyCount: 0, enabledStrategyCount: 0 })],
      }),
    });
    expect(emptyHtml).toContain('none loaded');
    expect(emptyHtml).toContain('no strategies loaded at all');
    expect(emptyHtml).not.toContain('carried no strategy count');
    // Muted, not a warning: an account with nothing loaded is an ordinary morning.
    expect(emptyHtml).toMatch(/badge muted"[^>]*>none loaded</);

    const unknownHtml = markup({
      tracker: tracker({
        accounts: [sample({ runState: 'unmeasured', strategyCount: null, enabledStrategyCount: null })],
      }),
    });
    expect(unknownHtml).toContain('no strategy data');
    expect(unknownHtml).toContain('carried no strategy count');
    expect(unknownHtml).not.toContain('no strategies loaded at all');
    // A reading the desk did not get IS worth a second look.
    expect(unknownHtml).toMatch(/badge warning"[^>]*>no strategy data</);
  });

  it('prints no dash of any kind in the rows, in the text or in a title', () => {
    /* House rule: commas and periods, never an em dash, an en dash or a spaced
     * hyphen in anything the desk reads. The no figure tooltip said "Not
     * measured - not zero" and the age cell fell back to an em dash. */
    const html = markup({ tracker: tracker({ accounts: [sample({ totalPnl: null })] }) });
    expect(html).toContain('Not measured, not zero.');
    expect(html).not.toMatch(/—|–| - /);
    // The age fallback is unreachable through the classifier (an unreadable
    // clock is never sampled, which prints "never"), so the source is held to it.
    const source = readFileSync('src/components/AccountTrackerPanel.jsx', 'utf8');
    expect(source).not.toMatch(/['"`][^'"`\n]*[—–][^'"`\n]*['"`]/);
    expect(source).not.toMatch(/(title|label)="[^"\n]* - [^"\n]*"/);
  });

  it('never turns a missing P&L into a zero', () => {
    const html = markup({ tracker: tracker({ accounts: [sample({ totalPnl: null })] }) });
    expect(html).toContain('no figure');
    expect(html).not.toContain('$0');
  });

  it('never shows a run state for a reading that has gone stale', () => {
    /* A silent account's last known "running" is a claim about a machine that
     * has stopped answering, and the desk would read it as now. */
    const html = markup({
      tracker: tracker({ accounts: [sample({ sampledAt: '2026-10-05T13:00:00.000Z', runState: 'running' })] }),
    });
    expect(html).toContain('Silent');
    /* `[^>]*` because the chip carries a title attribute between its class and its
       text: `/badge success">running/` could never match this markup and was
       vacuously true whatever the panel did. */
    const RUN_CHIP = /badge success"[^>]*>running</;
    expect(html).not.toMatch(RUN_CHIP);
    // The positive control, so the negative above is known to have teeth: the same
    // pattern against a current reading DOES match.
    expect(markup()).toMatch(RUN_CHIP);
  });

  it('carries the state in words and not in a colour class alone', () => {
    // The existing strategy chips encode `enabled` in a colour class and nothing
    // else. Every state here is also a word a screen reader reads.
    for (const [props, word] of [
      [{}, 'Live'],
      [{ tracker: tracker({ accounts: [sample({ connected: false })] }) }, 'Disconnected'],
      [{ device: device({ lastSeenAt: '2026-10-01T00:00:00Z' }) }, 'Offline'],
      [{
        device: device({ agentVersion: '1.0.0' }),
        tracker: tracker({ accounts: [], deviceHasSamples: false }),
        accountNames: ['APEX-1'],
      }, 'Collector too old to sample'],
      [{ tracker: tracker({ accounts: [], deviceHasSamples: false }), accountNames: ['APEX-1'] }, 'Never sampled'],
    ]) {
      expect(markup(props), word).toContain(word);
    }
  });

  it('prints the sample interval from the settings rather than a literal', () => {
    expect(markup({ tracker: tracker({ sampleIntervalSeconds: 900 }) })).toContain('every 15 minutes');
    expect(markup({ tracker: tracker({ sampleIntervalSeconds: 600 }) })).toContain('every 10 minutes');
  });
});

describe('the collector card that hosts it', () => {
  function card(status, props = {}) {
    return renderToStaticMarkup(<AutoCollectionCard
      clientUuid="11111111-1111-4111-8111-111111111111"
      clientName="Gray Elm"
      initialStatus={status}
      disableAutoLoad
      api={{ loadStatus: () => new Promise(() => {}) }}
      {...props}
    />);
  }

  const paired = {
    serverTime: '2026-10-05T15:00:00.000Z',
    client: { uuid: '11111111-1111-4111-8111-111111111111', name: 'Gray Elm' },
    permissions: { generate: true, rebind: true, revoke: true },
    release: { url: 'https://downloads.example.test/agent.msi', version: '1.2.0', sha256: 'a'.repeat(64) },
    device: {
      id: 'device-1', status: 'active', healthStatus: 'online', agentVersion: '1.2.0',
      revokedAt: null, createdAt: '2026-01-04T12:00:00Z', lastSeenAt: '2026-10-05T14:59:30.000Z',
      schedule: { time: '16:30:00', timezone: 'America/New_York' },
    },
    enrollment: null,
    lastBatch: { tradingDate: '2026-10-03', status: 'processed', rowCounts: { accounts: 5 } },
    accountTracker: tracker(),
  };

  it('shows the tracker for a paired client', () => {
    const html = card(paired, { accountNames: ['APEX-1'] });
    expect(html).toContain('Live accounts');
    expect(html).toContain('APEX-1');
  });

  it('shows nothing at all for a client with no VPS', () => {
    // A client with no VPS has nothing to sample, and the card above the tracker
    // already says so in its own words.
    const html = card({ ...paired, device: null, accountTracker: null });
    expect(html).not.toContain('Live accounts');
    expect(html).not.toContain('Migration step 55');
  });

  it('does not put the tracker into the header flag badge', () => {
    /* The badge is derived from collectorFlags, which reads the device, the
     * release and the last batch. Adding the tracker to it would put a red
     * triangle beside thirty client names on the day step 55 is run, about a
     * feature nobody has deployed yet. */
    const flags = card({ ...paired, accountTracker: tracker({ minAgentVersion: null, accounts: [], deviceHasSamples: false }) });
    expect(flags).toContain('No collector build sends live samples yet');
    expect(flags).not.toContain('collector-flag');
  });
});

describe('the panel refreshes itself, because a frozen age is not a tracker', () => {
  /* The card around it deliberately never reloads on a timer: only the POST
   * response carries a pairing code in plaintext, so a reload loses a code the
   * CAM is in the middle of using, and the card's clock therefore only ticks
   * while that code counts down. On a paired client that means never. These
   * assertions are the reason this panel asks the endpoint again on its own. */
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  function mount({ loadStatus, ...props } = {}) {
    return render(<AccountTrackerPanel
      clientUuid="11111111-1111-4111-8111-111111111111"
      tracker={tracker()}
      device={device()}
      accountNames={['APEX-1']}
      api={{ loadStatus: loadStatus || (() => new Promise(() => {})) }}
      refreshMs={1000}
      now={() => NOW}
      defaultDetailsOpen
      {...props}
    />);
  }

  it('takes the newer reading and moves its own clock with it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T15:10:00.000Z'));
    const loadStatus = vi.fn(async () => ({
      device: device({ lastSeenAt: '2026-10-05T15:09:30.000Z' }),
      accountTracker: tracker({ accounts: [sample({ sampledAt: '2026-10-05T15:06:00.000Z', totalPnl: 900 })] }),
    }));
    const { container } = mount({ loadStatus });
    // Seeded from the card: four minutes old against the handed-in clock.
    expect(container.textContent).toContain('4m ago');
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    expect(loadStatus).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('4m ago');
    expect(container.textContent).toContain('$900');
    expect(container.textContent).toContain('Live');
  });

  it('does NOT age the last reading when the refresh fails', async () => {
    /* Advancing the clock on a failure would report Silent about a machine that
     * is sampling perfectly and a CRM that simply could not be reached: a fault
     * on our side turned into a fault on the desk's. */
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T16:30:00.000Z'));
    const loadStatus = vi.fn(async () => { throw new Error('offline'); });
    const { container } = mount({ loadStatus });
    await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
    expect(loadStatus).toHaveBeenCalled();
    expect(container.textContent).toContain('4m ago');
    expect(container.textContent).toContain('Live');
    expect(container.textContent).not.toContain('Silent');
    // And no error of its own anywhere: the card reports its failures in its own
    // words and a courtesy panel is not worth a second one.
    expect(container.textContent).not.toMatch(/could not|failed|error/i);
  });

  it('asks nothing at all when it has no client, or when refreshing is off', async () => {
    vi.useFakeTimers();
    const loadStatus = vi.fn(async () => ({ accountTracker: tracker(), device: device() }));
    mount({ loadStatus, clientUuid: '' });
    mount({ loadStatus, disableAutoRefresh: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
    expect(loadStatus).not.toHaveBeenCalled();
  });

  it('never touches anything else on the card', async () => {
    // It keeps the tracker and the device out of the answer and nothing else, so
    // a pairing code the card is holding cannot be lost by a refresh of this.
    vi.useFakeTimers();
    const body = {
      accountTracker: tracker(),
      device: device(),
      enrollment: { id: 'e1', code: 'MUST-NOT-BE-READ' },
      release: { version: '9.9.9' },
    };
    const loadStatus = vi.fn(async () => body);
    const { container } = mount({ loadStatus });
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    expect(container.textContent).not.toContain('MUST-NOT-BE-READ');
    expect(container.textContent).not.toContain('9.9.9');
    // And it took the tracker OUT of the body rather than keeping the body: a
    // panel holding the whole answer would read `fresh.tracker` as undefined and
    // claim step 55 had not been run.
    expect(container.textContent).toContain('APEX-1');
    expect(container.textContent).not.toContain('Migration step 55');
  });
});

/* ------------------------------------------------------------------------- *
 * THE STRIP OF PILLS, which is what Pedro asked for: the tracker was right and
 * there was too much to read. One pill per account with the name, the
 * connection and the state in words, before the rows; the rows behind
 * "Details"; and a click on a pill opens what that account is running.
 * ------------------------------------------------------------------------- */
describe('the strip of pills over the rows', () => {
  afterEach(() => { cleanup(); resetClientLiveStrategiesCache(); });

  const three = () => tracker({
    accounts: [
      sample({ accountName: 'APEX-1' }),
      sample({ accountName: 'APEX-2', connected: false, status: 'ConnectionLost', connectionName: 'Bluesky' }),
      sample({ accountName: 'APEX-3', sampledAt: '2026-10-05T13:00:00.000Z', connectionName: null }),
    ],
  });

  function strip(props = {}) {
    return render(<AccountTrackerPanel
      clientUuid="11111111-1111-4111-8111-111111111111"
      clientName="Gray Elm"
      tracker={three()}
      device={device()}
      accountNames={['APEX-1', 'APEX-2', 'APEX-3', 'APEX-4']}
      disableAutoRefresh
      now={() => NOW}
      loadStrategies={() => new Promise(() => {})}
      {...props}
    />);
  }

  const pills = (container) => [...container.querySelectorAll('.account-pill')];
  const part = (pill, name) => pill.querySelector(`.account-pill-${name}`)?.textContent ?? null;

  it('shows one pill per account, each with its name, its connection and its state in words', () => {
    const { container } = strip();
    const lights = pills(container);
    expect(lights.map((light) => part(light, 'name'))).toEqual(['APEX-1', 'APEX-2', 'APEX-3', 'APEX-4']);
    expect(lights.map((light) => part(light, 'connection'))).toEqual(['Rithmic', 'Bluesky', 'No connection name', 'No connection name']);
    expect(lights.map((light) => light.querySelector('.account-pill-connection').className)).toEqual([
      'account-pill-connection', 'account-pill-connection', 'account-pill-connection absent', 'account-pill-connection absent',
    ]);
    expect(lights.map((light) => part(light, 'state'))).toEqual(['Live', 'Disconnected', 'Silent', 'Never sampled']);
    // The colour class and the word travel together on every pill.
    expect(lights.map((light) => light.className))
      .toEqual([
        'account-pill tracker-live tone-live',
        'account-pill tracker-disconnected tone-attention',
        'account-pill tracker-sample_stale tone-attention',
        'account-pill tracker-never_sampled tone-faint',
      ]);
    // The sentence is one hover away, on the pill itself, with the connection.
    const title = lights[1].querySelector('button').getAttribute('title');
    expect(title).toContain('APEX-2: Disconnected.');
    expect(title).toContain('Connection Bluesky.');
    expect(title).toContain('not connected to its broker');
    // With the device in hand the never sampled sentence is the one that names the VPS.
    expect(lights[3].querySelector('button').getAttribute('title')).toContain('sampling other accounts and has never sent this one');
  });

  it('shows the run state only under a current reading', () => {
    const { container } = strip();
    const runs = pills(container).map((light) => part(light, 'run'));
    // Live and disconnected carry it; silent and never sampled do not.
    expect(runs).toEqual(['running', 'running', null, null]);
  });

  it('says when it was updated and, when refreshing, how often', () => {
    const { container } = strip();
    expect(container.querySelector('.account-tracker-head .live-refresh').textContent).toMatch(/^Updated .*\.$/);
    expect(container.querySelector('.live-refresh').textContent).not.toContain('refreshes');
    cleanup();
    const live = strip({ disableAutoRefresh: false, refreshMs: 120_000, api: { loadStatus: () => new Promise(() => {}) } });
    expect(live.container.querySelector('.live-refresh').textContent).toContain('refreshes every 2 min.');
  });

  it('keeps the rows behind Details, closed by default, and every sentence comes back on a click', () => {
    const { container, getByRole } = strip();
    expect(container.querySelector('.account-tracker-rows')).toBeNull();
    expect(container.textContent).not.toContain('Sampled 4 minutes ago.');
    const toggle = getByRole('button', { name: /^Details/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('4 accounts');
    act(() => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelectorAll('.account-tracker-row').length).toBe(4);
    expect(container.textContent).toContain('Sampled 4 minutes ago.');
    expect(container.textContent).toContain('not connected to its broker');
    expect(container.textContent).toContain('last sampled this account 2 hours ago');
    act(() => { toggle.click(); });
    expect(container.querySelector('.account-tracker-rows')).toBeNull();
  });

  it('opens the rows from the start when asked to', () => {
    const { container } = strip({ defaultDetailsOpen: true });
    expect(container.querySelectorAll('.account-tracker-row').length).toBe(4);
    // The strip is still there above them: the picture is not an alternative to the rows.
    expect(container.querySelectorAll('.account-pill').length).toBe(4);
  });
});

/* ------------------------------------------------------------------------- *
 * CLICK AN ACCOUNT TO SEE WHAT IT IS RUNNING.
 * ------------------------------------------------------------------------- */
describe('what an account is running, under its pill', () => {
  afterEach(() => { cleanup(); resetClientLiveStrategiesCache(); });

  const CLIENT_UUID = '11111111-1111-4111-8111-111111111111';
  const CYCLE = '2026-10-05T14:50:00.000Z';

  function strategyRow(accountName, overrides = {}) {
    return {
      clientId: CLIENT_UUID,
      accountName,
      strategyId: '1',
      strategyName: '0 - OGX-PF-2.4',
      algorithm: 'OGX_PF',
      instrument: 'MNQ 12-26',
      instrumentRoot: 'MNQ',
      realizedPnl: -950,
      unrealizedPnl: -50,
      restartedAt: null,
      sampledAt: '2026-10-05T14:50:02.000Z',
      cycleStart: CYCLE,
      ...overrides,
    };
  }

  function answer(rows) {
    return {
      available: true,
      clientId: CLIENT_UUID,
      desk: {
        available: true, cycleStart: CYCLE, filling: false, scope: 'rest_of_desk',
        cohorts: [{ algorithm: 'OGX_PF', instrumentRoot: 'MNQ', status: 'compared', nAccounts: 12, nClients: 8, median: -500, spread: 100, nFlat: 0 }],
      },
      rows,
      settings: { minCohortAccounts: 5, minCohortClients: 3, differsAtSpread: 3, minSpreadDollars: 50, cycleSeconds: 600, fallback: false },
    };
  }

  function panel(props = {}) {
    return render(<AccountTrackerPanel
      clientUuid={CLIENT_UUID}
      clientName="Gray Elm"
      tracker={tracker({ accounts: [sample({ accountName: 'APEX-1' }), sample({ accountName: 'APEX-2', connectionName: 'Bluesky' })] })}
      device={device()}
      accountNames={['APEX-1', 'APEX-2']}
      disableAutoRefresh
      now={() => NOW}
      {...props}
    />);
  }

  it('reads what the client is running once, for this client, and marks the pill whose algorithm differs before any click', async () => {
    const loadStrategies = vi.fn(async () => answer([strategyRow('APEX-1'), strategyRow('APEX-2', { realizedPnl: -480, unrealizedPnl: 0 })]));
    const { container } = panel({ loadStrategies });
    await waitFor(() => expect(loadStrategies).toHaveBeenCalledTimes(1));
    expect(loadStrategies).toHaveBeenCalledWith({ clientId: CLIENT_UUID });
    await waitFor(() => expect(container.querySelectorAll('.account-pill.differs').length).toBe(1));
    const marked = container.querySelector('.account-pill.differs');
    expect(marked.getAttribute('data-account')).toBe('APEX-1');
    expect(marked.querySelector('.account-pill-mark')).not.toBeNull();
    expect(marked.querySelector('button').getAttribute('title')).toContain('1 algorithm differs from the desk.');
    expect(marked.className).toBe('account-pill tracker-live tone-live differs');
    expect(container.querySelector('.account-live-detail')).toBeNull();
  });

  it('expands one account at a time with its totals and its strategy rows', async () => {
    const loadStrategies = vi.fn(async () => answer([strategyRow('APEX-1'), strategyRow('APEX-2', { realizedPnl: -480, unrealizedPnl: 0 })]));
    const { container } = panel({ loadStrategies });
    await waitFor(() => expect(loadStrategies).toHaveBeenCalledTimes(1));
    const [one, two] = [...container.querySelectorAll('.account-pill-button')];
    act(() => { one.click(); });
    expect(one.getAttribute('aria-expanded')).toBe('true');
    const detail = container.querySelector('.account-live-detail');
    expect(detail).not.toBeNull();
    expect(one.getAttribute('aria-controls')).toBe(detail.getAttribute('id'));
    expect(detail.querySelector('strong').textContent).toBe('APEX-1');
    expect(detail.querySelector('.account-live-detail-connection').textContent).toBe('Connection Rithmic');
    // The account totals, from the tracker sample: 412.5 realized, -120 open, 292.5 total, 2 of 3 strategies.
    const values = [...detail.querySelectorAll('.account-live-detail-totals dd')].map((dd) => dd.textContent);
    expect(values.slice(0, 4)).toEqual(['$413', '-$120', '$293', '2 of 3 strategies enabled']);
    // The strategy row, with the three figures and the amber chip.
    const row = detail.querySelector('.account-live-strategy');
    expect(row.textContent).toContain('OGX_PF');
    expect(row.textContent).toContain('MNQ 12-26');
    expect(row.textContent).toContain('realized -$950');
    expect(row.textContent).toContain('open -$50');
    expect(row.textContent).toContain('total -$1,000');
    expect(row.querySelector('.account-live-strategy-differs').textContent).toBe('Differs from the desk');
    expect(row.textContent).toContain('Differs from the desk by $500, 5 times the usual spread.');

    act(() => { two.click(); });
    expect(one.getAttribute('aria-expanded')).toBe('false');
    expect(two.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelectorAll('.account-live-detail').length).toBe(1);
    expect(container.querySelector('.account-live-detail strong').textContent).toBe('APEX-2');
    expect(container.querySelector('.account-live-detail').textContent).toContain('Within the usual spread of the desk');
    expect(container.querySelector('.account-live-strategy-differs')).toBeNull();
    expect(loadStrategies).toHaveBeenCalledTimes(1);

    act(() => { two.click(); });
    expect(container.querySelector('.account-live-detail')).toBeNull();
  });

  it('says it could not read what is running inside the detail, keeps the totals, and raises no banner', async () => {
    const loadStrategies = vi.fn(async () => { throw new Error('timeout'); });
    const { container } = panel({ loadStrategies });
    await waitFor(() => expect(loadStrategies).toHaveBeenCalledTimes(1));
    act(() => { container.querySelector('.account-pill-button').click(); });
    const detail = container.querySelector('.account-live-detail');
    expect(detail.querySelector('.account-live-detail-failed').textContent).toBe('Could not read what is running.');
    expect(detail.textContent).toContain('$293');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelectorAll('.account-pill.differs').length).toBe(0);
  });

  it('refreshes the rows on the same cadence as the tracker while the panel is live', async () => {
    vi.useFakeTimers();
    try {
      const loadStrategies = vi.fn(async () => answer([strategyRow('APEX-1')]));
      panel({
        loadStrategies,
        disableAutoRefresh: false,
        refreshMs: 1_000,
        api: { loadStatus: async () => ({ accountTracker: tracker(), device: device() }) },
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(loadStrategies).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
      expect(loadStrategies).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the strategy rows on screen and says the refresh failed when a later read rejects', async () => {
    /* The first read answers with rows; the refresh two minutes later rejects.
     * The rows must stay (they are the last good answer, and the pill keeps its
     * marker from them) and the failure is one muted line under them, never a
     * banner and never "could not read", which would deny the rows above it. */
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const loadStrategies = vi.fn()
        .mockResolvedValueOnce(answer([strategyRow('APEX-1')]))
        .mockRejectedValue(new Error('timeout'));
      const { container } = panel({
        loadStrategies,
        disableAutoRefresh: false,
        refreshMs: 120_000,
        // The panel's own tracker refresh never answers here: this is about the rows.
        api: { loadStatus: () => new Promise(() => {}) },
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(loadStrategies).toHaveBeenCalledTimes(1);
      act(() => { container.querySelector('.account-pill-button').click(); });
      expect(container.querySelectorAll('.account-live-strategy').length).toBe(1);
      expect(container.querySelector('.account-live-detail-failed')).toBeNull();

      await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
      expect(loadStrategies).toHaveBeenCalledTimes(2);
      expect(container.querySelectorAll('.account-live-strategy').length).toBe(1);
      expect(container.querySelector('.account-live-strategy').textContent).toContain('total -$1,000');
      expect(container.querySelector('.account-live-detail-failed').textContent).toBe('Could not refresh what is running. The rows are the last answer.');
      expect(container.querySelector('[role="alert"]')).toBeNull();
      // The pill keeps the marker the last answer gave it.
      expect(container.querySelectorAll('.account-pill.differs').length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ------------------------------------------------------------------------- *
 * ONLY THE ACCOUNTS EXPECTED TO TRADE GET A PILL ON THE CLIENT PAGE.
 *
 * Pedro's words: dead accounts piled up on the client page as never sampled.
 * The strip now takes the registry itself (with what the closes saw of each
 * row) and lights the expected accounts only; a new one says so; the rest is
 * one folded line under the pills. Fictional registry.
 * ------------------------------------------------------------------------- */
describe('only the accounts expected to trade get a pill on the client page', () => {
  afterEach(() => { cleanup(); resetClientLiveStrategiesCache(); resetAccountObservationSettingsCache(); });

  const observed = (accountName, over = {}) => [accountName, {
    accountName, status: 'Active', accountType: 'Funded', observedState: 'seen',
    closesMissed: 0, lastCloseSeenOn: '2026-10-04', dateAdded: '2026-06-01', ...over,
  }];
  const REGISTRY = Object.fromEntries([
    observed('ACC 01'),
    observed('ACC 02'),
    observed('ACC 03', { observedState: 'breached', breachedOn: '2026-10-04', breachReading: -263 }),
    observed('ACC 04', { observedState: 'absent', closesMissed: 6, lastCloseSeenOn: '2026-09-26' }),
    observed('ACC 05', { observedState: 'never_seen', lastCloseSeenOn: '', dateAdded: '2026-10-02' }),
    observed('ACC 06', { status: 'Failed' }),
  ]);
  const settingsNever = () => new Promise(() => {});

  function strip(props = {}) {
    return render(<AccountTrackerPanel
      clientUuid="22222222-2222-4222-8222-222222222222"
      clientName="Maple Ridge"
      tracker={tracker({ accounts: [sample({ accountName: 'ACC 01' })] })}
      device={device()}
      accountRegistry={REGISTRY}
      disableAutoRefresh
      now={() => NOW}
      loadStrategies={() => new Promise(() => {})}
      loadObservationSettings={settingsNever}
      {...props}
    />);
  }
  const names = (container) => [...container.querySelectorAll('.account-pill')]
    .map((pill) => `${pill.dataset.account}: ${pill.querySelector('.account-pill-state').textContent}`);

  it('shows the two seen and the new one, hides the failed, the gone and the retired, and says why in one folded line', () => {
    const { container, getByRole } = strip();
    expect(names(container)).toEqual(['ACC 01: Live', 'ACC 02: Never sampled', 'ACC 05: New, not sampled yet']);
    expect(getByRole('button', { name: /^Details/ }).textContent).toContain('3 accounts');
    const line = container.querySelector('.account-tracker .not-shown');
    expect(line.querySelector('.not-shown-words').textContent)
      .toBe('Not shown: 1 account looks failed, breached on the close. 1 gone from the close for 6 closes. 1 retired: 1 Failed.');
    expect(container.textContent).not.toContain('ACC 03');
    const toggle = line.querySelector('.not-shown-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    act(() => { toggle.click(); });
    expect([...line.querySelectorAll('.not-shown-list li')].map((item) => item.textContent))
      .toEqual(['ACC 03 looks failed', 'ACC 04 gone from the close', 'ACC 06 Failed']);
    // Under the pills, above the Details toggle.
    expect(container.querySelector('.account-pills').compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(line.compareDocumentPosition(container.querySelector('.account-tracker-details-toggle')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the new account says so on the pill, in its title with the VPS sentence, and on its row', () => {
    const { container, getByRole } = strip();
    const fresh = container.querySelector('.account-pill[data-account="ACC 05"]');
    expect(fresh.className).toBe('account-pill tracker-never_sampled tone-faint');
    const title = fresh.querySelector('button').getAttribute('title');
    expect(title).toContain('ACC 05: New, not sampled yet.');
    expect(title).toContain('Added 3 days ago, not seen in a close yet.');
    // With the device in hand, the sentence that names the VPS follows.
    expect(title).toContain('sampling other accounts and has never sent this one');
    act(() => { getByRole('button', { name: /^Details/ }).click(); });
    const rows = [...container.querySelectorAll('.account-tracker-row')];
    expect(rows.map((row) => `${row.querySelector('.account-tracker-name').textContent.trim()}: ${row.querySelector('.account-tracker-state').textContent}`))
      .toEqual(['ACC 01: Live', 'ACC 02: Never sampled', 'ACC 05: New, not sampled yet']);
    expect(rows[2].querySelector('.account-tracker-detail').textContent).toContain('Added 3 days ago, not seen in a close yet.');
  });

  it('keeps the plain names prop: every name is expected and nothing is folded', () => {
    const { container } = strip({ accountRegistry: null, accountNames: ['ACC 01', 'ACC 02'] });
    expect(names(container)).toEqual(['ACC 01: Live', 'ACC 02: Never sampled']);
    expect(container.querySelector('.not-shown')).toBeNull();
  });

  it('keeps a pill for an account the VPS sampled that the registry lacks, or that the close hid', () => {
    const { container } = strip({
      tracker: tracker({ accounts: [sample({ accountName: 'ACC 01' }), sample({ accountName: 'ACC 03' }), sample({ accountName: 'ACC 09' })] }),
      defaultDetailsOpen: true,
    });
    expect(names(container)).toEqual(['ACC 01: Live', 'ACC 02: Never sampled', 'ACC 03: Live', 'ACC 05: New, not sampled yet', 'ACC 09: Live']);
    // The registry's "new" abbreviation is for an account the registry lacks, and no other.
    const rows = [...container.querySelectorAll('.account-tracker-row')];
    expect(rows.filter((row) => row.querySelector('abbr')).map((row) => row.querySelector('.account-tracker-name').textContent.trim().replace(/\s+new$/, '')))
      .toEqual(['ACC 09']);
    expect(container.querySelector('.not-shown-words').textContent).toBe('Not shown: 1 gone from the close for 6 closes. 1 retired: 1 Failed.');
    // ACC 03 looks failed on the close and is connected and running: a question,
    // in words, on its pill. ACC 09 is simply not on the registry: no marker.
    const marked = container.querySelector('.account-pill[data-account="ACC 03"]');
    expect(marked.querySelector('.account-pill-marked').textContent).toBe('Looks failed');
    expect(marked.querySelector('button').getAttribute('title')).toContain('ACC 03: Live. Looks failed on the close but still running.');
    expect(container.querySelector('.account-pill[data-account="ACC 09"] .account-pill-marked')).toBeNull();
  });

  /* Measured in production: accounts marked Failed on last night's close are
   * still in NinjaTrader's Accounts tab, disconnected and empty, and the VPS
   * samples them. On the client page they were amber "Disconnected" pills and a
   * "1 disconnected" in the header. Now they are the folded line only. */
  it('a Failed account NinjaTrader still lists disconnected is no pill, no row and no count: the line says so', () => {
    const { container, getByRole } = strip({
      tracker: tracker({ accounts: [
        sample({ accountName: 'ACC 01' }),
        sample({ accountName: 'ACC 06', connected: false, status: 'Disconnected', runState: 'no_strategies', strategyCount: 0, enabledStrategyCount: 0 }),
      ] }),
      defaultDetailsOpen: true,
    });
    expect(names(container)).toEqual(['ACC 01: Live', 'ACC 02: Never sampled', 'ACC 05: New, not sampled yet']);
    expect(container.querySelector('.account-tracker-head strong').textContent).toBe('Live accounts · 1 running');
    expect(container.querySelector('.account-tracker-head strong').textContent).not.toContain('disconnected');
    expect([...container.querySelectorAll('.account-tracker-row')].map((row) => row.querySelector('.account-tracker-name').textContent.trim()))
      .toEqual(['ACC 01', 'ACC 02', 'ACC 05']);
    expect(getByRole('button', { name: /^Hide details/ })).toBeTruthy();
    const line = container.querySelector('.not-shown');
    expect(line.querySelector('.not-shown-words').textContent).toBe(
      'Not shown: 1 account looks failed, breached on the close. 1 gone from the close for 6 closes. 1 retired: 1 Failed. '
      + '1 still listed by NinjaTrader, disconnected.',
    );
    act(() => { line.querySelector('.not-shown-toggle').click(); });
    expect([...line.querySelectorAll('.not-shown-list li')].map((item) => item.textContent)).toContain('ACC 06 Failed, still listed by NinjaTrader, disconnected');
  });

  it('a Failed account still connected and running keeps its pill with "Marked Failed", and a connected one with nothing loaded does not', () => {
    const { container } = strip({
      tracker: tracker({ accounts: [
        sample({ accountName: 'ACC 01' }),
        sample({ accountName: 'ACC 06' }),
        sample({ accountName: 'ACC 03', runState: 'no_strategies', strategyCount: 0, enabledStrategyCount: 0 }),
      ] }),
    });
    expect(names(container)).toEqual(['ACC 01: Live', 'ACC 02: Never sampled', 'ACC 05: New, not sampled yet', 'ACC 06: Live']);
    const marked = container.querySelector('.account-pill[data-account="ACC 06"]');
    expect(marked.className).toBe('account-pill tracker-live tone-live marked');
    expect(marked.querySelector('.account-pill-marked').textContent).toBe('Marked Failed');
    expect(marked.querySelector('button').getAttribute('title')).toContain('Marked Failed but still running.');
    act(() => { container.querySelector('.not-shown-toggle').click(); });
    expect([...container.querySelectorAll('.not-shown-list li')].map((item) => item.textContent))
      .toEqual(['ACC 03 looks failed, still listed by NinjaTrader, connected, nothing loaded', 'ACC 04 gone from the close']);
  });

  it('an account the registry does not have keeps its pill and its "new" mark, disconnected or not', () => {
    const { container } = strip({
      tracker: tracker({ accounts: [sample({ accountName: 'ACC 01' }), sample({ accountName: 'ACC 09', connected: false, status: 'Disconnected' })] }),
      defaultDetailsOpen: true,
    });
    expect(names(container)).toContain('ACC 09: Disconnected');
    const row = [...container.querySelectorAll('.account-tracker-row')].find((node) => node.textContent.includes('ACC 09'));
    expect(row.querySelector('abbr').textContent.trim()).toBe('new');
  });

  it('with nothing expected and nothing sampled, says so and still folds the rest', () => {
    const { container } = strip({
      tracker: tracker({ accounts: [], deviceHasSamples: false }),
      accountRegistry: Object.fromEntries([REGISTRY['ACC 03'], REGISTRY['ACC 04']].map((meta) => [meta.accountName, meta])),
    });
    expect(container.querySelectorAll('.account-pill').length).toBe(0);
    expect(container.querySelector('.account-tracker-none').textContent).toBe('No account is expected on the close for this client and none has been sampled.');
    expect(container.querySelector('.not-shown-words').textContent).toBe('Not shown: 1 account looks failed, breached on the close. 1 gone from the close for 6 closes.');
    cleanup();
    const bare = strip({ tracker: tracker({ accounts: [], deviceHasSamples: false }), accountRegistry: {} });
    expect(bare.container.querySelector('.account-tracker-none').textContent).toBe('No account is registered for this client and none has been sampled.');
    expect(bare.container.querySelector('.not-shown')).toBeNull();
  });

  it('reads new_account_days and moves the line with it', async () => {
    const loadObservationSettings = vi.fn(async () => ({ available: true, staleCloses: 5, autoFailOnBreach: true, newAccountDays: 2 }));
    const { container } = strip({ loadObservationSettings });
    await waitFor(() => expect(container.querySelectorAll('.account-pill').length).toBe(2));
    expect(loadObservationSettings).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.not-shown-words').textContent).toContain('1 registered and never seen in a close, added more than 2 days ago');
  });

  it('the collector card hands the registry down to the strip', () => {
    const html = renderToStaticMarkup(<AutoCollectionCard
      clientUuid="22222222-2222-4222-8222-222222222222"
      clientName="Maple Ridge"
      accountRegistry={REGISTRY}
      disableAutoLoad
      api={{ loadStatus: () => new Promise(() => {}) }}
      initialStatus={{
        serverTime: '2026-10-05T15:00:00.000Z',
        client: { uuid: '22222222-2222-4222-8222-222222222222', name: 'Maple Ridge' },
        permissions: { generate: true, rebind: true, revoke: true },
        release: { url: 'https://downloads.example.test/agent.msi', version: '1.2.0', sha256: 'a'.repeat(64) },
        device: {
          id: 'device-1', status: 'active', healthStatus: 'online', agentVersion: '1.2.0',
          revokedAt: null, createdAt: '2026-01-04T12:00:00Z', lastSeenAt: '2026-10-05T14:59:30.000Z',
          schedule: { time: '16:30:00', timezone: 'America/New_York' },
        },
        enrollment: null,
        lastBatch: { tradingDate: '2026-10-03', status: 'processed', rowCounts: { accounts: 5 } },
        accountTracker: tracker({ accounts: [sample({ accountName: 'ACC 01' })] }),
      }}
    />);
    expect(html).toContain('data-account="ACC 05"');
    expect(html).toContain('New, not sampled yet');
    expect(html).not.toContain('data-account="ACC 03"');
    expect(html).toContain('Not shown: 1 account looks failed, breached on the close.');
  });

  it('prints no dash of any kind in the strip, the line or a title', () => {
    const { container } = strip();
    act(() => { container.querySelector('.not-shown-toggle').click(); });
    expect(container.textContent).not.toMatch(/—|–| - /);
    for (const node of container.querySelectorAll('[title]')) expect(node.getAttribute('title')).not.toMatch(/—|–| - /);
  });

  /* The review's fixture: ACC 41 is marked Failed, and the VPS still sends it,
   * a few minutes old, not connected, nothing loaded. The strip said "none has
   * been sampled" over a folded line that named a sampled account. */
  it('a VPS that sends only retired accounts: says so, with the folded line listing them, never "none has been sampled"', () => {
    const dead = sample({ accountName: 'ACC 41', connected: false, status: 'Disconnected', runState: 'no_strategies', strategyCount: 0, enabledStrategyCount: 0 });
    const { container } = strip({ tracker: tracker({ accounts: [dead] }), accountRegistry: { 'ACC 41': { status: 'Failed' } } });
    expect(container.querySelectorAll('.account-pill').length).toBe(0);
    expect(container.querySelector('.account-tracker-head strong').textContent).toBe('Live accounts · Only retired accounts sampled');
    expect(container.querySelector('.account-tracker-none').textContent).toBe('NinjaTrader lists only accounts not expected to trade, in the line below.');
    expect(container.textContent).not.toContain('none has been sampled');
    const line = container.querySelector('.not-shown');
    expect(line.querySelector('.not-shown-words').textContent).toBe('Not shown: 1 retired: 1 Failed. 1 still listed by NinjaTrader, disconnected.');
    act(() => { line.querySelector('.not-shown-toggle').click(); });
    expect([...line.querySelectorAll('.not-shown-list li')].map((item) => item.textContent)).toEqual(['ACC 41 Failed, still listed by NinjaTrader, disconnected']);
  });

  it('and with expected accounts nobody sampled, says it in the header over their pills', () => {
    const dead = sample({ accountName: 'ACC 41', connected: false, status: 'Disconnected', runState: 'no_strategies', strategyCount: 0, enabledStrategyCount: 0 });
    const { container } = strip({ tracker: tracker({ accounts: [dead] }), accountRegistry: { 'ACC 41': { status: 'Failed' }, 'ACC 42': { status: 'Active' } } });
    expect(names(container)).toEqual(['ACC 42: Never sampled']);
    expect(container.querySelector('.account-tracker-head strong').textContent).toBe('Live accounts · Only retired accounts sampled');
    // A strip with an expected account sampled says nothing of the kind.
    cleanup();
    const mixed = strip({ tracker: tracker({ accounts: [sample({ accountName: 'ACC 42' }), dead] }), accountRegistry: { 'ACC 41': { status: 'Failed' }, 'ACC 42': { status: 'Active' } } });
    expect(mixed.container.querySelector('.account-tracker-head strong').textContent).toBe('Live accounts · 1 running');
  });
});

/* ------------------------------------------------------------------------- *
 * "DISCONNECTED SINCE 09:40" ON THE CLIENT PAGE STRIP.
 *
 * The same history and the same rule as the overviews: read only while a pill
 * here is disconnected, once per tracker clock, from the viewer's midnight,
 * and said in the pill's title and in its detail. The word stays short.
 * ------------------------------------------------------------------------- */
describe('since when an account has been disconnected, on the client page strip', () => {
  afterEach(() => { cleanup(); resetClientLiveStrategiesCache(); resetAccountObservationSettingsCache(); });
  const UUID = '33333333-3333-4333-8333-333333333333';
  const dayStart = historyWindowStart(NOW).getTime();
  const clock = (hours, minutes) => new Date(dayStart + (hours * 60 + minutes) * 60_000).toISOString();
  const HISTORY = {
    available: true,
    rows: [
      { clientId: UUID, deviceId: 'device-1', accountName: 'APEX-1', connected: true, firstSampledAt: clock(6, 30), lastSampledAt: clock(9, 30) },
      { clientId: UUID, deviceId: 'device-1', accountName: 'APEX-1', connected: false, firstSampledAt: clock(9, 40), lastSampledAt: clock(10, 58) },
    ],
  };
  function strip(props = {}) {
    return render(<AccountTrackerPanel
      clientUuid={UUID}
      clientName="Cedar Row"
      tracker={tracker({ accounts: [sample({ connected: false, status: 'ConnectionLost' })] })}
      device={device()}
      accountNames={['APEX-1']}
      disableAutoRefresh
      now={() => NOW}
      loadStrategies={() => new Promise(() => {})}
      loadObservationSettings={() => new Promise(() => {})}
      {...props}
    />);
  }

  it('reads today\'s history for this client once, and says it in the disconnected pill\'s title and detail', async () => {
    const loadHistory = vi.fn(async () => HISTORY);
    const { container } = strip({ loadHistory });
    await waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(1));
    expect(loadHistory).toHaveBeenCalledWith({ clientIds: [UUID], since: new Date(dayStart).toISOString() });
    const button = () => container.querySelector('.account-pill[data-account="APEX-1"] button');
    await waitFor(() => expect(button().getAttribute('title')).toMatch(/^APEX-1: Disconnected since 09:40\. /));
    expect(container.querySelector('.account-pill[data-account="APEX-1"] .account-pill-state').textContent).toBe('Disconnected');
    act(() => { button().click(); });
    expect(container.querySelector('.account-live-detail-since').textContent).toBe('Disconnected since 09:40');
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(loadHistory).toHaveBeenCalledTimes(1);
  });

  it('reads nothing while no pill is disconnected', async () => {
    const loadHistory = vi.fn(async () => HISTORY);
    strip({ loadHistory, tracker: tracker({ accounts: [sample()] }) });
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(loadHistory).not.toHaveBeenCalled();
  });

  it('reads again when its own refresh moves the clock, and not otherwise', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    try {
      const loadHistory = vi.fn(async () => HISTORY);
      const api = { loadStatus: vi.fn(async () => ({ accountTracker: tracker({ accounts: [sample({ connected: false, status: 'ConnectionLost' })] }), device: device() })) };
      strip({ loadHistory, api, disableAutoRefresh: false, refreshMs: 60_000 });
      await vi.waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(1));
      // A re-render with the same clock reads nothing.
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(loadHistory).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      await vi.waitFor(() => expect(api.loadStatus).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it('says nothing when the history is not deployed or the read fails, and the pill stands', async () => {
    const failing = vi.fn(async () => { throw new Error('account_live_sample_history: timeout'); });
    const { container } = strip({ loadHistory: failing });
    await waitFor(() => expect(failing).toHaveBeenCalled());
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(container.querySelector('.account-pill[data-account="APEX-1"] button').getAttribute('title')).toMatch(/^APEX-1: Disconnected\. /);
    expect(container.textContent).not.toMatch(/timeout|could not/i);
  });
});

describe('the amber "Close differs" badge on the strip (step 66)', () => {
  it('marks the pill whose verdict asks for a look, by lower case account name, and no other', () => {
    const html = markup({
      tracker: tracker({ accounts: [sample(), sample({ accountName: 'APEX-2' })] }),
      accountNames: ['APEX-1', 'APEX-2'],
      closeVerdicts: new Map([['apex-1', 'differs'], ['apex-2', 'matches']]),
    });
    expect(html).toMatch(/data-account="APEX-1"[^>]*>(?:(?!<\/li>).)*account-pill-close-differs/s);
    expect(html).not.toMatch(/data-account="APEX-2"[^>]*>(?:(?!<\/li>).)*account-pill-close-differs/s);
    expect(html).toContain('Close differs: the realized figures differ.');
    expect(html.match(/account-pill-close-differs/g)).toHaveLength(1);
    // Without verdicts, nothing changes on the strip.
    expect(markup()).not.toContain('close-differs');
  });
});
