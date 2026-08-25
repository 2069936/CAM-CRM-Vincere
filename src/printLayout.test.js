// What the print stylesheet promises the paper.
//
// A client's PDF is produced two ways now, and BOTH of them are this
// stylesheet. `printWithTitle` (src/domain/reportPrint.js) is window.print() on
// the live report DOM; the Download button posts that same DOM to
// /api/report/pdf, where a headless Chrome loads it against this same built
// stylesheet and prints it at the same Letter/12mm. Neither path re-implements
// the report, so the shape of what a client receives is still decided entirely
// by @page and the three `@media print` blocks in src/index.css. This file
// reads those blocks and pins the decisions in them — and pinning them is worth
// MORE than it was before, because two shipping paths now depend on them
// instead of one.
//
// WHY A STYLESHEET IS ASSERTED HERE AND NOT A RENDERED PAGE. jsdom has no
// fragmentation engine: it cannot tell you where a page breaks, so a test that
// rendered the report would be asserting nothing about paper. The real
// verification is a browser one and it is in scripts/verify-report-print-layout.mjs,
// which sends 13 book clients' reports through the real endpoint, measures the
// PDF bytes that come back, sweeps a section heading
// past the page boundary in 10px steps and fails on a stranded heading, a
// stranded row, a footer alone on a sheet, a lost repeated header, or a page
// left more than 75mm empty with content still queued. That script needs a
// browser and the book. THIS file is the fast guard that runs everywhere, and
// it exists because every one of the declarations below was measured to matter:
// dropping any of them moves the paper.
//
// The measurement behind the numbers, all of it on the printed page box a real
// print job produces (725 x 965 CSS px = US Letter minus 12mm), over the 13
// book clients with a close on 2026-07-30:
//
//                             sheets   near-empty 1st pages   footer-only pages
//   before                      23              4                    1
//   after                       18              0                    0
//
//   blank millimetres on pages that still had content queued behind them:
//   1,031mm before, 208mm after.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync('src/index.css', 'utf8');

/**
 * Every rule in the sheet, each tagged with the at-rules it sits inside.
 *
 * A hand-rolled walk rather than a parser dependency: the only thing needed is
 * "which declarations does this selector carry in this context", and the sheet
 * is plain CSS with no nesting beyond one level of @media.
 */
function rules() {
  const out = [];
  const context = [];
  let i = 0;
  let buffer = '';
  while (i < CSS.length) {
    if (CSS.startsWith('/*', i)) {
      i = CSS.indexOf('*/', i) + 2;
      continue;
    }
    const ch = CSS[i];
    if (ch === '{') {
      const head = buffer.trim();
      buffer = '';
      i += 1;
      // @page carries declarations, not nested rules, so it is read as one.
      if (head.startsWith('@') && !head.startsWith('@page')) {
        context.push(head);
        continue;
      }
      // A plain rule: read to its closing brace.
      let depth = 1;
      let body = '';
      while (i < CSS.length && depth > 0) {
        if (CSS.startsWith('/*', i)) { i = CSS.indexOf('*/', i) + 2; continue; }
        if (CSS[i] === '{') depth += 1;
        if (CSS[i] === '}') { depth -= 1; if (!depth) break; }
        body += CSS[i];
        i += 1;
      }
      i += 1;
      const declarations = {};
      for (const part of body.split(';')) {
        const at = part.indexOf(':');
        if (at < 0) continue;
        declarations[part.slice(0, at).trim()] = part.slice(at + 1).trim();
      }
      out.push({
        context: [...context],
        selectors: head.split(',').map((s) => s.replace(/\s+/g, ' ').trim()),
        declarations,
      });
      continue;
    }
    if (ch === '}') { context.pop(); buffer = ''; i += 1; continue; }
    buffer += ch;
    i += 1;
  }
  return out;
}

const ALL = rules();

/** The declarations `selector` ends up with inside `at`, later rules winning. */
function resolved(selector, at) {
  const merged = {};
  for (const rule of ALL) {
    const inContext = at === null
      ? rule.context.length === 0
      : rule.context.includes(at);
    if (!inContext) continue;
    if (!rule.selectors.includes(selector)) continue;
    Object.assign(merged, rule.declarations);
  }
  return merged;
}

const print = (selector) => resolved(selector, '@media print');
const screen = (selector) => resolved(selector, null);

describe('where the printed report is allowed to break', () => {
  it('lets an account section break, so a long one cannot push a whole sheet away', () => {
    // THE DEFECT. `break-inside: avoid` was on `.report-section` as well as on
    // `tr`. A section is a heading plus a whole account table, so a section
    // taller than the space left was moved to the next sheet entire and the
    // rest of the current one was thrown away — the desk shipped a report on
    // 2026-08-21 whose first page held the header and three metric tiles and
    // nothing else, 80% blank, with the table waiting overleaf.
    expect(print('.report-section')['break-inside']).toBe('auto');
    expect(print('.report-sheet section')['break-inside']).toBe('auto');
  });

  it('keeps a table row whole, because half a row is unreadable', () => {
    // The half of the old rule that was right. Rows stay atomic.
    expect(print('tr')['break-inside']).toBe('avoid');
  });

  it('keeps the CAM day sheet whole per client, which is a different question', () => {
    // The CAM's own all-clients sheet is a list of four-line blocks; splitting
    // one would put a client's name on one sheet and that client's money on the
    // next. It is scoped through `.report-sheet` so it outranks the `section`
    // rule above, which would otherwise win on specificity.
    expect(print('.report-sheet .cam-day-client')['break-inside']).toBe('avoid');
  });

  it('never lets a heading or a column header be the last thing on a sheet', () => {
    expect(print('h1')['break-after']).toBe('avoid');
    expect(print('h2')['break-after']).toBe('avoid');
    expect(print('thead')['break-after']).toBe('avoid');
  });

  it('never strands a single row at the start or the end of a continued table', () => {
    // Chrome honours neither `orphans` nor `widows` for table rows, so this has
    // to be said row by row. Removing the first-child rule was measured: it
    // saves a sheet across the 13 book clients AND produces a table that opens
    // with exactly one row before the break at six of the boundary positions
    // the browser sweep tries. The sheet is not worth the stranded row.
    expect(print('.report-table tbody tr:first-child')['break-after']).toBe('avoid');
    expect(print('.report-table tbody tr:last-child')['break-before']).toBe('avoid');
  });

  it('repeats the column headings when a table continues on the next sheet', () => {
    // This rule was in the file before and was dead: a header only repeats when
    // a table splits, and nothing was allowed to split. It is load-bearing now.
    expect(print('thead').display).toBe('table-header-group');
  });

  it('never gives the footer a sheet of its own', () => {
    // The second half of the complaint, and it shipped: a report whose last row
    // ended about 2pt above the margin put its one-line footer on a second
    // sheet, 96.7% blank.
    expect(print('.report-footer')['break-inside']).toBe('avoid');
    expect(print('.report-footer')['break-before']).toBe('avoid');
  });
});

describe('how much of the sheet the report is allowed to use', () => {
  it('lets the account columns take the width they need', () => {
    // `table-layout: fixed` with no column widths splits the width equally, so
    // the Account column — an alias plus a connection name — wrapped to five
    // lines while six numeric columns sat half empty. 81.1px per row fixed
    // against 63.0px auto, measured on a 14-row table: 4.8mm of paper a row.
    expect(print('.report-table')['table-layout']).toBe('auto');
    expect(print('.report-sheet .ops-table')['table-layout']).toBe('auto');
  });

  it('still keeps a pathological account id from widening the table past the sheet', () => {
    // The guarantee `fixed` was there for. `anywhere` holds min-content width
    // down to a single character, so `auto` cannot overflow the page; dropping
    // it would trade one defect for a worse one.
    expect(print('.report-table')['overflow-wrap']).toBe('anywhere');
    expect(print('.report-table').width).toBe('100%');
  });

  it('never breaks a column heading in the middle of a word', () => {
    // The first print of this change did. `overflow-wrap: anywhere` is there for
    // a pathological account id, but under `auto` it also lowers a column's
    // min-content width to one character, and the table algorithm duly made the
    // Status and Balance columns narrower than their own headings: the client
    // would have been sent a report reading "STATU / S" and "BALANC / E".
    expect(print('.report-table th')['overflow-wrap']).toBe('normal');
    expect(print('.report-table th')['word-break']).toBe('normal');
    // Only the headings. The account cells still break anywhere, which is what
    // keeps the table inside the page.
    expect(print('.report-table')['overflow-wrap']).toBe('anywhere');
  });

  it('tightens the fixed block margins for paper and leaves the screen alone', () => {
    // 22px above and below the metrics, 20px above every section and 32px above
    // the footer is 138px — 36.5mm, 14% of a sheet — of margin before a single
    // figure is printed, and it is what put three of the 13 book reports onto a
    // trailing sheet holding almost nothing.
    expect(print('.report-metrics').margin).toBe('12px 0');
    expect(print('.report-section')['margin-top']).toBe('12px');
    expect(print('.report-footer')['margin-top']).toBe('14px');
    // On screen the sheet scrolls and the air is free. Tightening it there
    // would be a different change, made for a different reason.
    expect(screen('.report-metrics').margin).toBe('22px 0');
    expect(screen('.report-section')['margin-top']).toBe('20px');
    expect(screen('.report-footer')['margin-top']).toBe('32px');
  });

  it('pins the metric tiles to a row, because paper is not a phone', () => {
    // `@media (max-width: 980px)` collapses this grid to one column, and the
    // printed page box is 725 CSS px wide, so on any print path that evaluates
    // width media queries against the page the three tiles stack into a 302px
    // tower — 80mm of sheet for three numbers. The eleven PDFs the desk sent
    // show them side by side on a 138pt pitch, so the desk's own print path and
    // a print-to-PDF of the same page disagreed about the report's shape.
    expect(print('.report-metrics')['grid-template-columns']).toBe('repeat(4, 1fr)');
    // The pin is only worth anything while the rule it overrides is still
    // there. If the responsive collapse ever goes away this assertion should be
    // read again rather than deleted on sight.
    expect(resolved('.report-metrics', '@media (max-width: 980px)')['grid-template-columns']).toBe('1fr');
  });

  it('stops claiming a paper size the desk never prints on', () => {
    // `size: A4` never once produced an A4 page: all eleven reports the desk
    // sent are 215.9 x 279.4mm. The margin is real and stays; the size was a
    // 17.6mm-per-sheet lie in every height calculation made against it.
    const page = ALL.find((rule) => rule.selectors.includes('@page'));
    expect(page.declarations.margin).toBe('12mm');
    expect(page.declarations.size).toBeUndefined();
  });
});

describe('the print contract the report already had, unchanged', () => {
  // These three are why ReportNoteSection.test.jsx and ReportNoteSwitch.test.jsx
  // exist: a note once reached a PDF it did not belong in. Nothing about page
  // breaking is allowed to move a `display` rule, and this is where that is
  // checked from the stylesheet side.
  it('still hides everything marked .no-print', () => {
    expect(print('.no-print').display).toBe('none !important');
    expect(print('.report-design-drawer').display).toBe('none !important');
  });

  it('still prints the plain-text copy of the note', () => {
    expect(print('.report-note-print').display).toBe('block');
    expect(screen('.report-note-print').display).toBe('none');
  });

  it('still keeps an unwritten note out of the client PDF', () => {
    expect(print('.report-note-section:not(.has-note)').display).toBe('none !important');
  });
});
