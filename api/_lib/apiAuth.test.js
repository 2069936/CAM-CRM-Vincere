import { describe, expect, it } from 'vitest';
import { extractBearerToken, requireAppUser } from './apiAuth.js';

function fakeClients({ authUser = { id: 'auth-1' }, appUser = null, assigned = true } = {}) {
  const calls = [];
  const admin = {
    from(table) {
      const query = {
        select() { return query; },
        eq(field, value) { calls.push({ table, field, value }); return query; },
        maybeSingle() {
          if (table === 'app_users') return Promise.resolve({ data: appUser, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        limit() { return query; },
        then(resolve) {
          return Promise.resolve({ data: assigned ? [{ client_id: 'client-1' }] : [], error: null }).then(resolve);
        },
      };
      return query;
    },
  };
  const auth = { auth: { getUser: async () => ({ data: { user: authUser }, error: null }) } };
  return { admin, auth, calls };
}

describe('extractBearerToken', () => {
  it('extracts only a bearer token from the authorization header', () => {
    expect(extractBearerToken({ headers: { authorization: 'Bearer session-token' } })).toBe('session-token');
    expect(extractBearerToken({ headers: { authorization: 'Basic xxx' } })).toBe('');
  });
});

describe('requireAppUser', () => {
  it('uses the database role instead of a browser-provided role', async () => {
    const { admin, auth } = fakeClients({ appUser: { id: 'app-1', role: 'CAM', status: 'Active', cam_profile_id: 'cam-1' } });
    await expect(requireAppUser(
      { headers: { authorization: 'Bearer valid', 'x-role': 'Manager' } },
      { admin, authClient: auth, roles: ['Manager'] },
    )).rejects.toMatchObject({ status: 403 });
  });

  it('rejects inactive users even when their role is allowed', async () => {
    const { admin, auth } = fakeClients({ appUser: { id: 'app-1', role: 'Manager', status: 'Inactive' } });
    await expect(requireAppUser(
      { headers: { authorization: 'Bearer valid' } },
      { admin, authClient: auth, roles: ['Manager'] },
    )).rejects.toMatchObject({ status: 403 });
  });

  it('rejects users whose database status is missing or unexpected', async () => {
    for (const status of [null, 'Pending']) {
      const { admin, auth } = fakeClients({ appUser: { id: 'app-1', role: 'Manager', status } });
      await expect(requireAppUser(
        { headers: { authorization: 'Bearer valid' } },
        { admin, authClient: auth, roles: ['Manager'] },
      )).rejects.toMatchObject({ status: 403 });
    }
  });

  it('allows a CAM only for a client assigned to its linked CAM profile', async () => {
    const { admin, auth, calls } = fakeClients({ appUser: { id: 'app-1', role: 'CAM', status: 'Active', cam_profile_id: 'cam-1' }, assigned: true });
    const user = await requireAppUser(
      { headers: { authorization: 'Bearer valid' } },
      { admin, authClient: auth, roles: ['CAM'], clientUuid: 'client-1' },
    );
    expect(user.id).toBe('app-1');
    expect(calls).toContainEqual({ table: 'client_assignments', field: 'cam_profile_id', value: 'cam-1' });
  });

  it('rejects a CAM for a client not assigned to its linked CAM profile', async () => {
    const { admin, auth } = fakeClients({ appUser: { id: 'app-1', role: 'CAM', status: 'Active', cam_profile_id: 'cam-1' }, assigned: false });
    await expect(requireAppUser(
      { headers: { authorization: 'Bearer valid' } },
      { admin, authClient: auth, roles: ['CAM'], clientUuid: 'client-1' },
    )).rejects.toMatchObject({ status: 403 });
  });

  it('allows a Manager to access every client without an assignment lookup', async () => {
    const { admin, auth, calls } = fakeClients({ appUser: { id: 'app-1', role: 'Manager', status: 'Active' }, assigned: false });
    await expect(requireAppUser(
      { headers: { authorization: 'Bearer valid' } },
      { admin, authClient: auth, roles: ['Manager', 'CAM'], clientUuid: 'client-1' },
    )).resolves.toMatchObject({ id: 'app-1' });
    expect(calls.some((call) => call.table === 'client_assignments')).toBe(false);
  });

  it('allows an explicit first-manager bootstrap when no app user exists', async () => {
    const { admin, auth } = fakeClients({ appUser: null });
    const user = await requireAppUser(
      { headers: { authorization: 'Bearer valid' } },
      {
        admin,
        authClient: auth,
        roles: ['Manager'],
        bootstrap: async ({ authUser }) => ({ id: 'first-manager', auth_user_id: authUser.id, role: 'Manager', status: 'Active' }),
      },
    );
    expect(user).toMatchObject({ id: 'first-manager', role: 'Manager' });
  });
});
