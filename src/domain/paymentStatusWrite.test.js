// The payment status, written: what reaches `clients` and what reaches the
// price log when the client form or the sheet importer saves a client.
//
// Drives the real updateSupabaseClient against a PostgREST stand-in, the way
// churnClassificationWrite.test.js does, so it is the actual write path being
// measured. Two things matter here and both are invisible from the parser and
// the panel tests beside it:
//
//   THE PRICE LOG. Revenue movement is computed from client_price_changes and
//   nothing else. An amount that changes without a log row is MRR that moved
//   and was never recorded, which is exactly the hole the log was created to
//   close. A status change that stops the money (paused, cancelled) must log
//   too, which it does because the price column goes to Undetermined.
//
//   THE COLUMN ONLY WHEN ASKED. payment_status is mapped only when the patch
//   carries it, so on a database where step 62 has not run an ordinary contact
//   card edit still saves.
//
// Synthetic throughout: no book, so CI runs every line.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ writes: [], row: { id: 'uuid-1', subscription_price: '$500' } }));

vi.mock('../lib/supabaseClient', () => ({
  isSupabaseConfigured: true,
  supabase: {
    from(table) {
      const builder = {
        select() { return builder; },
        update(patch) {
          db.writes.push({ table, kind: 'update', patch });
          return builder;
        },
        eq() { return builder; },
        upsert(patch) {
          db.writes.push({ table, kind: 'upsert', patch });
          return Promise.resolve({ error: null });
        },
        delete() { return builder; },
        insert(rows) {
          db.writes.push({ table, kind: 'insert', patch: rows });
          return Promise.resolve({ error: null });
        },
        maybeSingle() { return Promise.resolve({ data: db.row, error: null }); },
        single() { return Promise.resolve({ data: db.row, error: null }); },
      };
      return builder;
    },
  },
}));

const { updateSupabaseClient } = await import('./supabaseStore.js');
const { paymentPatchFor, buildPaymentStatusImport } = await import('./paymentStatusSheet.js');

const clientUpdate = () => db.writes.find((entry) => entry.table === 'clients' && entry.kind === 'update')?.patch;
const priceLogRows = () => db.writes.filter((entry) => entry.table === 'client_price_changes' && entry.kind === 'insert');

const stored = (price, status) => {
  db.row = { id: 'uuid-1', subscription_price: price, payment_status: status };
};

const client = (price, status) => ({
  id: 'c1',
  name: 'Ada Quill',
  status: 'Active',
  deletedAt: null,
  subscriptionPrice: price,
  paymentStatus: status,
  profile: { email: 'ada@quill.test', additionalEmails: [], fullName: 'Ada Quill', subscriptionPrice: price, paymentStatus: status },
});

const sheet = (status, amount) => {
  const titles = { paying: 'Paying a subscription', free: 'Free CAM', paused: 'Paused', cancelled: null };
  if (status === 'cancelled') return 'Name\tEmail\nAda Quill\tada@quill.test';
  return [
    titles[status],
    status === 'paying' ? 'Name\tEmail\tAmount\tNotes' : 'Name\tEmail\tNotes',
    status === 'paying' ? `Ada Quill\tada@quill.test\t${amount}\t` : 'Ada Quill\tada@quill.test\t',
  ].join('\n');
};

/** The one change the importer would Apply for this sheet over this client. */
function applyEntry(status, amount, current) {
  const plan = buildPaymentStatusImport(sheet(status, amount), [current]);
  expect(plan.changes).toHaveLength(1);
  return updateSupabaseClient('c1', paymentPatchFor(plan.changes[0]));
}

beforeEach(() => {
  db.writes = [];
  stored('$500', 'paying');
});

describe('an amount change from the sheet', () => {
  it('writes both columns in one UPDATE and a price log row from the old amount to the new', async () => {
    await applyEntry('paying', '$400', client('$500', 'paying'));
    expect(db.writes.filter((entry) => entry.table === 'clients' && entry.kind === 'update')).toHaveLength(1);
    expect(clientUpdate()).toMatchObject({ payment_status: 'paying', subscription_price: '$400' });
    expect(priceLogRows()).toHaveLength(1);
    expect(priceLogRows()[0].patch).toMatchObject({ client_id: 'uuid-1', previous_price: '$500', new_price: '$400' });
  });

  it('logs a pause as the money stopping: the price column goes to Undetermined', async () => {
    await applyEntry('paused', null, client('$500', 'paying'));
    expect(clientUpdate()).toMatchObject({ payment_status: 'paused', subscription_price: 'Undetermined' });
    expect(priceLogRows()[0].patch).toMatchObject({ previous_price: '$500', new_price: 'Undetermined' });
  });

  it('logs a cancellation the same way', async () => {
    await applyEntry('cancelled', null, client('$500', 'paying'));
    expect(clientUpdate()).toMatchObject({ payment_status: 'cancelled', subscription_price: 'Undetermined' });
    expect(priceLogRows()).toHaveLength(1);
  });

  it('logs a first amount for a client nobody had priced', async () => {
    stored('Undetermined', 'undetermined');
    await applyEntry('paying', '$183', client('Undetermined', 'undetermined'));
    expect(clientUpdate()).toMatchObject({ payment_status: 'paying', subscription_price: '$183' });
    expect(priceLogRows()[0].patch).toMatchObject({ previous_price: 'Undetermined', new_price: '$183' });
  });

  it('writes no log row when the status moves but the price column does not', async () => {
    // Undetermined to paused: nothing was being collected before or after.
    stored('Undetermined', 'undetermined');
    await applyEntry('paused', null, client('Undetermined', 'undetermined'));
    expect(clientUpdate()).toMatchObject({ payment_status: 'paused', subscription_price: 'Undetermined' });
    expect(priceLogRows()).toHaveLength(0);
  });
});

describe('the client form', () => {
  it('saves a preset amount with the status, and logs it', async () => {
    await updateSupabaseClient('c1', { profile: { fullName: 'Ada Quill', paymentStatus: 'paying', subscriptionPrice: '$375' } });
    expect(clientUpdate()).toMatchObject({ payment_status: 'paying', subscription_price: '$375', full_name: 'Ada Quill' });
    expect(priceLogRows()[0].patch).toMatchObject({ previous_price: '$500', new_price: '$375' });
  });

  it('normalizes what it is handed: an unknown status lands on undetermined, an unknown price on Undetermined', async () => {
    await updateSupabaseClient('c1', { profile: { paymentStatus: 'whatever', subscriptionPrice: 'premium' } });
    expect(clientUpdate()).toMatchObject({ payment_status: 'undetermined', subscription_price: 'Undetermined' });
  });

  it('leaves payment_status out of an ordinary contact card edit, so a pre-62 database still saves', async () => {
    await updateSupabaseClient('c1', { profile: { phone: '+57 300 000 0000', fullName: 'Ada Quill' } });
    const patch = clientUpdate();
    expect(patch.phone).toBe('+57 300 000 0000');
    expect('payment_status' in patch).toBe(false);
    expect('subscription_price' in patch).toBe(false);
    expect(priceLogRows()).toHaveLength(0);
  });

  it('writes no log row when the whole profile is re-sent with the same price', async () => {
    await updateSupabaseClient('c1', { profile: { phone: '1', paymentStatus: 'paying', subscriptionPrice: '$500' } });
    expect(priceLogRows()).toHaveLength(0);
  });
});
