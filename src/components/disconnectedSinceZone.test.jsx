// @vitest-environment jsdom
import process from 'node:process';
import { renderHook, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import useDisconnectedSince from './useDisconnectedSince';
import { disconnectedSinceByClient, historyWindowStart } from '../domain/disconnectedSince';

/* ------------------------------------------------------------------------- *
 * "TODAY" IS THE VIEWER'S DAY, PINNED IN A ZONE THAT IS NOT UTC.
 *
 * The history behind "Disconnected since 09:40" is read from the viewer's
 * local midnight, and a stretch that began before it is said as "since
 * before". The suite runs in UTC on CI, where local midnight and UTC midnight
 * are the same instant, so a regression to UTC midnight would pass there. This
 * file pins the viewer to Bogota (UTC minus 5, no daylight saving) and the
 * clock to 21:00 there, which is already 02:00 tomorrow in UTC: the two
 * midnights are 19 hours apart and every assertion below tells them apart.
 * ------------------------------------------------------------------------- */

const zone = process.env.TZ;
beforeAll(() => { process.env.TZ = 'America/Bogota'; });
afterAll(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});
afterEach(() => { vi.useRealTimers(); });

// 21:00 on 5 October in Bogota; 02:00 on 6 October in UTC.
const EVENING = new Date('2026-10-06T02:00:00.000Z');
const LOCAL_MIDNIGHT = '2026-10-05T05:00:00.000Z';
const UTC_MIDNIGHT = '2026-10-06T00:00:00.000Z';

describe('a viewer in Bogota at nine in the evening', () => {
  it('is in the zone the file pinned', () => {
    expect(EVENING.getHours()).toBe(21);
    expect(EVENING.getDate()).toBe(5);
  });

  it('starts the history window at Bogota\'s midnight, not UTC\'s', () => {
    expect(historyWindowStart(EVENING).toISOString()).toBe(LOCAL_MIDNIGHT);
    expect(historyWindowStart(EVENING.getTime()).toISOString()).toBe(LOCAL_MIDNIGHT);
    expect(historyWindowStart(EVENING.toISOString()).toISOString()).not.toBe(UTC_MIDNIGHT);
  });

  it('and with no clock handed in, from the system clock, the same', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(EVENING);
    expect(historyWindowStart(null).toISOString()).toBe(LOCAL_MIDNIGHT);
  });

  it('says "since 18:00" for a stretch that began at six this evening, which is yesterday in UTC', () => {
    const history = {
      available: true,
      rows: [
        { clientId: 'c-1', deviceId: 'd', accountName: 'ACC 01', connected: true, firstSampledAt: '2026-10-05T13:00:00.000Z', lastSampledAt: '2026-10-05T22:50:00.000Z' },
        { clientId: 'c-1', deviceId: 'd', accountName: 'ACC 01', connected: false, firstSampledAt: '2026-10-05T23:00:00.000Z', lastSampledAt: '2026-10-06T01:58:00.000Z' },
        // Since before the first run of the day: 23:30 last night in Bogota.
        { clientId: 'c-1', deviceId: 'd', accountName: 'ACC 02', connected: false, firstSampledAt: '2026-10-05T04:30:00.000Z', lastSampledAt: '2026-10-06T01:58:00.000Z' },
      ],
    };
    const words = disconnectedSinceByClient(history, { now: EVENING }).get('c-1');
    expect(words.get('ACC 01')).toBe('Disconnected since 18:00');
    expect(words.get('ACC 02')).toBe('Disconnected since before 08:00');
  });

  it('asks the history from Bogota\'s midnight, through the hook the panels use', async () => {
    const load = vi.fn(async () => ({ available: true, rows: [] }));
    renderHook(() => useDisconnectedSince({ clientIds: ['c-1'], clock: EVENING.getTime(), load }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    expect(load).toHaveBeenCalledWith({ clientIds: ['c-1'], since: LOCAL_MIDNIGHT });
  });
});
