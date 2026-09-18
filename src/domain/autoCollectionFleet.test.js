import { describe, expect, it } from 'vitest';
import { classifyFleetRow, newYorkTradingClock, summarizeIngestDay } from './autoCollectionFleet';

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

  it('treats an explicitly non-active device as operationally paused', () => {
    expect(classify('2026-07-23T21:01:00.000Z', {
      device: { ...onlineDevice, status: 'paused' },
    }).state).toBe('paused');
  });

  it('marks a processed current-date batch received', () => {
    expect(classify('2026-07-23T21:01:00.000Z', { todayBatch: { status: 'processed' } }).state).toBe('received');
  });
});

describe("the day's ingest line", () => {
  const day = [
    { status: 'processed', ingestDurationMs: 400, admissionDeferrals: 0 },
    { status: 'incomplete', ingestDurationMs: 1200, admissionDeferrals: 2 },
    { status: 'replaced', ingestDurationMs: 900, admissionDeferrals: 0 },
    { status: 'failed', ingestDurationMs: 6000, admissionDeferrals: 1 },
    { status: 'received', ingestDurationMs: null, admissionDeferrals: 3 },
  ];

  it('counts what the CRM stored, not what it was sent', () => {
    // A batch still in 'received' has not been accepted yet and a 'failed' one
    // was not accepted at all.
    expect(summarizeIngestDay(day).accepted).toBe(3);
  });

  it('counts door firings rather than machines, because that is what sizes the cap', () => {
    // Six refusals across three captures. A count of distinct machines would
    // read three and would say nothing about how hard the door was working.
    expect(summarizeIngestDay(day).shed).toBe(6);
  });

  it('measures every batch that carries a time, including the ones that failed', () => {
    const summary = summarizeIngestDay(day);
    expect(summary.measured).toBe(4);
    expect(summary.slowestMs).toBe(6000);
    // Four measurements: 400, 900, 1200, 6000. The lower middle, so the median
    // is an upload somebody can go and look at.
    expect(summary.medianMs).toBe(900);
  });

  it('reports nothing measured as null rather than as zero', () => {
    // Before migration step 45 runs, no batch carries a duration. Zero would
    // read as "every upload was instant".
    expect(summarizeIngestDay([{ status: 'processed' }])).toMatchObject({
      accepted: 1, shed: 0, measured: 0, medianMs: null, slowestMs: null,
    });
    expect(summarizeIngestDay()).toMatchObject({ accepted: 0, shed: 0, medianMs: null });
  });
});
