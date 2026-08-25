#!/usr/bin/env node
/**
 * House rule 1: verify by printing real output.
 *
 * A client's report reaches them two ways. `printWithTitle`
 * (src/domain/reportPrint.js) is window.print() on the live report DOM, and the
 * Download button posts that same DOM to /api/report/pdf, where a headless
 * Chrome loads it against this build's own stylesheet and prints it at the same
 * Letter/12mm. Both are the same stylesheet and the same fragmentation engine,
 * which is the entire reason the download route was chosen over a client-side
 * rasteriser or a second vector renderer. "Does the report use the page well" is
 * still a question only paper can answer, so this script produces paper and
 * measures it.
 *
 * WHAT CHANGED WHEN THE DOWNLOAD SHIPPED. This script used to print the report
 * in a local harness of its own. It now drives THE ENDPOINT, over HTTP, and
 * measures the bytes that come back — so the pinned 18 sheets, the 208mm of
 * mid-report blank and the 39-of-39 clean boundary positions are assertions
 * about the file the client actually receives, not about a lookalike. It also
 * checks the name on the response, because the file name is half of what the
 * CAM asked for.
 *
 * It runs four halves:
 *
 *   THE BOOK. Boots the CRM against public/local-snapshot.json, opens each
 *   listed client's close through the real UI, captures the live `.report-sheet`
 *   exactly as the Download button would send it, POSTs it to the endpoint and
 *   measures where the ink landed on the PDF that comes back. It fails on:
 *       * a sheet left more than 75mm blank while a later sheet still has content
 *       * a sheet whose only content is the footer line
 *       * a heading that renders under print media but is missing from the PDF
 *       * the editor chrome or the panel actions reaching the paper — checked
 *         BOTH by computed style and by looking for the button labels in the
 *         text of the delivered PDF
 *       * a Content-Disposition that does not name the file the way the desk
 *         files it
 *
 *   THE BOUNDARY. Walks a section heading past the page boundary in 10px steps
 *   and asks, at each position, whether the break the browser chose is one a
 *   reader would have chosen: no heading alone at the foot of a sheet, no column
 *   header without a row under it, no table opening or closing on a single
 *   stranded row, no footer alone, and the repeated column headings present on
 *   the continuation. This half needs no book and is the one that catches a
 *   regression in the rules themselves.
 *
 *   THE FONT GUARD. Renders one report with the deployment's own woff2 files
 *   blocked and requires the endpoint to REFUSE it. This is not defensive
 *   coding: measured here, a real book client's close is one sheet with Inter
 *   and Outfit loaded and TWO sheets without them. Font availability is a
 *   pagination input, and an unstyled render does not look broken enough for
 *   anyone to catch it before it reaches a client. It blocks the DEPLOYMENT's
 *   font URLs because that is where the two families live now — they were
 *   `@import`ed from fonts.googleapis.com until self-hosting them through
 *   `@fontsource` took Google off the render path — so this half also fails if a
 *   third-party origin ever creeps back onto it.
 *
 *   THE NAME. Asserts the endpoint's Content-Disposition survives a client name
 *   that is not ASCII. Real names on this book include Muñoz, Bałka and Şahin,
 *   and an HTTP header is latin-1 at best.
 *
 *   node scripts/verify-report-print-layout.mjs [--keep] [--sweep-only]
 *
 * IT RUNS `vite build` AND OVERWRITES dist/. That is deliberate: the endpoint
 * resolves the content-hashed /assets/index-<hash>.css out of the deployment's
 * own index.html, so the only way to measure the real thing is to serve a real
 * build. dist/ is git-ignored and the deploy rebuilds it anyway.
 *
 * Requires the playwright dev dependency and a Chrome on the machine. It does
 * NOT require @sparticuz/chromium: the endpoint's browser launcher is injected,
 * so this drives the shipped handler with a local Chrome.
 * src/printLayout.test.js is the fast stylesheet-level guard for the same rules.
 */

import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import http from 'node:http';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, createServer } from 'vite';
import { chromium } from 'playwright';
import { getTransformedRoutes } from '@vercel/routing-utils';
import { readPrintedPages, pageSpace } from './lib/printedPage.mjs';
import { createHandler } from '../api/report/pdf.js';
import { REPORT_VIEWPORT } from '../server/report/reportPdf.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(ROOT, '.print-layout-verify');
const DIST = path.join(ROOT, 'dist');
const KEEP = process.argv.includes('--keep');
const SWEEP_ONLY = process.argv.includes('--sweep-only');
const SNAPSHOT = path.join(ROOT, 'public', 'local-snapshot.json');

/** The last close every book client shares, so one date covers the whole set. */
const DATE = process.env.VERIFY_REPORT_DATE || '2026-07-30';
/**
 * Thirteen clients, chosen because between them they cover every shape the
 * report takes: one pool and two pools and three, two account rows and
 * nineteen, reports that fit on a sheet and reports that cannot.
 */
const CLIENTS = (process.env.VERIFY_REPORT_CLIENTS || [
  'Gray Birch', 'Sage Birch', 'Gray Elm', 'Indigo Hollow', 'Jordan Larch',
  'Ellis Pine', 'Oakley Pine', 'Indigo Cedar', 'Gray North', 'Ellis Onyx',
  'Harper Juniper', 'Wren Larch', 'Reese Knoll',
].join('|')).split('|');

/**
 * How empty a sheet may be left with content still queued behind it.
 *
 * Not zero, and the number is not a fudge. Some blocks travel together on
 * purpose: a section heading, its column headings, the first two body rows
 * (which are tied so a table never opens or closes on one stranded line) and,
 * where it follows them, the footer. Measured at print width that group runs to
 * about 65mm when the rows wrap to two lines, and up to about 72mm when they
 * wrap to three, so a sheet cannot always be filled closer than that without
 * splitting something a reader would not split.
 *
 * One book client sits right on it. Jordan Larch's close is 268mm of content on
 * a 255mm sheet, so it is two sheets whatever the rules say; the last section is
 * two rows and the footer follows it, and that group cannot fit the 63mm left at
 * the foot of sheet one. Letting the footer break away instead fills sheet one
 * to 249mm — and gives the client a second sheet holding one line of footer,
 * which is the other half of the complaint this change exists for. 63mm of paper
 * is the price of never sending that sheet, and it is worth paying.
 */
const ALLOWED_MID_REPORT_BLANK_MM = 75;
/**
 * The whole corpus's budget. 13 book clients wasted 1,031mm across sheets that
 * still had content queued before this change and 208mm after; anything much
 * over a sheet's worth means a rule has come loose.
 */
const ALLOWED_CORPUS_BLANK_MM = 300;

/**
 * Chrome on the paper, in text, that would mean the print contract has slipped.
 *
 * These are the labels of controls that live inside `.report-actions.no-print`
 * and `.report-note-editor.no-print`. They travel up to the endpoint inside the
 * report DOM ON PURPOSE — the whole reason this route was chosen is that the
 * `@media print` blocks, and not a second hand-maintained copy of them, decide
 * what reaches the paper — so finding one of them in the delivered PDF is the
 * exact failure the rasteriser route was rejected for.
 */
const CHROME_ON_PAPER = [
  'Download PDF',
  'Start from the generated message',
  'Save note',
  'Done designing',
];

let ok = true;
function report(label, passed, extra = '') {
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!passed) ok = false;
  return passed;
}

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

/* ------------------------------------------------------------------ *
 * The deployment, as the endpoint will see it.
 * ------------------------------------------------------------------ */

/**
 * `vercel.json`'s header rules, compiled by the router Vercel itself compiles
 * them with.
 *
 * WHY THE REAL COMPILER AND NOT A `path.extname(file) === '.woff2'` CHECK, which
 * is what this stood on until it was reviewed. The whole Download button now
 * rests on ONE line of deployment config matching the built font paths, and a
 * host that decided for itself which files are fonts would have passed
 * identically had that line read `/fonts/(.*).woff2` — it validated the header's
 * VALUE and never the `source` that carries it. The rule turned out to be
 * right, but nothing here had measured it, and nobody on this desk can deploy a
 * fix if it is ever wrong.
 *
 * `getTransformedRoutes` is Vercel's own `@vercel/routing-utils`, the code that
 * turns a `vercel.json` into the route table the platform runs. Feeding it this
 * repo's actual file yields
 * `{"src":"^/assets(?:/(.*))\\.woff2$","continue":true}` — a literal `.`, an
 * anchored suffix, case-sensitive — and every request below is matched against
 * that, so this host answers exactly what production answers.
 */
const VERCEL_HEADER_ROUTES = (() => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const { routes, error } = getTransformedRoutes(config);
  if (error) throw new Error(`vercel.json does not compile: ${error.message}`);
  return (routes || [])
    .filter((route) => route.headers && route.src)
    .map((route) => ({ pattern: new RegExp(route.src), headers: route.headers }));
})();

/** Every header the deployment would put on this path. */
function deploymentHeadersFor(pathname) {
  const out = {};
  for (const route of VERCEL_HEADER_ROUTES) {
    if (route.pattern.test(pathname)) Object.assign(out, route.headers);
  }
  return out;
}

// A woff2 that the compiled rule does NOT cover cannot be served with the header
// by any accident of this script, so fail loudly here rather than at render time
// with a 502 nobody can trace back to a routing pattern.
{
  const fonts = fs.existsSync(path.join(DIST, 'assets'))
    ? fs.readdirSync(path.join(DIST, 'assets')).filter((name) => name.endsWith('.woff2'))
    : [];
  const uncovered = fonts.filter(
    (name) => !deploymentHeadersFor(`/assets/${name}`)['Access-Control-Allow-Origin'],
  );
  if (fonts.length && uncovered.length) {
    throw new Error(
      `vercel.json does not send Access-Control-Allow-Origin on ${uncovered.length} of ${fonts.length} `
      + `built font files (${uncovered.join(', ')}). The render document has an opaque origin, so it `
      + 'asks for these with `Origin: null` and every report would come back 502 report_font_missing.',
    );
  }
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

/**
 * A plain static host over dist/, serving what the deployment serves.
 *
 * Not the vite dev server: dev serves a `.css` request through its own
 * transform pipeline, and the thing being verified is the BUILT stylesheet at
 * the content-hashed URL the endpoint will actually resolve in production.
 *
 * IT SENDS `Access-Control-Allow-Origin: *` ON THE FONTS, because Vercel does —
 * and it decides which paths get it by compiling `vercel.json` through Vercel's
 * own router (see VERCEL_HEADER_ROUTES), not by deciding for itself what a font
 * is. server/tests/report/reportFontOrigin.test.js holds the same two statements
 * together from the other side. This is not a convenience. A font fetch is always
 * CORS-mode, and the render document the endpoint builds with setContent has an
 * OPAQUE origin, so its request for the deployment's own woff2 arrives with
 * `Origin: null` and is refused without that header. Measured, on this exact
 * corpus, with the header absent: every one of the 13 reports and all 39 sweep
 * positions came back 502 report_font_missing. Serving the fonts here without it
 * would make this script pass or fail for reasons production does not share.
 */
async function startAssetServer() {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://assets.local').pathname;
    const file = path.join(DIST, pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
    if (!file.startsWith(DIST) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    const headers = {
      'Content-Type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream',
      ...deploymentHeadersFor(pathname),
    };
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

/**
 * The shipped handler, mounted on a real socket.
 *
 * Two things are injected and nothing else is: authorization (there is no
 * Supabase here) and the browser launcher (a local Chrome instead of
 * @sparticuz/chromium, so this script does not need a 76 MB dependency to
 * measure the route). Everything the layout depends on — the render document,
 * the CSP, the asset resolution, the font check, the paper, the file name — is
 * the production code path.
 *
 * The launcher hands out a fresh browser CONTEXT rather than a fresh browser
 * process. Process launch is not what this script measures, and 52 of them would
 * add a minute of nothing; the isolation that matters (a clean page, a clean
 * cache, the pinned viewport) is what a context gives.
 */
async function startReportEndpoint({ assetOrigin, browser, blockFonts = false }) {
  const launchBrowser = async () => {
    const context = await browser.newContext({ viewport: { ...REPORT_VIEWPORT } });
    if (blockFonts) {
      // The stylesheet itself is deliberately left reachable: blocking the whole
      // asset origin would trip report_stylesheet_missing first and this half
      // would stop testing what it claims to test.
      await context.route(`${assetOrigin}/assets/*.woff2`, (route) => route.abort());
    }
    return { newPage: () => context.newPage(), close: () => context.close() };
  };
  const handler = createHandler({
    createClients: () => ({ admin: {}, auth: {} }),
    authorize: async () => ({ id: 'verify', role: 'Manager', status: 'Active' }),
    launchBrowser,
    env: { REPORT_PDF_BASE_URL: assetOrigin },
  });
  const server = http.createServer((req, res) => {
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); return res; };
    res.send = (body) => { res.end(body); return res; };
    handler(req, res).catch((error) => {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(error?.message || error) }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

/** One report, through the endpoint, exactly as the Download button sends it. */
async function requestReportPdf(endpoint, { html, title }) {
  const response = await fetch(`${endpoint}/api/report/pdf`, {
    method: 'POST',
    headers: { Authorization: 'Bearer verify', 'Content-Type': 'application/json' },
    body: JSON.stringify({ html, title }),
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    contentType: response.headers.get('content-type') || '',
    disposition: response.headers.get('content-disposition') || '',
    bytes: buffer,
    error: response.ok ? '' : buffer.toString('utf8').slice(0, 300),
  };
}

/* ------------------------------------------------------------------ *
 * Half one: the book, through the real UI and then the real endpoint.
 * ------------------------------------------------------------------ */

async function captureReports(page) {
  const captured = {};
  await page.waitForSelector('.client-search', { timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('.client-link').length > 5, null, { timeout: 60000 });
  for (const name of CLIENTS) {
    await page.fill('.client-search', '');
    await page.fill('.client-search', name);
    await page.waitForSelector('.client-link-search', { timeout: 15000 });
    const hits = page.locator('.client-link-search');
    let index = -1;
    for (let i = 0; i < await hits.count(); i += 1) {
      if ((await hits.nth(i).innerText()).split('\n')[0].trim() === name) { index = i; break; }
    }
    if (index < 0) { report(`found ${name} in the book`, false); continue; }
    await hits.nth(index).click();
    await page.waitForSelector('.workspace-open-button', { timeout: 20000 });
    await page.locator('input[type="date"]').first().fill(DATE);
    await page.waitForTimeout(400);
    const open = page.locator('.workspace-open-button');
    if (await open.isDisabled()) { report(`${name} has a close on ${DATE}`, false); continue; }
    await open.click();
    await page.waitForSelector('.report-sheet', { timeout: 20000 });
    await page.waitForTimeout(500);
    // outerHTML of the live sheet: byte for byte what
    // src/domain/reportPdfDownload.js sends.
    captured[name] = await page.locator('.report-sheet').first().evaluate((node) => node.outerHTML);
    await page.locator('.report-close-button').click();
    await page.waitForTimeout(200);
  }
  return captured;
}

/**
 * What renders under print media, asked of a page rather than of a PDF.
 *
 * Kept as a separate probe because the PDF cannot answer it: "this heading is
 * visible under print media" is a statement about the DOM, and comparing it with
 * what came out of the endpoint is what catches a heading that the stylesheet
 * shows and the paper loses.
 */
async function probePrintMedia(browser, assetOrigin, css, html) {
  const page = await browser.newPage({ viewport: { ...REPORT_VIEWPORT } });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${assetOrigin}${css}"></head>
<body><div class="report-overlay">${html}</div></body></html>`, { waitUntil: 'load' });
  await page.emulateMedia({ media: 'print' });
  const seen = await page.evaluate(() => {
    const shown = (selector) => {
      const node = document.querySelector(selector);
      return node ? getComputedStyle(node).display : 'absent';
    };
    return {
      headings: [...document.querySelectorAll('.report-sheet h1, .report-sheet h2')]
        .filter((node) => getComputedStyle(node).display !== 'none'
          && getComputedStyle(node.closest('section, header, footer') || node).display !== 'none')
        .map((node) => node.innerText.replace(/\s+/g, ' ').trim()),
      actions: shown('.report-actions'),
      editor: shown('.report-note-editor'),
    };
  });
  await page.close();
  return seen;
}

async function measureBook(browser, endpoint, assetOrigin, cssPath, captured) {
  console.log('\nTHE BOOK — every report through /api/report/pdf at Letter/12mm');
  console.log('-'.repeat(78));
  console.log('  client            sheets   KB    used/blank mm per sheet');
  let sheets = 0;
  let midReportBlank = 0;
  let totalBytes = 0;
  const offences = [];
  for (const [name, html] of Object.entries(captured)) {
    const title = `${name} - ${DATE} daily report`;
    const onPaper = await probePrintMedia(browser, assetOrigin, cssPath, html);
    const answer = await requestReportPdf(endpoint, { html, title });

    if (answer.status !== 200) {
      report(`${name} rendered`, false, `${answer.status} ${answer.error}`);
      continue;
    }
    if (!answer.contentType.startsWith('application/pdf')) {
      offences.push(`${name}: the endpoint answered ${answer.contentType || '(no content type)'}`);
    }
    // The file name is half of what the CAM asked for: today the eleven reports
    // land in whichever folder the dialog last pointed at, under whatever the
    // title happened to be.
    if (!answer.disposition.includes(`filename="${title}.pdf"`)) {
      offences.push(`${name}: Content-Disposition is "${answer.disposition}", not the name the desk files by`);
    }

    if (KEEP) fs.writeFileSync(path.join(WORK, `${slug(name)}.pdf`), answer.bytes);
    totalBytes += answer.bytes.length;

    const pages = readPrintedPages(answer.bytes).map((sheet) => ({ ...pageSpace(sheet), text: sheet.text }));
    sheets += pages.length;
    const printed = pages.map((sheet) => sheet.text).join(' ');
    const squashed = printed.replace(/\s+/g, '').toLowerCase();
    for (const heading of onPaper.headings) {
      if (!squashed.includes(heading.replace(/\s+/g, '').toLowerCase())) {
        offences.push(`${name}: heading "${heading}" renders under print media but is not in the PDF`);
      }
    }
    if (onPaper.actions !== 'none') offences.push(`${name}: .report-actions reaches the paper`);
    if (onPaper.editor !== 'none' && onPaper.editor !== 'absent') offences.push(`${name}: the note editor reaches the paper`);
    // The same question, asked of the delivered bytes rather than of a
    // stylesheet. This is the one the client would have noticed.
    for (const label of CHROME_ON_PAPER) {
      if (printed.includes(label)) offences.push(`${name}: "${label}" is in the delivered PDF`);
    }

    pages.forEach((sheet, index) => {
      if (index === pages.length - 1) return;
      midReportBlank += sheet.blank;
      if (sheet.blank > ALLOWED_MID_REPORT_BLANK_MM) {
        offences.push(`${name}: sheet ${index + 1} of ${pages.length} left ${sheet.blank.toFixed(0)}mm blank with content still queued`);
      }
    });
    const last = pages[pages.length - 1];
    if (pages.length > 1 && last.used < 20) {
      offences.push(`${name}: the last sheet holds ${last.used.toFixed(0)}mm of ink and nothing else`);
    }

    console.log(`  ${name.padEnd(16)} ${String(pages.length).padStart(6)} ${(answer.bytes.length / 1024).toFixed(0).padStart(5)}    ${pages.map((s) => `${s.used.toFixed(0)}/${s.blank.toFixed(0)}`).join('  ')}`);
  }
  console.log('-'.repeat(78));
  const count = Object.keys(captured).length;
  console.log(`  ${sheets} sheets, ${midReportBlank.toFixed(0)}mm blank on sheets that still had content queued behind them`);
  console.log(`  ${(totalBytes / 1024).toFixed(0)} KB delivered, mean ${(totalBytes / 1024 / (count || 1)).toFixed(1)} KB a report`);
  for (const offence of offences) console.log(`  ! ${offence}`);
  report('no sheet is left substantially empty while content waits on the next', !offences.length, offences.length ? `${offences.length} offence(s)` : `${sheets} sheets`);
  report('the corpus wastes less than a sheet in total', midReportBlank <= ALLOWED_CORPUS_BLANK_MM,
    `${midReportBlank.toFixed(0)}mm of ${ALLOWED_CORPUS_BLANK_MM}mm budget, against 1,031mm before the change`);
}

/* ------------------------------------------------------------------ *
 * Half two: the page boundary, swept.
 * ------------------------------------------------------------------ */

const SWEEP_ROWS = 10;

/**
 * One `.report-sheet` with a spacer of a given height in front of the section.
 *
 * Built as a string rather than mutated in a live page, because the endpoint
 * takes markup: the sweep now walks the boundary through the same route a
 * client's report takes. The spacer carries a rule at its foot so it leaves
 * ink — a page whose content is an invisible box would measure as blank and the
 * sweep would lie.
 */
function sweepSheet(spacerPx) {
  const rows = Array.from({ length: SWEEP_ROWS }, (_, i) => `<tr><td><strong>Rowmark${i + 1}</strong><br><small>a connection name</small></td><td>Active</td><td><small>Legends</small></td><td>$0</td><td>$0</td><td>-</td><td>$50,000</td></tr>`).join('');
  return `<div class="report-sheet">
<header class="report-header"><div><p class="report-firm">Vincere Trading</p><h1>Boundary sweep</h1></div></header>
<div id="spacer" style="height:${spacerPx}px;border-bottom:1px solid #333"></div>
<section class="report-section"><h2>Sweepsection</h2><table class="report-table">
<thead><tr><th>Account</th><th>Status</th><th>Strategies</th><th>Daily PnL</th><th>Weekly PnL</th><th>Drawdown</th><th>Balance</th></tr></thead>
<tbody>${rows}</tbody></table></section>
<footer class="report-footer"><span>Generated</span><span>Vincere Trading · Confidential</span></footer>
</div>`;
}

async function sweepBoundary(endpoint) {
  console.log('\nTHE BOUNDARY — a section heading walked past the page edge in 10px steps');
  console.log('-'.repeat(78));
  const offences = [];
  let positions = 0;
  for (let spacer = 500; spacer <= 880; spacer += 10) {
    const answer = await requestReportPdf(endpoint, {
      html: sweepSheet(spacer),
      title: `Boundary sweep ${spacer}`,
    });
    if (answer.status !== 200) {
      offences.push(`spacer ${spacer}px: the endpoint answered ${answer.status} ${answer.error}`);
      positions += 1;
      continue;
    }
    const sheets = readPrintedPages(answer.bytes);
    positions += 1;
    const rowsOn = (text) => (text.match(/Rowmark/g) || []).length;
    const first = sheets[0];
    const last = sheets[sheets.length - 1];
    const headingOnFirst = /sweepsection/i.test(first.text);
    const headerOnFirst = /drawdown/i.test(first.text);
    const flags = [];
    if (headingOnFirst && rowsOn(first.text) === 0) flags.push('a heading alone at the foot of the sheet');
    if (headerOnFirst && rowsOn(first.text) === 0) flags.push('column headings with no row under them');
    if (sheets.length > 1 && rowsOn(first.text) === 1) flags.push('a table opening on one stranded row');
    if (sheets.length > 1 && rowsOn(last.text) === 1) flags.push('a table closing on one stranded row');
    if (sheets.length > 1 && rowsOn(last.text) === 0 && /confidential/i.test(last.text)) flags.push('a sheet holding the footer and nothing else');
    if (sheets.length > 1 && rowsOn(sheets[1].text) > 0 && !/drawdown/i.test(sheets[1].text)) flags.push('a continued table with no repeated column headings');
    const midBlank = sheets.slice(0, -1).map((sheet) => pageSpace(sheet).blank);
    const worst = midBlank.length ? Math.max(...midBlank) : 0;
    if (worst > ALLOWED_MID_REPORT_BLANK_MM) flags.push(`${worst.toFixed(0)}mm of the sheet left blank with content queued`);
    for (const flag of flags) offences.push(`spacer ${spacer}px: ${flag}`);
  }
  for (const offence of offences.slice(0, 12)) console.log(`  ! ${offence}`);
  if (offences.length > 12) console.log(`  ! ...and ${offences.length - 12} more`);
  report('every break the browser chooses is one a reader would choose', !offences.length, `${positions} boundary positions`);
}

/* ------------------------------------------------------------------ *
 * Half three: the fonts, and half four: the name.
 * ------------------------------------------------------------------ */

/**
 * The endpoint must REFUSE to render against fonts that did not arrive.
 *
 * Measured on this corpus: Gray Birch's close is one sheet with Inter and
 * Outfit loaded and two sheets without them. A silent fallback would post a
 * client a report paginated unlike every report they have received, and nothing
 * about it would look wrong enough to catch.
 *
 * Self-hosting the two families did not retire this. It changed what the failure
 * looks like — a woff2 that 404s after a bad deploy rather than a Google origin
 * the deployment cannot reach — and it costs the client the same extra sheet.
 */
async function verifyFontGuard(endpoint) {
  console.log('\nTHE FONT GUARD — a render with the deployment\'s own font files blocked');
  console.log('-'.repeat(78));
  const answer = await requestReportPdf(endpoint, { html: sweepSheet(200), title: 'Font guard - 2026-08-24 daily report' });
  console.log(`  the endpoint answered ${answer.status}: ${answer.error.slice(0, 120)}`);
  report('a report whose fonts did not load is refused, not sent', answer.status === 502 && /report_font_missing/.test(answer.error),
    'font availability is a pagination input');
}

async function verifyName(endpoint) {
  console.log('\nTHE NAME — the file the desk files by');
  console.log('-'.repeat(78));
  const title = 'Ayşe Şahin - 2026-08-24 daily report';
  const answer = await requestReportPdf(endpoint, { html: sweepSheet(120), title });
  const extended = /filename\*=UTF-8''(\S+)/.exec(answer.disposition)?.[1] || '';
  console.log(`  ${answer.disposition}`);
  report('a non-ASCII client name survives the header intact', decodeURIComponent(extended) === `${title}.pdf`,
    'HTTP header values are latin-1 at best; Node throws on U+015F');
  report('the response asks the browser to save rather than display', /^attachment;/.test(answer.disposition));
}

/* ------------------------------------------------------------------ */

async function main() {
  const hasBook = fs.existsSync(SNAPSHOT);
  if (!hasBook && !SWEEP_ONLY) {
    console.log('  public/local-snapshot.json is absent, so the book half cannot run.');
    console.log('  Running the boundary sweep only, which needs no book.');
  }
  const runBook = hasBook && !SWEEP_ONLY;

  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  let captured = {};
  if (runBook) {
    process.env.VITE_LOCAL_SNAPSHOT = '1';
    const dev = await createServer({ root: ROOT, server: { port: 5195, strictPort: false }, logLevel: 'error' });
    await dev.listen();
    const devPort = dev.config.server.port || dev.httpServer.address().port;
    const devBrowser = await chromium.launch({ channel: 'chrome' });
    try {
      const app = await devBrowser.newPage({ viewport: { width: 1440, height: 1000 } });
      app.on('pageerror', (error) => console.error('  [page error]', error.message));
      await app.goto(`http://localhost:${devPort}/`, { waitUntil: 'load' });
      captured = await captureReports(app);
      await app.close();
    } finally {
      await devBrowser.close();
      await dev.close();
    }
    report('opened every listed client through the real UI', Object.keys(captured).length === CLIENTS.length,
      `${Object.keys(captured).length}/${CLIENTS.length} on ${DATE}`);
    if (KEEP) {
      for (const [name, html] of Object.entries(captured)) {
        fs.writeFileSync(path.join(WORK, `${slug(name)}.html`), html);
      }
    }
  }

  // The endpoint resolves the content-hashed stylesheet out of the deployment's
  // own index.html, so the deployment has to be real.
  console.log('\nbuilding dist/ so the endpoint can resolve this build\'s own assets...');
  await build({ root: ROOT, logLevel: 'error' });
  const cssPath = (/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/.exec(fs.readFileSync(path.join(DIST, 'index.html'), 'utf8')) || [])[1];
  if (!cssPath) throw new Error('dist/index.html links no stylesheet');
  console.log(`  serving dist/, stylesheet ${cssPath}`);

  const assets = await startAssetServer();
  const browser = await chromium.launch({ channel: 'chrome' });
  const endpoint = await startReportEndpoint({ assetOrigin: assets.origin, browser });
  const blocked = await startReportEndpoint({ assetOrigin: assets.origin, browser, blockFonts: true });
  try {
    if (runBook) await measureBook(browser, endpoint.origin, assets.origin, cssPath, captured);
    await sweepBoundary(endpoint.origin);
    await verifyFontGuard(blocked.origin);
    await verifyName(endpoint.origin);
  } finally {
    endpoint.server.close();
    blocked.server.close();
    assets.server.close();
    await browser.close();
    if (!KEEP) fs.rmSync(WORK, { recursive: true, force: true });
    else console.log(`\nkept ${WORK}`);
  }
  console.log(ok ? '\nALL CHECKS PASSED' : '\nCHECKS FAILED');
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  fs.rmSync(WORK, { recursive: true, force: true });
  process.exit(1);
});
