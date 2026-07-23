import process from 'node:process';
import { createApiClients, requireAppUser, requireClientAssignment } from '../_lib/apiAuth.js';
import { ApiError, handleApiError, requireMethod, sendJson } from '../_lib/http.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION = /^[0-9]{1,5}(?:\.[0-9]{1,5}){1,3}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_DEVICE_ERROR_CODES = new Set([
  'ninjatrader_not_running',
  'addon_unavailable',
  'capture_timeout',
  'capture_failed',
  'contract_mismatch',
  'queue_capacity_warning',
  'upload_failed',
  'configuration_error',
]);
const DEVICE_SELECT = [
  'id', 'status', 'health_status', 'schedule_time', 'schedule_timezone',
  'agent_version', 'addon_version', 'ninjatrader_version', 'last_seen_at',
  'last_capture_at', 'last_success_at', 'last_error_code', 'revoked_at', 'created_at',
].join(',');
const ENROLLMENT_SELECT = 'id,expires_at,consumed_at,revoked_at,created_at';

function requireClientUuid(value) {
  const normalized = String(value || '').trim();
  if (!UUID.test(normalized)) throw new ApiError(400, 'invalid_client_uuid');
  return normalized.toLowerCase();
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function resolveInstallerRelease(env = process.env, {
  production = env.NODE_ENV === 'production',
} = {}) {
  const values = [
    env.AUTO_COLLECTION_INSTALLER_URL,
    env.AUTO_COLLECTION_INSTALLER_VERSION,
    env.AUTO_COLLECTION_INSTALLER_SHA256,
    env.AUTO_COLLECTION_INSTALLER_PUBLISHED_AT,
  ];
  if (values.every((value) => !String(value || '').trim())) return null;
  if (values.some((value) => !String(value || '').trim())) {
    throw new Error('Invalid auto-collection installer manifest configuration.');
  }

  try {
    const url = new URL(String(values[0]).trim());
    const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || (url.protocol !== 'https:' && (production || !isLoopback))) throw new Error('url');
    const version = String(values[1]).trim();
    const sha256 = String(values[2]).trim().toLowerCase();
    const publishedAt = canonicalTimestamp(String(values[3]).trim());
    if (!VERSION.test(version) || !SHA256.test(sha256) || !publishedAt) throw new Error('fields');
    return { url: url.toString(), version, sha256, publishedAt };
  } catch {
    throw new Error('Invalid auto-collection installer manifest configuration.');
  }
}

export function createIngestStatusStore(admin) {
  async function maybeLatest(table, columns, clientId) {
    const { data, error } = await admin
      .from(table)
      .select(columns)
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  }

  return {
    async load(clientId) {
      const clientPromise = admin.from('clients').select('id,name').eq('id', clientId).maybeSingle();
      const devicePromise = maybeLatest('ingest_devices', DEVICE_SELECT, clientId);
      const enrollmentPromise = maybeLatest('ingest_enrollments', ENROLLMENT_SELECT, clientId);
      const [{ data: client, error }, device, enrollment] = await Promise.all([
        clientPromise,
        devicePromise,
        enrollmentPromise,
      ]);
      if (error) throw error;
      if (!client?.id) throw new ApiError(404, 'client_not_found');
      return { client, device, enrollment };
    },
  };
}

function publicDevice(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    healthStatus: row.health_status,
    agentVersion: row.agent_version || null,
    addonVersion: row.addon_version || null,
    ninjaTraderVersion: row.ninjatrader_version || null,
    lastSeenAt: row.last_seen_at || null,
    lastCaptureAt: row.last_capture_at || null,
    lastSuccessAt: row.last_success_at || null,
    lastErrorCode: SAFE_DEVICE_ERROR_CODES.has(row.last_error_code)
      ? row.last_error_code
      : row.last_error_code ? 'collector_error' : null,
    revokedAt: row.revoked_at || null,
    schedule: {
      time: row.schedule_time,
      timezone: row.schedule_timezone,
    },
  };
}

function publicEnrollment(row) {
  if (!row) return null;
  return {
    id: row.id,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at || null,
    revokedAt: row.revoked_at || null,
  };
}

function publicError(error) {
  if (error instanceof ApiError) return error;
  if (error?.status === 401) return new ApiError(401, 'Invalid session token.');
  if (error?.status === 403) return new ApiError(403, 'Client assignment required.');
  return new ApiError(500, 'collector_status_failed');
}

export function createHandler({
  createClients = createApiClients,
  authorize = requireAppUser,
  enforceAssignment = requireClientAssignment,
  createStore = createIngestStatusStore,
  env = process.env,
  production = env.NODE_ENV === 'production',
  now = () => new Date(),
} = {}) {
  return async function handler(req, res) {
    try {
      requireMethod(req, ['GET']);
      res.setHeader('Cache-Control', 'private, no-store');
      const { admin, auth } = createClients();
      const actor = await authorize(req, {
        admin,
        authClient: auth,
        roles: ['Manager', 'CAM'],
      });
      const clientId = requireClientUuid(req.query?.clientUuid);
      await enforceAssignment(admin, actor, clientId);
      const status = await createStore(admin).load(clientId);
      const release = resolveInstallerRelease(env, { production });
      return sendJson(res, 200, {
        serverTime: now().toISOString(),
        client: { uuid: status.client.id, name: status.client.name },
        permissions: {
          generate: ['Manager', 'CAM'].includes(actor.role),
          rebind: ['Manager', 'CAM'].includes(actor.role),
          revoke: ['Manager', 'CAM'].includes(actor.role),
        },
        release,
        device: publicDevice(status.device),
        enrollment: publicEnrollment(status.enrollment),
      });
    } catch (error) {
      return handleApiError(res, publicError(error), { fallbackMessage: 'collector_status_failed' });
    }
  };
}

export default createHandler();
