import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/* ------------------------------------------------------------------------- *
 * THE CONTROLS ON THE REPORT SHEET HAVE TO BE VISIBLE ON IT.
 *
 * `.report-sheet` hardcodes `background: #ffffff; color: #12202b`, because it
 * is a document that prints, not a panel that follows the app theme. The
 * controls sitting on it did follow the theme, and on the dark theme that
 * means near-white text and a dark border. A CAM reported that Design and
 * Print were invisible; they were transparent buttons painting #eef6fb text on
 * a #f8fbfd bar. Download PDF was legible only by accident, because
 * .secondary-button paints itself with --surface-2. The design drawer was
 * worse: a dark --surface-2 card inheriting the sheet's dark text, so every
 * option label a CAM has to read to choose it was grey on charcoal.
 *
 * jsdom will not resolve a cascade of custom properties across a stylesheet it
 * never loaded, so this reads the rules the way printLayout.test.js reads the
 * print blocks: the decisions are in the file, and the file is what ships.
 * ------------------------------------------------------------------------- */
const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8');

function block(selector) {
  const at = css.indexOf(selector);
  expect(at, `${selector} is missing from index.css`).toBeGreaterThan(-1);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

// Relative luminance and contrast, WCAG 2.1.
function luminance(hex) {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}
function contrast(a, b) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

describe('report sheet chrome', () => {
  const scoped = block('.report-sheet .report-actions,');

  it('gives the chrome its own light palette instead of the app theme', () => {
    // The sheet is white whatever the theme is, so the tokens the buttons and
    // the drawer read have to be light-theme values inside it.
    for (const token of ['--text', '--line', '--surface', '--surface-2', '--muted']) {
      expect(scoped, `${token} is not redefined for the sheet`).toContain(`${token}:`);
    }
  });

  it('paints text on the sheet at better than WCAG AAA', () => {
    // 7:1 is AAA for body text. #12202b on #ffffff is about 16:1; the failure
    // being fixed was #eef6fb on #f8fbfd, which is about 1.05:1.
    expect(contrast('#12202b', '#ffffff')).toBeGreaterThan(7);
    expect(contrast('#12202b', '#eff5f9')).toBeGreaterThan(7);
    // The old state, kept as the thing this must never return to.
    expect(contrast('#eef6fb', '#f8fbfd')).toBeLessThan(1.2);
  });

  it('gives the transparent buttons a ground and an edge of their own', () => {
    // Print is the fallback the PDF error message points people at, so it is
    // the one button that can never be the one nobody can find.
    const ghost = block('.report-sheet .report-actions .ghost-button {');
    expect(ghost).toMatch(/background:\s*#ffffff/);
    expect(ghost).toMatch(/border-color:\s*#ccd9e3/);
    expect(ghost).toMatch(/color:\s*#12202b/);
    expect(contrast('#12202b', '#ffffff')).toBeGreaterThan(7);
  });

  it('keeps an unchecked option as readable as a checked one', () => {
    // An option nobody can read is an option nobody can choose, and most of
    // this drawer is unchecked most of the time.
    const toggle = block('.report-sheet .report-design-drawer .report-design-toggle {');
    expect(toggle).toMatch(/color:\s*#12202b/);
  });

  it('leaves the printed document alone', () => {
    // The override is scoped to the two containers that are chrome. If it ever
    // reaches .report-sheet itself it would repaint the report body, which has
    // its own measured palette and its own print tests.
    expect(scoped).not.toContain('--error');
    const selectorLine = css.slice(css.indexOf('.report-sheet .report-actions,'), css.indexOf('{', css.indexOf('.report-sheet .report-actions,')));
    expect(selectorLine).toContain('.report-design-drawer');
    expect(selectorLine.split(',').map((s) => s.trim()).filter(Boolean)).toEqual([
      '.report-sheet .report-actions',
      '.report-sheet .report-design-drawer',
    ]);
  });

  it('still hides the drawer on paper', () => {
    // The drawer is a control, not content. It was already excluded from print
    // and restyling it must not have changed that.
    expect(css).toMatch(/\.report-design-drawer\s*\{\s*display:\s*none\s*!important/);
  });
});
