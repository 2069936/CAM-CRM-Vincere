import { describe, it, expect } from 'vitest';
import { createIngestEnrollmentStore } from '../../../autoCollection/admin/ingest-enrollment.js';

/* create_ingest_enrollment refuses on any of five conditions and raises one
 * name for all of them, so the CAM read "This client is not ready for automatic
 * collection" and had no way to tell whether the status was wrong, the client
 * was deleted, or the product key had simply never been filled in. Four of the
 * five are one field away in the client profile. */

function storeReturning(row, error = null) {
  const admin = {
    from() { return this; },
    select() { return this; },
    eq() { return this; },
    async maybeSingle() { return { data: row, error }; },
  };
  return createIngestEnrollmentStore(admin);
}

const eligible = {
  status: 'Active',
  deleted_at: null,
  name: 'Joel Onafowokan',
  product_key: 'VIN-0001',
};

describe('naming which condition refused the client', () => {
  it('names a blank product key, the one nobody thinks to check', () => {
    // Nothing forces this field, so a client can look completely normal and
    // still be unenrollable forever.
    return expect(storeReturning({ ...eligible, product_key: '' }).describeIneligibility('id'))
      .resolves.toBe('client_product_key_missing');
  });

  it('treats a product key of only spaces as missing, the way the RPC does', () => {
    return expect(storeReturning({ ...eligible, product_key: '   ' }).describeIneligibility('id'))
      .resolves.toBe('client_product_key_missing');
  });

  it('names a status that is not Active', async () => {
    // The RPC compares exactly, so Churned, Inactive and Paused all refuse, and
    // this book has clients marked Churned that are trading every day.
    for (const status of ['Churned', 'Inactive', 'Paused', 'active', 'Active ']) {
      await expect(storeReturning({ ...eligible, status }).describeIneligibility('id'))
        .resolves.toBe('client_not_active');
    }
  });

  it('names a deleted client before anything else', async () => {
    // A deleted client is also not Active. Reporting the deletion is the more
    // useful of the two, because restoring it is a different action.
    await expect(storeReturning({ ...eligible, status: 'Churned', deleted_at: '2026-08-01' })
      .describeIneligibility('id')).resolves.toBe('client_deleted');
  });

  it('names a blank name', () => {
    return expect(storeReturning({ ...eligible, name: '  ' }).describeIneligibility('id'))
      .resolves.toBe('client_name_missing');
  });

  it('names a client that is not there', async () => {
    await expect(storeReturning(null).describeIneligibility('id')).resolves.toBe('client_not_found');
    await expect(storeReturning(null, { message: 'boom' }).describeIneligibility('id'))
      .resolves.toBe('client_not_found');
  });

  it('falls back to the old answer when every condition looks satisfied', () => {
    // The RPC said no and this read says yes, which means they disagree. Saying
    // "not ready" is honest there; inventing a reason would not be.
    return expect(storeReturning(eligible).describeIneligibility('id'))
      .resolves.toBe('client_not_eligible');
  });
});
