// What the server promises the paper, asserted without a browser.
//
// The real verification is a browser one and it is in
// scripts/verify-report-print-layout.mjs, which now drives THIS endpoint over
// HTTP and measures the bytes that come back — 13 real client reports at
// Letter/12mm, plus a section heading walked past the page boundary in 10px
// steps. That script needs a Chrome and the book. THIS file is the fast guard
// that runs everywhere, and it pins the decisions the browser cannot be asked
// about: what document the renderer is given, what the CSP lets that document
// reach, and what happens when the assets the page is laid out against are not
// there.

import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_REPORT_HTML_BYTES,
  MAX_REPORT_PDF_BYTES,
  REPORT_FONT_FAMILIES,
  REPORT_PAPER,
  absolutizeCssUrls,
  assertReportAssetsLoaded,
  clearReportStyleCache,
  fetchReportStyles,
  normalizeBaseUrl,
  renderReportPdf,
  reportDocument,
  resolveReportStylesheets,
} from '../../report/reportPdf.js';

const ORIGIN = 'https://cam.example.test';
const CSS_HREF = `${ORIGIN}/assets/index-abc123.css`;
const INDEX_HTML = `<!doctype html><html><head>
<link rel="icon" href="/favicon.svg">
<script type="module" crossorigin src="/assets/index-def456.js"></script>
<link rel="stylesheet" crossorigin href="/assets/index-abc123.css">
</head><body><div id="root"></div></body></html>`;
const CSS = '@font-face{font-family:"Inter Variable";src:url(/assets/inter-latin-wght-normal-Dx4kXJAl.woff2)}.y{fill:url(#clientPnlArea)}';

/** A live report sheet, with everything the print contract has to strip. */
const SHEET = `<div class="report-sheet">
  <div class="report-actions no-print"><button>Design</button></div>
  <header class="report-header"><h1>Wren Larch</h1></header>
  <section class="report-section report-note-section has-note">
    <div class="report-note-editor no-print"><textarea></textarea></div>
    <p class="report-note-print">A quiet close.</p>
  </section>
</div>`;

function fetchStub({ index = INDEX_HTML, css = CSS, indexStatus = 200, cssStatus = 200 } = {}) {
  return vi.fn(async (url) => {
    if (String(url).endsWith('/index.html')) {
      return { ok: indexStatus < 400, status: indexStatus, text: async () => index };
    }
    return { ok: cssStatus < 400, status: cssStatus, text: async () => css };
  });
}

const healthyProbe = {
  stylesheets: [1493],
  fonts: REPORT_FONT_FAMILIES.map((family) => ({ family, loaded: 2, seen: 8 })),
};

function browserStub({ probe = healthyProbe, pdf = Buffer.from('%PDF-1.4\nreal enough'), failAt } = {}) {
  const seen = { document: null, paper: null, closes: 0, pageCloses: 0, probeArg: null };
  const launch = vi.fn(async () => ({
    newPage: async () => ({
      setContent: async (markup) => {
        seen.document = markup;
        if (failAt === 'setContent') throw new Error('navigation blew up');
      },
      evaluate: async (_fn, arg) => { seen.probeArg = arg; return probe; },
      pdf: async (paper) => { seen.paper = paper; return pdf; },
      close: async () => { seen.pageCloses += 1; },
    }),
    close: async () => { seen.closes += 1; },
  }));
  return { launch, seen };
}

const render = (overrides = {}) => {
  clearReportStyleCache();
  const browser = overrides.browser || browserStub();
  return {
    browser,
    result: renderReportPdf({
      html: SHEET,
      title: 'Wren Larch - 2026-08-24 daily report',
      baseUrl: ORIGIN,
      launchBrowser: browser.launch,
      fetchImpl: overrides.fetchImpl || fetchStub(),
      ...overrides.render,
    }),
  };
};

describe('the document the renderer is given', () => {
  it('passes the report DOM through without editing it', async () => {
    // THE POINT OF THE WHOLE ROUTE. What reaches the paper is decided by the
    // `@media print` blocks in src/index.css and by nothing else. The moment
    // this module starts stripping `.no-print` itself, it becomes a SECOND copy
    // of the print contract — and a second copy is exactly what put the CAM's
    // action bar and the note textarea into the client's PDF when the
    // client-side rasteriser was measured.
    const { browser, result } = render();
    await result;
    expect(browser.seen.document).toContain('class="report-actions no-print"');
    expect(browser.seen.document).toContain('class="report-note-editor no-print"');
    expect(browser.seen.document).toContain('<p class="report-note-print">A quiet close.</p>');
    expect(browser.seen.document).toContain('report-note-section has-note');
  });

  it('wraps the sheet in .report-overlay, which is the box the print rules assume', async () => {
    const { browser, result } = render();
    await result;
    expect(browser.seen.document).toContain('<div class="report-overlay"><div class="report-sheet">');
  });

  it('prints US Letter at the 12mm margin the desk actually gets', async () => {
    const { browser, result } = render();
    await result;
    expect(browser.seen.paper).toEqual(REPORT_PAPER);
    expect(browser.seen.paper.format).toBe('Letter');
    expect(browser.seen.paper.margin).toEqual({ top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' });
    // Backgrounds carry the PnL colours and the flag badges. Without this the
    // client gets a report whose losses are not red.
    expect(browser.seen.paper.printBackground).toBe(true);
  });

  it('inlines the stylesheet instead of linking it', async () => {
    // MEASURED: a cross-origin <link> paints, but the setContent document has an
    // opaque origin, so `sheet.cssRules` throws SecurityError and the page can no
    // longer be asked whether its stylesheet arrived. Since a stylesheet that
    // silently did not arrive is the failure worth catching, it is inlined.
    const { browser, result } = render();
    await result;
    expect(browser.seen.document).toContain(`<style data-report-style="${CSS_HREF}">`);
    expect(browser.seen.document).not.toContain('<link rel="stylesheet"');
  });
});

describe('what the render document is allowed to reach', () => {
  const csp = (markup) => /content="([^"]*)"/.exec(markup)[1].replace(/&#/g, '&#');

  it('reaches nothing by default', async () => {
    // This endpoint runs a browser INSIDE the deployment's network on markup a
    // caller supplied. `default-src 'none'` is what stops that being a
    // server-side request forgery primitive pointed at the metadata service.
    const { browser, result } = render();
    await result;
    expect(csp(browser.seen.document)).toContain("default-src 'none'");
    expect(csp(browser.seen.document)).toContain("script-src 'none'");
    expect(csp(browser.seen.document)).toContain("connect-src 'none'");
    expect(csp(browser.seen.document)).toContain("object-src 'none'");
  });

  it('allows the deployment and nothing else, now that the fonts are the deployment\'s', async () => {
    // This list used to carry https://fonts.googleapis.com and
    // https://fonts.gstatic.com, because Inter and Outfit were `@import`ed from
    // Google and a render could not paginate without them. Self-hosting the two
    // families through `@fontsource` is what let both third-party origins leave
    // the policy, so their ABSENCE is the assertion worth making.
    const { browser, result } = render();
    await result;
    const policy = csp(browser.seen.document);
    expect(policy).toContain(`style-src ${ORIGIN} 'unsafe-inline'`);
    expect(policy).toContain(`font-src ${ORIGIN}`);
    expect(policy).toContain(`img-src ${ORIGIN} data:`);
    expect(policy).not.toContain('fonts.googleapis.com');
    expect(policy).not.toContain('fonts.gstatic.com');
  });

  it('keeps inline styles working, because the report uses them', async () => {
    // The CAM day sheet sets its break rule inline and the hand-rolled SVG
    // charts carry inline geometry. Dropping 'unsafe-inline' from style-src
    // would render the report wrong, quietly.
    const { browser, result } = render();
    await result;
    expect(csp(browser.seen.document)).toMatch(/style-src [^;]*'unsafe-inline'/);
    // And it is granted to style-src ONLY.
    expect(csp(browser.seen.document)).not.toMatch(/script-src [^;]*'unsafe-inline'/);
  });
});

describe('making the built stylesheet self-contained', () => {
  it('points root-relative asset urls back at the deployment', () => {
    // The sheet is inlined, so its own URL is no longer there to resolve
    // `url(/assets/…)` against. Without this the fonts 404 and the report
    // repaginates — and that is no longer a hypothetical: Inter and Outfit ARE
    // `/assets/*.woff2` now, so this rewrite is on the pagination path.
    expect(absolutizeCssUrls('a{src:url(/assets/inter-latin-wght-normal-Dx4kXJAl.woff2)}', ORIGIN))
      .toBe(`a{src:url(${ORIGIN}/assets/inter-latin-wght-normal-Dx4kXJAl.woff2)}`);
    expect(absolutizeCssUrls('a{src:url("/assets/g.woff2")}', ORIGIN)).toBe(`a{src:url("${ORIGIN}/assets/g.woff2")}`);
  });

  it('leaves SVG fragment references alone, because the charts are drawn with them', () => {
    // `url(#clientPnlArea)` and `url(#clientPnlLine)` are in the built sheet and
    // fill the report's performance charts. Rewriting them would blank the
    // charts on every downloaded report.
    expect(absolutizeCssUrls('a{fill:url(#clientPnlArea)}', ORIGIN)).toBe('a{fill:url(#clientPnlArea)}');
  });

  it('leaves urls that are already absolute alone', () => {
    // The stylesheet no longer carries a Google Fonts `@import` — the fonts are
    // self-hosted — but only a SINGLE leading slash is rewritten, and that is
    // what keeps any absolute url that does appear from being mangled into
    // `https://cam.example.test/https://…`.
    const css = '@import url("https://fonts.googleapis.com/css2?family=Inter");';
    expect(absolutizeCssUrls(css, ORIGIN)).toBe(css);
    // Protocol-relative too: `url(//host/x)` is not a root-relative path.
    expect(absolutizeCssUrls('a{src:url(//cdn/x.woff2)}', ORIGIN)).toBe('a{src:url(//cdn/x.woff2)}');
  });
});

describe('finding this build\'s stylesheet', () => {
  it('reads the hashed href out of the deployment\'s own index.html', async () => {
    // Not a constant and not caller-supplied: vite rehashes the CSS whenever it
    // changes, so the only honest source is the index.html this build shipped.
    await expect(resolveReportStylesheets({ baseUrl: ORIGIN, fetchImpl: fetchStub() }))
      .resolves.toEqual([CSS_HREF]);
  });

  it('ignores links that are not stylesheets', async () => {
    const hrefs = await resolveReportStylesheets({ baseUrl: ORIGIN, fetchImpl: fetchStub() });
    expect(hrefs).not.toContain(`${ORIGIN}/favicon.svg`);
    expect(hrefs).toHaveLength(1);
  });

  it('refuses a stylesheet that is not the deployment\'s own', async () => {
    const index = '<link rel="stylesheet" href="https://evil.example/x.css">';
    await expect(resolveReportStylesheets({ baseUrl: ORIGIN, fetchImpl: fetchStub({ index }) }))
      .rejects.toThrow(/report_stylesheet_missing/);
  });

  it('fails loudly when index.html names no stylesheet at all', async () => {
    // The failure this catches is a report that renders UNSTYLED and paginates
    // differently, not one that errors. Silence here ships that to a client.
    await expect(resolveReportStylesheets({ baseUrl: ORIGIN, fetchImpl: fetchStub({ index: '<html></html>' }) }))
      .rejects.toThrow(/report_stylesheet_missing/);
  });

  it('fails loudly when the deployment cannot be reached', async () => {
    await expect(resolveReportStylesheets({ baseUrl: ORIGIN, fetchImpl: fetchStub({ indexStatus: 404 }) }))
      .rejects.toThrow(/report_assets_unreachable/);
    const thrower = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    await expect(resolveReportStylesheets({ baseUrl: ORIGIN, fetchImpl: thrower }))
      .rejects.toThrow(/report_assets_unreachable/);
  });

  it('refuses a base url that is not a bare origin', () => {
    // A path, a query or a fragment here would be silently concatenated into
    // the asset URLs. An empty one would fetch "/index.html" from nowhere.
    expect(() => normalizeBaseUrl('')).toThrow(/report_base_url_invalid/);
    expect(() => normalizeBaseUrl('https://cam.example.test/app')).toThrow(/report_base_url_invalid/);
    expect(() => normalizeBaseUrl('cam.example.test')).toThrow(/report_base_url_invalid/);
    expect(normalizeBaseUrl('https://cam.example.test/')).toBe(ORIGIN);
  });

  it('refetches index.html every time but reuses the hashed stylesheet', async () => {
    // index.html is not hashed, so a cached one names an asset that a redeploy
    // has already removed. The CSS URL carries its own content hash, so reusing
    // it can never serve the wrong bytes.
    clearReportStyleCache();
    const fetchImpl = fetchStub();
    await fetchReportStyles({ baseUrl: ORIGIN, fetchImpl });
    await fetchReportStyles({ baseUrl: ORIGIN, fetchImpl });
    const urls = fetchImpl.mock.calls.map(([url]) => String(url));
    expect(urls.filter((url) => url.endsWith('/index.html'))).toHaveLength(2);
    expect(urls.filter((url) => url === CSS_HREF)).toHaveLength(1);
  });

  it('fails loudly when the stylesheet itself does not come back', async () => {
    clearReportStyleCache();
    await expect(fetchReportStyles({ baseUrl: ORIGIN, fetchImpl: fetchStub({ cssStatus: 404 }) }))
      .rejects.toThrow(/report_stylesheet_missing/);
    clearReportStyleCache();
    await expect(fetchReportStyles({ baseUrl: ORIGIN, fetchImpl: fetchStub({ css: '   ' }) }))
      .rejects.toThrow(/report_stylesheet_missing/);
  });
});

describe('refusing to send paper that was laid out against missing assets', () => {
  it('accepts a page whose stylesheet parsed and whose fonts loaded', () => {
    expect(() => assertReportAssetsLoaded(healthyProbe, 1)).not.toThrow();
  });

  it('refuses a page whose stylesheet did not parse', () => {
    expect(() => assertReportAssetsLoaded({ ...healthyProbe, stylesheets: [] }, 1))
      .toThrow(/report_stylesheet_missing/);
    expect(() => assertReportAssetsLoaded({ ...healthyProbe, stylesheets: [0] }, 1))
      .toThrow(/report_stylesheet_missing/);
    // -1 is the "cross-origin, cannot be read" answer, which is not proof of
    // anything and must not be counted as success.
    expect(() => assertReportAssetsLoaded({ ...healthyProbe, stylesheets: [-1] }, 1))
      .toThrow(/report_stylesheet_missing/);
  });

  it('refuses a page whose fonts did not load, because that changes the page count', () => {
    // MEASURED on a real book report rendered through this module: with Inter
    // and Outfit loaded, Gray Birch's close is ONE sheet. With the font files
    // blocked it is TWO. Font availability is a pagination input, and an
    // unstyled render does not look broken enough for anyone to catch it before
    // it reaches a client. Self-hosting the families did not retire this check —
    // a woff2 that 404s after a bad deploy costs the same sheet Google's outage
    // would have.
    const noFonts = { stylesheets: [1493], fonts: REPORT_FONT_FAMILIES.map((family) => ({ family, loaded: 0, seen: 8 })) };
    expect(() => assertReportAssetsLoaded(noFonts, 1)).toThrow(/report_font_missing/);
    // One of the two is just as wrong as neither: Outfit sets every heading.
    const halfFonts = { stylesheets: [1493], fonts: [{ family: 'Inter Variable', loaded: 2 }, { family: 'Outfit Variable', loaded: 0 }] };
    expect(() => assertReportAssetsLoaded(halfFonts, 1)).toThrow(/report_font_missing: Outfit Variable/);
  });

  it('refuses a page that reported no font families at all', () => {
    // A probe that returned nothing must not read as "nothing was missing".
    expect(() => assertReportAssetsLoaded({ stylesheets: [1493], fonts: [] }, 1)).toThrow(/report_font_missing/);
  });

  it('asks the page about the fonts the report is actually set in', async () => {
    // The names the BROWSER reports, not the ones a reader would guess:
    // @fontsource-variable declares its faces as "Inter Variable" and "Outfit
    // Variable", and `document.fonts` is asked by family name. Probing for
    // "Inter" would fail every render as surely as probing for Geist would have
    // — src/index.css used to import @fontsource-variable/geist, whose five
    // @font-face rules no declaration in the sheet ever selected.
    const { browser, result } = render();
    await result;
    expect(browser.seen.probeArg).toEqual(['Inter Variable', 'Outfit Variable']);
  });
});

describe('the bytes that come back', () => {
  it('names the file the way the desk files it, in the body and in the header', async () => {
    const { result } = render();
    const { fileName, contentDisposition } = await result;
    expect(fileName).toBe('Wren Larch - 2026-08-24 daily report.pdf');
    expect(contentDisposition).toContain('filename="Wren Larch - 2026-08-24 daily report.pdf"');
  });

  it('refuses a report DOM larger than any real one', async () => {
    const { result } = render({ render: { html: 'x'.repeat(MAX_REPORT_HTML_BYTES + 1) } });
    await expect(result).rejects.toThrow(/report_html_too_large/);
  });

  it('refuses an empty report DOM rather than printing a blank sheet', async () => {
    await expect(render({ render: { html: '   ' } }).result).rejects.toThrow(/report_html_required/);
    await expect(render({ render: { html: undefined } }).result).rejects.toThrow(/report_html_required/);
  });

  it('refuses anything that is not a PDF', async () => {
    // A renderer that answered with an error page instead of paper would
    // otherwise be saved as "<Client> - <date> daily report.pdf" in the folder
    // the CAM distributes from.
    const browser = browserStub({ pdf: Buffer.from('<html>not paper</html>') });
    await expect(render({ browser }).result).rejects.toThrow(/report_render_failed/);
  });

  it('refuses a render that would not fit a single response', async () => {
    // server/export/clientExport.js documents the 4 MiB platform ceiling; one
    // report is ~4% of it, so this only ever fires on something pathological —
    // and when it does, a diagnosable 413 beats a truncated PDF.
    const browser = browserStub({ pdf: Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(MAX_REPORT_PDF_BYTES)]) });
    await expect(render({ browser }).result).rejects.toThrow(/report_pdf_too_large/);
  });
});

describe('the browser is never left running', () => {
  it('closes it after a successful render', async () => {
    const { browser, result } = render();
    await result;
    expect(browser.seen.closes).toBe(1);
    expect(browser.seen.pageCloses).toBe(1);
  });

  it('closes it when the render throws', async () => {
    // A serverless container is reused between invocations, so a leaked chromium
    // is the one failure here that gets worse the more the desk uses the feature.
    const browser = browserStub({ failAt: 'setContent' });
    await expect(render({ browser }).result).rejects.toThrow(/navigation blew up/);
    expect(browser.seen.closes).toBe(1);
  });

  it('closes it when the assets were missing', async () => {
    const browser = browserStub({ probe: { stylesheets: [], fonts: [] } });
    await expect(render({ browser }).result).rejects.toThrow(/report_stylesheet_missing/);
    expect(browser.seen.closes).toBe(1);
  });
});

describe('reportDocument on its own', () => {
  it('escapes the title rather than letting it close the tag', () => {
    const markup = reportDocument({ html: '<p>x</p>', title: '</title><script>alert(1)</script>', origin: ORIGIN });
    expect(markup).not.toContain('<script>alert(1)</script>');
    expect(markup).toContain('&lt;/title&gt;');
  });
});
