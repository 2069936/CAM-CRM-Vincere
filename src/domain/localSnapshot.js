// Runs the CRM against a saved export instead of Supabase.
//
// Everything built over the last weeks — lifecycle, coverage, the report
// designer, the overview charts — has only ever been seen against fixtures.
// Fixtures answer "does it render", not "does it say something true about this
// book", and the two diverge exactly where it matters: an account nobody
// classified, a client with nineteen accounts, a strategy name that repeats.
//
// This is read-only on purpose. A local copy that could be edited would invite
// someone to fix a real problem in a file that goes nowhere.

import { buildCrmStateFromTables, CRM_STATE_TABLES } from './supabaseStore';

/** Where the snapshot is served from. Kept out of the bundle and out of git. */
export const LOCAL_SNAPSHOT_URL = '/local-snapshot.json';

export function isLocalSnapshotEnabled() {
  return String(import.meta.env?.VITE_LOCAL_SNAPSHOT || '') === '1';
}

/**
 * Accepts either the raw /api/admin/data-export body or a bare table map.
 *
 * Missing tables become empty arrays rather than throwing: an export taken
 * before a migration ran is still worth looking at, and failing the whole load
 * over one absent table would hide the eighteen that are present.
 */
export function normalizeSnapshot(payload) {
  const tables = payload?.tables && typeof payload.tables === 'object'
    ? payload.tables
    : payload;
  if (!tables || typeof tables !== 'object') {
    throw new Error('The snapshot file does not look like a data export.');
  }

  const normalized = {};
  const missing = [];
  for (const table of CRM_STATE_TABLES) {
    const rows = tables[table];
    if (Array.isArray(rows)) normalized[table] = rows;
    else {
      normalized[table] = [];
      missing.push(table);
    }
  }
  return { tables: normalized, missing };
}

export async function loadLocalSnapshotState({ preferredCamProfileId = null } = {}) {
  const response = await fetch(LOCAL_SNAPSHOT_URL, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(
      `No snapshot at ${LOCAL_SNAPSHOT_URL}. Export from Operations and save it to public/local-snapshot.json.`,
    );
  }
  const { tables, missing } = normalizeSnapshot(await response.json());
  const state = buildCrmStateFromTables(tables, { preferredCamProfileId });
  return { state, missing };
}
