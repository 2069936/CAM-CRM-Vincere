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
}));

vi.mock('./domain/supabaseStore', async (importOriginal) => ({
  ...(await importOriginal()),
  loadSupabaseAccountTracker: mocks.loadSupabaseAccountTracker,
}));

import { CamOverview } from './App';

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
});
afterEach(cleanup);

describe('the order of the panels for a CAM', () => {
  it('puts Live accounts first, then Open flags, then the rest as before', async () => {
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('.fsl-grid')).not.toBeNull());
    const live = indexOfHeading(container, 'Live accounts');
    const flags = indexOfHeading(container, 'Open flags');
    const coverage = indexOfHeading(container, 'Book coverage and mix');
    const feed = indexOfHeading(container, 'Insight Feed');
    expect(live).toBeLessThan(flags);
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
