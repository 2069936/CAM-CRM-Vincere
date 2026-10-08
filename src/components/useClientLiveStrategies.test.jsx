// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useClientLiveStrategies, { resetClientLiveStrategiesCache } from './useClientLiveStrategies';

/* ------------------------------------------------------------------------- *
 * WHAT ONE CLIENT IS RUNNING, READ WHEN A PILL IS OPENED.
 *
 * One read per client, not per account, not per render: a client with eight
 * accounts and one open pill costs one select, and opening a second account on
 * the same client costs nothing. Refreshed every two minutes only while
 * something is open, held in a cache per client so the amber marker stays on
 * the pills after the detail is closed.
 * ------------------------------------------------------------------------- */

const UUID = '4b0e5c8f-8c3f-4b2a-9d2e-1b2c3d4e5f60';
const ANSWER = { available: true, clientId: UUID, desk: { available: true, cycleStart: null, filling: false, cohorts: [] }, rows: [], settings: null };

function Probe({ clientId = UUID, active = true, load, refreshMs = 1_000 }) {
  const { data, error, reading, at } = useClientLiveStrategies(clientId, { active, load, refreshMs });
  return (
    <output data-at={at ?? ''} data-reading={String(reading)}>
      {error ? `error:${error}` : data ? `data:${data.clientId}` : 'nothing'}
    </output>
  );
}

const text = (container) => container.querySelector('output').textContent;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-08T14:00:00.000Z'));
  resetClientLiveStrategiesCache();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function flush(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

describe('useClientLiveStrategies', () => {
  it('reads once when active, then on the cadence, and stops when inactive', async () => {
    const load = vi.fn(async () => ANSWER);
    const { container, rerender } = render(<Probe load={load} />);
    expect(container.querySelector('output').getAttribute('data-reading')).toBe('true');
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith({ clientId: UUID });
    expect(text(container)).toBe(`data:${UUID}`);
    expect(container.querySelector('output').getAttribute('data-reading')).toBe('false');
    await flush(1_000);
    expect(load).toHaveBeenCalledTimes(2);
    rerender(<Probe load={load} active={false} />);
    await flush(5_000);
    expect(load).toHaveBeenCalledTimes(2);
    // The last answer stays on screen while inactive: that is what keeps the marker.
    expect(text(container)).toBe(`data:${UUID}`);
  });

  it('reads nothing while inactive and nothing for an empty client', async () => {
    const load = vi.fn(async () => ANSWER);
    const { container } = render(<Probe load={load} active={false} />);
    await flush(3_000);
    expect(load).not.toHaveBeenCalled();
    expect(text(container)).toBe('nothing');
    expect(container.querySelector('output').getAttribute('data-reading')).toBe('false');
    render(<Probe load={load} clientId="" />);
    await flush(3_000);
    expect(load).not.toHaveBeenCalled();
  });

  it('serves a second reader of the same client from the cache without a second read', async () => {
    const load = vi.fn(async () => ANSWER);
    const first = render(<Probe load={load} refreshMs={60_000} />);
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    const second = render(<Probe load={load} refreshMs={60_000} />);
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(text(second.container)).toBe(`data:${UUID}`);
    expect(text(first.container)).toBe(`data:${UUID}`);
  });

  it('re-reads a cached answer that is older than the cadence', async () => {
    const load = vi.fn(async () => ANSWER);
    const first = render(<Probe load={load} refreshMs={60_000} />);
    await flush();
    first.unmount();
    await flush(61_000);
    render(<Probe load={load} refreshMs={60_000} />);
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps one cache entry per client, keyed by the id it was asked with', async () => {
    const load = vi.fn(async ({ clientId }) => ({ ...ANSWER, clientId }));
    const a = render(<Probe load={load} clientId="client-a" />);
    const b = render(<Probe load={load} clientId="client-b" />);
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(text(a.container)).toBe('data:client-a');
    expect(text(b.container)).toBe('data:client-b');
  });

  it('reports a failed read as an error and keeps the previous answer', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce(ANSWER)
      .mockRejectedValueOnce(new Error('timeout'));
    const { container } = render(<Probe load={load} />);
    await flush();
    expect(text(container)).toBe(`data:${UUID}`);
    await flush(1_000);
    expect(load).toHaveBeenCalledTimes(2);
    // The data is still the last good answer; the error travels beside it.
    expect(text(container)).toBe('error:timeout');
    expect(container.querySelector('output').getAttribute('data-at')).not.toBe('');
  });

  it('reports a first read that fails, with nothing to show, as an error and not as reading', async () => {
    const load = vi.fn(async () => { throw new Error('offline'); });
    const { container } = render(<Probe load={load} />);
    await flush();
    expect(text(container)).toBe('error:offline');
    expect(container.querySelector('output').getAttribute('data-reading')).toBe('false');
  });
});
