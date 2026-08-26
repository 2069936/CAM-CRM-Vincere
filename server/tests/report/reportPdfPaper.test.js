// The two places the paper is described, held in agreement.
//
// src/index.css says `@page { margin: 12mm }`. server/report/reportPdf.js says
// `margin: { top: '12mm', … }`. Both are load-bearing and NEITHER is redundant:
// Chrome's printToPDF ignores `@page` unless preferCSSPageSize is set, so the
// server's copy is what actually shapes the downloaded file — and the desk's own
// print dialog reads the stylesheet's copy, which is what shapes the printed one.
// Download and Print are supposed to produce the same paper, so the day these
// two disagree is the day a client's downloaded report is laid out to a
// different page box from every report they have received before.
//
// src/printLayout.test.js pins the stylesheet's half (and that `size` stays off
// it, because `size: A4` never once produced an A4 page). This file pins that
// the server's half still matches it.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REPORT_PAPER, REPORT_VIEWPORT } from '../../report/reportPdf.js';

const CSS = readFileSync('src/index.css', 'utf8');

/** The declarations inside the stylesheet's one `@page` block. */
function pageRule() {
  const at = CSS.indexOf('@page');
  const open = CSS.indexOf('{', at);
  const close = CSS.indexOf('}', open);
  const body = CSS.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '');
  const declarations = {};
  for (const part of body.split(';')) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    declarations[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
  }
  return declarations;
}

describe('the server prints on the paper the stylesheet asks for', () => {
  it('uses the same margin @page does, on all four edges', () => {
    const margin = pageRule().margin;
    expect(margin).toBe('12mm');
    expect(REPORT_PAPER.margin).toEqual({ top: margin, bottom: margin, left: margin, right: margin });
  });

  it('prints US Letter, which is what the desk has always been sent', () => {
    // All eleven reports the desk sent measure 215.9 x 279.4mm and none of them
    // is A4. The stylesheet deliberately states no `size` — the paper came from
    // the dialog — so the server has to state it, and this is the value.
    expect(REPORT_PAPER.format).toBe('Letter');
    expect(pageRule().size).toBeUndefined();
  });

  it('keeps backgrounds, which is where the PnL colours and the flag badges live', () => {
    expect(REPORT_PAPER.printBackground).toBe(true);
    // The stylesheet's half of that same promise.
    expect(CSS).toContain('print-color-adjust: exact');
  });

  it('lays the report out in the box the verification measures it in', () => {
    // scripts/verify-report-print-layout.mjs has always printed the pinned
    // corpus at 1200x1400, and the two browser drivers set the viewport through
    // different APIs. If production and the verification lay the report out in
    // different boxes, the pinned 18 sheets stop being a statement about the
    // file the client receives.
    expect(REPORT_VIEWPORT).toEqual({ width: 1200, height: 1400 });
  });
});
