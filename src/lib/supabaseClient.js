import { createClient } from '@supabase/supabase-js';
import { createRetryingFetch } from '../domain/supabaseRetry';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseKey);

// Every request the app makes goes through the collector's retry policy —
// see src/domain/supabaseRetry.js for what is retried and why it differs by
// method. Installed on the client rather than around individual helpers so a
// new write in supabaseStore.js cannot forget it, and because Retry-After is
// only visible here: supabase-js hands its callers `{ data, error, status }`
// and drops the response headers.
export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseKey, {
    global: { fetch: createRetryingFetch((...args) => fetch(...args)) },
  })
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

