/* The browser's Supabase client, absent.
 *
 * supabaseStore.js holds buildCrmStateFromTables, which is a pure
 * transformation over table arrays, beside several dozen functions that talk
 * to the database as the signed-in user. The daily email bundle needs the
 * first and must not carry the second: the function runs inside the database
 * with a service role, and a browser auth client in that process is code with
 * no business being there.
 *
 * This is not a mock standing in for something that would otherwise work. It
 * is what src/lib/supabaseClient.js already evaluates to wherever the VITE_
 * variables are unset, which is every environment except a browser with the
 * app's own build. Any code path that reached for `supabase` here would have
 * been reaching for null in production too.
 */
export const isSupabaseConfigured = false;
export const supabase = null;
