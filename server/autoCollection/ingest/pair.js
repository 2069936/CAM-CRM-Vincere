import process from 'node:process';
import { resolveIngestPepper } from '../../apiLib/ingestPepper.js';
import { createServiceClient } from '../../apiLib/apiAuth.js';
import { normalizeCollectorVersion } from '../../apiLib/collectorVersion.js';
import { ApiError, handleApiError, readJsonBody, requireMethod, sendJson } from '../../apiLib/http.js';
import {
  deriveDeviceToken,
  digestEnrollmentCode,
  digestMachineId,
  digestPairRateLimitKey,
  normalizeEnrollmentCode,
  normalizeMachineId,
  normalizePairingNonce,
} from '../../apiLib/ingestTokens.js';

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

/* ------------------------------------------------------------------------- *
 * Nine ways to be refused, one sentence for all of them.
 *
 * Every denial came back as `invalid_or_expired_code`, so the Setup window said
 * "This code is invalid or expired. Generate a new code in the CRM." for all
 * nine. Two of them are actually fixed by a new code. The rest are not, and the
 * desk generated code after code against a machine that already had a device,
 * which no code will ever fix, being told each time to try another one.
 *
 * WHAT STAYS HIDDEN, AND WHY ONLY THAT. `code_not_found` is the one an attacker
 * could use: told apart from the others it turns this endpoint into an oracle
 * for guessing codes. Every other reason is only reachable once a real
 * enrollment row has been found by its hash, which means the caller already
 * holds a valid code, so naming it reveals nothing they did not bring with them.
 *
 * The `error` field is unchanged, so anything reading it keeps working.
 * ------------------------------------------------------------------------- */
const CODE_GUESSING_ORACLE = 'code_not_found';

export function publicDenialReason(reasonCode) {
  return reasonCode === CODE_GUESSING_ORACLE ? PUBLIC_PAIR_ERROR : reasonCode;
}

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

    /* WHO IS HOLDING THIS MACHINE.
     *
     * `machine_conflict` is the one refusal a new code can never fix, and it is
     * also the one the CAM cannot investigate: the blocking device belongs to
     * whichever client claimed this VPS first, and that client is very often
     * outside the CAM's own book, so the fleet view returns nothing and the
     * admin fleet endpoint answers 403. The desk spent two days generating code
     * after code against a machine that was never going to accept one.
     *
     * The pairing RPC knows the answer and cannot say it: it raises, and an
     * exception carries no row. So this reads it afterwards with the same
     * service role, on the denial path only, and the name goes into the audit
     * entry rather than into the response. The caller on the VPS holds one
     * client's enrolment code and has no business learning another client's
     * name from a failed request; the CAM in the CRM does. */
    async findMachineHolder(machineHash) {
      const { data, error } = await admin
        .from('ingest_devices')
        .select('id, client_id, created_at')
        .eq('machine_id_hash', machineHash)
        .eq('status', 'active')
        .is('revoked_at', null)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (!data?.client_id) return null;
      const { data: client, error: clientError } = await admin
        .from('clients')
        .select('name')
        .eq('id', data.client_id)
        .maybeSingle();
      if (clientError) throw clientError;
      return {
        deviceId: data.id,
        clientUuid: data.client_id,
        clientName: String(client?.name || '').trim() || null,
        pairedAt: data.created_at || null,
      };
    },

    /* Which client the attempt was for. The audit row used to carry a null
     * entity_id, so sixty-eight refusals were one undifferentiated pile and no
     * client page could show its own. The code hash is already in hand. */
    async findEnrollmentClient(codeHash) {
      const { data, error } = await admin
        .from('ingest_enrollments')
        .select('client_id')
        .eq('code_hash', codeHash)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data?.client_id || null;
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

/**
 * Turn an anonymous denial into one a client page can show.
 *
 * Best effort on purpose: this runs while answering a request that has already
 * failed, and a refusal that cannot be annotated is still a refusal. Losing the
 * detail must never turn a clean 400 into a 500.
 */
export async function attachAttemptDetail(store, entry, { reasonCode, codeHash, machineHash }) {
  try {
    const clientId = await store.findEnrollmentClient(codeHash);
    if (clientId) entry.entityId = clientId;
  } catch {
    // Unattributed is the state this was already in.
  }
  if (reasonCode !== SQL_DENIAL_CODES.MACHINE_CONFLICT) return entry;
  try {
    const holder = await store.findMachineHolder(machineHash);
    if (holder) entry.afterData = { ...entry.afterData, blockedBy: holder };
  } catch {
    // Same.
  }
  return entry;
}

export function createHandler({
  createClients = () => ({ admin: createServiceClient() }),
  createStore = createPairStore,
  createLimiter = createPairRateLimiter,
  trustedClientIp = trustedVercelClientIp,
  pepper = resolveIngestPepper(),
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
      // Hoisted: the denial path needs the same two hashes to say which client
      // was being paired and which one already holds this machine.
      const codeHash = digestEnrollmentCode(code, pepper);
      const machineHash = digestMachineId(machine, pepper);
      try {
        const paired = await store.pairDevice({
          codeHash,
          machineHash,
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
            time: String(paired.scheduleTime || '16:30:00').slice(0, 5),
            timeZone: paired.scheduleTimezone || 'America/New_York',
          },
        });
      } catch (error) {
        if (error instanceof PairingDeniedError) {
          const entry = denialAudit(error.reasonCode, { agentVersion, addonVersion });
          if (error.reasonCode === 'code_expired') entry.action = 'ingest_pair.expired';
          await attachAttemptDetail(store, entry, { reasonCode: error.reasonCode, codeHash, machineHash });
          await safeAudit(store, entry);
          return sendJson(res, 400, { error: PUBLIC_PAIR_ERROR, reason: publicDenialReason(error.reasonCode) });
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
