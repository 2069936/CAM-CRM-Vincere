// The weight a client's report headings print at.
//
// This file exists because that weight changed once without anyone choosing it,
// and nothing in the repo noticed.
//
// THE MECHANISM, measured. Tailwind preflight sets `h1..h6 { font-weight:
// inherit }`, so a report's <h1> (the client's name) and its <h2>s (the section
// titles) compute to 400. src/index.css used to import
// `css2?family=Outfit:wght@500;600;700;800`, and Google returns exactly those
// four discrete faces for it -- there is no 400. CSS font matching sends a
// desired 400 to the 500 face when no 400 exists, so every report ever printed
// or downloaded set its headings in Outfit Medium.
//
// Self-hosting through @fontsource-variable/outfit replaced those four faces
// with one variable face declared `font-weight: 100 900`, which HAS a real 400.
// The same CSS, unchanged, then printed 36 headings across the 13-client book
// at true 400 -- 16.8% less ink on the page, on every client's paper, on both
// the Print and the Download path. Sheet counts, sheet heights and every
// element box stayed identical, which is exactly why the pinned 18 sheets /
// 208mm / 39-of-39 did not catch it: pagination did not move, only ink did.
//
// So the weight is now stated in the stylesheet instead of inherited from
// whatever a font vendor happens to serve, and this file is what fails if it
// goes away again.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (relative) => readFileSync(resolve(ROOT, relative), 'utf8');

const CSS = read('src/index.css');
/** The sheet with its comments removed -- the comments TALK about weight 400. */
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** Declarations carried by an exact selector, in document order. */
function declarationsFor(selector) {
  const out = [];
  const pattern = new RegExp(`(^|[},])\\s*([^{}]*?)\\{([^{}]*)\\}`, 'g');
  let match;
  while ((match = pattern.exec(RULES))) {
    const selectors = match[2].split(',').map((part) => part.trim());
    if (selectors.includes(selector)) out.push(match[3]);
  }
  return out;
}

describe('report headings print at the weight the desk has always received', () => {
  it('states the weight rather than inheriting it from the font vendor', () => {
    for (const selector of ['.report-sheet h1', '.report-sheet h2']) {
      const declarations = declarationsFor(selector);
      expect(declarations.length, `${selector} carries no rule`).toBeGreaterThan(0);
      expect(declarations.join(';')).toMatch(/font-weight:\s*500/);
    }
  });

  it('scopes it to the report and leaves the product-wide headings alone', () => {
    // The global `h1,h2,h3,h4,h5,h6` block sets font-family for the whole app.
    // Putting a weight there would repaint every heading in every screen to fix
    // a report, so the rule must not live in it.
    const global = declarationsFor('h1').join(';');
    expect(global).not.toMatch(/font-weight/);
  });

  it('is load-bearing, because the served face really does cover 400', () => {
    // If Outfit were still served only at 500-800 this rule would be a no-op and
    // could be deleted by anyone tidying up. It is not: the face @fontsource
    // declares spans 100 900, so an unstated weight resolves to a true 400 and
    // the headings get lighter. Read from the package, so it fails if a future
    // @fontsource version narrows the range and makes this comment untrue.
    const face = read('node_modules/@fontsource-variable/outfit/wght.css');
    expect(face).toMatch(/font-weight:\s*100\s+900/);
  });
});
