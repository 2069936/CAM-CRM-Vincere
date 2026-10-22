import { describe, expect, it } from 'vitest';
import {
  CAPTURE_SOURCE, FROM_TRACKER_LABEL, TRACKER_SOURCE, fromTrackerCountLabel, isFromTracker, sourceFromRow,
} from './provisionalRows.js';

describe('a row the tracker wrote (step 73)', () => {
  it('reads the stored source back as tracker or capture and nothing else', () => {
    expect(sourceFromRow('tracker')).toBe(TRACKER_SOURCE);
    expect(sourceFromRow('capture')).toBe(CAPTURE_SOURCE);
    // A database without step 73 has no column: every row is a capture.
    for (const value of [undefined, null, '', 'Tracker', 'guess']) expect(sourceFromRow(value)).toBe('capture');
  });

  it('marks only a tracker row, in the words every screen uses', () => {
    expect(isFromTracker({ source: 'tracker' })).toBe(true);
    expect(isFromTracker({ source: 'capture' })).toBe(false);
    expect(isFromTracker({})).toBe(false);
    expect(isFromTracker(null)).toBe(false);
    expect(FROM_TRACKER_LABEL).toBe('From the tracker, no fills');
  });
});

describe('a count of provisional rows', () => {
  it('reads as one line for a table cell', () => {
    expect(fromTrackerCountLabel(1)).toBe('1 account from the tracker, no fills');
    expect(fromTrackerCountLabel(3)).toBe('3 accounts from the tracker, no fills');
  });
});
