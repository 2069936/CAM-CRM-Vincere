// A CAM's own words on a client's daily report: written, stored, and — the part
// that did not exist — READ BACK.
//
// WHAT WAS THERE BEFORE. ReportPanel INSERTS a `reports` row on every mount and
// never reads one. Every reference to the table in the repo is: the insert
// (supabaseStore.createSupabaseReport), one select (loadSupabaseReports) called
// immediately after that insert, and one render of the result — a three-column
// "Recent Saved Reports" table showing date / type / created_at, marked
// `.no-print`. `content` is written and never opened again. So a note typed on
// the report would have been rebuilt from `dailyImport` on the next open and
// lost, with 610 stored rows sitting there holding it.
//
// THE SHAPE, and why it is a NEW TOP-LEVEL KEY on `content`.
//
// All 610 rows carry exactly `{ title, reportDate, summary, source, message }`
// (verified by hashing key sets) and none carries anything note-like.
//   - `content` is jsonb default '{}' with no CHECK, so a new key breaks nothing
//     and reportFromRow passes it through untouched.
//   - NOT inside `summary`: ReportPanel writes `summary: report` verbatim from
//     buildDailyReportSummary, so anything parked under it is overwritten by the
//     next regeneration — which is precisely the "a regeneration must not
//     silently replace edited text" failure.
//   - NOT `content.reportDate`: createSupabaseReport:1600 promotes that to the
//     `report_date` column.
//
// THREE STATES, NOT TWO. `content.note` absent means nobody has ever written on
// this row. `{ text: '...' }` is a note. `{ text: null, clearedAt }` is a CAM
// having deliberately deleted one, which is a different fact and has to be
// storable: without it, clearing a note would be undone on the next open by the
// older row that still carries it (see pickNote below — the read walks the whole
// stack of rows for the day, because there are up to 9 of them). An empty string
// is never stored; house rule, and reportFromRow's own `content.title || ...`
// pattern already treats '' as absent.

/** Newest-first ordering over report rows for one close. */
function byNewest(a, b) {
  return String(b?.createdAt || '').localeCompare(String(a?.createdAt || ''));
}

/**
 * The note carried by one report row, or null when the row carries none.
 *
 * `null` for a row whose content predates this feature — 610 of 610 rows on the
 * book today — and it must never throw on one. Anything that is not an object
 * under `content.note` (a stray string, a number) is read as "no note" rather
 * than coerced, because coercing unknown data into a client-facing paragraph is
 * how the wrong text gets printed.
 */
export function readNote(content) {
  const note = content && typeof content === 'object' ? content.note : null;
  if (!note || typeof note !== 'object' || Array.isArray(note)) return null;
  const text = typeof note.text === 'string' && note.text.trim() ? note.text : null;
  return {
    text,
    authorName: typeof note.authorName === 'string' ? note.authorName : '',
    updatedAt: typeof note.updatedAt === 'string' ? note.updatedAt : '',
    clearedAt: typeof note.clearedAt === 'string' ? note.clearedAt : '',
  };
}

/**
 * The note for a close, out of every row stored for it.
 *
 * Newest row that carries a `note` key wins — not the newest row overall. The
 * two differ constantly: the panel inserts a fresh, note-less row every time it
 * mounts, so on the second open of a day the newest row is always the blank one
 * and reading only that would show an empty editor over a note that is sitting
 * one row down.
 */
export function pickNote(rows = []) {
  const sorted = [...rows].sort(byNewest);
  for (const row of sorted) {
    const note = readNote(row?.content);
    if (note) return { note, reportId: row.id || null };
  }
  return { note: null, reportId: sorted[0]?.id || null };
}

/**
 * What gets stored for a given draft. Empty text is a tombstone, never ''.
 */
export function noteFromDraft(text, { authorName = '', at = new Date().toISOString() } = {}) {
  const trimmed = String(text ?? '').trim();
  return trimmed
    ? { text: trimmed, authorName, updatedAt: at }
    : { text: null, authorName, updatedAt: at, clearedAt: at };
}

export function withNote(content, note) {
  return { ...(content && typeof content === 'object' ? content : {}), note };
}

export const NOTE_RESULTS = {
  SAVED: 'saved',
  CREATED: 'created',
  NO_BACKEND: 'no-backend',
};

/**
 * Load / save wired to whatever can list, update and create report rows.
 *
 * Injected rather than importing supabaseStore directly so the round trip can be
 * tested against an in-memory table that reproduces the two things about the
 * real one that matter — no unique key, and rows accumulate — instead of the
 * write path being read and declared correct.
 */
export function createReportNoteStore({ listReports, updateReportContent, createReport }) {
  async function load({ clientId, dailyImportId, reportType = 'daily_close' }) {
    if (!clientId || !dailyImportId) return { note: null, reportId: null, rows: 0 };
    const rows = (await listReports(clientId, dailyImportId, { reportType })) || [];
    return { ...pickNote(rows), rows: rows.length };
  }

  /**
   * Write the note onto the NEWEST row for the close, or make a row if the panel
   * has not managed to insert one (Supabase unreachable, or a save that lands
   * before the generate insert returns).
   *
   * Writing to the newest row and reading across all of them is what makes this
   * survive the duplicate-insert behaviour without changing it: whichever row
   * the note lands on, the next open finds it, and a later blank insert cannot
   * hide it.
   */
  async function save({
    clientId,
    dailyImportId,
    reportType = 'daily_close',
    text,
    authorName = '',
    at = new Date().toISOString(),
    fallbackContent = {},
  }) {
    const note = noteFromDraft(text, { authorName, at });
    const rows = (await listReports(clientId, dailyImportId, { reportType })) || [];
    const newest = [...rows].sort(byNewest)[0] || null;
    if (newest?.id) {
      const saved = await updateReportContent(newest.id, withNote(newest.content, note));
      if (saved) return { result: NOTE_RESULTS.SAVED, note, reportId: newest.id };
      return { result: NOTE_RESULTS.NO_BACKEND, note, reportId: newest.id };
    }
    const created = await createReport(
      clientId,
      dailyImportId,
      reportType,
      withNote(fallbackContent, note),
    );
    if (created) return { result: NOTE_RESULTS.CREATED, note, reportId: created.id || null };
    // No row to write to and no row could be made: Supabase is not configured
    // (createSupabaseReport returns null rather than throwing) or the app is in
    // local-snapshot read-only mode. Reported as its own result so the panel can
    // say "not saved" instead of showing a green tick over nothing.
    return { result: NOTE_RESULTS.NO_BACKEND, note, reportId: null };
  }

  return { load, save };
}
