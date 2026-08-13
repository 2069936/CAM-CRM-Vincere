import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createSupabaseAuditLog,
  createSupabaseReport,
  loadSupabaseReportsForImport,
  updateSupabaseReportContent,
} from '../domain/supabaseStore';
import { NOTE_RESULTS, createReportNoteStore } from '../domain/reportNote';

const supabaseNoteStore = createReportNoteStore({
  listReports: (clientId, dailyImportId, options) =>
    loadSupabaseReportsForImport(clientId, dailyImportId, options),
  updateReportContent: (reportId, content) => updateSupabaseReportContent(reportId, content),
  createReport: (clientId, dailyImportId, reportType, content) =>
    createSupabaseReport(clientId, dailyImportId, reportType, content),
});

/**
 * Fire-and-forget, the same helper shape App.auditSilently uses (App.jsx:1713)
 * and the same one already writing `report.generate` on this exact path. An
 * audit write that fails must never fail the save the CAM just made.
 */
function auditSilently(entry) {
  createSupabaseAuditLog(entry).catch((error) => {
    console.error('[CRM] Failed to write report note audit log:', error);
  });
}

/**
 * The CAM's own paragraph on a client's daily report.
 *
 * IT SAVES EXPLICITLY. There is a button and a status, and no timer: the report
 * screen already has one silent write on mount and the lesson of it is directly
 * above — an autosave halfway through a sentence stores half a sentence, and the
 * next open shows the client's CAM that the CRM ate their words.
 *
 * IT LOADS BACK, which is the part that did not exist. See src/domain/
 * reportNote.js: the read walks every `reports` row stored for the close, newest
 * first, and takes the first that carries a `note` key — never simply the newest
 * row, because ReportPanel inserts a fresh note-less row on every mount and 93
 * of the 440 (client, close) pairs on the book already hold more than one row,
 * one of them nine.
 *
 * IT NEVER OVERWRITES WHAT SOMEBODY WROTE.
 *   - The generated WhatsApp text is offered by a button and that button is
 *     disabled the moment the box is non-empty, so no click can replace typing.
 *   - The load result only seeds the box while the CAM has not touched it; a
 *     slow round trip landing after the first keystroke is discarded.
 *   - Clearing is possible, but it is the CAM emptying the box and pressing
 *     Save, and it stores a `clearedAt` tombstone rather than nothing (a plain
 *     absence would be undone on the next open by the older row that still holds
 *     the text).
 *
 * IT PRINTS. The editor carries `.no-print` — src/index.css:5250 hides that
 * class in every print — and a plain `<p>` sibling carries the text into the
 * PDF. The whole section is print-hidden while the text is empty, so a client
 * whose CAM wrote nothing gets no empty heading. What prints is what is IN THE
 * BOX, not the last thing saved: the failure this feature exists to avoid is a
 * CAM typing a paragraph and it not being in the PDF, so an unsaved edit prints
 * and gets an unmissable on-screen warning instead of being silently dropped.
 */
export default function ReportNoteSection({
  clientId,
  dailyImportId,
  reportType = 'daily_close',
  authorName = '',
  suggestedText = '',
  fallbackContent = null,
  store = supabaseNoteStore,
  // Seed for a render with no effects — the static-markup idiom the rest of the
  // components in this folder are tested with (AutoCollectionManager's
  // `initialFleet`, SimulationReportSection's prebuilt section). Production
  // never passes it; the note always arrives from store.load below.
  initialNote = null,
}) {
  const key = `${clientId || ''}:${dailyImportId || ''}:${reportType}`;
  const idle = !clientId || !dailyImportId;

  const [draft, setDraft] = useState(initialNote?.text || '');
  const [savedNote, setSavedNote] = useState(initialNote);
  const [loadState, setLoadState] = useState(idle || initialNote ? 'idle' : 'loading');
  const [saveState, setSaveState] = useState('idle');
  const [saveError, setSaveError] = useState('');
  const [shownKey, setShownKey] = useState(key);
  const touchedRef = useRef(false);

  // Switching to another client or another close resets the box during render
  // rather than in an effect. React's own "adjusting state when a prop changes"
  // pattern: an effect that reset it would render the previous close's note
  // once, and on a screen whose whole point is that the right person's words are
  // on the page, one frame of somebody else's paragraph is one too many.
  if (shownKey !== key) {
    setShownKey(key);
    setDraft('');
    setSavedNote(null);
    setSaveState('idle');
    setSaveError('');
    setLoadState(idle ? 'idle' : 'loading');
  }

  useEffect(() => {
    if (idle) return undefined;
    let cancelled = false;
    touchedRef.current = false;
    store
      .load({ clientId, dailyImportId, reportType })
      .then((result) => {
        if (cancelled) return;
        setSavedNote(result.note);
        // Only while nothing has been typed. A round trip that lands after the
        // first keystroke is the one that would eat a sentence.
        if (!touchedRef.current) setDraft(result.note?.text || '');
        setLoadState('loaded');
      })
      .catch((error) => {
        if (cancelled) return;
        console.error('[CRM] Failed to load report note:', error);
        setLoadState('error');
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const savedText = savedNote?.text || '';
  const dirty = draft.trim() !== savedText.trim();
  const hasText = Boolean(draft.trim());
  const canOfferSuggestion = Boolean(suggestedText) && !draft.trim();

  const status = useMemo(() => {
    if (loadState === 'loading') return { tone: '', text: 'Loading note…' };
    if (loadState === 'error') return { tone: 'error', text: 'Could not load the saved note' };
    if (saveState === 'saving') return { tone: '', text: 'Saving note…' };
    if (saveState === 'error') return { tone: 'error', text: saveError || 'Note not saved' };
    if (saveState === 'no-backend') return { tone: 'error', text: 'Not saved — no database connection' };
    if (dirty) return { tone: 'warn', text: 'Unsaved changes' };
    if (savedNote?.updatedAt) {
      return {
        tone: 'ok',
        text: `Saved ${new Date(savedNote.updatedAt).toLocaleString('en-US')}${savedNote.authorName ? ` by ${savedNote.authorName}` : ''}`,
      };
    }
    return { tone: '', text: 'No note yet' };
  }, [loadState, saveState, saveError, dirty, savedNote]);

  function handleSave() {
    if (!clientId || !dailyImportId) return;
    setSaveState('saving');
    setSaveError('');
    const before = savedNote;
    store
      .save({
        clientId,
        dailyImportId,
        reportType,
        text: draft,
        authorName,
        fallbackContent: fallbackContent || {},
      })
      .then((result) => {
        if (result.result === NOTE_RESULTS.NO_BACKEND) {
          setSaveState('no-backend');
          return;
        }
        setSavedNote(result.note);
        setSaveState('saved');
        touchedRef.current = false;
        auditSilently({
          entityType: 'report',
          entityId: result.reportId,
          action: 'report.note.update',
          // before/after, not just after: createSupabaseAuditLog has always
          // taken beforeData and the report path is the one place that passed
          // null for it. An edit is only auditable if what it replaced is on the
          // record.
          beforeData: before ? { text: before.text, authorName: before.authorName, updatedAt: before.updatedAt } : null,
          afterData: {
            clientId,
            dailyImportId,
            reportType,
            text: result.note.text,
            cleared: result.note.text === null,
            authorName,
          },
        });
      })
      .catch((error) => {
        console.error('[CRM] Failed to save report note:', error);
        setSaveState('error');
        setSaveError(error.message || 'Could not save the note.');
      });
  }

  return (
    <section className={`report-section report-note-section${hasText ? ' has-note' : ''}`}>
      <h2>Note from your account manager</h2>

      <div className="report-note-editor no-print">
        <div className="report-note-bar">
          <span className={`remote-pill ${status.tone === 'error' ? 'error' : status.tone === 'ok' ? 'connected' : ''}`}>
            {status.text}
          </span>
          <button
            type="button"
            className="ghost-button"
            disabled={!canOfferSuggestion}
            title={
              canOfferSuggestion
                ? 'Copy the generated daily message into the box as a starting point'
                : 'Only offered while the box is empty, so it can never replace what you wrote'
            }
            onClick={() => {
              touchedRef.current = true;
              setDraft(suggestedText);
            }}
          >
            Start from the generated message
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!dirty || saveState === 'saving' || loadState === 'loading'}
            onClick={handleSave}
          >
            {saveState === 'saving' ? 'Saving…' : 'Save note'}
          </button>
        </div>
        <textarea
          className="report-note-input"
          rows={5}
          value={draft}
          placeholder="What the client should know about this close, in your words. Saved with the report and printed in the PDF."
          onChange={(event) => {
            touchedRef.current = true;
            setDraft(event.target.value);
          }}
        />
        {dirty ? (
          <p className="report-note-warning">
            This text is not saved yet. It will appear in the PDF if you print now, but reopening this
            day would show the last saved version.
          </p>
        ) : null}
      </div>

      {/*
        The printed copy. Plain text so the PDF carries no form chrome and no
        scroll clipping, `white-space: pre-wrap` so the CAM's own line breaks
        survive, and it renders the DRAFT so what is on screen is what prints.
      */}
      <p className="report-note-print">{draft}</p>
    </section>
  );
}
