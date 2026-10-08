// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useDeskDevices, { loadDeskDevices } from './useDeskDevices';
import { AutoCollectionApiError } from '../domain/autoCollectionApi';

/* ------------------------------------------------------------------------- *
 * THE VPS OF EVERY CLIENT, FOR THE MANAGER'S BULBS.
 *
 * The browser cannot read ingest_devices; the Manager reaches the fleet through
 * /api/admin/ingest-fleet, paged by at most 100. This reads every page, keys
 * the devices by the client's uuid, and hands the bulbs a map. A role the
 * route refuses gets `available: false` and the bulbs fall back to samples.
 * ------------------------------------------------------------------------- */

const UUID_1 = '11111111-1111-4111-8111-111111111111';
const UUID_2 = '22222222-2222-4222-8222-222222222222';
const UUID_3 = '33333333-3333-4333-8333-333333333333';

function fleetRow(uuid, name, device) {
  return { client: { uuid, name }, device, todayBatch: null, quarantine: null, operationalStatus: { state: 'received' } };
}
const dev = (id, overrides = {}) => ({ id, status: 'active', healthStatus: 'online', lastSeenAt: '2026-10-08T14:59:00.000Z', lastErrorCode: null, revokedAt: null, ...overrides });

describe('loadDeskDevices', () => {
  it('reads every page of the fleet and keys the devices by the client uuid', async () => {
    const pages = {
      1: { rows: Array.from({ length: 100 }, (_, i) => fleetRow(`u-${i}`, `Client ${i}`, i % 2 ? dev(`d-${i}`) : null)), total: 109 },
      2: { rows: [fleetRow(UUID_1, 'Northwind', dev('d-n', { lastErrorCode: 'ninjatrader_not_running', healthStatus: 'error' })), fleetRow(UUID_2, 'Maple Ridge', null), ...Array.from({ length: 7 }, (_, i) => fleetRow(`v-${i}`, `Other ${i}`, dev(`e-${i}`)))], total: 109 },
    };
    const api = { loadFleet: vi.fn(async ({ page }) => pages[page]) };
    const result = await loadDeskDevices({ api });
    expect(api.loadFleet).toHaveBeenCalledTimes(2);
    expect(api.loadFleet).toHaveBeenNthCalledWith(1, expect.objectContaining({ page: 1, pageSize: 100 }));
    expect(api.loadFleet).toHaveBeenNthCalledWith(2, expect.objectContaining({ page: 2, pageSize: 100 }));
    expect(result.available).toBe(true);
    // A client without a device is not in the map: the bulbs read that as no VPS.
    expect(result.byClientId.has(UUID_2)).toBe(false);
    expect(result.byClientId.get(UUID_1)).toEqual([expect.objectContaining({ id: 'd-n', lastErrorCode: 'ninjatrader_not_running' })]);
    expect(result.byClientId.size).toBe(50 + 1 + 7);
  });

  it('stops when a page comes back short, even if the total says more', async () => {
    const api = { loadFleet: vi.fn(async () => ({ rows: [fleetRow(UUID_3, 'Client A', dev('d-a'))], total: 500 })) };
    const result = await loadDeskDevices({ api });
    expect(api.loadFleet).toHaveBeenCalledTimes(1);
    expect(result.byClientId.size).toBe(1);
  });

  it('lets a refusal through as the error it is', async () => {
    const api = { loadFleet: vi.fn(async () => { throw new AutoCollectionApiError('permission_denied', { status: 403 }); }) };
    await expect(loadDeskDevices({ api })).rejects.toMatchObject({ code: 'permission_denied' });
  });
});

function Probe({ enabled = true, load, refreshMs = 1_000 }) {
  const { devices, error, reading } = useDeskDevices({ enabled, load, refreshMs });
  return (
    <output data-reading={String(reading)}>
      {devices === null ? 'nothing' : devices.available ? `devices:${devices.byClientId.size}` : `unavailable:${devices.reason}`}
      {error ? `|error:${error}` : ''}
    </output>
  );
}
const text = (container) => container.querySelector('output').textContent;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-08T15:00:00.000Z'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function flush(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

describe('useDeskDevices', () => {
  it('reads on mount, then on the cadence, and stops on unmount', async () => {
    const load = vi.fn(async () => ({ available: true, byClientId: new Map([[UUID_1, [dev('d')]]]) }));
    const { container, unmount } = render(<Probe load={load} />);
    expect(container.querySelector('output').getAttribute('data-reading')).toBe('true');
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(text(container)).toBe('devices:1');
    expect(container.querySelector('output').getAttribute('data-reading')).toBe('false');
    await flush(1_000);
    expect(load).toHaveBeenCalledTimes(2);
    unmount();
    await flush(5_000);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('reads nothing while disabled', async () => {
    const load = vi.fn(async () => ({ available: true, byClientId: new Map() }));
    const { container } = render(<Probe load={load} enabled={false} />);
    await flush(3_000);
    expect(load).not.toHaveBeenCalled();
    expect(text(container)).toBe('nothing');
    expect(container.querySelector('output').getAttribute('data-reading')).toBe('false');
  });

  it('answers unavailable when the route refuses the role, and stops asking', async () => {
    const load = vi.fn(async () => { throw new AutoCollectionApiError('permission_denied', { status: 403 }); });
    const { container } = render(<Probe load={load} />);
    await flush();
    expect(text(container)).toBe('unavailable:permission_denied');
    await flush(3_000);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps the last answer beside any other failure', async () => {
    let fail = false;
    const load = vi.fn(async () => {
      if (fail) throw new Error('fleet down');
      return { available: true, byClientId: new Map([[UUID_1, [dev('d')]]]) };
    });
    const { container } = render(<Probe load={load} />);
    await flush();
    expect(text(container)).toBe('devices:1');
    fail = true;
    await flush(1_000);
    expect(text(container)).toBe('devices:1|error:fleet down');
  });
});
