import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';

// The message is a parameter because these endpoints are no longer all
// Manager-only: /api/admin/client-export is reachable by a CAM, and telling a
// CAM their "Manager session" is inactive sends them looking for the wrong problem.
async function authHeaders(inactiveMessage = 'Manager session is not active.') {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Supabase is not configured.');
  }
  const { data, error } = await supabase.auth.getSession();
  if (error) throw new Error(error.message);
  const token = data.session?.access_token;
  if (!token) throw new Error(inactiveMessage);
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

export async function loadSupabaseDataExport() {
  const response = await fetch('/api/admin/data-export', {
    method: 'GET',
    headers: await authHeaders(),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('Data export API route was not found. Run with `vercel dev` locally or deploy to Vercel.');
    }
    throw new Error(body.error || `Data export request failed (${response.status}).`);
  }
  return body;
}

/**
 * Client-scoped export: one client or all of the caller's clients, over a range.
 *
 * POST rather than GET because the request carries client uuids, and a GET would
 * put them in the query string of every access log between here and the server.
 * Omitting `clientIds` means "all my clients"; omitting the dates means the
 * server's default window, which the response states back.
 */
export async function loadClientScopedExport({
  clientIds = null,
  from = '',
  to = '',
  includeTradeHistory = false,
  batch = null,
} = {}) {
  const payload = { includeTradeHistory: Boolean(includeTradeHistory) };
  if (Array.isArray(clientIds) && clientIds.length) payload.clientIds = clientIds;
  if (from) payload.from = from;
  if (to) payload.to = to;
  // Sent only when this pull really is one part of several. Absent means an
  // unbatched export, and the server echoes it back into the file and the audit
  // row so the parts can be counted afterwards.
  if (batch) payload.batch = batch;

  const response = await fetch('/api/admin/client-export', {
    method: 'POST',
    headers: await authHeaders('Your session is not active. Sign in again.'),
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('Client export API route was not found. Run with `vercel dev` locally or deploy to Vercel.');
    }
    throw new Error(body.error || `Client export request failed (${response.status}).`);
  }
  return body;
}

export async function loadSupabaseIntakeSheet() {
  const response = await fetch('/api/admin/intake-sheet', {
    method: 'GET',
    headers: await authHeaders(),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('Intake sheet API route was not found. Run with `vercel dev` locally or deploy to Vercel.');
    }
    throw new Error(body.error || `Intake sheet request failed (${response.status}).`);
  }
  return body;
}
