// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useAlgorithmLiveRead, { algorithmLiveClientIds, resetAlgorithmLiveReadCache } from './useAlgorithmLiveRead';

/* ------------------------------------------------------------------------- *
 * THE ONE READ BEHIND THE ROLL CALL AND THE PER ACCOUNT COMPARISON.
 *
 * Asked of the hook itself, with a faked clock: how many times the loader is
 * called for one scope however many panels ask, what a failed refresh leaves
 * on screen, and when the timer stops.
 * ------------------------------------------------------------------------- */

const CYCLE = '2026-10-08T14:10:00.000Z';
const NOW = new Date('2026-10-08T14:13:00.000Z');
const CADENCE = 120_000;

function answer(desk = {}) {
  return { available: true, desk: { available: true, cycleStart: CYCLE, filling: false, cohorts: [], ...desk }, rows: [], settings: {} };
}

function mountRead(options) {
  return renderHook((props) => useAlgorithmLiveRead(props), { initialProps: { refreshMs: CADENCE, ...options } });
}

async function settle(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(NOW);
  resetAlgorithmLiveReadCache();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('one read per scope and cadence', () => {
  it('two panels asking for the same clients, in any order, share one read and one timer', async () => {
    const load = vi.fn(async () => answer());
    const first = mountRead({ load, clientIds: ['b', 'a'] });
    const second = mountRead({ load, clientIds: ['a', 'b', 'a'] });
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith({ clientIds: ['a', 'b'] });
    expect(first.result.current.data).toBe(second.result.current.data);
    await settle(CADENCE);
    expect(load).toHaveBeenCalledTimes(2);
    await settle(CADENCE);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('a different set of clients, or another cadence, is its own read', async () => {
    const load = vi.fn(async () => answer());
    mountRead({ load, clientIds: ['a'] });
    mountRead({ load, clientIds: ['a', 'b'] });
    mountRead({ load, clientIds: ['a'], refreshMs: 60_000 });
    await settle();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('a panel opened later shows the held answer at once and reads when that answer turns a cadence old', async () => {
    const load = vi.fn(async () => answer());
    mountRead({ load, clientIds: ['a'] });
    await settle(90_000);
    const later = mountRead({ load, clientIds: ['a'] });
    expect(later.result.current.data).not.toBeNull();
    expect(later.result.current.reading).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
    await settle(30_000);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('stops reading when the last panel closes, and reads again on the next open once the answer is old', async () => {
    const load = vi.fn(async () => answer());
    const one = mountRead({ load, clientIds: ['a'] });
    const two = mountRead({ load, clientIds: ['a'] });
    await settle();
    one.unmount();
    await settle(CADENCE);
    // One panel is still open: the timer is still running.
    expect(load).toHaveBeenCalledTimes(2);
    two.unmount();
    await settle(3 * CADENCE);
    expect(load).toHaveBeenCalledTimes(2);
    mountRead({ load, clientIds: ['a'] });
    await settle();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('a panel closed and opened again within the cadence shows the held answer and does not read again', async () => {
    const load = vi.fn(async () => answer());
    const first = mountRead({ load, clientIds: ['a'] });
    await settle(30_000);
    first.unmount();
    await settle(30_000);
    const again = mountRead({ load, clientIds: ['a'] });
    expect(again.result.current.data).not.toBeNull();
    expect(again.result.current.reading).toBe(false);
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    // The next read is due when the held answer turns a cadence old.
    await settle(CADENCE - 60_000 - 1);
    expect(load).toHaveBeenCalledTimes(1);
    await settle(1);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('joins a read already in flight instead of starting a second one', async () => {
    let release;
    const load = vi.fn(() => new Promise((resolve) => { release = () => resolve(answer()); }));
    const first = mountRead({ load, clientIds: ['a'] });
    act(() => { first.result.current.retry(); });
    mountRead({ load, clientIds: ['a'] });
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => { release(); });
    expect(first.result.current.data).not.toBeNull();
  });
});

describe('what a panel keeps', () => {
  it('a failed refresh keeps the last answer and does not move the clock', async () => {
    let fail = false;
    const load = vi.fn(async () => {
      if (fail) throw new Error('boom');
      return answer();
    });
    let clockNow = new Date('2026-10-08T14:13:00.000Z');
    const { result } = mountRead({ load, clientIds: ['a'], now: () => clockNow });
    await settle();
    const kept = result.current.data;
    expect(result.current.clock.toISOString()).toBe('2026-10-08T14:13:00.000Z');
    fail = true;
    clockNow = new Date('2026-10-08T14:15:00.000Z');
    await settle(CADENCE);
    expect(result.current.error).toBe('boom');
    expect(result.current.data).toBe(kept);
    expect(result.current.clock.toISOString()).toBe('2026-10-08T14:13:00.000Z');
    fail = false;
    clockNow = new Date('2026-10-08T14:17:00.000Z');
    await act(async () => { result.current.retry(); });
    expect(result.current.error).toBe('');
    expect(result.current.clock.toISOString()).toBe('2026-10-08T14:17:00.000Z');
  });

  it('keeps the last complete cycle while the next one fills, and names the filling one', async () => {
    let call = 0;
    const load = vi.fn(async () => {
      call += 1;
      return call === 1 ? answer() : answer({ filling: true, cycleStart: '2026-10-08T14:20:00.000Z' });
    });
    const { result } = mountRead({ load, clientIds: ['a'] });
    await settle();
    await settle(CADENCE);
    expect(result.current.data.desk.cycleStart).toBe(CYCLE);
    expect(result.current.data.fillingCycleStart).toBe('2026-10-08T14:20:00.000Z');
  });

  it('reads by uuid, never by the legacy key', () => {
    expect(algorithmLiveClientIds([
      { id: 'act-1700000000-ash', uuid: '4b0e5c8f-8c3f-4b2a-9d2e-1b2c3d4e5f60' },
      { id: 'c-birch' },
      null,
      {},
    ])).toEqual(['4b0e5c8f-8c3f-4b2a-9d2e-1b2c3d4e5f60', 'c-birch']);
  });
});
