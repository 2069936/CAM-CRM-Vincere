import { describe, expect, it } from 'vitest';
import { normalizeSnapshot } from './localSnapshot';
import { CRM_STATE_TABLES } from './supabaseStore';

describe('normalizeSnapshot', () => {
  it('accepts the raw export body', () => {
    const { tables } = normalizeSnapshot({ tables: { clients: [{ id: 'c1' }] } });

    expect(tables.clients).toEqual([{ id: 'c1' }]);
  });

  it('accepts a bare table map', () => {
    const { tables } = normalizeSnapshot({ clients: [{ id: 'c1' }] });

    expect(tables.clients).toEqual([{ id: 'c1' }]);
  });

  it('names absent tables instead of failing the whole load', () => {
    // An export taken before a migration ran is still worth looking at, and
    // refusing it over one missing table hides the seventeen that are present.
    const { tables, missing } = normalizeSnapshot({ clients: [] });

    expect(missing).toContain('cam_time_off');
    expect(missing).not.toContain('clients');
    for (const table of CRM_STATE_TABLES) expect(Array.isArray(tables[table])).toBe(true);
  });

  it('rejects a file that is not an export', () => {
    expect(() => normalizeSnapshot(null)).toThrow(/does not look like/);
    expect(() => normalizeSnapshot('nonsense')).toThrow(/does not look like/);
  });

  it('ignores a table that is present but not an array', () => {
    const { tables, missing } = normalizeSnapshot({ clients: { id: 'c1' } });

    expect(tables.clients).toEqual([]);
    expect(missing).toContain('clients');
  });
});
