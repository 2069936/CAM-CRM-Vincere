import process from 'node:process';
import { createApiClients, requireAppUser } from '../_lib/apiAuth.js';
import { ApiError, handleApiError, readJsonBody, requireMethod, sendJson } from '../_lib/http.js';
import { issueEnrollmentCode } from '../_lib/ingestTokens.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const REBIND_REASONS = Object.freeze(['vps_rebuilt', 'device_replaced', 'support_reset']);
export const REVOKE_REASONS = Object.freeze(['client_offboarded', 'security_revoke', 'support_reset']);

function requireUuid(value, field) {
  const normalized = String(value || '').trim();
  if (!UUID_PATTERN.test(normalized)) throw new ApiError(400, `invalid_${field}`);
  return normalized;
}

function requireAllowedReason(value, allowed) {
  const reason = String(value || '').trim().toLowerCase();
  if (!allowed.includes(reason)) throw new ApiError(400, 'invalid_reason');
  return reason;
}

function unwrapRpcRow(data) {
  return Array.isArray(data) ? data[0] : data;
}

function stableStoreError(error) {
  const source = `${error?.code || ''} ${error?.message || ''} ${error?.details || ''}`.toUpperCase();
  if (source.includes('CLIENT_NOT_ELIGIBLE')) return Object.assign(error, { code: 'CLIENT_NOT_ELIGIBLE' });
  if (source.includes('ACTIVE_DEVICE_EXISTS')) return Object.assign(error, { code: 'ACTIVE_DEVICE_EXISTS' });
  if (source.includes('INGEST_ACCESS_NOT_FOUND')) return Object.assign(error, { code: 'INGEST_ACCESS_NOT_FOUND' });
  return error;
}

export function createIngestEnrollmentStore(admin) {
  return {
    async createEnrollment({ clientId, codeHash, createdBy, expiresAt, rebind, actionCode, reasonCode }) {
      const { data, error } = await admin.rpc('create_ingest_enrollment', {
        p_client_id: clientId,
        p_code_hash: codeHash,
        p_created_by: createdBy,
        p_expires_at: expiresAt,
        p_rebind: rebind,
        p_action_code: actionCode,
        p_reason_code: reasonCode,
      });
      if (error) throw stableStoreError(error);
      const row = unwrapRpcRow(data);
      if (!row?.enrollment_id) throw new Error('Enrollment RPC returned no row.');
      return {
        enrollmentId: row.enrollment_id,
        clientId: row.client_id,
        clientName: row.client_name,
        expiresAt: row.expires_at,
        revokedDeviceIds: row.revoked_device_ids || [],
      };
    },

    async revokeAccess({ clientId, enrollmentId, deviceId, reasonCode, actorId }) {
      const { data, error } = await admin.rpc('revoke_ingest_access', {
        p_client_id: clientId,
        p_enrollment_id: enrollmentId || null,
        p_device_id: deviceId || null,
        p_reason_code: reasonCode,
        p_actor_id: actorId,
      });
      if (error) throw stableStoreError(error);
      const row = unwrapRpcRow(data);
      if (!row?.revoked_id) throw new Error('Revoke RPC returned no row.');
      return { clientId: row.client_id, kind: row.revoked_kind, id: row.revoked_id };
    },
  };
}

function publicAdminError(error) {
  if (error instanceof ApiError || (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500)) return error;
  if (error?.code === 'CLIENT_NOT_ELIGIBLE') return new ApiError(409, 'client_not_eligible');
  if (error?.code === 'ACTIVE_DEVICE_EXISTS') return new ApiError(409, 'active_device_exists');
  if (error?.code === 'INGEST_ACCESS_NOT_FOUND') return new ApiError(404, 'ingest_access_not_found');
  return new ApiError(500, 'enrollment_request_failed');
}

export function createHandler({
  createClients = createApiClients,
  authorize = requireAppUser,
  createStore = createIngestEnrollmentStore,
  issueCode = issueEnrollmentCode,
  pepper = process.env.INGEST_TOKEN_PEPPER,
  now = () => new Date(),
} = {}) {
  return async function handler(req, res) {
    try {
      requireMethod(req, ['POST', 'DELETE']);
      const body = await readJsonBody(req, { maxBytes: 8 * 1024 });
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_request');
      if ('productKey' in body || 'product_key' in body) throw new ApiError(400, 'invalid_request');
      const clientId = requireUuid(body.clientUuid, 'client_uuid');
      const { admin, auth } = createClients();
      const actor = await authorize(req, {
        admin,
        authClient: auth,
        roles: ['Manager', 'CAM'],
        clientUuid: clientId,
      });
      const store = createStore(admin);

      if (req.method === 'POST') {
        const action = body.action == null || body.action === '' ? 'generate' : String(body.action).toLowerCase();
        if (!['generate', 'rebind'].includes(action)) throw new ApiError(400, 'invalid_action');
        if (action === 'generate' && body.reason != null) throw new ApiError(400, 'invalid_reason');
        const reasonCode = action === 'rebind' ? requireAllowedReason(body.reason, REBIND_REASONS) : null;
        const issued = issueCode({ pepper, now: now() });
        const created = await store.createEnrollment({
          clientId,
          codeHash: issued.record.credentialHash,
          createdBy: actor.id,
          expiresAt: issued.record.expiresAt,
          rebind: action === 'rebind',
          actionCode: action === 'rebind' ? 'rebound' : 'generated',
          reasonCode,
        });
        return sendJson(res, 201, {
          enrollment: {
            id: created.enrollmentId,
            clientUuid: created.clientId,
            clientName: created.clientName,
            code: issued.code,
            expiresAt: created.expiresAt,
          },
        });
      }

      const enrollmentId = body.enrollmentId ? requireUuid(body.enrollmentId, 'enrollment_id') : null;
      const deviceId = body.deviceId ? requireUuid(body.deviceId, 'device_id') : null;
      if (Boolean(enrollmentId) === Boolean(deviceId)) throw new ApiError(400, 'invalid_revoke_target');
      const reasonCode = requireAllowedReason(body.reason, REVOKE_REASONS);
      const revoked = await store.revokeAccess({ clientId, enrollmentId, deviceId, reasonCode, actorId: actor.id });
      return sendJson(res, 200, { revoked });
    } catch (error) {
      return handleApiError(res, publicAdminError(error), { fallbackMessage: 'enrollment_request_failed' });
    }
  };
}

export default createHandler();
