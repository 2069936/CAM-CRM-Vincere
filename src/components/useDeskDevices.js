import { useEffect, useState } from 'react';
import { autoCollectionApi } from '../domain/autoCollectionApi';
import { LIVE_REFRESH_MS } from '../domain/liveRefresh';

/**
 * THE VPS OF EVERY CLIENT, FOR THE DESK BULBS.
 *
 * A bulb that says "is NinjaTrader up" needs the device, and the browser cannot
 * read ingest_devices: step 28 closed the table to the browser key and nothing
 * since reopened it. The one fleet wide path is /api/admin/ingest-fleet, a
 * serverless route for Managers only, paged by at most 100. This reads every
 * page (109 clients is two requests) on the tracker's cadence and hands the
 * bulbs a map of devices by client uuid, in the route's own public shape
 * (status, healthStatus, lastSeenAt, lastErrorCode, revokedAt).
 *
 * A ROLE THE ROUTE REFUSES GETS A CLEAR ANSWER, NOT A RETRY. A CAM is answered
 * 403 and the API throws permission_denied; the hook records
 * `{ available: false, reason: 'permission_denied' }`, stops asking, and the
 * bulbs fall back to samples and the registry, saying so. Any other failure
 * keeps the last answer beside the error, so a hiccup on the route does not
 * repaint every VPS as absent.
 *
 * @returns {{devices: object|null, error: string|null, reading: boolean}}
 */
export const FLEET_PAGE_SIZE = 100;

/** Every page of the fleet, as {available: true, byClientId: Map<uuid, device[]>}. */
export async function loadDeskDevices({ api = autoCollectionApi, pageSize = FLEET_PAGE_SIZE, signal } = {}) {
  const byClientId = new Map();
  let total = Infinity;
  let seen = 0;
  // Bounded: a fleet of ten thousand clients is not this desk, and a route
  // that kept answering full pages forever must not keep this loop alive.
  for (let page = 1; seen < total && page <= 100; page += 1) {
    const result = await api.loadFleet({ page, pageSize, signal });
    const rows = Array.isArray(result?.rows) ? result.rows : [];
    total = Number.isFinite(Number(result?.total)) ? Number(result.total) : seen + rows.length;
    for (const row of rows) {
      const uuid = row?.client?.uuid;
      // A client without a device is left out: the bulbs read that as no VPS.
      if (!uuid || !row.device) continue;
      byClientId.set(uuid, [...(byClientId.get(uuid) || []), row.device]);
    }
    seen += rows.length;
    if (rows.length < pageSize) break;
  }
  return { available: true, byClientId, at: Date.now() };
}

export default function useDeskDevices({ enabled = true, refreshMs = LIVE_REFRESH_MS, load = loadDeskDevices } = {}) {
  const [state, setState] = useState({ devices: null, error: null });
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    let timer = null;
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    async function read() {
      try {
        const devices = await load();
        if (live) setState({ devices, error: null });
      } catch (failure) {
        if (!live) return;
        if (failure?.code === 'permission_denied') {
          stop();
          setState({ devices: { available: false, reason: 'permission_denied' }, error: null });
          return;
        }
        setState((previous) => ({ devices: previous.devices, error: String(failure?.message || failure || 'failed') }));
      }
    }
    read();
    timer = refreshMs > 0 ? setInterval(read, refreshMs) : null;
    return () => {
      live = false;
      stop();
    };
  }, [enabled, refreshMs, load]);
  if (!enabled) return { devices: null, error: null, reading: false };
  return {
    devices: state.devices,
    error: state.error,
    reading: state.devices === null && state.error === null,
  };
}
