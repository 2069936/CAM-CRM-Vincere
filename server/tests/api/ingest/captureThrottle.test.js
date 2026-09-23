import { describe, expect, it } from 'vitest';
import {
  QUIET_MS,
  THROTTLE_REASON,
  decideCaptureThrottle,
  throttledCompleteness,
  completenessWithOpenPositions,
} from '../../../autoCollection/ingest/captureThrottle.js';

/* The storm this exists for, measured on 2026-09-22: one VPS sent 62 captures
 * of the same trading day between 16:30 and 17:00, because its client still had
 * positions open and the agent re-captures every 15 seconds until the cutoff.
 * Each capture rewrote the client's whole day. The rule below skips the middle
 * of that and never, under any circumstance, skips the close. */
const NOW = '2026-09-22T20:45:00.000Z';
const OPEN = { open: true, accounts: [{ accountName: 'A', unrealizedPnl: -420 }], unrealizedTotal: -420 };
const SETTLED = { open: false, accounts: [], unrealizedTotal: 0 };

function day(secondsAgo, extra = {}) {
  return {
    id: 'daily-1',
    status: 'Open',
    updatedAt: new Date(Date.parse(NOW) - secondsAgo * 1000).toISOString(),
    ...extra,
  };
}

function decide(openPositions, dailyImport, now = NOW) {
  return decideCaptureThrottle({ openPositions, dailyImport, now });
}

describe('capture throttle', () => {
  it('skips a provisional capture on a day rewritten seconds ago', () => {
    const decision = decide(OPEN, day(15));
    expect(decision).toMatchObject({ skip: true, reason: THROTTLE_REASON, dailyImportId: 'daily-1' });
    expect(decision.quietForMs).toBe(15000);
  });

  it('never skips the settled close, however soon it arrives', () => {
    // The whole storm exists to produce this one. If it is ever skipped the
    // day keeps a reading taken while money was still moving, which is the
    // 2026-09-08 bug the agent's retry was written to prevent: -$2,064 stood
    // for a day that was really -$1,319.
    for (const secondsAgo of [0, 1, 15, 60]) {
      expect(decide(SETTLED, day(secondsAgo))).toMatchObject({ skip: false, reason: 'settled_capture' });
    }
  });

  it('never skips when nothing is the day yet', () => {
    expect(decide(OPEN, null)).toMatchObject({ skip: false, reason: 'no_daily_import_yet' });
    expect(decide(OPEN, { id: null })).toMatchObject({ skip: false, reason: 'no_daily_import_yet' });
  });

  it('lets a provisional capture through once the day has gone quiet', () => {
    // Otherwise a day whose captures are ALL provisional would freeze on the
    // 16:30 reading and never move again.
    expect(decide(OPEN, day(QUIET_MS / 1000))).toMatchObject({ skip: false, reason: 'day_is_stale' });
    expect(decide(OPEN, day(QUIET_MS / 1000 + 1))).toMatchObject({ skip: false, reason: 'day_is_stale' });
    expect(decide(OPEN, day(QUIET_MS / 1000 - 1))).toMatchObject({ skip: true });
  });

  it('leaves a closed day to the branch that refuses it by name', () => {
    expect(decide(OPEN, day(5, { status: 'Closed' }))).toMatchObject({ skip: false, reason: 'closed_day' });
  });

  it('treats an unusable timestamp as no evidence, and writes', () => {
    for (const updatedAt of [null, '', 'not a date', undefined]) {
      expect(decide(OPEN, day(5, { updatedAt }))).toMatchObject({ skip: false, reason: 'unknown_daily_import_age' });
    }
    // A clock that went backwards is a broken measurement, not a fresh day.
    expect(decide(OPEN, day(-30))).toMatchObject({ skip: false, reason: 'day_is_stale' });
  });

  it('treats a missing or malformed openPositions as settled, which writes', () => {
    // The field is computed by the normalizer on every capture, but if it is
    // ever absent the safe reading is "this might be the close".
    for (const value of [null, undefined, {}, { open: 'yes' }, { open: null }]) {
      expect(decide(value, day(5))).toMatchObject({ skip: false, reason: 'settled_capture' });
    }
  });

  it('thins a real storm to the shape the desk expects', () => {
    // 30 minutes of captures every 15 seconds, all provisional, then a settled
    // one at the end. Replays the 2026-09-22 device against the rule.
    const start = Date.parse('2026-09-22T20:30:00.000Z');
    let current = null;
    let written = 0;
    for (let tick = 0; tick < 120; tick += 1) {
      const now = new Date(start + tick * 15000).toISOString();
      const settled = tick === 119;
      const decision = decideCaptureThrottle({
        openPositions: settled ? SETTLED : OPEN,
        dailyImport: current,
        now,
      });
      if (!decision.skip) {
        written += 1;
        current = { id: 'daily-1', status: 'Open', updatedAt: now };
      }
    }
    // 62 became 7: one at 16:30, one every five minutes after it, and the
    // settled close at the end, which is the one that matters.
    expect(written).toBe(7);
  });
});

describe('what the batch records', () => {
  it('keeps the open-positions detail the CRM was already computing and discarding', () => {
    const metadata = { isComplete: true, emptySections: [], openPositions: OPEN };
    expect(completenessWithOpenPositions(metadata)).toEqual({
      isComplete: true, emptySections: [], openPositions: OPEN,
    });
  });

  it('marks a skipped capture as skipped, with why and how fresh the day was', () => {
    const decision = decide(OPEN, day(15));
    expect(throttledCompleteness({ isComplete: false, emptySections: ['orders'], openPositions: OPEN }, decision))
      .toEqual({
        isComplete: false,
        emptySections: ['orders'],
        openPositions: OPEN,
        throttled: { skipped: true, reason: THROTTLE_REASON, quietForMs: 15000 },
      });
  });

  it('survives metadata that is missing pieces', () => {
    expect(completenessWithOpenPositions(null)).toEqual({ isComplete: null, emptySections: [], openPositions: null });
    expect(completenessWithOpenPositions({})).toEqual({ isComplete: null, emptySections: [], openPositions: null });
  });
});
