// How big a real client report actually is, measured on the book.
//
// The print rules in src/index.css are pinned by src/printLayout.test.js, which
// needs no book and runs on every clone. What that file cannot say is WHY the
// account sections have to be allowed to break: that answer is a fact about
// this book, not about CSS, and it is the fact the old stylesheet got wrong.
//
// The constants below are not guesses. They were measured in Chrome, on the
// printed page box a real print job produces — 725 x 965 CSS px, which is US
// Letter minus the 12mm margin the stylesheet asks for, confirmed against the
// eleven PDFs the desk sent on 2026-08-21 (all of them 215.9 x 279.4mm, none of
// them A4). At that width an account row measures 56px when nothing wraps and
// up to 76px when the account cell runs to two lines, so 56 is the smallest a
// row can be and every bound below that uses it is the generous one.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildDailyReportSummary } from './domain/report';
import { buildCrmStateFromTables } from './domain/supabaseStore';

/** The printable page box, in CSS px, measured out of a real Chrome print job. */
const PAGE_PX = 965;
/**
 * The shortest an account row can be on that page. Measured over the 95 account
 * rows the 13 book clients print on 2026-07-30: 56px when nothing wraps, 76px
 * when the account cell runs to two lines. Every bound below uses 56, so every
 * bound below is the generous one.
 */
const SHORTEST_ROW_PX = 56;
/** A section's heading plus its column headings. Measured across 36 of them. */
const HEADING_PX = 54;
/** Header, metric tiles and the margins between them, on every report. */
const PREAMBLE_PX = 93 + 12 + 68 + 12;
/** The footer, its rule and the margin above it. */
const FOOTER_PX = 14 + 12 + 30;

// The pools the report prints as separate `.report-section` blocks, in the order
// App.jsx renders them. `cash` is deliberately absent: it is the combined bucket
// the segment tiles use, and printing it as well would list every cash account
// twice.
const POOLS = ['evaluations', 'funded', 'cashIra', 'cashStraight', 'cashLegacy', 'unclassified'];

describe('the real book (public/local-snapshot.json)', () => {
  const snapshot = JSON.parse(
    readFileSync(new URL('../public/local-snapshot.json', import.meta.url), 'utf8'),
  );
  const state = buildCrmStateFromTables(snapshot.tables);

  /** The least paper a close could possibly take, at the shortest row measured. */
  const shortestHeight = (close) => PREAMBLE_PX
    + close.sections * HEADING_PX
    + close.rows * SHORTEST_ROW_PX
    + FOOTER_PX;

  const closes = [];
  for (const client of state.clients) {
    for (const dailyImport of client.dailyImports || []) {
      const report = buildDailyReportSummary(client, dailyImport);
      const sizes = POOLS.map((pool) => report.grouped[pool].length);
      const rows = sizes.reduce((total, n) => total + n, 0);
      if (!rows) continue;
      closes.push({
        client: client.name,
        date: dailyImport.date,
        rows,
        sections: sizes.filter((n) => n > 0).length,
        largestSection: Math.max(...sizes),
      });
    }
  }

  it('holds one account section of 21 rows, taller than any sheet on its own', () => {
    const largest = closes.reduce((worst, close) => (close.largestSection > worst.largestSection ? close : worst));
    expect(largest.largestSection).toBe(21);
    // One pool, one heading, 21 rows and nowhere to put them. At the shortest
    // row the page can produce this single section is 1,176px against a 965px
    // sheet — 1.2 sheets before its heading and column headings are counted —
    // so `break-inside: avoid` on a section was never a rule the browser could
    // honour here. It was a rule the browser had to break, and the sheet it
    // spoiled getting there was the one in front of it.
    expect(largest.largestSection * SHORTEST_ROW_PX).toBeGreaterThan(PAGE_PX);
    expect(largest.largestSection * SHORTEST_ROW_PX).toBe(1176);
    // And it is not one freak close. 55 of the book's 476 hold a single section
    // over half a sheet tall, which is the population where "keep the section
    // whole" throws away the better part of a sheet to move it: that is the
    // shape of the report the desk sent on 2026-08-21 with its first page 80%
    // blank, and it is why this is a rule about breaking, not about one client.
    const overHalfASheet = closes.filter((close) => close.largestSection * SHORTEST_ROW_PX > PAGE_PX / 2);
    expect(overHalfASheet).toHaveLength(55);
  });

  it('is 425 closes of 476 that DO fit a sheet, which is why the waste looked like bad luck', () => {
    // The old rule only bit when a section straddled the boundary, so nine
    // reports in eleven printed fine and the two that did not read as an
    // accident rather than a rule. These proportions are the reason the defect
    // survived: anything that moves them is changing what this fix is for.
    expect(closes).toHaveLength(476);
    const fits = closes.filter((close) => shortestHeight(close) <= PAGE_PX);
    expect(fits).toHaveLength(425);
    // 51 closes in the book cannot be one sheet however the rules are written.
    // Those are the ones where "break where a reader would break it" is the
    // whole question.
    expect(closes.length - fits.length).toBe(51);
  });

  it('gives a break somewhere good to land: 264 closes of 476 carry more than one pool', () => {
    // A report that were one single section could only ever break inside a
    // table. Most of the book is two pools or three, which is what makes
    // `h2 { break-after: avoid }` worth having — there are real section
    // boundaries for the page to prefer over a mid-table one.
    const bySections = {};
    for (const close of closes) bySections[close.sections] = (bySections[close.sections] || 0) + 1;
    expect(bySections).toEqual({ 1: 212, 2: 252, 3: 12 });
    expect(closes.filter((close) => close.sections >= 2)).toHaveLength(264);
  });
});
