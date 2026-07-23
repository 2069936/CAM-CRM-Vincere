import { createApiClients, requireAppUser } from '../_lib/apiAuth.js';
import { handleApiError, readJsonBody, requireMethod, sendJson } from '../_lib/http.js';

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function legacyUserKey(username) {
  return `user-${normalizeUsername(username).replace(/[^a-z0-9_-]/g, '-')}`;
}

function legacyCamKey(username) {
  return `am-${normalizeUsername(username).replace(/[^a-z0-9_-]/g, '-')}`;
}

function mapUser(row) {
  return {
    id: row.legacy_key || row.id,
    appUserId: row.id,
    authUserId: row.auth_user_id || '',
    username: row.username || '',
    role: row.role || 'CAM',
    status: row.status || 'Active',
    displayName: row.display_name || row.username || '',
    email: row.email || '',
    camProfileId: row.cam_profiles?.legacy_key || null,
    hasCamProfile: Boolean(row.cam_profile_id),
    lastActiveAt: row.last_active_at || '',
  };
}

function authUserDisplayName(authUser) {
  return authUser.user_metadata?.display_name
    || authUser.user_metadata?.full_name
    || authUser.email?.split('@')?.[0]
    || 'Manager';
}

function authUserUsername(authUser) {
  return normalizeUsername(
    authUser.user_metadata?.username
    || authUser.email?.split('@')?.[0]
    || 'manager',
  );
}

async function bootstrapFirstManager(admin, authUser) {
  const { count, error: countError } = await admin
    .from('app_users')
    .select('id', { count: 'exact', head: true });
  if (countError) throw countError;
  if (count !== 0) return null;

  const username = authUserUsername(authUser);
  const displayName = authUserDisplayName(authUser);
  const email = normalizeEmail(authUser.email);

  const { data, error } = await admin
    .from('app_users')
    .insert({
      legacy_key: legacyUserKey(username),
      auth_user_id: authUser.id,
      username,
      display_name: displayName,
      email,
      role: 'Manager',
      status: 'Active',
      updated_at: new Date().toISOString(),
    })
    .select('id, role, status')
    .single();
  if (error) throw error;
  return data;
}

async function getCamProfileId(admin, camProfileId) {
  if (!camProfileId) return null;
  const { data, error } = await admin
    .from('cam_profiles')
    .select('id')
    .eq('legacy_key', camProfileId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.id) throw Object.assign(new Error(`CAM profile not found: ${camProfileId}`), { status: 400 });
  return data.id;
}

async function createCamProfileForUser(admin, { username, displayName, status = 'Active' }) {
  const { data, error } = await admin
    .from('cam_profiles')
    .upsert({
      legacy_key: legacyCamKey(username),
      name: displayName,
      role_title: 'CAM',
      status,
      live: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'legacy_key' })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function updateLinkedCamProfile(admin, camProfileId, { name, status }) {
  if (!camProfileId) return;
  const { error } = await admin
    .from('cam_profiles')
    .update({
      name,
      status,
      live: status !== 'Inactive',
      updated_at: new Date().toISOString(),
    })
    .eq('id', camProfileId);
  if (error) throw error;
}

async function deleteCamProfile(admin, camProfileId) {
  if (!camProfileId) return;
  const { error } = await admin
    .from('cam_profiles')
    .delete()
    .eq('id', camProfileId);
  if (error) throw error;
}

async function listUsers(admin) {
  const { data, error } = await admin
    .from('app_users')
    .select('*, cam_profiles(legacy_key, name)')
    .order('role', { ascending: false })
    .order('display_name', { ascending: true });
  if (error) throw error;
  const users = (data || []).map(mapUser);
  if (!users.length) {
    throw Object.assign(new Error('No app_users rows returned from Supabase. Verify public.app_users has rows and the API is pointed at the correct project.'), { status: 500 });
  }
  return users;
}

async function createUser(admin, payload) {
  const username = normalizeUsername(payload.username);
  const email = normalizeEmail(payload.email);
  const password = String(payload.password || '');
  const displayName = String(payload.displayName || '').trim();
  const role = payload.role === 'Manager' ? 'Manager' : 'CAM';
  if (!username || !email || !password || !displayName) {
    throw Object.assign(new Error('Display name, username, email, and password are required.'), { status: 400 });
  }

  const { data: duplicate, error: duplicateError } = await admin
    .from('app_users')
    .select('id')
    .or(`username.eq.${username},email.eq.${email}`)
    .limit(1)
    .maybeSingle();
  if (duplicateError) throw duplicateError;
  if (duplicate?.id) {
    throw Object.assign(new Error('Username or email is already in use.'), { status: 409 });
  }

  const { data: authData, error: authError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { username, display_name: displayName, role },
  });
  if (authError) throw authError;

  try {
    const wantsCamProfile = Boolean(payload.hasCamProfile || payload.camProfileId);
    const camUuid = payload.camProfileId
      ? await getCamProfileId(admin, payload.camProfileId)
      : wantsCamProfile
        ? await createCamProfileForUser(admin, { username, displayName, status: 'Active' })
        : null;
    const { data, error } = await admin
      .from('app_users')
      .upsert({
        legacy_key: legacyUserKey(username),
        auth_user_id: authData.user.id,
        username,
        display_name: displayName,
        email,
        role,
        status: 'Active',
        cam_profile_id: camUuid,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'auth_user_id' })
      .select('*, cam_profiles(legacy_key, name)')
      .single();
    if (error) throw error;
    return mapUser(data);
  } catch (err) {
    // Roll back the freshly-created Auth user so a later failure doesn't strand
    // an orphan (Auth user with no app_users row) that blocks re-creating the email.
    await admin.auth.admin.deleteUser(authData.user.id).catch(() => {});
    throw err;
  }
}

async function updateUser(admin, payload) {
  const appUserId = payload.appUserId;
  if (!appUserId) throw Object.assign(new Error('appUserId is required.'), { status: 400 });

  const { data: existing, error: existingError } = await admin
    .from('app_users')
    .select('*')
    .eq('id', appUserId)
    .maybeSingle();
  if (existingError) throw existingError;
  if (!existing) throw Object.assign(new Error('User not found.'), { status: 404 });

  const username = payload.username != null ? normalizeUsername(payload.username) : existing.username;
  const email = payload.email != null ? normalizeEmail(payload.email) : existing.email;
  const displayName = payload.displayName != null ? String(payload.displayName || '').trim() : existing.display_name;
  const role = payload.role === 'Manager' ? 'Manager' : payload.role === 'CAM' ? 'CAM' : existing.role;
  const status = payload.status === 'Inactive' ? 'Inactive' : 'Active';
  const wantsCamProfile = (
    'hasCamProfile' in payload
      ? Boolean(payload.hasCamProfile)
      : 'camProfileId' in payload
        ? Boolean(payload.camProfileId)
        : Boolean(existing.cam_profile_id)
  );
  let camUuid = existing.cam_profile_id;

  if (!username || !email || !displayName) {
    throw Object.assign(new Error('Display name, username, and email are required.'), { status: 400 });
  }

  // Catch a colliding username/email up front (excluding this user) so a duplicate
  // returns a clean 409 instead of a late DB constraint error after Auth/CAM are
  // already mutated below, which would leave the account half-updated.
  const { data: conflict, error: conflictError } = await admin
    .from('app_users')
    .select('id')
    .or(`username.eq.${username},email.eq.${email}`)
    .neq('id', appUserId)
    .limit(1)
    .maybeSingle();
  if (conflictError) throw conflictError;
  if (conflict?.id) {
    throw Object.assign(new Error('Username or email is already in use.'), { status: 409 });
  }

  if (!wantsCamProfile) {
    await deleteCamProfile(admin, existing.cam_profile_id);
    camUuid = null;
  } else if (payload.camProfileId && payload.camProfileId !== existing.cam_profile_id) {
    camUuid = await getCamProfileId(admin, payload.camProfileId);
    await updateLinkedCamProfile(admin, camUuid, { name: displayName, status });
  } else if (!existing.cam_profile_id) {
    camUuid = await createCamProfileForUser(admin, { username, displayName, status });
  } else {
    await updateLinkedCamProfile(admin, existing.cam_profile_id, { name: displayName, status });
  }

  if (existing.auth_user_id) {
    const authPatch = {
      email,
      user_metadata: { username, display_name: displayName, role },
      ban_duration: status === 'Inactive' ? '876000h' : 'none',
    };
    if (payload.password) authPatch.password = String(payload.password);
    const { error: authError } = await admin.auth.admin.updateUserById(existing.auth_user_id, authPatch);
    if (authError) throw authError;
  }

  const { data, error } = await admin
    .from('app_users')
    .update({
      legacy_key: legacyUserKey(username),
      username,
      display_name: displayName,
      email,
      role,
      status,
      cam_profile_id: camUuid,
      updated_at: new Date().toISOString(),
    })
    .eq('id', appUserId)
    .select('*, cam_profiles(legacy_key, name)')
    .single();
  if (error) throw error;
  return mapUser(data);
}

async function deleteUser(admin, payload) {
  const appUserId = payload.appUserId;
  if (!appUserId) throw Object.assign(new Error('appUserId is required.'), { status: 400 });

  const { data: existing, error: existingError } = await admin
    .from('app_users')
    .select('*')
    .eq('id', appUserId)
    .maybeSingle();
  if (existingError) throw existingError;
  if (!existing) throw Object.assign(new Error('User not found.'), { status: 404 });
  if (existing.role === 'Manager') {
    throw Object.assign(new Error('Manager users cannot be deleted from this panel.'), { status: 400 });
  }

  if (existing.auth_user_id) {
    const { error: authError } = await admin.auth.admin.deleteUser(existing.auth_user_id);
    if (authError) throw authError;
  }

  const { error: appUserError } = await admin
    .from('app_users')
    .delete()
    .eq('id', appUserId);
  if (appUserError) throw appUserError;

  await deleteCamProfile(admin, existing.cam_profile_id);
  return mapUser(existing);
}

export function createHandler({ createClients = createApiClients } = {}) {
  return async function handler(req, res) {
    try {
      const { admin, auth } = createClients();
      await requireAppUser(req, {
        admin,
        authClient: auth,
        roles: ['Manager'],
        // This is deliberately the sole bootstrap exception: only an empty
        // app_users table can establish the first Manager.
        bootstrap: ({ admin: service, authUser }) => bootstrapFirstManager(service, authUser),
      });

      if (req.method === 'GET') {
        return sendJson(res, 200, { users: await listUsers(admin) });
      }

      const payload = await readJsonBody(req);
      if (req.method === 'POST') {
        const user = await createUser(admin, payload);
        return sendJson(res, 201, { user, users: await listUsers(admin) });
      }
      if (req.method === 'PATCH') {
        const user = await updateUser(admin, payload);
        return sendJson(res, 200, { user, users: await listUsers(admin) });
      }
      if (req.method === 'DELETE') {
        const user = await deleteUser(admin, payload);
        return sendJson(res, 200, { user, users: await listUsers(admin) });
      }

      requireMethod(req, ['GET', 'POST', 'PATCH', 'DELETE']);
    } catch (error) {
      return handleApiError(res, error, { fallbackMessage: 'Unexpected user management error.' });
    }
  }
}

export default createHandler();
