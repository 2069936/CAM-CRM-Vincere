import { describe, expect, it } from 'vitest';
import {
  disconnectedSinceByClient,
  disconnectedSinceWords,
  disconnectedStretchStart,
  historyWindowStart,
} from './disconnectedSince';

/* ------------------------------------------------------------------------- *
 * "DISCONNECTED SINCE 09:40", FROM THE TRACKER'S HISTORY (step 66).
 *
 * The history is runs: one row per stretch of identical readings per device
 * and account. A new run opens whenever anything changes, so one disconnected
 * stretch can be several runs; the start is the earliest of the unbroken
 * stretch of not connected runs that ends at the latest one. Times are built
 * in the viewer's own clock so the assertions hold in any time zone.
 * ------------------------------------------------------------------------- */

const at = (hours, minutes = 0, day = 5) => new Date(2026, 9, day, hours, minutes).toISOString();
const NOW = new Date(2026, 9, 5, 11, 0);
const UUID = '9c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';

function run(accountName, connected, first, last, over = {}) {
  return {
    clientId: UUID, deviceId: 'dev-1', accountName, connected, status: connected ? 'Connected' : 'Disconnected',
    runState: 'running', firstSampledAt: first, lastSampledAt: last, samples: 3, ...over,
  };
}

const history = (rows) => ({ available: true, rows });

describe('the stretch: the latest run and the not connected runs right before it', () => {
  it('takes the first sample of the latest not connected run', () => {
    const start = disconnectedStretchStart([
      run('ACC 01', true, at(6, 30), at(9, 30)),
      run('ACC 01', false, at(9, 40), at(10, 58)),
    ]);
    expect(start).toBe(Date.parse(at(9, 40)));
  });

  it('walks back over several not connected runs (the money or the status changed), and stops at a connected one', () => {
    const start = disconnectedStretchStart([
      run('ACC 01', false, at(6, 30), at(7, 0)),
      run('ACC 01', true, at(7, 10), at(9, 30)),
      run('ACC 01', false, at(9, 40), at(10, 0)),
      run('ACC 01', false, at(10, 10), at(10, 30), { status: 'ConnectionLost' }),
      run('ACC 01', false, at(10, 40), at(10, 58), { totalPnl: -20 }),
    ]);
    // 09:40, not 10:40 (the latest run alone) and not 06:30 (before the reconnect).
    expect(start).toBe(Date.parse(at(9, 40)));
  });

  it('says nothing when the latest run is connected', () => {
    expect(disconnectedStretchStart([run('ACC 01', false, at(9, 0), at(9, 30)), run('ACC 01', true, at(9, 40), at(10, 58))])).toBeNull();
    expect(disconnectedStretchStart([])).toBeNull();
  });

  it('with two devices on one account, the one that sampled last speaks', () => {
    const rows = [
      run('ACC 01', false, at(8, 0), at(9, 0), { deviceId: 'old-vps' }),
      run('ACC 01', true, at(6, 30), at(10, 0), { deviceId: 'new-vps' }),
      run('ACC 01', false, at(10, 10), at(10, 58), { deviceId: 'new-vps' }),
    ];
    expect(disconnectedStretchStart(rows)).toBe(Date.parse(at(10, 10)));
    // And when the device that sampled last says connected, nothing is said.
    expect(disconnectedStretchStart([
      run('ACC 01', false, at(8, 0), at(9, 0), { deviceId: 'old-vps' }),
      run('ACC 01', true, at(6, 30), at(10, 58), { deviceId: 'new-vps' }),
    ])).toBeNull();
  });
});

describe('the words', () => {
  const dayStart = historyWindowStart(NOW).getTime();

  it('says the clock when the stretch started today', () => {
    expect(disconnectedSinceWords(Date.parse(at(9, 40)), { dayStart, firstToday: Date.parse(at(6, 30)) })).toBe('Disconnected since 09:40');
  });

  it('says "since before" the first run of today when the stretch started yesterday, never yesterday\'s clock', () => {
    const yesterday = Date.parse(at(15, 10, 4));
    expect(disconnectedSinceWords(yesterday, { dayStart, firstToday: Date.parse(at(6, 30)) })).toBe('Disconnected since before 06:30');
    expect(disconnectedSinceWords(yesterday, { dayStart, firstToday: null })).toBe('Disconnected since before today');
    expect(disconnectedSinceWords(null, { dayStart })).toBeNull();
  });

  it('the window starts at the viewer\'s midnight', () => {
    expect(historyWindowStart(NOW).getTime()).toBe(new Date(2026, 9, 5, 0, 0).getTime());
  });
});

describe('every account the history can speak about, by client', () => {
  it('maps the client key to account words, and the first run of today comes from any account of the client', () => {
    const map = disconnectedSinceByClient(history([
      run('ACC 02', true, at(6, 30), at(10, 58)),
      run('ACC 01', true, at(7, 0), at(9, 30)),
      run('ACC 01', false, at(9, 40), at(10, 58)),
      // ACC 03 has been disconnected since yesterday afternoon, one long run.
      run('ACC 03', false, at(15, 10, 4), at(10, 58)),
    ]), { now: NOW });
    expect([...map.keys()]).toEqual([UUID]);
    expect(Object.fromEntries(map.get(UUID))).toEqual({
      'ACC 01': 'Disconnected since 09:40',
      'ACC 03': 'Disconnected since before 06:30',
    });
  });

  it('says nothing when the history is not deployed, could not be read, or has no rows', () => {
    expect(disconnectedSinceByClient({ available: false, reason: 'not_deployed' }, { now: NOW }).size).toBe(0);
    expect(disconnectedSinceByClient(null, { now: NOW }).size).toBe(0);
    expect(disconnectedSinceByClient(history([]), { now: NOW }).size).toBe(0);
  });

  it('never prints a dash', () => {
    const map = disconnectedSinceByClient(history([run('ACC 01', false, at(9, 40), at(10, 58)), run('ACC 03', false, at(15, 0, 4), at(10, 58))]), { now: NOW });
    for (const words of map.get(UUID).values()) expect(words).not.toMatch(/[—–]| - /);
  });
});
