import process from 'node:process';
import { createServiceClient } from '../_lib/apiAuth.js';
import { normalizeCollectorVersion } from '../_lib/collectorVersion.js';
import { ApiError, handleApiError, readJsonBody, requireMethod, sendJson } from '../_lib/http.js';
import {
  deriveDeviceToken,
  digestEnrollmentCode,
  digestMachineId,
  digestPairRateLimitKey,
  normalizeEnrollmentCode,
  normalizeMachineId,
  normalizePairingNonce,
} from '../_lib/ingestTokens.js';

const PUBLIC_PAIR_ERROR = 'invalid_or_expired_code';
const SQL_DENIAL_CODES = Object.freeze({
  CODE_NOT_FOUND: 'code_not_found',
  CODE_EXPIRED: 'code_expired',
  CODE_REVOKED: 'code_revoked',
  CODE_CONSUMED: 'code_consumed',
  MACHINE_CONFLICT: 'machine_conflict',
  NONCE_OR_CREDENTIAL_CONFLICT: 'nonce_or_credential_conflict',
  CREDENTIAL_CONFLICT: 'credential_conflict',
  DEVICE_REVOKED: 'device_revoked',
  CLIENT_INELIGIBLE: 'client_ineligible',
});

export class PairingDeniedError extends Error {
  constructor(reasonCode) {
    super('Pairing denied.');
    this.name = 'PairingDeniedError';
    this.reasonCode = reasonCode;
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function unwrapRpcRow(data) {
  return Array.isArray(data) ? data[0] : data;
}

function pairingDenial(error) {
  const source = `${error?.code || ''} ${error?.message || ''} ${error?.details || ''}`.toUpperCase();
  const matched = Object.keys(SQL_DENIAL_CODES).find((code) => source.includes(code));
  return matched ? new PairingDeniedError(SQL_DENIAL_CODES[matched]) : null;
}

export function createPairStore(admin) {
  return {
    async pairDevice({ codeHash, machineHash, credentialHash, credentialPrefix, agentVersion, addonVersion }) {
      const { data, error } = await admin.rpc('pair_ingest_device_v2', {
        p_code_hash: codeHash,
        p_machine_hash: machineHash,
        p_credential_hash: credentialHash,
        p_credential_prefix: credentialPrefix,
        p_agent_version: agentVersion,
        p_addon_version: addonVersion,
      });
      if (error) throw pairingDenial(error) || error;
      const device = unwrapRpcRow(data);
      if (!device?.device_id
        || !device?.client_id
        || typeof device?.client_name !== 'string'
        || !device.client_name.trim()) {
        throw new Error('Pairing RPC returned no device.');
      }
      return {
        deviceId: device.device_id,
        clientId: device.client_id,
        clientName: device.client_name,
        scheduleTime: device.schedule_time,
        scheduleTimezone: device.schedule_timezone,
        agentVersion: device.agent_version,
        addonVersion: device.addon_version,
      };
    },

    async writeAudit({ entityType, entityId, action, afterData }) {
      const { error } = await admin.from('audit_logs').insert({
        user_id: null,
        entity_type: entityType,
        entity_id: entityId || null,
        action,
        after_data: afterData,
      });
      if (error) throw error;
    },
  };
}

export function createPairRateLimiter(admin, { maxAttempts, windowSeconds, blockSeconds }) {
  return {
    async check({ keyHash, now }) {
      const { data, error } = await admin.rpc('check_ingest_pair_rate_limit', {
        p_key_hash: keyHash,
        p_now: now.toISOString(),
        p_max_attempts: maxAttempts,
        p_window_seconds: windowSeconds,
        p_block_seconds: blockSeconds,
      });
      if (error) throw error;
      const row = unwrapRpcRow(data);
      return {
        allowed: Boolean(row?.allowed),
        retryAfterSeconds: Math.max(0, Number(row?.retry_after_seconds) || 0),
      };
    },
  };
}

export function trustedVercelClientIp(req) {
  const value = req?.headers?.['x-vercel-forwarded-for'] || req?.headers?.['x-real-ip'] || '';
  return String(Array.isArray(value) ? value[0] : value).split(',')[0].trim();
}

async function safeAudit(store, entry) {
  try {
    await store?.writeAudit(entry);
  } catch {
    // Pairing responses must not leak audit infrastructure details or secrets.
  }
}

function denialAudit(reasonCode, versions = {}) {
  return {
    entityType: 'ingest_pair_attempt',
    entityId: null,
    action: 'ingest_pair.denied',
    afterData: {
      reasonCode,
      ...(versions.agentVersion ? { agentVersion: versions.agentVersion } : {}),
      ...(versions.addonVersion ? { addonVersion: versions.addonVersion } : {}),
    },
  };
}

export function createHandler({
  createClients = () => ({ admin: createServiceClient() }),
  createStore = createPairStore,
  createLimiter = createPairRateLimiter,
  trustedClientIp = trustedVercelClientIp,
  pepper = process.env.INGEST_TOKEN_PEPPER,
  maxAttempts = positiveInteger(process.env.INGEST_PAIR_RATE_LIMIT_MAX_ATTEMPTS, 10),
  windowSeconds = positiveInteger(process.env.INGEST_PAIR_RATE_LIMIT_WINDOW_SECONDS, 60),
  blockSeconds = positiveInteger(process.env.INGEST_PAIR_RATE_LIMIT_BLOCK_SECONDS, 300),
  now = () => new Date(),
} = {}) {
  return async function handler(req, res) {
    let store;
    try {
      requireMethod(req, 'POST');
      const { admin } = createClients();
      store = createStore(admin);
      const limiter = createLimiter(admin, { maxAttempts, windowSeconds, blockSeconds });
      let requestBody;
      try {
        requestBody = await readJsonBody(req, { maxBytes: 8 * 1024 });
      } catch (error) {
        if (error instanceof ApiError && [400, 413].includes(error.status)) {
          await safeAudit(store, denialAudit('invalid_request'));
          return sendJson(res, 400, { error: PUBLIC_PAIR_ERROR });
        }
        throw error;
      }

      let code;
      let machine;
      let nonce;
      let agentVersion;
      let addonVersion;
      try {
        code = normalizeEnrollmentCode(requestBody.enrollmentCode);
        machine = normalizeMachineId(requestBody.machineId);
        nonce = normalizePairingNonce(requestBody.pairingNonce);
        agentVersion = normalizeCollectorVersion(requestBody.agentVersion);
        addonVersion = normalizeCollectorVersion(requestBody.addonVersion);
      } catch {
        await safeAudit(store, denialAudit('invalid_request'));
        return sendJson(res, 400, { error: PUBLIC_PAIR_ERROR });
      }

      let limit;
      try {
        const keyHash = digestPairRateLimitKey(trustedClientIp(req), pepper);
        limit = await limiter.check({ keyHash, now: now() });
      } catch {
        await safeAudit(store, denialAudit('rate_limit_unavailable', { agentVersion, addonVersion }));
        return sendJson(res, 500, { error: 'pairing_unavailable' });
      }
      if (!limit.allowed) {
        const retryAfter = Math.max(1, Math.ceil(limit.retryAfterSeconds));
        res.setHeader('Retry-After', String(retryAfter));
        await safeAudit(store, denialAudit('rate_limited', { agentVersion, addonVersion }));
        return sendJson(res, 429, { error: PUBLIC_PAIR_ERROR });
      }

      const issued = deriveDeviceToken({ enrollmentCode: code, machineId: machine, pairingNonce: nonce, pepper });
      try {
        const paired = await store.pairDevice({
          codeHash: digestEnrollmentCode(code, pepper),
          machineHash: digestMachineId(machine, pepper),
          credentialHash: issued.record.credentialHash,
          credentialPrefix: issued.record.tokenPrefix,
          agentVersion,
          addonVersion,
        });
        return sendJson(res, 200, {
          deviceToken: issued.token,
          clientName: paired.clientName,
          deviceId: paired.deviceId,
          schedule: {
            time: String(paired.scheduleTime || '16:45:00').slice(0, 5),
            timeZone: paired.scheduleTimezone || 'America/New_York',
          },
        });
      } catch (error) {
        if (error instanceof PairingDeniedError) {
          const entry = denialAudit(error.reasonCode, { agentVersion, addonVersion });
          if (error.reasonCode === 'code_expired') entry.action = 'ingest_pair.expired';
          await safeAudit(store, entry);
          return sendJson(res, 400, { error: PUBLIC_PAIR_ERROR });
        }
        await safeAudit(store, {
          ...denialAudit('pairing_unavailable', { agentVersion, addonVersion }),
          action: 'ingest_pair.unavailable',
        });
        return sendJson(res, 500, { error: 'pairing_unavailable' });
      }
    } catch (error) {
      const publicError = error instanceof ApiError ? error : new ApiError(500, 'pairing_unavailable');
      return handleApiError(res, publicError, { fallbackMessage: 'pairing_unavailable' });
    }
  };
}

export default createHandler();
