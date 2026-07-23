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
    await requireAssignment(clients.admin, appUser.cam_profile_id, clientUuid);
  }
  return appUser;
}
