import process from 'node:process';
import { createServiceClient } from '../_lib/apiAuth.js';
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

function hasControlCharacter(value) {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeVersion(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 64 || hasControlCharacter(normalized)) {
    throw new Error('Invalid version.');
  }
  return normalized;
}

function unwrapRpcRow(data) {
  return Array.isArray(data) ? data[0] : data;
}

export function createPairStore(admin) {
  return {
    async pairDevice({ codeHash, machineHash, credentialHash, credentialPrefix, agentVersion, addonVersion }) {
      const { data, error } = await admin.rpc('pair_ingest_device', {
        p_code_hash: codeHash,
        p_machine_hash: machineHash,
        p_credential_hash: credentialHash,
        p_credential_prefix: credentialPrefix,
        p_agent_version: agentVersion,
        p_addon_version: addonVersion,
      });
      if (error) throw Object.assign(new Error('Pairing denied.'), { code: 'INVALID_PAIRING' });
      const device = unwrapRpcRow(data);
      if (!device?.id || !device?.client_id) throw new Error('Pairing RPC returned no device.');
      const { data: client, error: clientError } = await admin
        .from('clients')
        .select('name')
        .eq('id', device.client_id)
        .maybeSingle();
      if (clientError || !client?.name) throw new Error('Paired client was not found.');
      return {
        deviceId: device.id,
        clientId: device.client_id,
        clientName: client.name,
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
        agentVersion = normalizeVersion(requestBody.agentVersion);
        addonVersion = normalizeVersion(requestBody.addonVersion);
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
        return sendJson(res, 429, { error: PUBLIC_PAIR_ERROR });
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
        await safeAudit(store, {
          entityType: 'ingest_device',
          entityId: paired.deviceId,
          action: 'ingest_pair.succeeded',
          afterData: { clientId: paired.clientId, deviceId: paired.deviceId, agentVersion, addonVersion },
        });
        return sendJson(res, 200, {
          deviceToken: issued.token,
          clientName: paired.clientName,
          deviceId: paired.deviceId,
          schedule: {
            time: String(paired.scheduleTime || '16:45:00').slice(0, 5),
            timeZone: paired.scheduleTimezone || 'America/New_York',
          },
          agentVersion: paired.agentVersion || agentVersion,
          addonVersion: paired.addonVersion || addonVersion,
        });
      } catch {
        await safeAudit(store, denialAudit('invalid_or_expired_code', { agentVersion, addonVersion }));
        return sendJson(res, 400, { error: PUBLIC_PAIR_ERROR });
      }
    } catch (error) {
      const publicError = error instanceof ApiError ? error : new ApiError(500, 'pairing_failed');
      return handleApiError(res, publicError, { fallbackMessage: 'pairing_failed' });
    }
  };
}

export default createHandler();
