// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AccountTrackerPanel from './AccountTrackerPanel';
import { ACCOUNT_TRACKER_STATES } from '../domain/autoCollectionFleet';
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
 * THE TRAFFIC LIGHT STRIP, which is what Pedro asked for: the tracker was right
 * and there was too much to read. One large dot per account with the name and
 * the state in words under it, before the rows; the rows behind "Details".
 * ------------------------------------------------------------------------- */
describe('the traffic light strip over the rows', () => {
  afterEach(cleanup);

  const three = () => tracker({
    accounts: [
      sample({ accountName: 'APEX-1' }),
      sample({ accountName: 'APEX-2', connected: false, status: 'ConnectionLost' }),
      sample({ accountName: 'APEX-3', sampledAt: '2026-10-05T13:00:00.000Z' }),
    ],
  });

  function strip(props = {}) {
    return render(<AccountTrackerPanel
      tracker={three()}
      device={device()}
      accountNames={['APEX-1', 'APEX-2', 'APEX-3', 'APEX-4']}
      disableAutoRefresh
      now={() => NOW}
      {...props}
    />);
  }

  it('shows one light per account, each with its name and its state in words', () => {
    const { container } = strip();
    const lights = [...container.querySelectorAll('.account-tracker-light')];
    expect(lights.map((light) => light.querySelector('.account-tracker-light-name').textContent))
      .toEqual(['APEX-1', 'APEX-2', 'APEX-3', 'APEX-4']);
    expect(lights.map((light) => light.querySelector('.account-tracker-light-state').textContent))
      .toEqual(['Live', 'Disconnected', 'Silent', 'Never sampled']);
    // The colour class and the word travel together on every light.
    expect(lights.map((light) => light.className))
      .toEqual([
        'account-tracker-light tracker-live',
        'account-tracker-light tracker-disconnected',
        'account-tracker-light tracker-sample_stale',
        'account-tracker-light tracker-never_sampled',
      ]);
    // The sentence is one hover away, on the light itself.
    expect(lights[1].getAttribute('title')).toContain('not connected to its broker');
  });

  it('shows the run state only under a current reading', () => {
    const { container } = strip();
    const runs = [...container.querySelectorAll('.account-tracker-light')]
      .map((light) => light.querySelector('.account-tracker-light-run')?.textContent ?? null);
    // Live and disconnected carry it; silent and never sampled do not.
    expect(runs).toEqual(['running', 'running', null, null]);
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
    expect(container.querySelectorAll('.account-tracker-light').length).toBe(4);
  });
});
