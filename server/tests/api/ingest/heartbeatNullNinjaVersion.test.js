import { describe, it, expect } from 'vitest';
import { normalizeHeartbeatBody } from '../../../autoCollection/ingest/heartbeat.js';

/* THE DEADLOCK THIS UNDOES.
 *
 * ninjaTraderVersion was validated as a required version string, and the agent
 * does not know that version until the add-on has told it. So a machine that
 * had not completed a capture sent null, the heartbeat was refused as malformed
 * with a 400, and because ninjatrader_version is only ever written BY a
 * heartbeat, the device could never acquire the value that would let its
 * heartbeats be accepted.
 *
 * Observed on the desk: four devices paired across three days, every one with
 * ninjatrader_version NULL, health_status 'pending', last_seen_at frozen at the
 * second it paired, and nine captured snapshots waiting on disk. */

const body = (over = {}) => ({
  agentVersion: '1.0.2',
  addonVersion: '1.0.0',
  ninjaTraderVersion: null,
  lastCaptureAt: null,
  lastSuccessAt: null,
  lastErrorCode: null,
  lastErrorMessage: null,
  queueDepth: 9,
  queueBytes: 23481,
  addonAvailable: true,
  ...over,
});

describe('a collector that does not know its NinjaTrader version yet', () => {
  it('is accepted, because not knowing yet is what a new install looks like', () => {
    expect(normalizeHeartbeatBody(body())).toMatchObject({
      agentVersion: '1.0.2',
      ninjaTraderVersion: null,
      queueDepth: 9,
    });
  });

  it.each([[null], [undefined], ['']], )('treats %p as not known rather than as malformed', (value) => {
    expect(normalizeHeartbeatBody(body({ ninjaTraderVersion: value })).ninjaTraderVersion).toBeNull();
  });

  it('treats whitespace as not known too', () => {
    expect(normalizeHeartbeatBody(body({ ninjaTraderVersion: '   ' })).ninjaTraderVersion).toBeNull();
  });

  it('still records the version once the add-on reports one', () => {
    expect(normalizeHeartbeatBody(body({ ninjaTraderVersion: '8.1.5.2' })).ninjaTraderVersion).toBe('8.1.5.2');
  });

  it('still rejects a NinjaTrader version that is not a version', () => {
    // Relaxing null must not relax the string itself. This column is displayed.
    for (const bad of ['not-a-version', '8.1.5.2-beta', '<script>', '1'.repeat(40)]) {
      expect(() => normalizeHeartbeatBody(body({ ninjaTraderVersion: bad }))).toThrow();
    }
  });
});

describe('what stays required', () => {
  it('still demands the agent and add-on versions, which the agent always knows', () => {
    expect(() => normalizeHeartbeatBody(body({ agentVersion: null }))).toThrow();
    expect(() => normalizeHeartbeatBody(body({ addonVersion: null }))).toThrow();
    expect(() => normalizeHeartbeatBody(body({ agentVersion: 'nope' }))).toThrow();
  });

  it('still refuses a body carrying a key it does not know', () => {
    expect(() => normalizeHeartbeatBody({ ...body(), schemaVersion: 1 })).toThrow();
  });
});
