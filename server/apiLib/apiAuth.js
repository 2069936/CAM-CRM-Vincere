import { createClient } from '@supabase/supabase-js';
import process from 'node:process';
import { ApiError } from './http.js';

function resolveConfig(env) {
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const publishableKey = env.SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !serviceRoleKey || !publishableKey) {
    throw new Error('Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or SUPABASE_PUBLISHABLE_KEY server env.');
  }
  return { url, serviceRoleKey, publishableKey };
}

export function createServiceClient({ env = process.env, clientFactory = createClient } = {}) {
  const { url, serviceRoleKey } = resolveConfig(env);
  return clientFactory(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function createAuthClient({ env = process.env, clientFactory = createClient } = {}) {
  const { url, publishableKey } = resolveConfig(env);
  return clientFactory(url, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function createApiClients(options = {}) {
  return {
    admin: createServiceClient(options),
    auth: createAuthClient(options),
  };
}

export function extractBearerToken(req) {
  const value = req?.headers?.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match ? match[1].trim() : '';
}

async function authenticatedUser(req, authClient) {
  const token = extractBearerToken(req);
  if (!token) throw new ApiError(401, 'Missing bearer token.');
  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data?.user?.id) throw new ApiError(401, 'Invalid session token.');
  return data.user;
}

async function requireAssignment(admin, camProfileId, clientUuid) {
  if (!camProfileId) throw new ApiError(403, 'Client assignment required.');
  const { data, error } = await admin
    .from('client_assignments')
    .select('client_id')
    .eq('cam_profile_id', camProfileId)
    .eq('client_id', clientUuid)
    .limit(1);
  if (error) throw error;
  if (!data?.length) throw new ApiError(403, 'Client assignment required.');
}

export async function requireClientAssignment(admin, appUser, clientUuid) {
  if (!appUser || !clientUuid) throw new ApiError(403, 'Client assignment required.');
  if (appUser.role !== 'Manager') {
    await requireAssignment(admin, appUser.cam_profile_id, clientUuid);
  }
}

/**
 * Authorizes a whole set of clients at once.
 *
 * Every id goes through requireClientAssignment — there is no shortcut where
 * the first id is checked and the rest are trusted, because a bulk export is
 * exactly the request where one unchecked id hands over another CAM's book.
 * The checks run together rather than in sequence: the largest CAM on the real
 * book carries 32 clients, and 32 sequential round trips to an indexed
 * (cam_profile_id, client_id) lookup is a third of a second of latency for no
 * extra safety.
 *
 * A denial always wins over a storage failure, and it always carries the same
 * message whether the client belongs to another CAM or does not exist at all.
 * A caller that could tell those apart could enumerate the book.
 */
export async function requireClientAssignments(admin, appUser, clientUuids = []) {
  if (!appUser) throw new ApiError(403, 'Client assignment required.');
  const list = clientUuids || [];
  if (!list.length) throw new ApiError(403, 'Client assignment required.');
  // Every entry has to BE a client id, not merely coerce to one. This used to
  // be `.filter(Boolean)`, which silently shrank the set being checked: a list
  // of 12 ids where two were '' or null was authorized as 10 and the caller
  // still held 12. Nothing that reached this function was ever checked and then
  // dropped; the failure mode was the reverse, and it fails closed now.
  const ids = [...new Set(list)];
  if (ids.some((clientUuid) => typeof clientUuid !== 'string' || !clientUuid)) {
    throw new ApiError(403, 'Client assignment required.');
  }
  const results = await Promise.allSettled(
    ids.map((clientUuid) => requireClientAssignment(admin, appUser, clientUuid)),
  );
  const rejected = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
  if (!rejected.length) return ids;
  const denied = rejected.find((reason) => reason?.status === 403);
  throw denied || rejected[0];
}

/**
 * Every client a CAM is assigned to, for the requests that cannot name one.
 *
 * requireAssignment answers "may this user see THIS client", which is the right
 * question when a request carries a client id. "Export all my clients" has no
 * id to carry, so the set has to be read out. Same table, same predicate, same
 * indifference to assignment_role — this is enumeration of the existing rule,
 * not a second rule.
 *
 * Manager is deliberately not special-cased. A Manager has no assignment rows
 * on the real book, so "my clients" for a Manager is empty here and the caller
 * decides what that means; nothing silently widens to the whole book.
 */
export async function listAssignedClientIds(admin, camProfileId) {
  if (!camProfileId) return [];
  const pageSize = 1000;
  const ids = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await admin
      .from('client_assignments')
      .select('client_id')
      .eq('cam_profile_id', camProfileId)
      .order('client_id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    for (const row of data || []) {
      if (row?.client_id) ids.push(row.client_id);
    }
    if (!data || data.length < pageSize) break;
  }
  return [...new Set(ids)];
}

export async function requireAppUser(req, {
  roles,
  clientUuid,
  admin,
  authClient,
  createClients = createApiClients,
  bootstrap,
} = {}) {
  const clients = (admin && authClient) ? { admin, auth: authClient } : createClients();
  const authUser = await authenticatedUser(req, clients.auth);
  const { data, error } = await clients.admin
    .from('app_users')
    .select('id, auth_user_id, role, status, cam_profile_id')
    .eq('auth_user_id', authUser.id)
    .maybeSingle();
  if (error) throw error;
  const appUser = data || (bootstrap ? await bootstrap({ admin: clients.admin, authUser }) : null);
  if (!appUser || appUser.status !== 'Active' || (roles && !roles.includes(appUser.role))) {
    throw new ApiError(403, roles?.length === 1 && roles[0] === 'Manager'
      ? 'Manager permission required.'
      : 'App user permission required.');
  }
  if (clientUuid && appUser.role !== 'Manager') {
    await requireClientAssignment(clients.admin, appUser, clientUuid);
  }
  return appUser;
}
