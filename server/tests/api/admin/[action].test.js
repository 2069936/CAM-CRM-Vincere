import { describe, expect, it } from 'vitest';
import { resolveAdminHandler } from '../../../../api/admin/[action].js';

describe('admin route dispatcher', () => {
  it.each(['client-export', 'ingest-agent-update', 'ingest-batches', 'ingest-download', 'ingest-enrollment', 'ingest-fleet', 'ingest-reprocess', 'ingest-status', 'ingest-trading-export', 'ingest-verify'])('preserves /api/admin/%s', (action) => {
    expect(resolveAdminHandler(action)).toEqual(expect.any(Function));
  });

  it('dispatches /api/admin/ingest-trading-export to the Manager trading export route (step 72)', async () => {
    const route = (await import('../../../autoCollection/admin/ingest-trading-export.js')).default;
    expect(resolveAdminHandler('ingest-trading-export')).toBe(route);
  });

  it('does not dispatch unknown paths', () => {
    expect(resolveAdminHandler('unknown')).toBeNull();
  });
});
