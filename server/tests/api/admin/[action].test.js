import { describe, expect, it } from 'vitest';
import { resolveAdminHandler } from '../../../../api/admin/[action].js';

describe('admin route dispatcher', () => {
  it.each(['ingest-batches', 'ingest-download', 'ingest-enrollment', 'ingest-fleet', 'ingest-reprocess', 'ingest-status', 'ingest-verify'])('preserves /api/admin/%s', (action) => {
    expect(resolveAdminHandler(action)).toEqual(expect.any(Function));
  });

  it('does not dispatch unknown paths', () => {
    expect(resolveAdminHandler('unknown')).toBeNull();
  });
});
