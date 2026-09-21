import { describe, expect, it } from 'vitest';
import { classifyFleetRow, describeQuarantineItem, newYorkTradingClock, quarantineHeadline, summarizeFleet, summarizeIngestDay, summarizeQuarantine } from './autoCollectionFleet';

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

/* THE FOLDER ON THE VPS, AS A STATE ON THE ROW.
 *
 * Every 422 quarantine also exists here as a failed batch, raw snapshot
 * included, and a 400, a 413 and every queue level code never reached
 * storage. The split is what tells the desk whether the fix is one click in
 * the failed closes panel or a capture only the VPS has. */
describe('a quarantine on the VPS', () => {
  const retrying = { captureId: 'a', tradingDate: '2026-09-14', code: 'snapshot_processing_failed', attempts: 1, final: false, stored: { batchId: 'b1', status: 'failed', errorCode: 'normalization_failed' } };
  const finalStored = { captureId: 'b', tradingDate: '2026-09-17', code: 'snapshot_processing_failed', attempts: 3, final: true, stored: { batchId: 'b2', status: 'failed', errorCode: 'persistence_failed' } };
  const neverStored = { captureId: 'c', tradingDate: '2026-09-18', code: 'snapshot_rejected', attempts: 0, final: true, stored: null };

  it('is its own state, ahead of a day that arrived and a day still to come', () => {
    const quarantine = summarizeQuarantine([retrying]);
    expect(classify('2026-07-23T21:01:00.000Z', { todayBatch: { status: 'processed' }, quarantine }).state).toBe('quarantine');
    expect(classify('2026-07-23T20:30:00.000Z', { quarantine }).state).toBe('quarantine');
    expect(classify('2026-07-25T21:10:00.000Z', { quarantine }).state).toBe('quarantine');
  });

  it('says how many, and how many the agent will not send again', () => {
    const status = classify('2026-07-23T21:01:00.000Z', { todayBatch: { status: 'processed' }, quarantine: summarizeQuarantine([retrying, finalStored, neverStored]) });
    expect(status.label).toBe('Quarantine');
    expect(status.detail).toBe('3 captures in quarantine on the VPS. 2 are final and need action here; 1 will be retried by the agent at its next daily review.');
    expect(quarantineHeadline(summarizeQuarantine([retrying]))).toBe('1 capture in quarantine on the VPS. 1 will be retried by the agent at its next daily review.');
    expect(quarantineHeadline(summarizeQuarantine([]))).toBe('');
  });

  it('yields to today being late, offline, failed and the rest, which are the newer fact', () => {
    const quarantine = summarizeQuarantine([finalStored]);
    expect(classify('2026-07-23T21:01:00.000Z', { quarantine }).state).toBe('late');
    expect(classify('2026-07-23T21:01:00.000Z', { quarantine, device: { ...onlineDevice, lastSeenAt: '2026-07-23T20:40:00.000Z' } }).state).toBe('offline');
    expect(classify('2026-07-23T21:01:00.000Z', { quarantine, device: { ...onlineDevice, healthStatus: 'error', lastErrorCode: 'capture_failed' } }).state).toBe('failed');
    expect(classify('2026-07-23T21:01:00.000Z', { quarantine, todayBatch: { status: 'incomplete' } }).state).toBe('incomplete');
  });

  it('is nothing before step 46 has run, and nothing when the folder is empty', () => {
    expect(classify('2026-07-23T21:01:00.000Z', { todayBatch: { status: 'processed' }, quarantine: null }).state).toBe('received');
    expect(classify('2026-07-23T21:01:00.000Z', { todayBatch: { status: 'processed' }, quarantine: summarizeQuarantine([]) }).state).toBe('received');
  });

  it('needs attention only when the agent will never send one of them again', () => {
    const rows = (quarantine) => [{ quarantine, operationalStatus: classify('2026-07-23T21:01:00.000Z', { todayBatch: { status: 'processed' }, quarantine }) }];
    expect(summarizeFleet(rows(summarizeQuarantine([retrying])))).toMatchObject({ quarantine: 1, attention: 0 });
    expect(summarizeFleet(rows(summarizeQuarantine([retrying, finalStored])))).toMatchObject({ quarantine: 1, attention: 1 });
  });

  it('counts final from the rows and lists newest trading date first', () => {
    const summary = summarizeQuarantine([retrying, neverStored, finalStored]);
    expect(summary).toMatchObject({ count: 3, final: 2 });
    expect(summary.items.map((item) => item.tradingDate)).toEqual(['2026-09-18', '2026-09-17', '2026-09-14']);
  });

  it('tells the desk where the capture is: stored here as a failed close, or only on the VPS', () => {
    expect(describeQuarantineItem(retrying).storage).toBe('Stored here as a failed close. Reprocess it from the failed closes panel.');
    expect(describeQuarantineItem(neverStored).storage).toBe('Never stored here. Only the VPS has this capture.');
    // Replayed from here after the VPS gave up on it: the day is not missing.
    expect(describeQuarantineItem({ ...finalStored, stored: { batchId: 'b2', status: 'processed' } }).storage)
      .toBe('Already processed here. Nothing is missing from this side.');
  });

  it('tells the desk what the agent will do, counting the attempt it is about to make', () => {
    expect(describeQuarantineItem(retrying).agent).toBe('The agent retries it at its next daily review, attempt 2 of 3.');
    expect(describeQuarantineItem(finalStored).agent).toBe('The agent retried it 3 times and will not again.');
    expect(describeQuarantineItem(neverStored).agent).toBe('The agent will not retry it.');
  });
});
