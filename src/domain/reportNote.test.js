// The note has to come BACK. Everything else about it already existed.
//
// The round trip is driven through an in-memory `reports` table that reproduces
// the two properties of the real one that break naive implementations, both
// measured on public/local-snapshot.json: there is no unique key on
// (client_id, daily_import_id, report_type) — neither cam_crm_schema.sql:282 nor
// step_11_report_history.sql declares one — and ReportPanel inserts a row on
// every mount, so the 610 stored rows sit over 440 distinct (client, close)
// pairs with 93 pairs duplicated and one pair holding nine copies.
//
// Testing against a table that behaved itself would prove nothing: a "read the
// newest row" implementation passes that and loses a note the first time a CAM
// closes and reopens the day.

import { describe, expect, it } from 'vitest';
import {
  NOTE_RESULTS,
  createReportNoteStore,
  noteFromDraft,
  pickNote,
  readNote,
  withNote,
} from './reportNote';

/** The exact top-level key set every one of the 610 stored rows carries. */
function oldShapedContent(date = '2026-08-11') {
  return {
    title: `Daily close report - Daniel Swanson - ${date}`,
    reportDate: date,
    summary: {
      clientName: 'Daniel Swanson',
      camName: '',
      date,
      status: 'Needs review',
      grouped: { cash: [], evaluations: [], funded: [], ignored: [] },
      totals: { grossRealizedPnl: 0, weeklyPnl: -942, aggregateBalance: 249648, unrealizedPnl: 0 },
      counts: { accounts: 5 },
      flags: [],
      openFlags: [],
      criticalFlags: [],
      priorDailyPnl: -2353,
      generatedAt: '2026-08-11T19:50:00.000Z',
    },
    source: {
      clientId: 'c-swanson',
      clientName: 'Daniel Swanson',
      dailyImportId: 'di-2026-08-11',
      dailyImportDate: date,
      status: 'Needs review',
    },
    message: '📊 *Daily Update - 2026-08-11*',
  };
}

/**
 * A `reports` table with no unique key, insert-only inserts, and a real UPDATE.
 * `createdAt` is handed out in ascending order so "newest" is well defined.
 */
function fakeReportsTable(seed = []) {
  const rows = seed.map((row, index) => ({
    id: row.id || `r${index}`,
    clientId: row.clientId,
    dailyImportId: row.dailyImportId,
    reportType: row.reportType || 'daily_close',
    content: row.content || {},
    createdAt: row.createdAt || `2026-08-11T10:0${index}:00.000Z`,
  }));
  let clock = 100;
  const table = {
    rows,
    inserts: 0,
    updates: 0,
    store: null,
  };
  table.store = createReportNoteStore({
    listReports: async (clientId, dailyImportId, { reportType } = {}) =>
      rows
        .filter((row) => row.clientId === clientId
          && row.dailyImportId === dailyImportId
          && (!reportType || row.reportType === reportType))
        .map((row) => ({ ...row })),
    updateReportContent: async (reportId, content) => {
      const row = rows.find((candidate) => candidate.id === reportId);
      if (!row) return null;
      table.updates += 1;
      row.content = content;
      return { ...row };
    },
    createReport: async (clientId, dailyImportId, reportType, content) => {
      table.inserts += 1;
      clock += 1;
      const row = {
        id: `new-${table.inserts}`,
        clientId,
        dailyImportId,
        reportType,
        content,
        createdAt: `2026-08-11T12:${clock}:00.000Z`,
      };
      rows.push(row);
      return { ...row };
    },
  });
  return table;
}

/** What ReportPanel's mount effect does: a fresh row with no note on it. */
function panelMountInsert(table, { clientId = 'c-swanson', dailyImportId = 'di-2026-08-11' } = {}) {
  const at = table.rows.length;
  table.rows.push({
    id: `mount-${at}`,
    clientId,
    dailyImportId,
    reportType: 'daily_close',
    content: oldShapedContent(),
    createdAt: `2026-08-11T20:${String(at).padStart(2, '0')}:00.000Z`,
  });
}

const ARGS = { clientId: 'c-swanson', dailyImportId: 'di-2026-08-11', reportType: 'daily_close' };

describe('reading a stored note', () => {
  it('reads an old-shaped content row as "no note", never as an error', () => {
    const content = oldShapedContent();
    expect(readNote(content)).toBeNull();
    expect(() => readNote(content)).not.toThrow();
    expect(readNote(null)).toBeNull();
    expect(readNote(undefined)).toBeNull();
    expect(readNote({})).toBeNull();
  });

  it('refuses to coerce a non-object note into text', () => {
    // Anything that is not the shape we write is "no note". Coercing unknown
    // data into a paragraph is how the wrong text reaches a client.
    expect(readNote({ note: 'hello' })).toBeNull();
    expect(readNote({ note: 42 })).toBeNull();
    expect(readNote({ note: ['a'] })).toBeNull();
  });

  it('never stores an empty string: no text is a tombstone with a null text', () => {
    expect(noteFromDraft('  ', { at: 'T' })).toEqual({ text: null, authorName: '', updatedAt: 'T', clearedAt: 'T' });
    expect(noteFromDraft('hello', { at: 'T' }).text).toBe('hello');
    expect(noteFromDraft('hello', { at: 'T' }).clearedAt).toBeUndefined();
  });

  it('picks the newest row CARRYING a note, not the newest row', () => {
    const picked = pickNote([
      { id: 'blank-newest', createdAt: '2026-08-11T20:00:00Z', content: oldShapedContent() },
      { id: 'has-note', createdAt: '2026-08-11T11:00:00Z', content: withNote(oldShapedContent(), { text: 'kept' }) },
      { id: 'older-note', createdAt: '2026-08-11T09:00:00Z', content: withNote(oldShapedContent(), { text: 'stale' }) },
    ]);
    expect(picked.reportId).toBe('has-note');
    expect(picked.note.text).toBe('kept');
  });
});

describe('save then reload', () => {
  it('round trips: type, save, reopen the day, and it is still there', async () => {
    const table = fakeReportsTable();
    panelMountInsert(table);

    const before = await table.store.load(ARGS);
    expect(before.note).toBeNull();

    const written = await table.store.save({
      ...ARGS,
      text: 'Two of your orders were refused by the platform today. Nothing else changed.',
      authorName: 'Pedro',
      at: '2026-08-11T21:00:00.000Z',
    });
    expect(written.result).toBe(NOTE_RESULTS.SAVED);
    expect(table.inserts).toBe(0);
    expect(table.updates).toBe(1);

    // Closing and reopening the report unmounts ReportPanel and remounts it,
    // which inserts ANOTHER note-less row. This is the step that loses the note
    // if the read looks only at the newest row.
    panelMountInsert(table);

    const reloaded = await table.store.load(ARGS);
    expect(reloaded.note.text).toBe('Two of your orders were refused by the platform today. Nothing else changed.');
    expect(reloaded.note.authorName).toBe('Pedro');
    expect(reloaded.note.updatedAt).toBe('2026-08-11T21:00:00.000Z');
    // Two rows: the first mount's, and the second mount's. The save UPDATED the
    // first rather than adding a third, and the note is now on the OLDER row.
    expect(reloaded.rows).toBe(2);
    expect(reloaded.reportId).toBe('mount-0');
  });

  it('survives nine stacked rows for the same close (the worst pair on the book)', async () => {
    const table = fakeReportsTable();
    for (let i = 0; i < 4; i += 1) panelMountInsert(table);
    await table.store.save({ ...ARGS, text: 'buried in the middle', at: '2026-08-11T21:00:00.000Z' });
    for (let i = 0; i < 5; i += 1) panelMountInsert(table);

    const reloaded = await table.store.load(ARGS);
    expect(reloaded.rows).toBe(9);
    expect(reloaded.note.text).toBe('buried in the middle');
  });

  it('keeps the row\'s existing content: writing a note does not eat the summary', async () => {
    const table = fakeReportsTable();
    panelMountInsert(table);
    await table.store.save({ ...ARGS, text: 'kept', at: 'T' });

    const row = table.rows.find((candidate) => candidate.content.note);
    expect(Object.keys(row.content).sort()).toEqual(['message', 'note', 'reportDate', 'source', 'summary', 'title']);
    expect(row.content.summary.totals.weeklyPnl).toBe(-942);
    expect(row.content.reportDate).toBe('2026-08-11');
  });

  it('a regeneration cannot replace the note: the panel insert writes no note key', async () => {
    const table = fakeReportsTable();
    panelMountInsert(table);
    await table.store.save({ ...ARGS, text: 'the CAM wrote this', at: 'T1' });

    // Six more panel mounts, i.e. six regenerations of the summary.
    for (let i = 0; i < 6; i += 1) panelMountInsert(table);
    const reloaded = await table.store.load(ARGS);
    expect(reloaded.note.text).toBe('the CAM wrote this');
  });

  it('an explicit clear sticks, and does not resurrect the older row\'s text', async () => {
    const table = fakeReportsTable();
    panelMountInsert(table);
    await table.store.save({ ...ARGS, text: 'first version', at: 'T1' });
    panelMountInsert(table);
    const cleared = await table.store.save({ ...ARGS, text: '', at: 'T2' });

    expect(cleared.note.text).toBeNull();
    expect(cleared.note.clearedAt).toBe('T2');
    const reloaded = await table.store.load(ARGS);
    // A note record exists (somebody acted) and it holds no text. Absent and
    // cleared are different facts, and only the second can beat an older row.
    expect(reloaded.note).not.toBeNull();
    expect(reloaded.note.text).toBeNull();
  });

  it('creates a row when the panel has not managed to insert one', async () => {
    const table = fakeReportsTable();
    const written = await table.store.save({
      ...ARGS,
      text: 'saved before the generate insert returned',
      at: 'T',
      fallbackContent: { title: 'Daily close report - Daniel Swanson - 2026-08-11', reportDate: '2026-08-11' },
    });
    expect(written.result).toBe(NOTE_RESULTS.CREATED);
    expect(table.inserts).toBe(1);
    const reloaded = await table.store.load(ARGS);
    expect(reloaded.note.text).toBe('saved before the generate insert returned');
    expect(table.rows[0].content.reportDate).toBe('2026-08-11');
  });

  it('reports "no backend" instead of a false success when nothing can be written', async () => {
    // isSupabaseConfigured === false: createSupabaseReport returns null rather
    // than throwing, and local-snapshot mode is read-only. A green tick over
    // that would be the worst possible lie on this particular feature.
    const store = createReportNoteStore({
      listReports: async () => [],
      updateReportContent: async () => null,
      createReport: async () => null,
    });
    const written = await store.save({ ...ARGS, text: 'goes nowhere', at: 'T' });
    expect(written.result).toBe(NOTE_RESULTS.NO_BACKEND);
  });

  it('scopes to one close: a note on Monday is not shown on Tuesday', async () => {
    const table = fakeReportsTable();
    panelMountInsert(table, { dailyImportId: 'di-2026-08-10' });
    panelMountInsert(table);
    await table.store.save({ ...ARGS, dailyImportId: 'di-2026-08-10', text: 'monday', at: 'T' });

    const tuesday = await table.store.load(ARGS);
    expect(tuesday.note).toBeNull();
    const monday = await table.store.load({ ...ARGS, dailyImportId: 'di-2026-08-10' });
    expect(monday.note.text).toBe('monday');
  });

  it('returns nothing rather than guessing when the close is not identified', async () => {
    const table = fakeReportsTable();
    panelMountInsert(table);
    await table.store.save({ ...ARGS, text: 'x', at: 'T' });
    expect(await table.store.load({ ...ARGS, dailyImportId: null })).toEqual({ note: null, reportId: null, rows: 0 });
  });
});
