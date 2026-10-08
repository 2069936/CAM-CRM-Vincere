// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* ------------------------------------------------------------------------- *
 * THE TRACKER WAKES UP WITH THE TAB.
 *
 * Pedro's question: if I leave this open all day, does it refresh on its own?
 * It polls every two minutes, and a laptop that slept through the afternoon
 * fires no interval while asleep, so the first thing he saw on opening the lid
 * was an age from before lunch. The hook now re-reads the moment the document
 * becomes visible again or the window regains focus, and at most once every
 * thirty seconds, because a lid opening fires both events within a second.
 * ------------------------------------------------------------------------- */

const mocks = vi.hoisted(() => ({
  loadSupabaseAccountTracker: vi.fn(),
}));

vi.mock('../domain/supabaseStore', async (importOriginal) => ({
  ...(await importOriginal()),
  loadSupabaseAccountTracker: mocks.loadSupabaseAccountTracker,
}));

import useLiveAccountTracker from './useLiveAccountTracker';
import { LIVE_REFRESH_MS, WAKE_MIN_GAP_MS } from '../domain/liveRefresh';

const TRACKER = { available: true, staleSeconds: 1500, minAgentVersion: '1.2.0', samplesByClientId: new Map() };

function Probe({ ids = ['c-1'] }) {
  const { tracker, clock, refreshMs } = useLiveAccountTracker(ids);
  return <output data-clock={clock} data-refresh={refreshMs}>{tracker ? 'ready' : 'none'}</output>;
}

let visibility = 'visible';
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-08T14:00:00.000Z'));
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  mocks.loadSupabaseAccountTracker.mockReset();
  mocks.loadSupabaseAccountTracker.mockResolvedValue(TRACKER);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete document.visibilityState;
});

async function flush() {
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

async function wait(ms) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

function show() {
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('a tab that comes back', () => {
  it('re-reads when the document becomes visible, at most once per thirty seconds', async () => {
    render(<Probe />);
    await flush();
    expect(mocks.loadSupabaseAccountTracker).toHaveBeenCalledTimes(1);

    // Hidden: nothing to show, nothing read.
    visibility = 'hidden';
    await wait(WAKE_MIN_GAP_MS + 1_000);
    act(() => show());
    await flush();
    expect(mocks.loadSupabaseAccountTracker).toHaveBeenCalledTimes(1);

    // Visible again, more than thirty seconds after the last read: one read.
    visibility = 'visible';
    act(() => show());
    await flush();
    expect(mocks.loadSupabaseAccountTracker).toHaveBeenCalledTimes(2);

    // Visible again a second later (the focus event of the same lid): no read.
    await wait(1_000);
    act(() => show());
    act(() => window.dispatchEvent(new Event('focus')));
    await flush();
    expect(mocks.loadSupabaseAccountTracker).toHaveBeenCalledTimes(2);

    // Thirty seconds on, focus alone is enough.
    await wait(WAKE_MIN_GAP_MS);
    act(() => window.dispatchEvent(new Event('focus')));
    await flush();
    expect(mocks.loadSupabaseAccountTracker).toHaveBeenCalledTimes(3);
  });

  it('counts the interval read as a read, so a wake just after the timer does not double it', async () => {
    render(<Probe />);
    await flush();
    await wait(LIVE_REFRESH_MS);
    expect(mocks.loadSupabaseAccountTracker).toHaveBeenCalledTimes(2);
    act(() => show());
    await flush();
    expect(mocks.loadSupabaseAccountTracker).toHaveBeenCalledTimes(2);
  });

  it('moves its clock on the wake read and reports the cadence it polls at', async () => {
    const { container } = render(<Probe />);
    await flush();
    const first = Number(container.querySelector('output').getAttribute('data-clock'));
    expect(container.querySelector('output').getAttribute('data-refresh')).toBe(String(LIVE_REFRESH_MS));
    await wait(WAKE_MIN_GAP_MS + 5_000);
    act(() => show());
    await flush();
    const second = Number(container.querySelector('output').getAttribute('data-clock'));
    expect(second - first).toBe(WAKE_MIN_GAP_MS + 5_000);
    expect(container.textContent).toBe('ready');
  });

  it('does not move the clock when the wake read fails', async () => {
    const { container } = render(<Probe />);
    await flush();
    const first = Number(container.querySelector('output').getAttribute('data-clock'));
    mocks.loadSupabaseAccountTracker.mockRejectedValueOnce(new Error('offline'));
    await wait(WAKE_MIN_GAP_MS + 5_000);
    act(() => show());
    await flush();
    expect(mocks.loadSupabaseAccountTracker).toHaveBeenCalledTimes(2);
    expect(Number(container.querySelector('output').getAttribute('data-clock'))).toBe(first);
  });

  it('stops listening when it unmounts', async () => {
    const { unmount } = render(<Probe />);
    await flush();
    unmount();
    await wait(WAKE_MIN_GAP_MS + 5_000);
    act(() => show());
    act(() => window.dispatchEvent(new Event('focus')));
    await flush();
    expect(mocks.loadSupabaseAccountTracker).toHaveBeenCalledTimes(1);
  });

  it('listens for nothing with no clients to read', async () => {
    render(<Probe ids={[]} />);
    await flush();
    await wait(WAKE_MIN_GAP_MS + 5_000);
    act(() => show());
    await flush();
    expect(mocks.loadSupabaseAccountTracker).not.toHaveBeenCalled();
  });
});
