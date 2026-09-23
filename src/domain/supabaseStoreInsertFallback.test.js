import { describe, expect, it, vi } from 'vitest';

/* A DEPLOY THAT ARRIVES BEFORE ITS MIGRATION.
 *
 * On 2026-09-23 the build carrying step 47 reached production and the
 * migration did not. strategy_snapshots inserts name `ran` and `ran_basis`,
 * so every manual close import answered `column "ran" does not exist` and
 * wrote nothing, while every read on the same session degraded happily. These
 * pin the write side behaving the same way: drop what the database does not
 * have, keep the close, and let the migration's backfill put the column's
 * values back.
 */
function fakeClient(missing = []) {
  const absent = new Set(missing);
  const attempts = [];
  return {
    attempts,
    from() {
      return {
        insert(rows) {
          attempts.push(rows);
          const offending = [...absent].find((name) =>
            rows.some((row) => Object.prototype.hasOwnProperty.call(row, name)));
          return Promise.resolve(offending
            ? { error: { message: `column "${offending}" does not exist` } }
            : { error: null });
        },
      };
    },
  };
}

async function insertThrough(client, table, rows) {
  const { createSupabaseDailyImportAdapter } = await import('./supabaseStore');
  return createSupabaseDailyImportAdapter(client).insertRows(table, rows);
}

describe('insertRows against a database one migration behind', () => {
  it('drops the column the database does not have and writes the rest', async () => {
    const client = fakeClient(['ran', 'ran_basis']);
    await insertThrough(client, 'strategy_snapshots', [
      { daily_import_id: 'd1', strategy_name: 'RBO', ran: true, ran_basis: 'fills', realized: 0 },
    ]);
    const written = client.attempts.at(-1)[0];
    expect(written).not.toHaveProperty('ran');
    expect(written).not.toHaveProperty('ran_basis');
    expect(written).toMatchObject({ daily_import_id: 'd1', strategy_name: 'RBO', realized: 0 });
  });

  it('rethrows anything that is not a missing column', async () => {
    const client = {
      from: () => ({ insert: () => Promise.resolve({ error: { message: 'duplicate key value violates unique constraint' } }) }),
    };
    await expect(insertThrough(client, 'strategy_snapshots', [{ daily_import_id: 'd1' }]))
      .rejects.toThrow(/duplicate key/);
  });
});
