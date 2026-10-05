// The opt-in gate on the client report's evaluations section: that there is
// exactly one mount, that it is guarded, that it ships off, and that a CAM can
// open it.
//
// WHAT THIS FILE NO LONGER CLAIMS, and why that matters more than what it does.
// It used to hold the PDF half as well — "the mount is inside `.report-sheet` and
// outside every `.no-print` subtree" — as arithmetic on positions inside App.jsx
// read as a 500 KB string. It could not fail on the regression it was written for:
//
//   `const sheetAt = APP.indexOf('className="report-sheet"')` takes the FIRST of
//   three occurrences in App.jsx. That one belongs to MonthlyReportPanel, 450
//   lines above the ReportPanel sheet the mount actually lives in, so
//   `expect(mountAt).toBeGreaterThan(sheetAt)` asserted only that the mount came
//   somewhere after a different component's opening tag, and the `head` slice it
//   searched for an unclosed `no-print` spanned two components.
//
//   A verifier moved the gated mount out of the sheet and into the enclosing
//   `.report-overlay`, right after the sheet's closing `</div>`. The section still
//   renders on screen; `sheetRef.current.outerHTML` — the exact string
//   reportPdfDownload.js:89 posts to /api/report/pdf — no longer contains it, so
//   it is gone from every client's PDF. That is the CAM's complaint reproduced
//   word for word, and this file passed, with all 4,440 tests green.
//
// The handoff half went the same way. "Hands the rows over rather than printing
// them twice" was two regexes for two `.filter(...)` expressions, and the same
// verifier deleted both filters while leaving their text inside block comments.
// The regexes matched the comments. With the toggle on, every evaluation row then
// printed twice on one page.
//
// Both questions are about a rendered document, so both now live in
// src/reportEvaluationsMount.test.jsx, which renders `ReportPanel` with real props
// and walks the DOM: `section.closest('.report-sheet')`, the ancestors checked for
// `.no-print`, `sheet.outerHTML`, and the account names counted in the sheet's
// table bodies. Mutations F and G were applied again afterwards and that file fails
// 7 of 12 and 3 of 12 respectively; this file still passed both, which is the
// reason the assertions moved rather than being corrected in place. A gate that
// cannot fail is worse than no gate, because it reads as proof.
//
// WHAT IS LEFT HERE EARNS BEING TEXTUAL. "Exactly one mount in the file" is a
// question about the file — a second, unguarded mount somewhere else in App.jsx is
// counted in source and is invisible to any single render. The config assertions
// are about reportConfig.js. And the stylesheet assertions are about the text of
// src/index.css, which is where printLayout.test.js pins every other print rule
// for the same reason: jsdom has no fragmentation engine and no print media.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_REPORT_CONFIG, REPORT_FIELDS, SIMPLIFIED_REPORT_CONFIG, resolveReportConfig } from './reportConfig';

const APP = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../index.css', import.meta.url), 'utf8');

describe('the report evaluations section is opt-in, and reachable', () => {
  it('mounts only behind cfg.showEvaluations', () => {
    const mounts = APP.match(/<EvaluationsReportSection\b/g) || [];
    // Not just "a guarded mount exists": a SECOND, unguarded mount elsewhere in
    // App.jsx would satisfy the regex below on the strength of the first one, and
    // would print the section on every client report. One render cannot see it;
    // counting the file can.
    expect(mounts).toHaveLength(1);

    // The one mount is the consequent of a cfg.showEvaluations conditional.
    // `{true ? <EvaluationsReportSection .../> : null}` and
    // `{false ? ... }` both fail here.
    expect(APP).toMatch(
      /\{\s*cfg\.showEvaluations\s*\?\s*\(\s*<EvaluationsReportSection\b/,
    );
  });

  it('is off unless a CAM or a client turns it on', () => {
    // Anything new ships false (reportConfig.js:50-52). A CAM who opens the app
    // tomorrow having changed nothing must see the report they saw yesterday, and
    // with this false App.jsx still draws the evaluations group inside the
    // per-account table and still draws the Evaluations segment tile.
    expect(DEFAULT_REPORT_CONFIG.showEvaluations).toBe(false);
    // The Simplified preset too: it is the one click that changes thirteen fields
    // at once, so a new section appearing in it would change shape for every
    // client on the preset without anybody choosing it.
    expect(SIMPLIFIED_REPORT_CONFIG.showEvaluations).toBe(false);
    expect(resolveReportConfig(null, null).showEvaluations).toBe(false);
  });

  it('can be turned on, per CAM and per client, through the report designer', () => {
    // A gate nobody can open is the same as no feature. The toggle has to be
    // offered in the designer and both scopes have to reach it.
    expect(REPORT_FIELDS.map((field) => field.key)).toContain('showEvaluations');
    expect(resolveReportConfig({ showEvaluations: true }, null).showEvaluations).toBe(true);
    expect(resolveReportConfig(null, { showEvaluations: true }).showEvaluations).toBe(true);
    expect(resolveReportConfig({ showEvaluations: true }, { showEvaluations: false }).showEvaluations).toBe(false);
  });
});

describe('the print stylesheet lets the section through and keeps the drawer out', () => {
  // The PDF is the posted `.report-sheet` rendered in headless Chrome against this
  // build's own stylesheet. WHERE the section sits in that DOM is asserted on a
  // rendered document in src/reportEvaluationsMount.test.jsx; what the stylesheet
  // then does to it is a question about this file's text, and this is the half
  // that belongs here.

  it('does not hide .report-evaluations in print, which would be the whole complaint', () => {
    // A rule that hid it in print would produce exactly the defect this change
    // answers: visible on screen, absent from the paper.
    expect(CSS).not.toMatch(/\.report-evaluations[^{]*\{[^}]*display:\s*none/);
  });

  it('still hides the designer, which is where the per-toggle explanations live', () => {
    // The counterpart: describeSilentReportFields' sentences are the desk's own
    // bookkeeping — "no account on this client is set to simulation" is about data
    // entry, not about the client's day — and they must never reach the client.
    // They live inside the drawer, which the print block hides: pinned from the
    // stylesheet side in printLayout.test.js and from this side here, and proved on
    // delivered PDF bytes by scripts/verify-report-print-layout.mjs, which looks
    // for "Done designing" in the text of every report it renders.
    expect(CSS).toContain('.report-design-drawer');
    expect(APP).toContain('className="report-design-drawer no-print"');
    expect(APP).toMatch(/<small className="report-design-silent">/);
  });

  it('has a rendered counterpart for everything it cannot answer', () => {
    /* NOT DECORATION. Four tests in this repo have now passed against prose, and
     * the rule learned from them is that a source-text assertion about the report
     * needs a behavioural one standing beside it. This checks the file is there
     * and is wired to the component, because a renamed or deleted
     * reportEvaluationsMount.test.jsx would otherwise leave this file looking like
     * a complete gate again — which is the state the branch was reviewed in. */
    const mount = readFileSync(new URL('../reportEvaluationsMount.test.jsx', import.meta.url), 'utf8');
    expect(mount).toContain("from './App'");
    expect(mount).toContain("closest('.report-sheet')");
    expect(mount).toContain('sheet.outerHTML');
  });
});
