// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* ------------------------------------------------------------------------- *
 * ONE READ OF THE LIVE ALGORITHMS FOR A CAM OVERVIEW, HOWEVER MANY PANELS.
 *
 * The roll call (open by default) and "Each algorithm today, against the desk"
 * (opened by a click) show the same read for the same book: the floors, the
 * desk figure and the book's rows from loadSupabaseAlgorithmLive. Each panel
 * used to read on its own two minute timer, so a CAM with both open read the
 * same thing twice per cadence. They now subscribe to one entry of
 * useAlgorithmLiveRead.
 *
 * Asked of a RENDERED CamOverview with the clock faked: the loader's calls are
 * counted at mount, when the second panel opens, and over three cadences.
 * ------------------------------------------------------------------------- */

const mocks = vi.hoisted(() => ({
  loadSupabaseAccountTracker: vi.fn(),
  loadSupabaseTrackerCloseReadings: vi.fn(),
  loadSupabaseAlgorithmLive: vi.fn(),
}));

vi.mock('./domain/supabaseStore', async (importOriginal) => ({
  ...(await importOriginal()),
  loadSupabaseAccountTracker: mocks.loadSupabaseAccountTracker,
  loadSupabaseTrackerCloseReadings: mocks.loadSupabaseTrackerCloseReadings,
  loadSupabaseAlgorithmLive: mocks.loadSupabaseAlgorithmLive,
}));

import { CamOverview } from './App';
import { resetAlgorithmLiveReadCache } from './components/useAlgorithmLiveRead';
import { LIVE_REFRESH_MS } from './domain/liveRefresh';

const NOW = new Date('2026-10-08T14:13:00.000Z');
const CYCLE = '2026-10-08T14:10:00.000Z';
const UUID = '4b0e5c8f-8c3f-4b2a-9d2e-1b2c3d4e5f60';

function client(id, name, accounts, extra = {}) {
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
    activityLog: [],
    ...extra,
  };
}

// One client with a legacy key and a uuid, one with a uuid for an id.
const BOOK = [
  client('act-1700000000-cedar', 'Cedar Row', ['CR-1'], { uuid: UUID }),
  client('c-birch', 'Birch Lane', ['BL-1']),
];

const ALGORITHM_LIVE = {
  available: true,
  desk: {
    available: true,
    cycleStart: CYCLE,
    filling: false,
    scope: 'rest_of_desk',
    cohorts: [{ algorithm: 'OGX_PF', instrumentRoot: 'MNQ', status: 'compared', nAccounts: 12, nClients: 8, median: -500, spread: 100, nFlat: 0 }],
  },
  rows: [{
    clientId: UUID, accountName: 'CR-1', strategyId: '1', strategyName: 'OGX PF 2.4', algorithm: 'OGX_PF', instrumentRoot: 'MNQ',
    instrument: 'MNQ 12-26', realizedPnl: -1100, unrealizedPnl: -100, restartedAt: null, sampledAt: '2026-10-08T14:10:02.000Z', cycleStart: CYCLE,
    marketPosition: null, positionQuantity: null, tradesThisRun: null,
  }],
  settings: { minCohortAccounts: 5, minCohortClients: 3, differsAtSpread: 3, minSpreadDollars: 50, cycleSeconds: 600, fallback: false },
};

function mount() {
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
  />);
}

// Lets the reads the timers started settle, without moving the clock.
async function settle(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

function openComparison(container) {
  const toggle = [...container.querySelectorAll('.collapse-toggle')]
    .find((button) => button.textContent.includes('Each algorithm today, against the desk'));
  expect(toggle, 'the comparison panel is on the page').toBeTruthy();
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  act(() => { toggle.click(); });
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(NOW);
  resetAlgorithmLiveReadCache();
  mocks.loadSupabaseAccountTracker.mockReset();
  mocks.loadSupabaseAccountTracker.mockResolvedValue({ available: true, staleSeconds: 1500, minAgentVersion: '1.2.0', samplesByClientId: new Map() });
  mocks.loadSupabaseTrackerCloseReadings.mockReset();
  mocks.loadSupabaseTrackerCloseReadings.mockResolvedValue({ available: false, reason: 'not_deployed' });
  mocks.loadSupabaseAlgorithmLive.mockReset();
  mocks.loadSupabaseAlgorithmLive.mockImplementation(async () => ALGORITHM_LIVE);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the roll call and the comparison on a CAM overview', () => {
  it('make ONE read per cadence for the same book, with both panels open', async () => {
    const { container } = mount();
    await settle();
    // The roll call is open by default and has read once, by uuid.
    expect(mocks.loadSupabaseAlgorithmLive).toHaveBeenCalledTimes(1);
    expect(mocks.loadSupabaseAlgorithmLive).toHaveBeenLastCalledWith({ clientIds: [UUID, 'c-birch'].sort() });
    expect(container.querySelector('.algorithm-rollcall-row[data-algorithm="OGX_PF"]')).not.toBeNull();

    // A minute later the CAM opens the comparison: it shows the answer the roll
    // call holds, at once, and reads nothing of its own.
    await settle(60_000);
    expect(mocks.loadSupabaseAlgorithmLive).toHaveBeenCalledTimes(1);
    openComparison(container);
    await settle();
    expect(mocks.loadSupabaseAlgorithmLive).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.algorithm-live').textContent).toContain('Desk median -$500 over 12 accounts from 8 clients.');

    // The next read is due one cadence after the first answer, and it is one
    // read for both panels; so is every read after it.
    await settle(LIVE_REFRESH_MS - 60_000);
    expect(mocks.loadSupabaseAlgorithmLive).toHaveBeenCalledTimes(2);
    await settle(LIVE_REFRESH_MS);
    expect(mocks.loadSupabaseAlgorithmLive).toHaveBeenCalledTimes(3);
    await settle(LIVE_REFRESH_MS);
    expect(mocks.loadSupabaseAlgorithmLive).toHaveBeenCalledTimes(4);
    for (const call of mocks.loadSupabaseAlgorithmLive.mock.calls) {
      expect(call[0]).toEqual({ clientIds: [UUID, 'c-birch'].sort() });
    }
  });

  it('keeps reading on the cadence after the comparison is folded again, once per cadence', async () => {
    const { container } = mount();
    await settle();
    openComparison(container);
    await settle();
    const toggle = [...container.querySelectorAll('.collapse-toggle')]
      .find((button) => button.textContent.includes('Each algorithm today, against the desk'));
    act(() => { toggle.click(); });
    expect(container.querySelector('.algorithm-live')).toBeNull();
    await settle(LIVE_REFRESH_MS);
    expect(mocks.loadSupabaseAlgorithmLive).toHaveBeenCalledTimes(2);
    await settle(LIVE_REFRESH_MS);
    expect(mocks.loadSupabaseAlgorithmLive).toHaveBeenCalledTimes(3);
  });
});
