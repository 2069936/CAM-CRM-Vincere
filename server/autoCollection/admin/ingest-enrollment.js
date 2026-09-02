import { resolveIngestPepper } from '../../apiLib/ingestPepper.js';
import { createApiClients, requireAppUser } from '../../apiLib/apiAuth.js';
import { ApiError, handleApiError, readJsonBody, requireMethod, sendJson } from '../../apiLib/http.js';
import { issueEnrollmentCode } from '../../apiLib/ingestTokens.js';

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
    /* WHICH OF THE FIVE IT WAS.
     *
     * create_ingest_enrollment refuses on any of five conditions and raises one
     * name for all of them, so the CAM was told "This client is not ready for
     * automatic collection" and had to guess. Four of the five are things they
     * can fix in the client profile in ten seconds, and the fifth, a blank
     * product key, is invisible until someone thinks to look at that field.
     *
     * Read after the refusal rather than before it: checking first would be a
     * second read on every successful enrolment, and a check that races the RPC
     * can disagree with it. This runs only when the answer is already no. */
    async describeIneligibility(clientId) {
      const { data, error } = await admin
        .from('clients')
        .select('status, deleted_at, name, product_key')
        .eq('id', clientId)
        .maybeSingle();
      if (error || !data) return 'client_not_found';
      if (data.deleted_at) return 'client_deleted';
      if (data.status !== 'Active') return 'client_not_active';
      if (!String(data.name ?? '').trim()) return 'client_name_missing';
      if (!String(data.product_key ?? '').trim()) return 'client_product_key_missing';
      return 'client_not_eligible';
    },

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
  if (error instanceof ApiError) return error;
  if (error?.status === 401) return new ApiError(401, 'Invalid session token.');
  if (error?.status === 403) return new ApiError(403, 'Client assignment required.');
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
  pepper = resolveIngestPepper(),
  now = () => new Date(),
} = {}) {
  return async function handler(req, res) {
    // Held outside the try so the catch can ask which of the five conditions
    // refused this client. Null until the request is far enough along to know.
    let resolvedClientId = null;
    let resolvedStore = null;
    try {
      requireMethod(req, ['POST', 'DELETE']);
      res.setHeader('Cache-Control', 'private, no-store');
      const body = await readJsonBody(req, { maxBytes: 8 * 1024 });
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_request');
      if ('productKey' in body || 'product_key' in body) throw new ApiError(400, 'invalid_request');
      const clientId = requireUuid(body.clientUuid, 'client_uuid');
      resolvedClientId = clientId;
      const { admin, auth } = createClients();
      const actor = await authorize(req, {
        admin,
        authClient: auth,
        roles: ['Manager', 'CAM'],
        clientUuid: clientId,
      });
      const store = createStore(admin);
      resolvedStore = store;

      if (req.method === 'POST') {
        const action = body.action == null || body.action === '' ? 'generate' : String(body.action).toLowerCase();
        if (!['generate', 'rebind'].includes(action)) throw new ApiError(400, 'invalid_action');
        if (action === 'generate' && body.reason != null) throw new ApiError(400, 'invalid_reason');
        const reasonCode = action === 'rebind' ? requireAllowedReason(body.reason, REBIND_REASONS) : null;
        const requestNow = now();
        // Say which knob is missing rather than throwing a 500 the caller has to
        // guess at. Without INGEST_TOKEN_PEPPER, issueCode throws "Credential
        // pepper is required" (apiLib/ingestTokens.js), which surfaced in the CRM
        // as "Collector setup is temporarily unavailable. Try again." -- wording
        // that invites a retry when retrying can never work, and that cost a desk
        // a day of guessing before someone read the code. The pepper is a
        // deployment secret and no code path may invent one: a generated value
        // would differ per instance and per deploy, and every already-paired VPS
        // would stop authenticating.
        if (!String(pepper || '').trim()) throw new ApiError(503, 'collector_not_configured');
        const issued = issueCode({ pepper, now: requestNow });
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
          serverTime: requestNow.toISOString(),
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
      let reported = publicAdminError(error);
      if (error?.code === 'CLIENT_NOT_ELIGIBLE' && resolvedClientId && resolvedStore?.describeIneligibility) {
        try {
          reported = new ApiError(409, await resolvedStore.describeIneligibility(resolvedClientId));
        } catch {
          // The reason is a courtesy. Losing it must not turn a 409 into a 500.
        }
      }
      return handleApiError(res, reported, { fallbackMessage: 'enrollment_request_failed' });
    }
  };
}

export default createHandler();
