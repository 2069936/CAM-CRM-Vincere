import { Buffer } from 'node:buffer';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function digest(value, pepper) {
  if (!pepper) throw new Error('Credential pepper is required.');
  return createHmac('sha256', pepper).update(String(value)).digest('hex');
}

export function digestEnrollmentCode(code, pepper) {
  return digest(code, pepper);
}

export function digestDeviceToken(token, pepper) {
  return digest(token, pepper);
}

export function issueEnrollmentCode({ pepper, now = new Date(), ttlMs = 60 * 60 * 1000 } = {}) {
  const bytes = randomBytes(10);
  const code = Array.from(bytes, (byte) => CROCKFORD_BASE32[byte & 31]).join('');
  return {
    code,
    record: {
      credentialHash: digestEnrollmentCode(code, pepper),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    },
  };
}

export function issueDeviceToken({ pepper } = {}) {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    record: {
      credentialHash: digestDeviceToken(token, pepper),
      tokenPrefix: token.slice(0, 8),
    },
  };
}

export function safeEqualHex(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function isExpired(expiresAt, now = new Date()) {
  const expiry = new Date(expiresAt);
  return Number.isNaN(expiry.getTime()) || expiry.getTime() <= now.getTime();
}
