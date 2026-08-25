/**
 * Rendering a client's daily report to PDF on the server, so a click downloads
 * it instead of opening the OS print dialog.
 *
 * WHAT THIS REPLACES. printWithTitle (src/App.jsx) sets document.title and calls
 * window.print(). The CAM closes eleven clients every trading day and every one
 * of them needed that dialog, one at a time, and the eleven files landed in
 * whichever folder the dialog last pointed at. The dialog is also the one step
 * nothing can automate: it is an operating-system window, so no script and no
 * agent can drive it.
 *
 * WHY THE SERVER AND NOT A LIBRARY IN THE BROWSER. Two client-side routes were
 * built and measured against the 13-client corpus scripts/verify-report-print-
 * layout.mjs pins, and both were rejected on evidence:
 *
 *   A DOM-TO-PDF RASTERISER (html2canvas + jsPDF) reads COMPUTED styles out of
 *   the live document, and the live document is under SCREEN media — `@media
 *   print` never applies to it. Measured inside the html2canvas clone:
 *   `.report-actions` computed to flex, `.report-note-editor` to flex,
 *   `.report-note-print` to none. That is the CAM's action bar, the Design
 *   button and the note TEXTAREA in the client's PDF and the note's printed copy
 *   missing from it — the exact three-part contract `.no-print`,
 *   `.report-note-print` and `.report-note-section:not(.has-note)` exist to
 *   enforce, all three broken at once. Replaying the print rules by hand fixes
 *   that and still cannot fix pagination: a bitmap has no fragmentation engine,
 *   so it is one tall image cut with pixel arithmetic. Judged by the rules the
 *   verify script judges by, 4 of 4 real multi-sheet cuts and 39 of 39 boundary
 *   sweep positions offend, against 39/39 clean here. And 0 of its characters
 *   are searchable.
 *
 *   A VECTOR RE-RENDER from the report data (pdfmake / jsPDF's text API) is
 *   crisp and tiny, and it is a SECOND renderer for a panel that is 441 lines of
 *   JSX over four sub-components, four domain builders, 14 config toggles and
 *   two hand-rolled inline SVG charts. The figures could not drift — both sides
 *   would read buildDailyReportSummary — but the shape would, and the whole
 *   verification apparatus would stop testing the shipped artifact, because the
 *   boundary sweep measures the break the BROWSER chooses and under that route
 *   the browser no longer chooses. Its 5.3 KB/report also needs jsPDF's
 *   standard-14 Helvetica, which drops "—" and "…" silently and prints "Bałka"
 *   as "BaBka".
 *
 * So: the report DOM goes up, a headless Chrome loads it against the deployment's
 * OWN built stylesheet, and prints it at Letter/12mm. The output IS the print
 * output — same stylesheet, same fragmentation engine, same paper — which is why
 * every guard that pins the print layout keeps testing the file the client
 * actually receives.
 *
 * WHAT THE DESK LOSES, plainly: the file is ~4.4x bigger (41 KB from the macOS
 * dialog's subset fonts, ~180 KB from Chrome's printToPDF; still selectable and
 * searchable), and it needs the network and the deployment where print needed
 * only the open tab. That second one is the real cost, and it is why the Print
 * button stays — demoted, but there.
 *
 * THIS MODULE TAKES NO BROWSER DEPENDENCY. `launchBrowser` is injected:
 * api/report/pdf.js passes puppeteer-core + @sparticuz/chromium, and
 * scripts/verify-report-print-layout.mjs passes the playwright dev dependency,
 * so the verification measures this exact code path with a real Chrome and no
 * 76 MB install.
 */

import { Buffer } from 'node:buffer';
import { ApiError } from '../apiLib/http.js';
import { reportContentDisposition, reportPdfFileName } from '../../src/domain/reportFileName.js';

export { reportContentDisposition, reportPdfFileName };

/**
 * The paper, and it is not a preference.
 *
 * US Letter at a 12mm margin is what the desk's dialog produces — all eleven
 * reports it sent on 2026-08-24 measure 215.9 x 279.4mm, never A4 — and 12mm is
 * what `@page` in src/index.css asks for. Chrome's printToPDF ignores `@page`
 * unless preferCSSPageSize is set, so the margin is stated twice; the two are
 * held in agreement by server/report/reportPdfPaper.test.js, which reads the
 * stylesheet and fails if they diverge. src/printLayout.test.js pins the
 * stylesheet's half of that pair.
 */
export const REPORT_PAPER = Object.freeze({
  format: 'Letter',
  printBackground: true,
  margin: Object.freeze({ top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' }),
});

/**
 * The window the report is laid out in before it is paginated.
 *
 * Pinned HERE rather than left to whichever launcher is in use, because the two
 * launchers set it through different APIs (puppeteer's `defaultViewport` at
 * launch, playwright's `viewport` at newPage) and a verification measuring a
 * different box from production is a verification that proves nothing. 1200x1400
 * is what scripts/verify-report-print-layout.mjs has always printed the pinned
 * corpus at.
 */
export const REPORT_VIEWPORT = Object.freeze({ width: 1200, height: 1400 });

/**
 * How much report DOM the endpoint will accept.
 *
 * The 13 book reports serialize to a mean of 5.2 KB and a maximum of 8.5 KB, so
 * 256 KB is 30x the worst real one. It bounds abuse, not reports.
 */
export const MAX_REPORT_HTML_BYTES = 256 * 1024;

/**
 * How large a rendered report may be before it is refused.
 *
 * server/export/clientExport.js documents the 4 MiB platform response ceiling at
 * length because a 30-day multi-client export lives at 62-99% of it. One report
 * is ~180 KB — 4.4% of it — so this ceiling does not threaten the feature; it
 * exists so a pathological render fails with a diagnosable 413 rather than a
 * platform-level truncation the CAM would read as a corrupt PDF.
 */
export const MAX_REPORT_PDF_BYTES = 4 * 1024 * 1024;

/**
 * The faces the report is actually SET IN, and the list was measured, not read
 * off the import list.
 *
 * `--font-sans: "Inter Variable", …` is inherited by the whole sheet and every
 * table in it, and `--font-heading: "Outfit Variable", …` sets h1 and h2. The
 * names carry `Variable` because that is what `@fontsource-variable/inter` and
 * `@fontsource-variable/outfit` declare their `@font-face` families as, and this
 * list has to name the family the browser will report, not the family a reader
 * would guess. A scan of the built stylesheet finds nine `@font-face` rules —
 * seven `Inter Variable` subsets and two `Outfit Variable` — and every one of
 * them is reachable from a declaration that uses it.
 *
 * (It did not always hold. `@fontsource-variable/geist` used to sit in the same
 * import list declaring five faces that NOTHING in the sheet selected: `Geist
 * Variable` appeared in five font-face rules and in zero declarations, and 76.4
 * KB of woff2 shipped on every build for it. Asserting Geist here would have
 * failed every render. It is gone.)
 *
 * WHY THIS IS A HARD FAILURE AND NOT A WARNING, measured on real book reports
 * rendered through this exact module with the font files blocked:
 *
 *     client            fonts loaded        sheets
 *     Gray Birch        Inter, Outfit         1
 *     Gray Birch        (none)                2
 *
 * A whole extra sheet, sent to a client, from a font that quietly did not
 * arrive. Font availability is a PAGINATION INPUT. An unstyled render does not
 * look broken enough for anyone to catch it before it reaches a client, so a
 * font that does not load fails the request and the CAM falls back to Print.
 *
 * WHERE THEY COME FROM, and this changed. Both families were `@import`ed from
 * fonts.googleapis.com, which made a third party a runtime dependency of THIS
 * SERVER: every render reached out to Google, and this check existed to catch
 * the renders where that failed. They are now self-hosted through `@fontsource`
 * and served from the deployment's own `/assets` — the same Inter v20 and Outfit
 * v15 files Google was serving, one variable woff2 a subset sliced to the wght
 * axis, so the paper is unchanged. The check stays: a self-hosted font can still
 * 404 after a bad deploy, and it would still cost a client a sheet.
 *
 * SELF-HOSTED STILL MEANS CROSS-ORIGIN HERE, and this is the trap. A font fetch
 * is always CORS-mode, and the document below is built with setContent, which
 * gives it an OPAQUE origin — so its request for the deployment's own woff2 goes
 * out with `Origin: null` and is refused unless the response carries
 * `Access-Control-Allow-Origin`. fonts.gstatic.com always sent one, which is why
 * nothing here had to think about it before. `vercel.json` now sends one on
 * `/assets/*.woff2`; server/tests/report/reportFontOrigin.test.js holds that
 * file and this module together, and without it every render is refused with the
 * error below — measured, all 13 book reports and all 39 sweep positions.
 */
export const REPORT_FONT_FAMILIES = Object.freeze(['Inter Variable', 'Outfit Variable']);

const ORIGIN_ONLY = /^https?:\/\/[^/?#]+$/;

/** `https://host` with no trailing slash, path, query or fragment. */
export function normalizeBaseUrl(value) {
  const trimmed = String(value || '').trim().replace(/\/+$/, '');
  if (!ORIGIN_ONLY.test(trimmed)) {
    throw new ApiError(500, `report_base_url_invalid: ${trimmed || '(empty)'}`);
  }
  return trimmed;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Root-relative asset URLs in the built stylesheet, made absolute.
 *
 * The stylesheet is INLINED into the render document rather than linked, so its
 * own URL is no longer there to resolve `url(/assets/…)` against. This is what
 * makes the report's fonts resolve at all now that they are the deployment's own
 * `/assets/inter-latin-wght-normal-<hash>.woff2` and not Google's, so it is on
 * the pagination path, not a tidiness measure.
 *
 * What must survive untouched and does: `url(#clientPnlArea)` and
 * `url(#clientPnlLine)` are SVG fragment references the report's charts depend
 * on, and an absolute or protocol-relative `url(//host/…)` is not a root-
 * relative path either. Only a single leading `/` is rewritten, so neither
 * matches.
 */
export function absolutizeCssUrls(css, origin) {
  return String(css).replace(/url\((['"]?)\/(?!\/)/g, `url($1${origin}/`);
}

/**
 * The document the headless browser is given.
 *
 * THE REPORT DOM IS PASSED THROUGH UNTOUCHED, and that is deliberate. The one
 * thing this route buys over a client-side rasteriser is that the print
 * stylesheet — not a second hand-maintained copy of it — decides what reaches
 * the paper. Stripping `.no-print` here, or inlining the note, would BE that
 * second copy, and it is the copy that let the CAM's textarea into a client's
 * PDF when the rasteriser was measured. `.report-actions`,
 * `.report-note-editor`, `.report-design-drawer` and an unwritten
 * `.report-note-section` all arrive in this HTML and all are removed by the same
 * `@media print` rules that remove them from a printed page.
 *
 * WHY THE STYLESHEET IS INLINED RATHER THAN LINKED. Measured: a cross-origin
 * `<link>` loads and paints, but the document created by setContent has an
 * opaque origin, so `sheet.cssRules` throws SecurityError and the page can no
 * longer be asked whether its stylesheet actually arrived. Since a stylesheet
 * that silently did not arrive is precisely the failure worth catching, the CSS
 * is fetched server-side and inlined, where its rules are readable and countable.
 *
 * WHAT CONSTRAINS THE HTML IS THE CSP, and it is doing real work. The endpoint
 * renders caller-supplied HTML in a browser that sits inside the deployment's
 * network, so an `<img src="http://169.254.169.254/…">` or an exfiltrating
 * `<script>` would be a genuine hole. `default-src 'none'` closes it: the only
 * subresources this document may fetch at all are the deployment's OWN assets.
 * `font-src ${origin}` is necessary but NOT sufficient for the fonts: this
 * document has an opaque origin, so the deployment also has to answer those
 * requests with `Access-Control-Allow-Origin` (see REPORT_FONT_FAMILIES).
 * That is the whole allow-list now — it used to also carry
 * https://fonts.googleapis.com and https://fonts.gstatic.com, because Inter and
 * Outfit were `@import`ed from Google and the render could not paginate without
 * them; self-hosting the two families through `@fontsource` took both third-party
 * origins out of this policy and off the render path. `'unsafe-inline'` is
 * granted to style-src alone, because the report sets inline styles (the CAM day
 * sheet's break rule, and the hand-rolled SVG charts) and would render wrong
 * without it. script-src stays `'none'`.
 */
export function reportDocument({ html, title, styles = [], origin }) {
  const sheets = styles
    .map((style) => `<style data-report-style="${escapeHtml(style.href)}">${style.css}</style>`)
    .join('\n    ');
  const csp = [
    "default-src 'none'",
    `style-src ${origin} 'unsafe-inline'`,
    `font-src ${origin}`,
    `img-src ${origin} data:`,
    "script-src 'none'",
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
    <title>${escapeHtml(String(title || 'report'))}</title>
    ${sheets}
  </head>
  <body>
    <div class="report-overlay">${html}</div>
  </body>
</html>`;
}

/**
 * The deployment's own hashed stylesheet URLs, read out of its own index.html.
 *
 * NOT A HARDCODED PATH AND NOT A CLIENT-SUPPLIED ONE. Vite emits
 * /assets/index-<hash>.css and the hash changes whenever the CSS does, so the
 * only honest source for "which stylesheet is this build's" is the index.html
 * this build deployed. Taking it from the caller would let the caller point a
 * browser inside the deployment at any URL it liked; taking it from a constant
 * would render this month's report against last month's stylesheet, or against
 * nothing at all.
 *
 * index.html is refetched every time and never cached: it is a few hundred
 * bytes, and a stale one after a redeploy names a hash that no longer resolves.
 */
export async function resolveReportStylesheets({ baseUrl, fetchImpl = globalThis.fetch }) {
  const origin = normalizeBaseUrl(baseUrl);
  let response;
  try {
    response = await fetchImpl(`${origin}/index.html`, { headers: { accept: 'text/html' } });
  } catch {
    throw new ApiError(502, `report_assets_unreachable: ${origin}/index.html could not be fetched`);
  }
  if (!response?.ok) {
    throw new ApiError(502, `report_assets_unreachable: ${origin}/index.html returned ${response?.status}`);
  }
  const markup = await response.text();
  const hrefs = [];
  for (const tag of markup.match(/<link\b[^>]*>/gi) || []) {
    if (!/\brel\s*=\s*["']?stylesheet\b/i.test(tag)) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) continue;
    const absolute = new URL(href, `${origin}/`).toString();
    // index.html is ours, but "ours" is an assumption and checking costs one
    // comparison.
    if (absolute.startsWith(`${origin}/`)) hrefs.push(absolute);
  }
  if (!hrefs.length) {
    throw new ApiError(502, `report_stylesheet_missing: no same-origin stylesheet is linked from ${origin}/index.html`);
  }
  return hrefs;
}

/**
 * Fetched stylesheet text, keyed by its content-hashed URL.
 *
 * Safe to keep for the life of the container precisely BECAUSE the URL carries
 * the content hash: a changed stylesheet is a changed key, so this can never
 * serve the wrong CSS. It saves refetching ~200 KB on every warm render.
 */
const styleCache = new Map();
const STYLE_CACHE_LIMIT = 8;

export function clearReportStyleCache() {
  styleCache.clear();
}

/** Every stylesheet the build links, fetched and made self-contained. */
export async function fetchReportStyles({ baseUrl, fetchImpl = globalThis.fetch, cache = styleCache }) {
  const origin = normalizeBaseUrl(baseUrl);
  const hrefs = await resolveReportStylesheets({ baseUrl: origin, fetchImpl });
  const styles = [];
  for (const href of hrefs) {
    if (cache.has(href)) {
      styles.push({ href, css: cache.get(href) });
      continue;
    }
    let response;
    try {
      response = await fetchImpl(href, { headers: { accept: 'text/css' } });
    } catch {
      throw new ApiError(502, `report_stylesheet_missing: ${href} could not be fetched`);
    }
    if (!response?.ok) {
      throw new ApiError(502, `report_stylesheet_missing: ${href} returned ${response?.status}`);
    }
    const css = absolutizeCssUrls(await response.text(), origin);
    if (!css.trim()) throw new ApiError(502, `report_stylesheet_missing: ${href} is empty`);
    if (cache.size >= STYLE_CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(href, css);
    styles.push({ href, css });
  }
  return styles;
}

/**
 * Read back out of the rendered page: did the stylesheet and the fonts arrive?
 *
 * A standalone arrow taking everything as arguments, because puppeteer and
 * playwright both serialize the function source and send it across — it can
 * close over nothing.
 */
export const REPORT_ASSET_PROBE = async (families) => {
  // Force layout before waiting. document.fonts.ready resolves immediately when
  // no font load has been started yet, so a report whose fonts had not been
  // asked for would otherwise report itself perfectly healthy.
  void document.body.offsetHeight;
  await document.fonts.ready;
  const faces = [...document.fonts];
  const named = (family) => faces.filter((face) => String(face.family).replace(/["']/g, '') === family);
  return {
    stylesheets: [...document.styleSheets].map((sheet) => {
      try { return sheet.cssRules.length; } catch { return -1; }
    }),
    fonts: families.map((family) => ({
      family,
      loaded: named(family).filter((face) => face.status === 'loaded').length,
      seen: named(family).length,
    })),
  };
};

/**
 * Fails the request when the paper the browser just produced was laid out
 * against assets that were not there.
 *
 * Both halves are pagination inputs, not cosmetics: a missing stylesheet means
 * none of the break rules applied, and a missing font was measured moving a real
 * client's report from one sheet to two.
 */
export function assertReportAssetsLoaded(probe, expectedStyleCount) {
  const usable = (probe?.stylesheets || []).filter((rules) => rules > 0);
  if (usable.length < expectedStyleCount) {
    throw new ApiError(502, `report_stylesheet_missing: ${usable.length} of ${expectedStyleCount} stylesheet(s) parsed in the rendered page`);
  }
  const absent = (probe?.fonts || []).filter((font) => !font.loaded).map((font) => font.family);
  if (absent.length || !probe?.fonts?.length) {
    throw new ApiError(502, `report_font_missing: ${absent.join(', ') || 'no font families were probed'} did not load into the rendered page`);
  }
}

function assertHtmlWithinLimit(html) {
  const text = typeof html === 'string' ? html : '';
  if (!text.trim()) throw new ApiError(400, 'report_html_required');
  if (Buffer.byteLength(text, 'utf8') > MAX_REPORT_HTML_BYTES) {
    throw new ApiError(413, 'report_html_too_large');
  }
  return text;
}

/**
 * The whole render: report DOM in, the bytes of a US Letter PDF out.
 *
 * The browser is closed in a `finally` whatever happens. A serverless container
 * is reused between invocations, and a leaked chromium is the one failure here
 * that gets worse the more the desk uses the feature.
 */
export async function renderReportPdf({
  html,
  title,
  baseUrl,
  launchBrowser,
  fetchImpl = globalThis.fetch,
  paper = REPORT_PAPER,
  fontFamilies = REPORT_FONT_FAMILIES,
}) {
  const body = assertHtmlWithinLimit(html);
  const origin = normalizeBaseUrl(baseUrl);
  const styles = await fetchReportStyles({ baseUrl: origin, fetchImpl });
  const markup = reportDocument({ html: body, title, styles, origin });

  const browser = await launchBrowser();
  let bytes;
  try {
    const page = await browser.newPage();
    await page.setContent(markup, { waitUntil: 'load' });
    assertReportAssetsLoaded(await page.evaluate(REPORT_ASSET_PROBE, [...fontFamilies]), styles.length);
    // No emulateMedia call: printToPDF applies print media itself, in puppeteer
    // and playwright alike, which is the entire point of this route.
    bytes = Buffer.from(await page.pdf(paper));
    await page.close();
  } finally {
    await browser.close();
  }

  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new ApiError(502, 'report_render_failed: the renderer did not return a PDF');
  }
  if (bytes.length > MAX_REPORT_PDF_BYTES) {
    throw new ApiError(413, `report_pdf_too_large: ${bytes.length} bytes`);
  }
  return {
    bytes,
    fileName: reportPdfFileName(title),
    contentDisposition: reportContentDisposition(title),
  };
}
