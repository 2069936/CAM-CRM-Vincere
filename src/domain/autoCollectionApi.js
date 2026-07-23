import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REBIND_REASONS = new Set(['vps_rebuilt', 'device_replaced', 'support_reset']);
const REVOKE_REASONS = new Set(['client_offboarded', 'security_revoke', 'support_reset']);

const SAFE_MESSAGES = Object.freeze({
  permission_denied: 'You do not have access to this client setup.',
  active_device_exists: 'This client already has a connected VPS. Use Rebind VPS if it was replaced.',
  client_not_eligible: 'This client is not ready for automatic collection.',
  ingest_access_not_found: 'That setup access no longer exists. Refresh the status.',
  invalid_request: 'The collector setup request is invalid. Refresh and try again.',
  unavailable: 'Collector setup is temporarily unavailable. Try again.',
});

export class AutoCollectionApiError extends Error {
  constructor(code, { status = 0, cause } = {}) {
    super(SAFE_MESSAGES[code] || SAFE_MESSAGES.unavailable, cause ? { cause } : undefined);
    this.name = 'AutoCollectionApiError';
    this.code = code;
    this.status = status;
  }
}

function validateUuid(value) {
  const normalized = String(value || '').trim();
  if (!UUID.test(normalized)) throw new AutoCollectionApiError('invalid_request', { status: 400 });
  return normalized.toLowerCase();
}

async function defaultAccessToken() {
  if (!isSupabaseConfigured || !supabase) throw new AutoCollectionApiError('permission_denied', { status: 401 });
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token) throw new AutoCollectionApiError('permission_denied', { status: 401 });
  return data.session.access_token;
}

function errorCode(status, body) {
  if (status === 401 || status === 403) return 'permission_denied';
  const serverCode = typeof body?.error === 'string' ? body.error : '';
  if (status === 409 && ['active_device_exists', 'client_not_eligible'].includes(serverCode)) return serverCode;
  if (status === 404 && serverCode === 'ingest_access_not_found') return serverCode;
  if (status >= 400 && status < 500) return 'invalid_request';
  return 'unavailable';
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function createAutoCollectionApi({
  fetchImpl = globalThis.fetch,
  getAccessToken = defaultAccessToken,
  retryDelay = (signal) => delay(250, signal),
} = {}) {
  async function request(path, { method = 'GET', payload, signal } = {}) {
    let token;
    try {
      token = await getAccessToken();
    } catch (error) {
      if (error instanceof AutoCollectionApiError) throw error;
      throw new AutoCollectionApiError('permission_denied', { status: 401, cause: error });
    }
    let response;
    try {
      response = await fetchImpl(path, {
        method,
        signal,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(payload ? { 'Content-Type': 'application/json' } : {}),
        },
        body: payload ? JSON.stringify(payload) : undefined,
      });
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted) throw error;
      throw new AutoCollectionApiError('unavailable', { cause: error });
    }
    let body;
    try {
      body = await response.json();
    } catch {
      body = {};
    }
    if (!response.ok) throw new AutoCollectionApiError(errorCode(response.status, body), { status: response.status });
    return body;
  }

  return {
    async loadStatus(clientUuid, { signal } = {}) {
      const clientId = validateUuid(clientUuid);
      const path = `/api/admin/ingest-status?clientUuid=${encodeURIComponent(clientId)}`;
      try {
        return await request(path, { signal });
      } catch (error) {
        if (error?.name === 'AbortError' || signal?.aborted || (error instanceof AutoCollectionApiError && error.status > 0 && error.status < 500)) throw error;
        await retryDelay(signal);
        return request(path, { signal });
      }
    },

    async generateEnrollment(clientUuid, { signal } = {}) {
      return request('/api/admin/ingest-enrollment', {
        method: 'POST', signal, payload: { clientUuid: validateUuid(clientUuid), action: 'generate' },
      });
    },

    async rebind(clientUuid, reason, { signal } = {}) {
      if (!REBIND_REASONS.has(reason)) throw new AutoCollectionApiError('invalid_request', { status: 400 });
      return request('/api/admin/ingest-enrollment', {
        method: 'POST', signal, payload: { clientUuid: validateUuid(clientUuid), action: 'rebind', reason },
      });
    },

    async revoke(clientUuid, { deviceId, enrollmentId, reason, signal } = {}) {
      if (!REVOKE_REASONS.has(reason) || Boolean(deviceId) === Boolean(enrollmentId)) {
        throw new AutoCollectionApiError('invalid_request', { status: 400 });
      }
      const target = deviceId ? { deviceId: validateUuid(deviceId) } : { enrollmentId: validateUuid(enrollmentId) };
      return request('/api/admin/ingest-enrollment', {
        method: 'DELETE', signal, payload: { clientUuid: validateUuid(clientUuid), ...target, reason },
      });
    },
  };
}

export const autoCollectionApi = createAutoCollectionApi();
