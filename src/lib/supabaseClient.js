import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseKey);

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseKey)
  : null;

// Self-service password change: any signed-in user (Manager or CAM) can update
// their own password from their profile. Uses the caller's own Supabase session
// for identity, so it does NOT go through the Manager-only /api/admin/users
// route and does not require the old password.
export async function changeOwnPassword(newPassword) {
  if (!supabase) throw new Error('Supabase is not configured.');
  const password = String(newPassword || '');
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
  return true;
}

