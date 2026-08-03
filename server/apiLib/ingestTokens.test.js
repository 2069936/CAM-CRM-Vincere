import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  deriveDeviceToken,
  digestDeviceToken,
  digestEnrollmentCode,
  digestMachineId,
  digestPairRateLimitKey,
  normalizeEnrollmentCode,
  normalizeMachineId,
  normalizePairingNonce,
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

  it('uses an exact 60-minute enrollment expiration by default', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const issued = issueEnrollmentCode({ pepper: 'test-pepper', now });
    expect(issued.record.expiresAt).toBe('2026-01-01T01:00:00.000Z');
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

  it('normalizes Crockford enrollment codes and Windows MachineGuids', () => {
    expect(normalizeEnrollmentCode(' abcd-efgh-jk ')).toBe('ABCDEFGHJK');
    expect(normalizeMachineId('  A1B2-C3D4  ')).toBe('a1b2-c3d4');
    expect(() => normalizeEnrollmentCode('ABCD-EFIO-JK')).toThrow('Invalid enrollment code.');
    expect(() => normalizeMachineId('   ')).toThrow('Invalid machine ID.');
  });

  it('requires a canonical 32-byte base64url pairing nonce', () => {
    const nonce = Buffer.alloc(32, 7).toString('base64url');
    expect(normalizePairingNonce(nonce)).toBe(nonce);
    expect(() => normalizePairingNonce('too-short')).toThrow('Invalid pairing nonce.');
    expect(() => normalizePairingNonce(`${nonce}=`)).toThrow('Invalid pairing nonce.');
  });

  it('canonicalizes accepted base64url nonce spellings with nonzero unused pad bits', () => {
    const canonical = Buffer.alloc(32, 7).toString('base64url');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const lastIndex = alphabet.indexOf(canonical.at(-1));
    const alternate = `${canonical.slice(0, -1)}${alphabet[(lastIndex & 0b110000) | 0b001111]}`;
    expect(alternate).not.toBe(canonical);
    expect(Buffer.from(alternate, 'base64url')).toEqual(Buffer.from(canonical, 'base64url'));
    expect(normalizePairingNonce(alternate)).toBe(canonical);

    const baseArgs = { enrollmentCode: 'ABCDEFGHJK', machineId: 'machine-guid', pepper: 'test-pepper' };
    expect(deriveDeviceToken({ ...baseArgs, pairingNonce: alternate }))
      .toEqual(deriveDeviceToken({ ...baseArgs, pairingNonce: canonical }));
  });

  it('derives a deterministic pseudorandom token bound to code, machine, and nonce', () => {
    const args = {
      enrollmentCode: 'ABCDEFGHJK',
      machineId: 'machine-guid',
      pairingNonce: Buffer.alloc(32, 9).toString('base64url'),
      pepper: 'test-pepper',
    };
    const first = deriveDeviceToken(args);
    const retry = deriveDeviceToken(args);
    expect(first).toEqual(retry);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.record.credentialHash).toBe(digestDeviceToken(first.token, args.pepper));
    expect(JSON.stringify(first.record)).not.toContain(first.token);
    expect(deriveDeviceToken({ ...args, machineId: 'other-machine' }).token).not.toBe(first.token);
    expect(deriveDeviceToken({ ...args, pairingNonce: Buffer.alloc(32, 10).toString('base64url') }).token).not.toBe(first.token);
  });

  it('domain-separates machine and rate-limit identity HMACs', () => {
    const machine = digestMachineId('machine-guid', 'test-pepper');
    const rateKey = digestPairRateLimitKey('203.0.113.4', 'test-pepper');
    expect(machine).toMatch(/^[a-f0-9]{64}$/);
    expect(rateKey).toMatch(/^[a-f0-9]{64}$/);
    expect(machine).not.toBe(digestDeviceToken('machine-guid', 'test-pepper'));
    expect(rateKey).not.toContain('203.0.113.4');
  });
});
