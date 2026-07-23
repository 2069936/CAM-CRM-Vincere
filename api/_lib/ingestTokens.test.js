import { describe, expect, it } from 'vitest';
import {
  digestDeviceToken,
  digestEnrollmentCode,
  isExpired,
  issueDeviceToken,
  issueEnrollmentCode,
  safeEqualHex,
} from './ingestTokens.js';

describe('ingest tokens', () => {
  it('issues a 10-character Crockford Base32 enrollment code with an expiration', () => {
    const issued = issueEnrollmentCode({ pepper: 'test-pepper', now: new Date('2026-01-01T00:00:00Z'), ttlMs: 60_000 });
    expect(issued.code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/);
    expect(issued.record.credentialHash).toBe(digestEnrollmentCode(issued.code, 'test-pepper'));
    expect(isExpired(issued.record.expiresAt, new Date('2026-01-01T00:01:00Z'))).toBe(true);
  });

  it('never stores or logs the raw device token', () => {
    const issued = issueDeviceToken({ pepper: 'test-pepper' });
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(issued.record.credentialHash).not.toContain(issued.token);
    expect(JSON.stringify(issued.record)).not.toContain(issued.token);
    expect(issued.record.tokenPrefix).toHaveLength(8);
    expect(issued.record.credentialHash).toBe(digestDeviceToken(issued.token, 'test-pepper'));
  });

  it('matches equal digests in constant time and safely rejects malformed values', () => {
    const digest = digestDeviceToken('device-token', 'test-pepper');
    expect(safeEqualHex(digest, digest)).toBe(true);
    expect(safeEqualHex(digest, 'not hexadecimal')).toBe(false);
    expect(safeEqualHex(digest, digest.slice(2))).toBe(false);
  });
});
