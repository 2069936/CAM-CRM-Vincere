// The opt-in gate on the client report's evaluations section, and its route to
// the PDF.
//
// WHY THIS IS ASSERTED ON THE SOURCE. The same reason simulationReportGate.test.js
// gives: the mount lives eight thousand lines into App.jsx's report preview, in a
// component wired to Supabase, routing and a dozen panels. There is no seam to
// render it through, and adding one to make it testable would change shipped code
// to satisfy a test. So the wiring is asserted textually here and the behaviour of
// the section itself is left to EvaluationsReportSection.test.jsx, which renders
// it, and to evaluationReport.test.js, which exercises the builder.
//
// simulationReportGate.test.js exists because a mutation pass changed its gate to
// `{true ? ... }` and then to `{false ? ... }` and BOTH passed all 1782 tests —
// one printing a section on every client report whether or not a CAM asked for
// it, the other deleting the feature from the product while leaving every file in
// place. This file is the same guard for the same shape of wiring, and the
// mutations were run against it before it was written down.
//
// IT ALSO PINS THE PDF, because that is how the complaint arrived: "it does not
// come out in the PDF". The PDF is the live `.report-sheet` DOM posted to
// /api/report/pdf and rendered in headless Chrome against this build's
// stylesheet, so a section reaches the paper if and only if it is inside that div
// and outside every `.no-print` subtree. Both halves are checked: the position in
// App.jsx here, and the absence of `no-print` on the rendered markup in
// EvaluationsReportSection.test.jsx.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_REPORT_CONFIG, REPORT_FIELDS, SIMPLIFIED_REPORT_CONFIG, resolveReportConfig } from './reportConfig';

const APP = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../index.css', import.meta.url), 'utf8');

describe('the report evaluations section is opt-in, and reachable', () => {
  it('mounts only behind cfg.showEvaluations', () => {
    const mounts = APP.match(/<EvaluationsReportSection\b/g) || [];
    // Not just "a guarded mount exists": a SECOND, unguarded mount elsewhere in
    // App.jsx would satisfy the regex below on the strength of the first one.
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

  it('hands the rows over rather than printing them twice', () => {
    // 203 evaluation rows across 47 clients on the book's latest closes. With the
    // section on and the per-account table untouched, every one of them would
    // print twice on one page, and printLayout.book.test.js would not notice:
    // its POOLS list is hardcoded, so a second evaluations section adds paper
    // while every assertion in that file still passes.
    expect(APP).toMatch(/\.filter\(\(group\) => !\(group === "evaluations" && cfg\.showEvaluations\)\)/);
    // And the segment tile, which states a balance and a P&L for the same pool.
    expect(APP).toMatch(/\.filter\(\(\{ key \}\) => !\(key === "evalStandard" && cfg\.showEvaluations\)\)/);
  });
});

describe('the evaluations section reaches the PDF', () => {
  // The CAM's complaint arrived as "it does not come out in the PDF", and a test
  // that asserts a component renders on screen says nothing about paper.
  const sheetAt = APP.indexOf('className="report-sheet"');
  const mountAt = APP.indexOf('<EvaluationsReportSection');

  it('mounts inside .report-sheet, which is the DOM the PDF is made from', () => {
    expect(sheetAt).toBeGreaterThan(-1);
    expect(mountAt).toBeGreaterThan(sheetAt);
    // reportPdfDownload.js posts `sheet?.outerHTML` for exactly this element.
    expect(APP).toContain('<div\n      className="report-overlay"');
    expect(APP).toMatch(/<div className="report-sheet" ref=\{sheetRef\}>/);
  });

  it('mounts outside every .no-print subtree inside that sheet', () => {
    // The three no-print subtrees in the sheet are the action bar, the design
    // drawer and the save-error notice. Each is opened and closed before the
    // report body starts, so the check is that none of them is still open where
    // the section mounts: the last `no-print` occurrence before the mount must be
    // followed by its own closing tag before the mount is reached.
    const head = APP.slice(sheetAt, mountAt);
    const lastNoPrint = head.lastIndexOf('no-print');
    expect(lastNoPrint).toBeGreaterThan(-1);
    const after = head.slice(lastNoPrint);
    // `) : null}` closes the conditional that renders the last no-print block.
    expect(after).toMatch(/\) : null\}/);
    // And the section's own markup carries no no-print of its own.
    const section = readFileSync(new URL('../components/EvaluationsReportSection.jsx', import.meta.url), 'utf8');
    expect(section).not.toContain('no-print');
  });

  it('is not hidden by the print stylesheet, and the designer still is', () => {
    // A rule that hid `.report-evaluations` in print would produce exactly the
    // complaint this change answers: visible on screen, absent from the paper.
    expect(CSS).not.toMatch(/\.report-evaluations[^{]*\{[^}]*display:\s*none/);
    // The counterpart: the designer's per-toggle explanations are the desk's own
    // bookkeeping and must never reach the client. They live inside the drawer,
    // which the print block hides — pinned from the stylesheet side in
    // printLayout.test.js and from this side here.
    expect(CSS).toContain('.report-design-drawer');
    expect(APP).toContain('className="report-design-drawer no-print"');
    expect(APP).toMatch(/<small className="report-design-silent">/);
  });
});
