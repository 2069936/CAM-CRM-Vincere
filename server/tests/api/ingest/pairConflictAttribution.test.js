import { describe, it, expect, vi } from 'vitest';
import { attachAttemptDetail, createPairStore } from '../../../autoCollection/ingest/pair.js';

/* SIXTY-SIX OF SIXTY-EIGHT REFUSALS WERE machine_conflict, AND EVERY AUDIT ROW
 * READ {"reasonCode":"machine_conflict"} AND NOTHING ELSE.
 *
 * entity_id was null, so the rows could not be attributed to the client being
 * paired and no client page could show its own. And the device holding the
 * machine was never named, so the one action that resolves this refusal, asking
 * the other client's CAM to revoke, had nobody to ask. The pairing RPC knows
 * both and cannot say either: it raises, and an exception carries no row. */

const CLIENT = '11111111-1111-4111-8111-111111111111';
const HOLDER = '22222222-2222-4222-8222-222222222222';
const DEVICE = '33333333-3333-4333-8333-333333333333';

const entry = () => ({
  entityType: 'ingest_pair_attempt',
  entityId: null,
  action: 'ingest_pair.denied',
  afterData: { reasonCode: 'machine_conflict', agentVersion: '1.0.1' },
});

const store = (over = {}) => ({
  findEnrollmentClient: vi.fn(async () => CLIENT),
  findMachineHolder: vi.fn(async () => ({
    deviceId: DEVICE,
    clientUuid: HOLDER,
    clientName: 'Andrew Nestra',
    pairedAt: '2026-09-01T20:32:00.000Z',
  })),
  ...over,
});

const hashes = { codeHash: 'code-hash', machineHash: 'machine-hash' };

describe('attributing a refusal', () => {
  it('stamps the client that was being paired, so the client page can find it', async () => {
    const result = await attachAttemptDetail(store(), entry(), { reasonCode: 'machine_conflict', ...hashes });
    expect(result.entityId).toBe(CLIENT);
  });

  it('records who is holding the machine', async () => {
    const result = await attachAttemptDetail(store(), entry(), { reasonCode: 'machine_conflict', ...hashes });
    expect(result.afterData.blockedBy).toMatchObject({ clientName: 'Andrew Nestra', clientUuid: HOLDER, deviceId: DEVICE });
  });

  it('keeps the reason and versions that were already being written', async () => {
    const result = await attachAttemptDetail(store(), entry(), { reasonCode: 'machine_conflict', ...hashes });
    expect(result.afterData).toMatchObject({ reasonCode: 'machine_conflict', agentVersion: '1.0.1' });
  });

  it('does not look for a holder on refusals that are not about the machine', async () => {
    // An extra service-role read on every expired code, for a field nothing
    // would show.
    const fake = store();
    await attachAttemptDetail(fake, entry(), { reasonCode: 'code_expired', ...hashes });
    expect(fake.findMachineHolder).not.toHaveBeenCalled();
    expect(fake.findEnrollmentClient).toHaveBeenCalledWith('code-hash');
  });

  it('still attributes a refusal whose holder lookup failed', async () => {
    // Half an answer beats the null row this replaced.
    const result = await attachAttemptDetail(
      store({ findMachineHolder: vi.fn(async () => { throw new Error('permission denied'); }) }),
      entry(),
      { reasonCode: 'machine_conflict', ...hashes },
    );
    expect(result.entityId).toBe(CLIENT);
    expect(result.afterData.blockedBy).toBeUndefined();
  });

  it('never throws, because this runs while answering a request that already failed', async () => {
    const broken = {
      findEnrollmentClient: async () => { throw new Error('down'); },
      findMachineHolder: async () => { throw new Error('down'); },
    };
    await expect(attachAttemptDetail(broken, entry(), { reasonCode: 'machine_conflict', ...hashes }))
      .resolves.toMatchObject({ entityId: null });
  });

  it('leaves the row unattributed when the code matches no enrollment', async () => {
    const result = await attachAttemptDetail(
      store({ findEnrollmentClient: vi.fn(async () => null) }),
      entry(),
      { reasonCode: 'machine_conflict', ...hashes },
    );
    expect(result.entityId).toBeNull();
  });
});

describe('reading the holder out of the fleet', () => {
  function admin(deviceRow, clientRow) {
    const calls = [];
    const query = (table) => {
      const q = {
        select(columns) { calls.push({ table, columns }); return q; },
        eq(column, value) { calls.push({ table, column, value }); return q; },
        is() { return q; },
        order() { return q; },
        limit() { return q; },
        async maybeSingle() {
          return { data: table === 'ingest_devices' ? deviceRow : clientRow, error: null };
        },
      };
      return q;
    };
    return { calls, from: (table) => query(table) };
  }

  it('resolves the active device on that machine to a client name', async () => {
    const fake = admin(
      { id: DEVICE, client_id: HOLDER, created_at: '2026-09-01T20:32:00.000Z' },
      { name: 'Andrew Nestra' },
    );
    await expect(createPairStore(fake).findMachineHolder('machine-hash')).resolves.toEqual({
      deviceId: DEVICE,
      clientUuid: HOLDER,
      clientName: 'Andrew Nestra',
      pairedAt: '2026-09-01T20:32:00.000Z',
    });
  });

  it('asks only for devices still holding the machine', async () => {
    // A revoked device does not block anything, and naming one would send a CAM
    // to ask for a revocation that already happened.
    const fake = admin({ id: DEVICE, client_id: HOLDER }, { name: 'Andrew Nestra' });
    await createPairStore(fake).findMachineHolder('machine-hash');
    expect(fake.calls).toContainEqual({ table: 'ingest_devices', column: 'machine_id_hash', value: 'machine-hash' });
    expect(fake.calls).toContainEqual({ table: 'ingest_devices', column: 'status', value: 'active' });
  });

  it('is null when nothing holds the machine', async () => {
    await expect(createPairStore(admin(null, null)).findMachineHolder('machine-hash')).resolves.toBeNull();
  });

  it('reports the device with no name rather than failing on a blank one', async () => {
    const fake = admin({ id: DEVICE, client_id: HOLDER }, { name: '   ' });
    await expect(createPairStore(fake).findMachineHolder('machine-hash'))
      .resolves.toMatchObject({ clientName: null, clientUuid: HOLDER });
  });
});
