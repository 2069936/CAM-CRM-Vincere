// The note on the page, asserted on the markup that becomes the PDF.
//
// Both paths to a client's PDF render THIS markup through THIS stylesheet:
// `printWithTitle` (src/domain/reportPrint.js) calls window.print() on the live
// report DOM, and the Download button posts the same live DOM to
// /api/report/pdf, which loads it into a headless Chrome under print media.
// Neither one filters the markup itself — deliberately, because a second copy of
// this contract is precisely how the CAM's textarea would reach a client. So
// "does it print" is still entirely a question of which classes the markup
// carries, and that is what these assert:
//
//   .no-print          -> src/index.css:5250 `display: none !important` in print
//   .report-note-print -> `display: none` on screen, `display: block` in print
//   .has-note          -> without it, `.report-note-section` is print-hidden
//
// A browser round trip through the real print stylesheet, printed to PDF and
// read back, is in scripts/verify-report-note-print.mjs; this is the fast guard.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ReportNoteSection from './ReportNoteSection';

const note = (text) => ({ text, authorName: 'Pedro', updatedAt: '2026-08-11T21:00:00.000Z', clearedAt: '' });

const inert = { load: async () => ({ note: null, reportId: null, rows: 0 }), save: async () => ({}) };

function render(props = {}) {
  return renderToStaticMarkup(
    <ReportNoteSection clientId="c1" dailyImportId="di1" store={inert} {...props} />,
  );
}

describe('the note on the printed page', () => {
  it('puts the text in a print-only block that carries no .no-print', () => {
    const html = render({ initialNote: note('Two of your orders were refused by the platform today.') });
    expect(html).toContain('<p class="report-note-print">Two of your orders were refused by the platform today.</p>');
    // The editor is the screen view and must not reach the PDF.
    expect(html).toContain('class="report-note-editor no-print"');
    // ...but the section wrapping both must not be no-print, or nothing prints.
    expect(html).toContain('class="report-section report-note-section has-note"');
    expect(html).toContain('Note from your account manager');
  });

  it('marks the section has-note only when there is text, so an empty one never prints', () => {
    const empty = render();
    expect(empty).toContain('class="report-section report-note-section"');
    expect(empty).not.toContain('has-note');
    // The heading is still in the markup — @media print hides the whole section
    // when .has-note is absent (src/index.css), which is what keeps an empty
    // "Note from your account manager" out of a client's PDF.
    expect(empty).toContain('Note from your account manager');
  });

  it('prints what is in the box, and warns on screen that it is unsaved', () => {
    // What you see is what prints. The failure this feature exists to avoid is a
    // CAM typing a paragraph and it not being in the PDF, so an unsaved edit is
    // never silently dropped from the print — it is flagged instead.
    const html = render({ initialNote: null, suggestedText: 'generated' });
    expect(html).toContain('report-note-print');
    const dirty = render({ initialNote: note('typed but not saved') });
    expect(dirty).toContain('typed but not saved');
  });
});

describe('the note never overwrites what somebody wrote', () => {
  it('disables the suggestion button while the box has text', () => {
    const html = render({ initialNote: note('the CAM wrote this'), suggestedText: '📊 Daily Update' });
    expect(html).toMatch(/Start from the generated message/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Start from the generated message/);
    expect(html).toContain('Only offered while the box is empty, so it can never replace what you wrote');
  });

  it('offers the suggestion only when there is one and the box is empty', () => {
    const offered = render({ suggestedText: '📊 Daily Update' });
    expect(offered).not.toMatch(/<button[^>]*disabled[^>]*>Start from the generated message/);
    const none = render({ suggestedText: '' });
    expect(none).toMatch(/<button[^>]*disabled[^>]*>Start from the generated message/);
  });

  it('shows who saved it and when, from the stored note rather than the session', () => {
    const html = render({ initialNote: note('kept') });
    expect(html).toContain('by Pedro');
  });

  it('cannot save an unchanged note', () => {
    const clean = render({ initialNote: note('kept') });
    expect(clean).toMatch(/<button[^>]*disabled[^>]*>Save note/);
  });
});
