import { Buffer } from 'node:buffer';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENROLLMENT_CODE_PATTERN = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/;
const PAIRING_NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function hasControlCharacter(value) {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function digest(value, pepper) {
  if (!pepper) throw new Error('Credential pepper is required.');
  return createHmac('sha256', pepper).update(String(value)).digest('hex');
}

function domainDigest(domain, value, pepper) {
  if (!pepper) throw new Error('Credential pepper is required.');
  return createHmac('sha256', pepper)
    .update(`cam-crm:${domain}:v1\0`)
    .update(String(value))
    .digest('hex');
}

export function digestEnrollmentCode(code, pepper) {
  return digest(code, pepper);
}

export function digestDeviceToken(token, pepper) {
  return digest(token, pepper);
}

export function digestMachineId(machineId, pepper) {
  return domainDigest('ingest-machine', normalizeMachineId(machineId), pepper);
}

export function digestPairRateLimitKey(clientIp, pepper) {
  const normalized = String(clientIp || '').trim();
  if (!normalized || normalized.length > 128) throw new Error('Trusted client IP is required.');
  return domainDigest('ingest-pair-rate-limit', normalized, pepper);
}

export function normalizeEnrollmentCode(value) {
  const normalized = String(value || '').toUpperCase().replace(/[\s-]+/g, '');
  if (!ENROLLMENT_CODE_PATTERN.test(normalized)) throw new Error('Invalid enrollment code.');
  return normalized;
}

export function normalizeMachineId(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || normalized.length > 256 || hasControlCharacter(normalized)) {
    throw new Error('Invalid machine ID.');
  }
  return normalized;
}

export function normalizePairingNonce(value) {
  const normalized = String(value || '');
  const decoded = Buffer.from(normalized, 'base64url');
  if (!PAIRING_NONCE_PATTERN.test(normalized) || decoded.length !== 32) {
    throw new Error('Invalid pairing nonce.');
  }
  return decoded.toString('base64url');
}

export function deriveDeviceToken({ enrollmentCode, machineId, pairingNonce, pepper } = {}) {
  if (!pepper) throw new Error('Credential pepper is required.');
  const code = normalizeEnrollmentCode(enrollmentCode);
  const machine = normalizeMachineId(machineId);
  const nonce = normalizePairingNonce(pairingNonce);
  const token = createHmac('sha256', pepper)
    .update('cam-crm:ingest-device-token:v1\0')
    .update(code)
    .update('\0')
    .update(machine)
    .update('\0')
    .update(nonce)
    .digest('base64url');
  return {
    token,
    record: {
      credentialHash: digestDeviceToken(token, pepper),
      tokenPrefix: token.slice(0, 8),
    },
  };
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
