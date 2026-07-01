import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';

function mapAppUser(row) {
  if (!row) return null;
  return {
    id: row.legacy_key || row.id,
    authUserId: row.auth_user_id || '',
    username: row.username || '',
    role: row.role || 'CAM',
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
  return mapAppUser(data);
}

async function resolveLoginEmail(login) {
  const value = String(login || '').trim();
  if (value.includes('@')) return value.toLowerCase();

  const { data, error } = await supabase
    .from('app_users')
    .select('email')
    .eq('username', value.toLowerCase())
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.email) throw new Error('Unknown username or email.');
  return data.email;
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

