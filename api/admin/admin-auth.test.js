import { describe, expect, it } from 'vitest';
import { createHandler as createUsersHandler } from './users.js';
import { createHandler as createIntakeHandler } from './intake-sheet.js';
import { createHandler as createExportHandler } from './data-export.js';

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(status) { this.statusCode = status; return this; },
    json(body) { this.body = body; return this; },
  };
}

function camClients() {
  const admin = {
    from() {
      const query = {
        select() { return query; },
        eq() { return query; },
        maybeSingle: async () => ({
          data: { id: 'app-cam', role: 'CAM', status: 'Active', cam_profile_id: 'cam-1' },
          error: null,
        }),
      };
      return query;
    },
  };
  const auth = { auth: { getUser: async () => ({ data: { user: { id: 'auth-cam' } }, error: null }) } };
  return () => ({ admin, auth });
}

function emptyAppUsersClients() {
  let created = null;
  const admin = {
    from(table) {
      const query = {
        mode: '',
        select(columns, options) {
          if (options?.head) query.mode = 'count';
          else if (columns.startsWith('*')) query.mode = 'list';
          else query.mode = 'lookup';
          return query;
        },
        eq() { return query; },
        order() { return query; },
        maybeSingle: async () => ({ data: null, error: null }),
        insert(row) {
          created = row;
          return { select: () => ({ single: async () => ({ data: { id: 'manager-1', role: 'Manager', status: 'Active' }, error: null }) }) };
        },
        then(resolve) {
          const value = query.mode === 'count'
            ? { count: 0, error: null }
            : { data: [{ ...created, id: 'manager-1' }], error: null };
          return Promise.resolve(value).then(resolve);
        },
      };
      if (table !== 'app_users') throw new Error(`Unexpected table: ${table}`);
      return query;
    },
  };
  const auth = { auth: { getUser: async () => ({ data: { user: { id: 'auth-first', email: 'first@example.test' } }, error: null }) } };
  return { createClients: () => ({ admin, auth }), created: () => created };
}

describe('admin endpoint authorization regression', () => {
  it('rejects a CAM from user administration', async () => {
    const res = response();
    await createUsersHandler({ createClients: camClients() })({ method: 'GET', headers: { authorization: 'Bearer valid' } }, res);
    expect(res).toMatchObject({ statusCode: 403, body: { error: 'Manager permission required.' } });
  });

  it('rejects a CAM from the intake sheet', async () => {
    const res = response();
    await createIntakeHandler({ createClients: camClients(), sheetUrl: 'https://example.test/sheet.csv' })({ method: 'GET', headers: { authorization: 'Bearer valid' } }, res);
    expect(res).toMatchObject({ statusCode: 403, body: { error: 'Manager permission required.' } });
  });

  it('rejects a CAM from data export', async () => {
    const res = response();
    await createExportHandler({ createClients: camClients() })({ method: 'GET', headers: { authorization: 'Bearer valid' } }, res);
    expect(res).toMatchObject({ statusCode: 403, body: { error: 'Manager permission required.' } });
  });

  it('keeps the explicit empty-table first-Manager bootstrap for user administration', async () => {
    const clients = emptyAppUsersClients();
    const res = response();
    await createUsersHandler({ createClients: clients.createClients })({ method: 'GET', headers: { authorization: 'Bearer valid' } }, res);
    expect(clients.created()).toMatchObject({ auth_user_id: 'auth-first', role: 'Manager', status: 'Active' });
    expect(res).toMatchObject({ statusCode: 200, body: { users: [expect.objectContaining({ role: 'Manager' })] } });
  });
});
