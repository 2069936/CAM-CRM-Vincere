import { describe, it, expect } from 'vitest';
import { ENROLLMENT_CODE_TTL_MS, issueEnrollmentCode } from '../../apiLib/ingestTokens.js';

/* An hour was right when installing was a download and a service registration.
 * The installer now builds the AddOn on the machine, which means fetching the
 * .NET SDK and compiling, and on a slow VPS that is most of an hour before the
 * Setup window opens. Codes expired on the desk with `code_expired` in the audit
 * while the CAM sat looking at a window asking for one. */

describe('how long a pairing code lives', () => {
  it('outlasts an install that now downloads an SDK and compiles', () => {
    expect(ENROLLMENT_CODE_TTL_MS).toBeGreaterThanOrEqual(4 * 60 * 60 * 1000);
  });

  it('stamps the expiry from the clock it was handed, not the real one', () => {
    const now = new Date('2026-09-01T16:00:00.000Z');
    const { record } = issueEnrollmentCode({ pepper: 'p', now });
    expect(record.expiresAt).toBe(new Date(now.getTime() + ENROLLMENT_CODE_TTL_MS).toISOString());
  });

  it('still expires, because a code that never dies is not one-time in practice', () => {
    // Bounded is the point. The exposure is a code left in a chat window, and
    // the answer to that is that it is consumed, not that it is short lived.
    expect(ENROLLMENT_CODE_TTL_MS).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it('lets a caller ask for a shorter one', () => {
    const now = new Date('2026-09-01T16:00:00.000Z');
    const { record } = issueEnrollmentCode({ pepper: 'p', now, ttlMs: 60_000 });
    expect(record.expiresAt).toBe('2026-09-01T16:01:00.000Z');
  });
});
