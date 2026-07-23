import { describe, expect, it } from 'vitest';
import { classifyFleetRow, newYorkTradingClock } from './autoCollectionFleet';

const onlineDevice = {
  status: 'active',
  healthStatus: 'online',
  lastSeenAt: '2026-07-23T20:44:00.000Z',
  agentVersion: '1.4.2',
};

function classify(now, overrides = {}) {
  return classifyFleetRow({
    now,
    releaseVersion: '1.4.2',
    device: { ...onlineDevice, lastSeenAt: now },
    todayBatch: null,
    schedule: { time: '16:45:00', timezone: 'America/New_York' },
    ...overrides,
  });
}

describe('New York collector schedule', () => {
  it('converts UTC through DST without a fixed-offset assumption', () => {
    expect(newYorkTradingClock('2026-07-23T20:45:00.000Z')).toMatchObject({ date: '2026-07-23', minuteOfDay: 16 * 60 + 45, weekday: 4 });
    expect(newYorkTradingClock('2026-01-23T21:45:00.000Z')).toMatchObject({ date: '2026-01-23', minuteOfDay: 16 * 60 + 45, weekday: 5 });
  });

  it('keeps weekdays pending before the scheduled capture', () => {
    expect(classify('2026-07-23T20:30:00.000Z').state).toBe('pending');
  });

  it('uses a grace period before declaring a missing capture late', () => {
    expect(classify('2026-07-23T20:55:00.000Z').state).toBe('expected');
    expect(classify('2026-07-23T21:01:00.000Z').state).toBe('late');
  });

  it('does not expect a normal capture on weekends', () => {
    expect(classify('2026-07-25T21:10:00.000Z').state).toBe('not_expected');
  });
});

describe('collector fleet state priority', () => {
  it('surfaces incomplete batches even when the device is online', () => {
    expect(classify('2026-07-23T21:01:00.000Z', { todayBatch: { status: 'incomplete' } }).state).toBe('incomplete');
  });

  it('surfaces revoked, update-required, and offline devices', () => {
    expect(classify('2026-07-23T21:01:00.000Z', { device: { ...onlineDevice, status: 'revoked', revokedAt: '2026-07-23T20:00:00Z' } }).state).toBe('revoked');
    expect(classify('2026-07-23T21:01:00.000Z', { device: { ...onlineDevice, healthStatus: 'update_required' } }).state).toBe('update_required');
    expect(classify('2026-07-23T21:01:00.000Z', { device: { ...onlineDevice, lastSeenAt: '2026-07-23T20:40:00.000Z' } }).state).toBe('offline');
  });

  it('marks a processed current-date batch received', () => {
    expect(classify('2026-07-23T21:01:00.000Z', { todayBatch: { status: 'processed' } }).state).toBe('received');
  });
});
