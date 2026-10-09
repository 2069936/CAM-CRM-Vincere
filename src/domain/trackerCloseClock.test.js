import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import process from 'node:process';
import { buildTrackerClosePanel } from './trackerClosePanel';
import { compareTrackerToClose } from './trackerCloseComparison';
import { ANSWER, CLIENT, DATE, READINGS, SETTINGS, dailyImport } from '../components/trackerCloseFixtures.test-helpers';

/* ------------------------------------------------------------------------- *
 * THE HEADER AND THE VERDICT SENTENCES IN ONE CLOCK, IN A FIXED ZONE.
 *
 * The verdict sentences used to print UTC ("20:30 UTC") under a header in the
 * viewer's own clock ("16:31"): the same afternoon in two zones, one line
 * apart. The suite runs in UTC on CI, where the two read alike, so this file
 * pins the viewer's zone to New York, the close's own, and asks the DEFAULT
 * path, with no formatter handed in.
 * ------------------------------------------------------------------------- */

const zone = process.env.TZ;
beforeAll(() => { process.env.TZ = 'America/New_York'; });
afterAll(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

describe('a viewer in New York', () => {
  it('reads the capture, the comparison and the tracker sentence in New York time', () => {
    // The zone took: 20:30 UTC is 16:30 here.
    expect(new Date('2026-10-07T20:30:00.000Z').getHours()).toBe(16);
    const view = buildTrackerClosePanel({ client: CLIENT, dailyImport: dailyImport(), date: DATE, answer: ANSWER });
    expect(view.header.words).toBe('Close captured 16:31, compared 16:31, tolerance $5');
    const trackerOnly = view.rows.find((row) => row.verdict === 'tracker_only');
    expect(trackerOnly.sentence).toBe('The tracker saw this account at 16:30 but the close does not list it.');
    const differs = view.rows.find((row) => row.verdict === 'differs');
    expect(differs.trackerWords.sampled).toBe('sampled 16:30, held since 16:20');
  });

  it('reads the sentence in New York time from the comparison alone, with no formatter handed in', () => {
    const result = compareTrackerToClose({ readings: [READINGS[0]], accountSnapshots: [], settings: SETTINGS });
    expect(result.rows[0].verdict).toBe('tracker_only');
    expect(result.rows[0].sentence).toBe('The tracker saw this account at 16:30 but the close does not list it.');
  });
});
