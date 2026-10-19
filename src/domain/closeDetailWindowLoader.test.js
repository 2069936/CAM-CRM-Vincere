// The period report's loader: one fetch per window, its own load state, and
// never "loaded" over rows that are not here.
//
// UNGATED: no database and no React; the cache is App's ref shape.

import { describe, expect, it, vi } from 'vitest';
import { createWindowDetailLoader } from './closeDetailWindowLoader';

function harness({ load } = {}) {
  const cache = { current: new Map() };
  const states = [];
  const merged = [];
  const loader = createWindowDetailLoader({
    cache,
    load: load || vi.fn(async (ids) => ({ importIds: ids })),
    onLoaded: (detail) => merged.push(detail),
    setPanelLoad: (key, state) => states.push([key, state.status, state.error]),
    log: () => {},
  });
  return { cache, states, merged, loader };
}

describe('createWindowDetailLoader', () => {
  it('fetches the window once, merges it, and reports loading then loaded under the window key', async () => {
    const load = vi.fn(async (ids) => ({ importIds: ids }));
    const { cache, states, merged, loader } = harness({ load });
    await loader('client-period-report:c1:2026-10-12:2026-10-18', ['a', 'b', 'a', null]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(['a', 'b']);
    expect(merged).toEqual([{ importIds: ['a', 'b'] }]);
    expect(states).toEqual([
      ['client-period-report:c1:2026-10-12:2026-10-18', 'loading', ''],
      ['client-period-report:c1:2026-10-12:2026-10-18', 'loaded', ''],
    ]);
    expect(cache.current.get('a')).toEqual({ status: 'loaded' });
  });

  it('waits on a request already out for the same closes instead of fetching twice or calling them loaded early', async () => {
    let release;
    const load = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const { states, loader } = harness({ load });
    const first = loader('w1', ['a', 'b']);
    const second = loader('w2', ['b']);
    // Both are waiting; neither is loaded.
    expect(states.filter(([, status]) => status === 'loaded')).toEqual([]);
    expect(load).toHaveBeenCalledTimes(1);
    release({ importIds: ['a', 'b'] });
    await Promise.all([first, second]);
    expect(states).toContainEqual(['w2', 'loaded', '']);
    expect(states).toContainEqual(['w1', 'loaded', '']);
  });

  it('says why when the fetch fails, keeps nothing in the cache, and fetches again on retry', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ importIds: ['a'] });
    const { cache, states, merged, loader } = harness({ load });
    await loader('w', ['a']);
    expect(states.at(-1)).toEqual(['w', 'error', 'Could not load the closes for this report: timeout']);
    expect(cache.current.has('a')).toBe(false);
    expect(merged).toEqual([]);
    await loader('w', ['a']);
    expect(load).toHaveBeenCalledTimes(2);
    expect(states.at(-1)).toEqual(['w', 'loaded', '']);
  });

  it('reports an error when the request it waited on failed', async () => {
    let fail;
    const load = vi.fn(() => new Promise((resolve, reject) => { fail = reject; }));
    const { states, loader } = harness({ load });
    const first = loader('w1', ['a']);
    const second = loader('w2', ['a']);
    fail(new Error('boom'));
    await Promise.all([first, second]);
    expect(states.at(-1)[1]).toBe('error');
    expect(states).toContainEqual(['w2', 'error', 'Could not load the closes for this report: the request failed.']);
  });

  it('is loaded at once when there is nothing to fetch', async () => {
    const { states, loader } = harness();
    await loader('w', []);
    expect(states).toEqual([['w', 'loaded', '']]);
  });

  it('fetches again a close the cache calls loaded, because the panel only asks for closes state does not hold', async () => {
    const load = vi.fn(async (ids) => ({ importIds: ids }));
    const { cache, loader } = harness({ load });
    cache.current.set('a', { status: 'loaded' });
    await loader('w', ['a']);
    expect(load).toHaveBeenCalledWith(['a']);
  });
});
