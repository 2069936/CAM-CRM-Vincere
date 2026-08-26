// The two places the report's fonts are described, held in agreement.
//
// src/index.css imports Inter and Outfit from `@fontsource`, so they are served
// from the deployment's own /assets. server/report/reportPdf.js writes a CSP
// that lets the render document reach exactly that origin for fonts and nothing
// else. Neither statement is enough on its own, because of a third one that is
// easy to miss: a font fetch is ALWAYS CORS-mode, and the render document is
// built with setContent, which gives it an opaque origin. Its request for the
// deployment's own woff2 therefore leaves with `Origin: null` and needs
// `Access-Control-Allow-Origin` coming back — which fonts.gstatic.com always
// sent for free, and which a static host does not send by default.
//
// Measured with that header absent, through the shipped endpoint against a real
// build: all 13 book reports and all 39 boundary-sweep positions came back 502
// `report_font_missing`. Not a wrong layout — no layout at all. So the header is
// part of the render contract, and this file is what fails when vercel.json
// stops carrying it.
//
// scripts/verify-report-print-layout.mjs reads the same rule out of the same
// file to configure its own static host, so the verification cannot pass on a
// header production is not sending.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REPORT_FONT_FAMILIES, reportDocument } from '../../report/reportPdf.js';

const ORIGIN = 'https://cam.example.test';
const VERCEL = JSON.parse(readFileSync('vercel.json', 'utf8'));
const CSS = readFileSync('src/index.css', 'utf8');
/** The same sheet with its comments removed — the comments TALK about Google. */
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** The vercel.json header rule that covers the built font files. */
const fontRule = () => (VERCEL.headers || []).find((rule) => /woff2/.test(rule.source || ''));

describe('the deployment can actually serve the render document its fonts', () => {
  it('sends Access-Control-Allow-Origin on the built woff2 files', () => {
    const rule = fontRule();
    expect(rule).toBeDefined();
    expect(rule.source).toBe('/assets/(.*).woff2');
    const allow = rule.headers.find((header) => header.key.toLowerCase() === 'access-control-allow-origin');
    // `*` and not the deployment's own origin: the document asking is opaque, so
    // it sends `Origin: null` and an origin-specific value would never match it.
    expect(allow?.value).toBe('*');
  });

  it('points font-src at the deployment, which is where those files are', () => {
    const csp = /content="([^"]*)"/.exec(reportDocument({ html: '<p>x</p>', title: 't', origin: ORIGIN }))[1];
    expect(csp).toContain(`font-src ${ORIGIN}`);
    // The CSP and the header are two different gates and the fonts need both.
    // Google's two origins are through neither of them any more.
    expect(csp).not.toContain('fonts.gstatic.com');
    expect(csp).not.toContain('fonts.googleapis.com');
  });
});

describe('the stylesheet asks for the families the endpoint checks for', () => {
  it('self-hosts both, and reaches no third party for them', () => {
    expect(CSS).toContain('@import "@fontsource-variable/inter/wght.css"');
    expect(CSS).toContain('@import "@fontsource-variable/outfit/wght.css"');
    // The `@import url("https://fonts.googleapis.com/…")` that used to be
    // src/index.css:1 is what made a third party a runtime dependency of the PDF
    // endpoint. A stylesheet that reaches Google again would render fine and put
    // it straight back on the render path, so its absence is asserted here
    // rather than left to be noticed.
    expect(RULES).not.toContain('fonts.googleapis.com');
    expect(RULES).not.toContain('fonts.gstatic.com');
  });

  it('is set in the families REPORT_FONT_FAMILIES names, under the names @fontsource declares', () => {
    // The endpoint asks `document.fonts` by family NAME, and @fontsource-variable
    // declares its faces as "Inter Variable" / "Outfit Variable". Probing for
    // "Inter" would refuse every render even though the paper was perfect.
    expect(REPORT_FONT_FAMILIES).toEqual(['Inter Variable', 'Outfit Variable']);
    for (const family of REPORT_FONT_FAMILIES) {
      expect(CSS).toContain(`"${family}"`);
    }
  });

  it('ships no font it does not set anything in', () => {
    // @fontsource-variable/geist sat in this import list declaring five faces
    // that no declaration selected — "Geist Variable" appeared in five
    // @font-face rules and in zero uses — and 76.4 KB of woff2 shipped on every
    // build for it.
    expect(RULES).not.toContain('geist');
    expect(RULES).not.toContain('Geist');
  });
});
