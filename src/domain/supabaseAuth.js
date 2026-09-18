import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';

function mapAppUser(row) {
  if (!row) return null;
  return {
    id: row.legacy_key || row.id,
    authUserId: row.auth_user_id || '',
    username: row.username || '',
    role: row.role || 'CAM',
    status: row.status || 'Active',
    displayName: row.display_name || row.username || '',
    email: row.email || '',
    camProfileId: row.cam_profiles?.legacy_key || null,
  };
}

async function fetchAppUserByAuthId(authUserId) {
  const { data, error } = await supabase
    .from('app_users')
    .select('*, cam_profiles(legacy_key, name)')
    .eq('auth_user_id', authUserId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Supabase Auth user is not linked to an app user.');
  if (data.status === 'Inactive') throw new Error('This user account is inactive.');
  return mapAppUser(data);
}

/* SIGNING IN BY USERNAME IS THE ONE READ THAT HAPPENS BEFORE A SESSION.
 *
 * This used to select from app_users directly, which only worked because that
 * table had no row level security: the key in the browser bundle could read
 * every user, their email and their role, signed in or not. Step 43 closes
 * every table and moves this one lookup into login_email_for_username, a
 * function that answers with the email for one username and nothing else.
 *
 * The fallback exists for a deployment where step 43 has not run yet: the RPC
 * is missing there, so the old select still answers. It can be deleted once
 * every environment has the migration. */
async function resolveLoginEmail(login) {
  const value = String(login || '').trim();
  if (value.includes('@')) return value.toLowerCase();

  const { data, error } = await supabase.rpc('login_email_for_username', { p_username: value });
  if (!error) {
    if (!data) throw new Error('Unknown username or email.');
    return data;
  }
  if (!isMissingFunction(error)) throw new Error(error.message);

  const fallback = await supabase
    .from('app_users')
    .select('email')
    .eq('username', value.toLowerCase())
    .maybeSingle();
  if (fallback.error) throw new Error(fallback.error.message);
  if (!fallback.data?.email) throw new Error('Unknown username or email.');
  return fallback.data.email;
}

function isMissingFunction(error) {
  // PostgREST answers PGRST202 for a function it cannot find in its schema
  // cache, and 404 before the cache is built.
  return error?.code === 'PGRST202'
    || error?.status === 404
    || /could not find the function|does not exist/i.test(error?.message || '');
}

export async function authenticateSupabaseAppUser(login, password) {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Supabase is not configured.');
  }

  const email = await resolveLoginEmail(login);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  return fetchAppUserByAuthId(data.user.id);
}

export async function getSupabaseSessionAppUser() {
  if (!isSupabaseConfigured || !supabase) return null;
  const { data, error } = await supabase.auth.getSession();
  if (error) throw new Error(error.message);
  if (!data.session?.user?.id) return null;
  return fetchAppUserByAuthId(data.session.user.id);
}

export async function signOutSupabase() {
  if (!isSupabaseConfigured || !supabase) return;
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error(error.message);
}
