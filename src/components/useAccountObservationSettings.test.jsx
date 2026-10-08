// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useAccountObservationSettings, {
  cachedAccountObservationSettings,
  resetAccountObservationSettingsCache,
} from './useAccountObservationSettings';
import { ACCOUNT_OBSERVATION_DEFAULTS } from '../domain/accountBuckets';

/* ------------------------------------------------------------------------- *
 * HOW new_account_days REACHES THE LIGHTS.
 *
 * One row of account_observation_settings, read once per session the way the
 * other live settings are (the tracker's stale_sample_seconds rides in with the
 * tracker; the strategies are cached per client by useClientLiveStrategies).
 * Every tile, strip and drawer asks this hook; the first asks the database,
 * the rest read the answer. Defaults when step 65 has not run or the read
 * fails, and the screen never says a word about it.
 * ------------------------------------------------------------------------- */

beforeEach(() => resetAccountObservationSettingsCache());
afterEach(cleanup);

describe('useAccountObservationSettings', () => {
  it('reads once per session and hands every caller the same settings', async () => {
    const load = vi.fn(async () => ({ available: true, staleCloses: 7, autoFailOnBreach: true, newAccountDays: 3 }));
    const one = renderHook(() => useAccountObservationSettings({ load }));
    const two = renderHook(() => useAccountObservationSettings({ load }));
    expect(one.result.current.settings).toBeNull();
    expect(one.result.current.reading).toBe(true);
    await waitFor(() => expect(one.result.current.settings).toEqual({ newAccountDays: 3, staleCloses: 7 }));
    expect(two.result.current.settings).toEqual({ newAccountDays: 3, staleCloses: 7 });
    expect(one.result.current.available).toBe(true);
    expect(one.result.current.error).toBeNull();
    expect(one.result.current.reading).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
    // A later caller finds the answer at once and asks nothing.
    const three = renderHook(() => useAccountObservationSettings({ load }));
    expect(three.result.current.settings).toEqual({ newAccountDays: 3, staleCloses: 7 });
    expect(load).toHaveBeenCalledTimes(1);
    expect(cachedAccountObservationSettings()).toMatchObject({ settings: { newAccountDays: 3, staleCloses: 7 } });
  });

  it('falls back to the column defaults when step 65 has not run, and when the read fails', async () => {
    const missing = vi.fn(async () => ({ available: false, ...ACCOUNT_OBSERVATION_DEFAULTS }));
    const first = renderHook(() => useAccountObservationSettings({ load: missing }));
    await waitFor(() => expect(first.result.current.settings).toEqual({ newAccountDays: 14, staleCloses: 5 }));
    expect(first.result.current.available).toBe(false);
    expect(first.result.current.error).toBeNull();

    resetAccountObservationSettingsCache();
    const failing = vi.fn(async () => { throw new Error('boom'); });
    const second = renderHook(() => useAccountObservationSettings({ load: failing }));
    await waitFor(() => expect(second.result.current.settings).toEqual({ newAccountDays: 14, staleCloses: 5 }));
    expect(second.result.current.available).toBe(false);
    expect(second.result.current.error).toBe('boom');
    // Once per session, a failure included: the defaults are not re-asked on every render.
    renderHook(() => useAccountObservationSettings({ load: failing }));
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('asks nothing when disabled, and keeps a bad value out of the settings', async () => {
    const load = vi.fn(async () => ({ available: true, newAccountDays: 'soon', staleCloses: -2 }));
    const off = renderHook(() => useAccountObservationSettings({ load, enabled: false }));
    expect(off.result.current.settings).toBeNull();
    expect(off.result.current.reading).toBe(false);
    expect(load).not.toHaveBeenCalled();
    const on = renderHook(() => useAccountObservationSettings({ load }));
    await waitFor(() => expect(on.result.current.settings).toEqual({ newAccountDays: 14, staleCloses: 5 }));
  });
});
