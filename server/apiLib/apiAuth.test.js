import { describe, expect, it } from 'vitest';
import { extractBearerToken, listAssignedClientIds, requireAppUser, requireClientAssignments } from './apiAuth.js';

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

// A minimal admin client for the bulk-assignment helpers: one row per
// (cam_profile_id, client_id), which is exactly what client_assignments holds.
function assignmentsClient(rows) {
  const queries = [];
  return {
    queries,
    from(table) {
      const filters = {};
      const query = {
        select() { return query; },
        eq(field, value) { filters[field] = value; queries.push({ table, field, value }); return query; },
        order() { return query; },
        limit() { return query; },
        range(from, to) {
          const matched = rows.filter((row) => Object.entries(filters).every(([key, value]) => row[key] === value));
          return Promise.resolve({ data: matched.slice(from, to + 1), error: null });
        },
        then(resolve) {
          const matched = rows.filter((row) => Object.entries(filters).every(([key, value]) => row[key] === value));
          return Promise.resolve({ data: matched, error: null }).then(resolve);
        },
      };
      return query;
    },
  };
}

const ASSIGNMENTS = [
  { cam_profile_id: 'cam-1', client_id: 'client-a' },
  { cam_profile_id: 'cam-1', client_id: 'client-b' },
  { cam_profile_id: 'cam-2', client_id: 'client-c' },
];

describe('requireClientAssignments', () => {
  it('checks every id, so one foreign client in a long list still denies', async () => {
    const admin = assignmentsClient(ASSIGNMENTS);
    const cam = { id: 'app-1', role: 'CAM', cam_profile_id: 'cam-1' };
    await expect(requireClientAssignments(admin, cam, ['client-a', 'client-b']))
      .resolves.toEqual(['client-a', 'client-b']);
    await expect(requireClientAssignments(admin, cam, ['client-a', 'client-b', 'client-c']))
      .rejects.toMatchObject({ status: 403, message: 'Client assignment required.' });
    // Three ids in, three assignment lookups: no id is taken on trust.
    const lookups = admin.queries.filter((call) => call.table === 'client_assignments' && call.field === 'client_id');
    expect(lookups.map((call) => call.value)).toEqual(
      expect.arrayContaining(['client-a', 'client-b', 'client-c']),
    );
  });

  it('is a no-op for a Manager and reads no assignment rows', async () => {
    const admin = assignmentsClient(ASSIGNMENTS);
    const manager = { id: 'app-2', role: 'Manager', cam_profile_id: null };
    await expect(requireClientAssignments(admin, manager, ['client-c'])).resolves.toEqual(['client-c']);
    expect(admin.queries).toHaveLength(0);
  });

  it('denies an empty list rather than treating it as "everything"', async () => {
    const admin = assignmentsClient(ASSIGNMENTS);
    await expect(requireClientAssignments(admin, { role: 'CAM', cam_profile_id: 'cam-1' }, []))
      .rejects.toMatchObject({ status: 403 });
  });
});

describe('listAssignedClientIds', () => {
  it('returns only the clients assigned to that CAM profile', async () => {
    const admin = assignmentsClient(ASSIGNMENTS);
    await expect(listAssignedClientIds(admin, 'cam-1')).resolves.toEqual(['client-a', 'client-b']);
    await expect(listAssignedClientIds(admin, 'cam-2')).resolves.toEqual(['client-c']);
  });

  it('returns nothing for a user with no cam profile, and never widens to the book', async () => {
    const admin = assignmentsClient(ASSIGNMENTS);
    await expect(listAssignedClientIds(admin, null)).resolves.toEqual([]);
    expect(admin.queries).toHaveLength(0);
  });
});

describe('requireClientAssignments input handling', () => {
  it('denies a list holding a falsy id rather than checking the rest and clearing them', async () => {
    // This used to be `.filter(Boolean)`: a list of ids where one was '' or null
    // was authorized as the survivors, and the caller still held the full list.
    // The set that clears has to be the set that was handed in.
    const admin = assignmentsClient(ASSIGNMENTS);
    const cam = { id: 'app-1', role: 'CAM', cam_profile_id: 'cam-1' };
    for (const list of [['client-a', ''], ['client-a', null], ['client-a', undefined]]) {
      await expect(requireClientAssignments(admin, cam, list))
        .rejects.toMatchObject({ status: 403, message: 'Client assignment required.' });
    }
  });

  it('denies a non-string id without letting it reach an assignment lookup', async () => {
    const admin = assignmentsClient(ASSIGNMENTS);
    const cam = { id: 'app-1', role: 'CAM', cam_profile_id: 'cam-1' };
    await expect(requireClientAssignments(admin, cam, ['client-a', { toString: () => 'client-a' }]))
      .rejects.toMatchObject({ status: 403 });
    expect(admin.queries).toHaveLength(0);
  });

  it('returns the de-duplicated set it actually cleared', async () => {
    const admin = assignmentsClient(ASSIGNMENTS);
    const cam = { id: 'app-1', role: 'CAM', cam_profile_id: 'cam-1' };
    await expect(requireClientAssignments(admin, cam, ['client-a', 'client-a', 'client-b']))
      .resolves.toEqual(['client-a', 'client-b']);
  });
});
