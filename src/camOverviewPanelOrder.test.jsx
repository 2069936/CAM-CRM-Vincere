// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* ------------------------------------------------------------------------- *
 * WHAT A CAM SEES FIRST, AND WHAT A CAM DOES NOT SEE AT ALL.
 *
 * Pedro's words, from the CAM's chair: the status light ("semáforo") should be
 * the first thing on the overview, for every client, as a picture; Revenue
 * health does not interest a CAM and should not be there; for a Manager the
 * order revenue, light, flags, coverage is fine, with revenue folded until
 * asked for.
 *
 * Asked of a RENDERED overview and its headings in DOM order, not of App.jsx
 * read as a string: this repo has shipped tests that passed against prose.
 * ------------------------------------------------------------------------- */

const mocks = vi.hoisted(() => ({
  loadSupabaseAccountTracker: vi.fn(),
  loadSupabaseTrackerCloseReadings: vi.fn(),
}));

vi.mock('./domain/supabaseStore', async (importOriginal) => ({
  ...(await importOriginal()),
  loadSupabaseAccountTracker: mocks.loadSupabaseAccountTracker,
  loadSupabaseTrackerCloseReadings: mocks.loadSupabaseTrackerCloseReadings,
}));

import { CamOverview } from './App';
import { todayIsoDate } from './domain/crmStateStore';

function client(id, name, accounts) {
  return {
    id,
    name,
    profile: { stage: 'Active', subscriptionPrice: '$250' },
    accountRegistry: Object.fromEntries(accounts.map((accountName) => [accountName, {
      accountName, accountType: 'Funded', status: 'Active',
    }])),
    dailyImports: [],
    tasks: [],
    activities: [],
  };
}

const BOOK = [
  client('c-1', 'Cedar Row', ['CR-1', 'CR-2']),
  client('c-2', 'Birch Lane', ['BL-1']),
];

function sample(accountName, overrides = {}) {
  return {
    accountName,
    connected: true,
    status: 'Connected',
    totalPnl: 50,
    runState: 'running',
    sampledAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    ...overrides,
  };
}

const TRACKER = {
  available: true,
  staleSeconds: 1500,
  minAgentVersion: '1.2.0',
  samplesByClientId: new Map([
    ['c-1', [sample('CR-1'), sample('CR-2', { connected: false, status: 'ConnectionLost' })]],
  ]),
};

function mount(props = {}) {
  return render(<CamOverview
    clients={BOOK}
    allClients={BOOK}
    camProfiles={[]}
    onSelectClient={vi.fn()}
    onAddClientTask={vi.fn()}
    onLogClientActivity={vi.fn()}
    onResolveFlag={vi.fn()}
    onClassifyAccount={vi.fn()}
    isManager={false}
    {...props}
  />);
}

const headings = (container) => [...container.querySelectorAll('h3')].map((node) => node.textContent.trim());

function indexOfHeading(container, text) {
  const list = headings(container);
  const index = list.findIndex((heading) => heading.startsWith(text));
  expect(index, `heading "${text}" is on the page; saw ${JSON.stringify(list)}`).toBeGreaterThanOrEqual(0);
  return index;
}

beforeEach(() => {
  mocks.loadSupabaseAccountTracker.mockReset();
  mocks.loadSupabaseAccountTracker.mockResolvedValue(TRACKER);
  mocks.loadSupabaseTrackerCloseReadings.mockReset();
  mocks.loadSupabaseTrackerCloseReadings.mockResolvedValue({ available: false, reason: 'not_deployed' });
});
afterEach(cleanup);

describe('the order of the panels for a CAM', () => {
  it('puts Live accounts first, then Open flags, then the rest as before', async () => {
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('.fsl-grid')).not.toBeNull());
    const live = indexOfHeading(container, 'Live accounts');
    const rollCall = indexOfHeading(container, 'Algorithm roll call');
    const close = indexOfHeading(container, 'Tracker against the close');
    const flags = indexOfHeading(container, 'Open flags');
    const coverage = indexOfHeading(container, 'Book coverage and mix');
    const feed = indexOfHeading(container, 'Insight Feed');
    const comparison = indexOfHeading(container, 'Each algorithm today, against the desk');
    // The roll call for the chat sits right under the light, before the flags
    // and well before the per account comparison it summarises.
    expect(rollCall).toBe(live + 1);
    // The tracker against today's close, right under the roll call and before the flags.
    expect(close).toBe(rollCall + 1);
    expect(close).toBeLessThan(flags);
    expect(rollCall).toBeLessThan(flags);
    expect(rollCall).toBeLessThan(comparison);
    expect(flags).toBeLessThan(coverage);
    expect(coverage).toBeLessThan(feed);
    // The first panel heading on the page is the light's.
    expect(headings(container)[0]).toBe('Live accounts');
  });

  it('opens the Live accounts panel by default, as a grid of tiles and not a sentence', async () => {
    const { container } = mount();
    await waitFor(() => expect(container.querySelectorAll('.fsl-tile').length).toBe(2));
    const toggle = [...container.querySelectorAll('.collapse-toggle')]
      .find((button) => button.textContent.includes('Live accounts'));
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    // Worst first: Cedar Row has a disconnected account, Birch Lane has no sample.
    expect([...container.querySelectorAll('.fsl-tile-name')].map((node) => node.textContent))
      .toEqual(['Cedar Row', 'Birch Lane']);
    expect(container.querySelector('.fsl-summary').textContent).toContain('2 accounts sampled: 1 running, 1 disconnected, across 1 of 2 clients.');
  });

  it('opens the roll call by default, as a region the CAM can paste from', async () => {
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('.fsl-grid')).not.toBeNull());
    const toggle = [...container.querySelectorAll('.collapse-toggle')]
      .find((button) => button.textContent.includes('Algorithm roll call'));
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await waitFor(() => expect(container.querySelector('.algorithm-rollcall')).not.toBeNull());
  });

  it('does not show Revenue health to a CAM at all', async () => {
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('.fsl-grid')).not.toBeNull());
    expect(headings(container)).not.toContain('Revenue health');
    expect(container.textContent).not.toContain('Total MRR');
  });

  it('no longer repeats the live count as a line of text in the header', async () => {
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('.fsl-grid')).not.toBeNull());
    const header = container.querySelector('.page-header');
    expect(header.textContent).not.toMatch(/live: \d+ of \d+ accounts/);
  });
});

describe('the order of the panels for a Manager', () => {
  it('keeps Revenue health first, folded, with Live accounts right after it and the flags after that', async () => {
    const { container } = mount({ isManager: true });
    await waitFor(() => expect(container.querySelector('.fsl-grid')).not.toBeNull());
    const revenue = indexOfHeading(container, 'Revenue health');
    const live = indexOfHeading(container, 'Live accounts');
    const flags = indexOfHeading(container, 'Open flags');
    expect(revenue).toBeLessThan(live);
    expect(live).toBeLessThan(flags);
    expect(headings(container)[0]).toBe('Revenue health');
    // Exactly one heading says Revenue health: the collapsible's, not a second one inside it.
    expect(headings(container).filter((heading) => heading === 'Revenue health').length).toBe(1);
  });

  it('renders Revenue health collapsed, and a click opens the figures', async () => {
    const { container } = mount({ isManager: true });
    await waitFor(() => expect(container.querySelector('.fsl-grid')).not.toBeNull());
    const toggle = [...container.querySelectorAll('.collapse-toggle')]
      .find((button) => button.textContent.includes('Revenue health'));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('Total MRR');
    act(() => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('Total MRR');
    // Still one heading: the body renders without a panel of its own.
    expect(headings(container).filter((heading) => heading === 'Revenue health').length).toBe(1);
  });
});

describe('the tracker against the close (step 66)', () => {
  const today = todayIsoDate();
  /* One reading pinned at today's close for Cedar Row, by the overview's own
   * fixture shape; `over` moves the figures so a case can make it differ. */
  const pinned = (accountName, over = {}) => ({
    id: 1, dailyImportId: 'imp-today', clientId: 'c-1', tradingDate: today, accountName, source: 'crm_history',
    connectionName: 'Live', connected: true, status: 'Connected', realizedPnl: 10, unrealizedPnl: 0, totalPnl: 10,
    strategyCount: 1, enabledStrategyCount: 1, runState: 'running', sampledAt: `${today}T20:30:00.000Z`,
    readingSince: `${today}T20:00:00.000Z`, resetSeen: false, nextSampledAt: null, strategies: [], closeBatchId: 'b',
    closeCapturedAt: `${today}T20:31:00.000Z`, closeTimeBasis: 'captured', graceSeconds: 120, staleSeconds: 1500,
    comparedAt: `${today}T20:31:05.000Z`,
    ...over,
  });
  const text = (node) => (node?.textContent || '').replace(/\s+/g, ' ').trim();

  it('reads today\'s pinned rows once for the working book, and names the migration when there are none to read', async () => {
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('.tracker-close-overview')).not.toBeNull());
    await waitFor(() => expect(container.textContent).toContain('Migration step 66 has not been run'));
    expect(mocks.loadSupabaseTrackerCloseReadings).toHaveBeenCalledTimes(1);
    expect(mocks.loadSupabaseTrackerCloseReadings).toHaveBeenCalledWith({ clientIds: ['c-1', 'c-2'], importIds: null, tradingDate: todayIsoDate() });
    expect(container.querySelectorAll('.tracker-close-verdict').length).toBe(0);
    const toggle = [...container.querySelectorAll('.collapse-toggle')]
      .find((button) => button.textContent.includes('Tracker against the close'));
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('moves the briefing close dot to uploaded when today\'s rows are pinned for a client this session has no close for, without a reload', async () => {
    mocks.loadSupabaseTrackerCloseReadings.mockResolvedValue({ available: true, readings: [pinned('CR-1'), pinned('CR-2')], settings: null });
    const { container } = mount();
    await waitFor(() => expect(container.textContent).toContain('after this session loaded'));
    // Cedar Row's close is pinned and not in this session; Birch Lane has nothing.
    const briefingToggle = [...container.querySelectorAll('.collapse-toggle, button')]
      .find((button) => button.textContent.includes("Today's briefing"));
    act(() => { briefingToggle.click(); });
    const cards = [...container.querySelectorAll('.briefing-card')];
    const cedar = cards.find((card) => card.textContent.includes('Cedar Row'));
    const birch = cards.find((card) => card.textContent.includes('Birch Lane'));
    expect(cedar.querySelector('.briefing-dot-uploaded')).not.toBeNull();
    expect(cedar.querySelector('.briefing-dot-uploaded').getAttribute('title')).toBe('Uploaded');
    expect(birch.querySelector('.briefing-dot-pending')).not.toBeNull();
    // The overview line says what happened and what to do, with no verdict invented.
    const line = container.querySelector('.tracker-close-line[data-client-id="c-1"]');
    expect(line.textContent).toMatch(/Close compared at \d\d:\d\d, after this session loaded\. Reload to see it\./);
    expect(container.querySelectorAll('.tracker-close-verdict').length).toBe(0);
  });

  it('puts the amber Close differs badge on the tile pill of the one account whose close differs today, and on no other pill', async () => {
    /* Cedar Row has today's close in the session: CR-1 closed at $200 and the
     * tracker was pinned at $340, so CR-1 differs; CR-2 is not in the close. The
     * verdicts the overview computed reach the Live accounts tiles through
     * CamOverview, so the badge sits on CR-1's pill and nowhere else. */
    const cedar = {
      ...BOOK[0],
      dailyImports: [{
        id: 'di-today', uuid: 'imp-today', clientId: 'c-1', date: today, status: 'Needs review',
        sourceSummary: { pnl_sources: { realized: 1 } },
        snapshots: [{ id: 'snap-cr1', accountName: 'CR-1', connection: 'Live', grossRealizedPnl: 200, unrealizedPnl: 0, strategies: [] }],
        strategies: [], simulation: {}, flags: [], snapshotsLoaded: true, detailLoaded: true,
      }],
    };
    const book = [cedar, BOOK[1]];
    mocks.loadSupabaseTrackerCloseReadings.mockResolvedValue({ available: true, readings: [pinned('CR-1', { realizedPnl: 340, totalPnl: 340 })], settings: null });
    const { container } = mount({ clients: book, allClients: book });
    await waitFor(() => expect(text(container.querySelector('.tracker-close-line[data-client-id="c-1"]'))).toContain('Cedar Row: 1 differs'));
    await waitFor(() => expect(container.querySelectorAll('.fsl-tile').length).toBe(2));
    const badges = container.querySelectorAll('.fsl-tile[data-client-id="c-1"] .account-pill-close-differs');
    expect(badges.length).toBe(1);
    expect(badges[0].closest('.account-pill').dataset.account).toBe('CR-1');
    expect(badges[0].getAttribute('title')).toBe('Close differs: the realized figures differ.');
    expect(container.querySelectorAll('.fsl-tile[data-client-id="c-1"] .account-pill[data-account="CR-2"] .account-pill-close-differs').length).toBe(0);
    expect(container.querySelectorAll('.fsl-tile[data-client-id="c-2"] .account-pill-close-differs').length).toBe(0);
  });
});

describe('one read for the whole page', () => {
  it('asks the tracker once for the working book and feeds the light from that answer', async () => {
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('.fsl-grid')).not.toBeNull());
    expect(mocks.loadSupabaseAccountTracker).toHaveBeenCalledTimes(1);
    expect(mocks.loadSupabaseAccountTracker).toHaveBeenCalledWith({ clientIds: ['c-1', 'c-2'] });
  });

  it('says step 55 has not run when the read answers unavailable, without an error banner', async () => {
    mocks.loadSupabaseAccountTracker.mockResolvedValue({ available: false, staleSeconds: 1500, samplesByClientId: new Map() });
    const { container } = mount();
    await waitFor(() => expect(container.textContent).toContain('Migration step 55 has not been run'));
    expect(headings(container)[0]).toBe('Live accounts');
    expect(container.querySelectorAll('.fsl-tile').length).toBe(0);
  });
});
