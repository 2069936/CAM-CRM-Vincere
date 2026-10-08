// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* ------------------------------------------------------------------------- *
 * THE PINNED READINGS, KEPT FRESH THE WAY THE TRACKER IS.
 *
 * Twin of useLiveAccountTracker: one read on mount, one every two minutes, one
 * when the tab comes back after thirty seconds away, the clock moving only on
 * a successful read, and a failed refresh keeping the last answer beside the
 * error rather than blanking the screen.
 * ------------------------------------------------------------------------- */

const mocks = vi.hoisted(() => ({
  loadSupabaseTrackerCloseReadings: vi.fn(),
  loadSupabaseAccountLiveSampleHistory: vi.fn(),
}));

vi.mock('../domain/supabaseStore', async (importOriginal) => ({
  ...(await importOriginal()),
  loadSupabaseTrackerCloseReadings: mocks.loadSupabaseTrackerCloseReadings,
  loadSupabaseAccountLiveSampleHistory: mocks.loadSupabaseAccountLiveSampleHistory,
}));

import useTrackerCloseComparison from './useTrackerCloseComparison';
import { LIVE_REFRESH_MS, WAKE_MIN_GAP_MS } from '../domain/liveRefresh';

const ANSWER = { available: true, readings: [{ clientId: 'c-1', accountName: 'ACC 01' }], settings: null };
const HISTORY = { available: true, rows: [] };

function Probe({ ids = ['c-1'], importIds = null, tradingDate = null, since = null, enabled = true, refreshMs = undefined }) {
  const read = useTrackerCloseComparison({ clientIds: ids, importIds, tradingDate, since, enabled, refreshMs });
  return (
    <output
      data-clock={read.clock}
      data-refresh={read.refreshMs}
      data-reading={String(read.reading)}
      data-error={read.error || ''}
      data-history={read.history ? 'yes' : 'no'}
      onClick={read.retry}
    >
      {read.answer ? (read.answer.available ? `ready:${read.answer.readings.length}` : `unavailable:${read.answer.reason}`) : 'none'}
    </output>
  );
}

let visibility = 'visible';
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-08T14:00:00.000Z'));
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  mocks.loadSupabaseTrackerCloseReadings.mockReset();
  mocks.loadSupabaseTrackerCloseReadings.mockResolvedValue(ANSWER);
  mocks.loadSupabaseAccountLiveSampleHistory.mockReset();
  mocks.loadSupabaseAccountLiveSampleHistory.mockResolvedValue(HISTORY);
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
const output = (container) => container.querySelector('output');

describe('the cadence', () => {
  it('reads once on mount by uuid, sorted and de-duplicated, and again every two minutes', async () => {
    const { container } = render(<Probe ids={['c-2', 'c-1', 'c-1']} tradingDate="2026-10-08" />);
    await flush();
    expect(mocks.loadSupabaseTrackerCloseReadings).toHaveBeenCalledTimes(1);
    expect(mocks.loadSupabaseTrackerCloseReadings).toHaveBeenCalledWith({ clientIds: ['c-1', 'c-2'], importIds: null, tradingDate: '2026-10-08' });
    expect(output(container).textContent).toBe('ready:1');
    expect(output(container).dataset.refresh).toBe(String(LIVE_REFRESH_MS));
    // No history was asked for: the overview has no sparkline.
    expect(mocks.loadSupabaseAccountLiveSampleHistory).not.toHaveBeenCalled();
    expect(output(container).dataset.history).toBe('no');
    await wait(LIVE_REFRESH_MS);
    expect(mocks.loadSupabaseTrackerCloseReadings).toHaveBeenCalledTimes(2);
    await wait(LIVE_REFRESH_MS);
    expect(mocks.loadSupabaseTrackerCloseReadings).toHaveBeenCalledTimes(3);
  });

  it('reads the history slice beside the readings when a window is named, scoped to the same clients', async () => {
    const { container } = render(<Probe importIds={['imp-1']} since="2026-10-08T04:00:00.000Z" />);
    await flush();
    expect(mocks.loadSupabaseTrackerCloseReadings).toHaveBeenCalledWith({ clientIds: ['c-1'], importIds: ['imp-1'], tradingDate: null });
    expect(mocks.loadSupabaseAccountLiveSampleHistory).toHaveBeenCalledWith({ clientIds: ['c-1'], since: '2026-10-08T04:00:00.000Z' });
    expect(output(container).dataset.history).toBe('yes');
  });

  it('reads nothing for an empty scope or when disabled, and refreshMs 0 means one read', async () => {
    const none = render(<Probe ids={[]} />);
    await flush();
    expect(mocks.loadSupabaseTrackerCloseReadings).not.toHaveBeenCalled();
    expect(output(none.container).textContent).toBe('none');
    expect(output(none.container).dataset.reading).toBe('false');
    none.unmount();
    const off = render(<Probe enabled={false} />);
    await flush();
    expect(mocks.loadSupabaseTrackerCloseReadings).not.toHaveBeenCalled();
    off.unmount();
    render(<Probe refreshMs={0} />);
    await flush();
    expect(mocks.loadSupabaseTrackerCloseReadings).toHaveBeenCalledTimes(1);
    await wait(LIVE_REFRESH_MS * 3);
    expect(mocks.loadSupabaseTrackerCloseReadings).toHaveBeenCalledTimes(1);
  });
});

describe('the clock and the failures', () => {
  it('advances the clock only on a successful read, and keeps the last answer beside the error', async () => {
    const { container } = render(<Probe />);
    await flush();
    const first = Number(output(container).dataset.clock);
    expect(first).toBe(Date.parse('2026-10-08T14:00:00.000Z'));
    mocks.loadSupabaseTrackerCloseReadings.mockRejectedValue(new Error('boom'));
    await wait(LIVE_REFRESH_MS);
    expect(mocks.loadSupabaseTrackerCloseReadings).toHaveBeenCalledTimes(2);
    expect(output(container).textContent).toBe('ready:1');
    expect(output(container).dataset.error).toBe('boom');
    expect(Number(output(container).dataset.clock)).toBe(first);
    mocks.loadSupabaseTrackerCloseReadings.mockResolvedValue(ANSWER);
    await wait(LIVE_REFRESH_MS);
    expect(output(container).dataset.error).toBe('');
    expect(Number(output(container).dataset.clock)).toBe(first + 2 * LIVE_REFRESH_MS);
  });

  it('hands back available:false as the answer, so the screen names the state instead of a blank', async () => {
    mocks.loadSupabaseTrackerCloseReadings.mockResolvedValue({ available: false, reason: 'not_deployed' });
    const { container } = render(<Probe />);
    await flush();
    expect(output(container).textContent).toBe('unavailable:not_deployed');
  });

  it('a failed history read is the readings without a trail, not a failed panel', async () => {
    mocks.loadSupabaseAccountLiveSampleHistory.mockRejectedValue(new Error('history down'));
    const { container } = render(<Probe since="2026-10-08T04:00:00.000Z" />);
    await flush();
    expect(output(container).textContent).toBe('ready:1');
    expect(output(container).dataset.history).toBe('no');
    expect(output(container).dataset.error).toBe('');
  });

  it('retry reads again at once', async () => {
    mocks.loadSupabaseTrackerCloseReadings.mockRejectedValue(new Error('boom'));
    const { container } = render(<Probe />);
    await flush();
    expect(output(container).textContent).toBe('none');
    expect(output(container).dataset.error).toBe('boom');
    mocks.loadSupabaseTrackerCloseReadings.mockResolvedValue(ANSWER);
    await act(async () => { output(container).click(); });
    await flush();
    expect(mocks.loadSupabaseTrackerCloseReadings).toHaveBeenCalledTimes(2);
    expect(output(container).textContent).toBe('ready:1');
  });
});

describe('a tab that comes back', () => {
  it('re-reads when the document becomes visible, at most once per thirty seconds, never while hidden', async () => {
    render(<Probe />);
    await flush();
    expect(mocks.loadSupabaseTrackerCloseReadings).toHaveBeenCalledTimes(1);
    visibility = 'hidden';
    await wait(WAKE_MIN_GAP_MS + 1_000);
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await flush();
    expect(mocks.loadSupabaseTrackerCloseReadings).toHaveBeenCalledTimes(1);
    visibility = 'visible';
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await flush();
    expect(mocks.loadSupabaseTrackerCloseReadings).toHaveBeenCalledTimes(2);
    // A focus a second later is the same wake: no third read.
    await wait(1_000);
    act(() => { window.dispatchEvent(new Event('focus')); });
    await flush();
    expect(mocks.loadSupabaseTrackerCloseReadings).toHaveBeenCalledTimes(2);
  });

  it('stops reading when unmounted', async () => {
    const { unmount } = render(<Probe />);
    await flush();
    unmount();
    await wait(LIVE_REFRESH_MS * 2);
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await flush();
    expect(mocks.loadSupabaseTrackerCloseReadings).toHaveBeenCalledTimes(1);
  });
});
