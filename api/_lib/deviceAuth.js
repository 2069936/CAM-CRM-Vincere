import { Buffer } from 'node:buffer';
import process from 'node:process';
import { createServiceClient, extractBearerToken } from './apiAuth.js';
import { ApiError } from './http.js';
import {
  digestDeviceToken,
  digestMachineId,
  normalizeMachineId,
  safeEqualHex,
} from './ingestTokens.js';

const DEVICE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PUBLIC_AUTH_ERROR = 'invalid_device_credential';

function unauthorized() {
  return new ApiError(401, PUBLIC_AUTH_ERROR);
}

function normalizeDeviceToken(value) {
  const token = String(value || '');
  const decoded = Buffer.from(token, 'base64url');
  if (!DEVICE_TOKEN_PATTERN.test(token)
    || decoded.length !== 32
    || decoded.toString('base64url') !== token) {
    throw unauthorized();
  }
  return token;
}

export function createDeviceAuthStore(admin) {
  return {
    async findByCredentialDigest(credentialDigest) {
      const { data, error } = await admin
        .from('ingest_devices')
        .select('id, client_id, credential_hash, machine_id_hash, status, revoked_at, schedule_time, schedule_timezone')
        .eq('credential_hash', credentialDigest)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  };
}

export async function requireIngestDevice(req, {
  admin,
  store,
  createClient = createServiceClient,
  createStore = createDeviceAuthStore,
  pepper = process.env.INGEST_TOKEN_PEPPER,
} = {}) {
  let token;
  let machineId;
  try {
    token = normalizeDeviceToken(extractBearerToken(req));
    machineId = normalizeMachineId(req?.headers?.['x-machine-id']);
  } catch {
    throw unauthorized();
  }

  const credentialDigest = digestDeviceToken(token, pepper);
  const machineDigest = digestMachineId(machineId, pepper);
  const resolvedStore = store || createStore(admin || createClient());
  const candidate = await resolvedStore.findByCredentialDigest(credentialDigest);

  if (!candidate
    || candidate.status !== 'active'
    || candidate.revoked_at !== null
    || !safeEqualHex(candidate.credential_hash, credentialDigest)
    || !safeEqualHex(candidate.machine_id_hash, machineDigest)) {
    throw unauthorized();
  }

  return {
    id: candidate.id,
    clientId: candidate.client_id,
    status: candidate.status,
    revokedAt: candidate.revoked_at,
    scheduleTime: candidate.schedule_time,
    scheduleTimezone: candidate.schedule_timezone,
  };
}
