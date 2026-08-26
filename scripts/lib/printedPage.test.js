// The measuring end of "verify by printing real output", checked on a PDF whose
// ink positions are known because they were written by hand.
//
// This matters more than it looks: every claim about the printed report — 23
// sheets before and 18 after, a first page 80% blank, a second sheet holding
// one line of footer — is this module's arithmetic. A parser that quietly reads
// the white sheet background as ink would report every page as full and the
// defect would measure as fixed while the CAM kept sending the same PDF.
//
// The fixtures below are uncompressed, which the reader accepts because it
// falls back to the raw bytes when a stream is not deflated.

import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { readPrintedPages, pageSpace, DEFAULT_MARGIN_PT } from './printedPage.mjs';

/** A one-page US Letter PDF carrying `content` as its content stream. */
function pdf(content, pages = 1) {
  const pageObjects = [];
  for (let i = 0; i < pages; i += 1) {
    const pageNumber = 10 + i * 2;
    pageObjects.push(`${pageNumber} 0 obj
<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents ${pageNumber + 1} 0 R /MediaBox [0 0 612 792] >>
endobj
${pageNumber + 1} 0 obj
<< /Length ${content[i].length} >>
stream
${content[i]}
endstream
endobj
`);
  }
  const kids = Array.from({ length: pages }, (_, i) => `${10 + i * 2} 0 R`).join(' ');
  return Buffer.from(`%PDF-1.4
2 0 obj
<< /Type /Pages /Count ${pages} /Kids [ ${kids} ] >>
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
${pageObjects.join('')}
trailer
<< /Root 1 0 R >>
%%EOF
`, 'latin1');
}

const MARGIN = DEFAULT_MARGIN_PT;

describe('reading the ink off a printed page', () => {
  it('ignores the white sheet background, which would otherwise fill every page', () => {
    // The report paints a page-sized white rectangle. Counted as ink it would
    // make a page holding one line of footer measure as completely full.
    const pages = readPrintedPages(pdf([`1 1 1 rg 0 0 612 792 re f
0 0 0 rg 34 700 543 2 re f`]));
    expect(pages).toHaveLength(1);
    expect(pages[0].topPt).toBeCloseTo(702, 1);
    expect(pages[0].bottomPt).toBeCloseTo(700, 1);
  });

  it('ignores a clip rectangle, which marks nothing', () => {
    // `re W n` sets the clip and paints nothing. Chrome emits one the size of
    // the whole content box on every page.
    const pages = readPrintedPages(pdf([`34 34 543 723 re W n
0 0 0 rg 34 600 543 2 re f`]));
    expect(pages[0].topPt).toBeCloseTo(602, 1);
    expect(pages[0].bottomPt).toBeCloseTo(600, 1);
  });

  it('drops the browser page header, which prints in the margin and is not the report', () => {
    // Every one of the eleven PDFs the desk sent carries Chrome's own header
    // and footer: the date, the tab title, "Page 1 of 2" and the app URL. They
    // sit outside the 12mm band and must not count as content.
    const pages = readPrintedPages(pdf([`BT /F1 10 Tf 1 0 0 1 40 776 Tm (21/08/26 daily report) Tj ET
BT /F1 10 Tf 1 0 0 1 40 400 Tm (Evaluations) Tj ET
BT /F1 10 Tf 1 0 0 1 40 13 Tm (Page 1 of 2) Tj ET`]));
    expect(pages[0].text).toBe('Evaluations');
    expect(pages[0].topPt).toBeLessThan(792 - MARGIN);
  });

  it('turns ink extents into the used and blank millimetres a reader would see', () => {
    // Band is 792 - 2 x 34.016pt = 723.97pt = 255.4mm, which is US Letter at a
    // 12mm margin — the paper the desk actually prints on.
    const pages = readPrintedPages(pdf([`0 0 0 rg 34 400 543 2 re f`]));
    const space = pageSpace(pages[0]);
    expect(space.band).toBeCloseTo(255.4, 1);
    expect(space.used).toBeCloseTo((792 - DEFAULT_MARGIN_PT - 400) * 25.4 / 72, 1);
    expect(space.used + space.blank).toBeCloseTo(space.band, 3);
  });

  it('calls a page with no marks at all completely blank', () => {
    const pages = readPrintedPages(pdf([`1 1 1 rg 0 0 612 792 re f`]));
    const space = pageSpace(pages[0]);
    expect(space.used).toBe(0);
    expect(space.blank).toBeCloseTo(255.4, 1);
  });

  it('keeps the pages in the order the document lists them', () => {
    const pages = readPrintedPages(pdf([
      `BT /F1 10 Tf 1 0 0 1 40 400 Tm (first) Tj ET`,
      `BT /F1 10 Tf 1 0 0 1 40 400 Tm (second) Tj ET`,
    ], 2));
    expect(pages.map((page) => page.text)).toEqual(['first', 'second']);
  });
});
