import { describe, it, expect } from 'vitest';
import { resolveClientForIngest } from './ingestAuth';

// Minimal chainable mock of a Supabase service-role client.
function mockAdmin({ clientRow = null, deviceRow = null } = {}) {
  const inserts = [];
  const admin = {
    inserts,
    from(table) {
      const builder = {
        select() { return builder; },
        eq() { return builder; },
        maybeSingle() {
          if (table === 'clients') return Promise.resolve({ data: clientRow, error: null });
          if (table === 'ingest_devices') return Promise.resolve({ data: deviceRow, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        insert(row) {
          inserts.push({ table, row });
          return Promise.resolve({ error: null });
        },
      };
      return builder;
    },
  };
  return admin;
}

describe('resolveClientForIngest', () => {
  it('binds the machine on the first upload for a product key', async () => {
    const admin = mockAdmin({ clientRow: { id: 'client-1' }, deviceRow: null });
    const result = await resolveClientForIngest(admin, { productKey: 'PK-ABC', machineId: 'vps-01' });
    expect(result).toEqual({ clientId: 'client-1', bound: true });
    expect(admin.inserts).toEqual([
      { table: 'ingest_devices', row: { product_key: 'PK-ABC', client_id: 'client-1', machine_id: 'vps-01' } },
    ]);
  });

  it('accepts a later upload from the same bound machine', async () => {
    const admin = mockAdmin({ clientRow: { id: 'client-1' }, deviceRow: { id: 'dev-1', machine_id: 'vps-01' } });
    const result = await resolveClientForIngest(admin, { productKey: 'PK-ABC', machineId: 'vps-01' });
    expect(result).toEqual({ clientId: 'client-1', bound: false });
    expect(admin.inserts).toHaveLength(0);
  });

  it('rejects a leaked product key used from a different machine (403)', async () => {
    const admin = mockAdmin({ clientRow: { id: 'client-1' }, deviceRow: { id: 'dev-1', machine_id: 'vps-01' } });
    await expect(
      resolveClientForIngest(admin, { productKey: 'PK-ABC', machineId: 'attacker-pc' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects an unknown product key (401)', async () => {
    const admin = mockAdmin({ clientRow: null });
    await expect(
      resolveClientForIngest(admin, { productKey: 'nope', machineId: 'vps-01' }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('requires a product key and a machine id', async () => {
    const admin = mockAdmin({ clientRow: { id: 'client-1' } });
    await expect(resolveClientForIngest(admin, { machineId: 'vps-01' })).rejects.toMatchObject({ status: 401 });
    await expect(resolveClientForIngest(admin, { productKey: 'PK-ABC' })).rejects.toMatchObject({ status: 400 });
  });
});
