import { useEffect, useState } from 'react';
import { ACCOUNT_OBSERVATION_DEFAULTS } from '../domain/accountBuckets';
import { loadSupabaseAccountObservationSettings } from '../domain/supabaseStore';

/**
 * HOW new_account_days REACHES THE LIGHTS.
 *
 * The one row of account_observation_settings (step 65) says how many days a
 * never seen account is still new, and how many closes an account may miss
 * before it is gone. The tiles, the desk drawer and the client page strip all
 * sort a registry by it (src/domain/accountBuckets.js), so it is read the way
 * the other live settings are: once, cached in this module for the session,
 * and handed to whoever asks. The first component to mount asks the database;
 * every other one, and every later mount, reads the answer.
 *
 *   * ONE READ PER SESSION. The row is edited in the SQL editor, not from the
 *     app; re-reading it every two minutes on three panels would be three
 *     requests for a number that changes once a quarter.
 *   * DEFAULTS, QUIETLY. When step 65 has not run the loader answers
 *     available:false with the column defaults; when the read fails the
 *     defaults are used too and the error is kept beside them. Either way the
 *     lights draw with 14 days for new and say nothing about it: a setting
 *     that could not be read is not a fault on the desk's side.
 *   * NULL UNTIL READ. Before the answer `settings` is null and the buckets use
 *     their defaults; the answer re-renders every mounted caller once.
 *
 * @param {{enabled?: boolean, load?: Function}} [options] `load` is injectable
 *   for tests, like the strategies and devices loaders.
 * @returns {{settings: {newAccountDays: number, staleCloses: number}|null,
 *   available: boolean|null, error: string|null, reading: boolean}}
 */
let held = null;
let inflight = null;

/** For tests only: forget the answer. */
export function resetAccountObservationSettingsCache() {
  held = null;
  inflight = null;
}

/** The cached answer, if any, without reading. */
export function cachedAccountObservationSettings() {
  return held;
}

function integer(value, fallback, { min, max }) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function settle(answer) {
  return {
    settings: {
      newAccountDays: integer(answer?.newAccountDays, ACCOUNT_OBSERVATION_DEFAULTS.newAccountDays, { min: 0, max: 90 }),
      staleCloses: integer(answer?.staleCloses, ACCOUNT_OBSERVATION_DEFAULTS.staleCloses, { min: 1, max: 30 }),
    },
    available: answer?.available === true,
    error: null,
    reading: false,
  };
}

function failed(failure) {
  return {
    settings: {
      newAccountDays: ACCOUNT_OBSERVATION_DEFAULTS.newAccountDays,
      staleCloses: ACCOUNT_OBSERVATION_DEFAULTS.staleCloses,
    },
    available: false,
    error: String(failure?.message || failure || 'failed'),
    reading: false,
  };
}

export default function useAccountObservationSettings({ enabled = true, load = loadSupabaseAccountObservationSettings } = {}) {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!enabled || held) return undefined;
    let live = true;
    if (!inflight) {
      inflight = Promise.resolve()
        .then(() => load())
        .then(settle, failed)
        .then((entry) => {
          held = entry;
          inflight = null;
          return entry;
        });
    }
    inflight.then(() => {
      if (live) bump((value) => value + 1);
    });
    return () => {
      live = false;
    };
  }, [enabled, load]);
  if (held) return held;
  return { settings: null, available: null, error: null, reading: Boolean(enabled) };
}
