#!/usr/bin/env node
/**
 * House rule 1: verify by printing real output.
 *
 * There is no PDF generator in this repo. printWithTitle (App.jsx:1721) is
 * window.print() on the live report DOM, so "does the report use the page well"
 * is a question only paper can answer, and a print layout argued from CSS is how
 * this kind of change ships wrong. This script prints and measures.
 *
 * It runs two halves:
 *
 *   THE BOOK. Boots the CRM against public/local-snapshot.json, opens each
 *   listed client's close through the real UI, prints the live report DOM to PDF
 *   at US Letter with the 12mm margin @page asks for — the paper the desk
 *   actually uses, confirmed against the eleven reports it sent on 2026-08-21,
 *   every one of them 215.9 x 279.4mm and none of them A4 — and then measures
 *   where the ink landed. It fails on:
 *       * a sheet left more than 60mm blank while a later sheet still has content
 *       * a sheet whose only content is the footer line
 *       * a heading that renders under print media but is missing from the PDF
 *       * the editor chrome or the panel actions reaching the paper
 *
 *   THE BOUNDARY. Walks a section heading past the page boundary in 10px steps
 *   and asks, at each position, whether the break the browser chose is one a
 *   reader would have chosen: no heading alone at the foot of a sheet, no column
 *   header without a row under it, no table opening or closing on a single
 *   stranded row, no footer alone, and the repeated column headings present on
 *   the continuation. This half needs no book and is the one that catches a
 *   regression in the rules themselves.
 *
 *   node scripts/verify-report-print-layout.mjs [--keep] [--sweep-only]
 *
 * Requires the playwright dev dependency and a Chrome on the machine.
 * src/printLayout.test.js is the fast stylesheet-level guard for the same rules.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { readPrintedPages, pageSpace } from './lib/printedPage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(ROOT, '.print-layout-verify');
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

/** US Letter at 12mm, which is what the desk's dialog produces. */
const PAPER = {
  format: 'Letter',
  printBackground: true,
  margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' },
};
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

let ok = true;
function report(label, passed, extra = '') {
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!passed) ok = false;
  return passed;
}

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

/* ------------------------------------------------------------------ *
 * Half one: the book, through the real UI.
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
    captured[name] = await page.locator('.report-sheet').first().evaluate((node) => node.outerHTML);
    await page.locator('.report-close-button').click();
    await page.waitForTimeout(200);
  }
  return captured;
}

function writeHarness(captured) {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  for (const [name, html] of Object.entries(captured)) {
    fs.writeFileSync(path.join(WORK, `${slug(name)}.html`), `<!doctype html>
<html><head><meta charset="utf-8"><title>${name}</title></head>
<body><div class="report-overlay" id="root"></div>
<script type="module">
import '../src/index.css';
document.getElementById('root').innerHTML = ${JSON.stringify(html)};
window.__ready = true;
</script></body></html>`);
  }
}

async function measureBook(browser, port, captured) {
  console.log('\nTHE BOOK — every report printed to PDF at Letter/12mm');
  console.log('-'.repeat(78));
  console.log('  client            sheets   used/blank mm per sheet');
  let sheets = 0;
  let midReportBlank = 0;
  const offences = [];
  for (const name of Object.keys(captured)) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1400 } });
    await page.goto(`http://localhost:${port}/${path.basename(WORK)}/${slug(name)}.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
    await page.waitForTimeout(200);

    await page.emulateMedia({ media: 'print' });
    const onPaper = await page.evaluate(() => {
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
    await page.emulateMedia({ media: null });

    const pages = readPrintedPages(await page.pdf(PAPER)).map((sheet) => ({ ...pageSpace(sheet), text: sheet.text }));
    await page.close();

    sheets += pages.length;
    const printed = pages.map((sheet) => sheet.text).join(' ').replace(/\s+/g, '').toLowerCase();
    for (const heading of onPaper.headings) {
      if (!printed.includes(heading.replace(/\s+/g, '').toLowerCase())) {
        offences.push(`${name}: heading "${heading}" renders under print media but is not in the PDF`);
      }
    }
    if (onPaper.actions !== 'none') offences.push(`${name}: .report-actions reaches the paper`);
    if (onPaper.editor !== 'none' && onPaper.editor !== 'absent') offences.push(`${name}: the note editor reaches the paper`);

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

    console.log(`  ${name.padEnd(16)} ${String(pages.length).padStart(6)}   ${pages.map((s) => `${s.used.toFixed(0)}/${s.blank.toFixed(0)}`).join('  ')}`);
  }
  console.log('-'.repeat(78));
  console.log(`  ${sheets} sheets, ${midReportBlank.toFixed(0)}mm blank on sheets that still had content queued behind them`);
  for (const offence of offences) console.log(`  ! ${offence}`);
  report('no sheet is left substantially empty while content waits on the next', !offences.length, offences.length ? `${offences.length} offence(s)` : `${sheets} sheets`);
  report('the corpus wastes less than a sheet in total', midReportBlank <= ALLOWED_CORPUS_BLANK_MM,
    `${midReportBlank.toFixed(0)}mm of ${ALLOWED_CORPUS_BLANK_MM}mm budget, against 1,031mm before the change`);
}

/* ------------------------------------------------------------------ *
 * Half two: the page boundary, swept.
 * ------------------------------------------------------------------ */

const SWEEP_ROWS = 10;

function writeSweep() {
  fs.mkdirSync(WORK, { recursive: true });
  const rows = Array.from({ length: SWEEP_ROWS }, (_, i) => `<tr><td><strong>Rowmark${i + 1}</strong><br><small>a connection name</small></td><td>Active</td><td><small>Legends</small></td><td>$0</td><td>$0</td><td>-</td><td>$50,000</td></tr>`).join('');
  fs.writeFileSync(path.join(WORK, 'sweep.html'), `<!doctype html>
<html><head><meta charset="utf-8"><title>boundary sweep</title></head><body>
<div class="report-overlay"><div class="report-sheet">
<header class="report-header"><div><p class="report-firm">Vincere Trading</p><h1>Boundary sweep</h1></div></header>
<div id="spacer"></div>
<section class="report-section"><h2>Sweepsection</h2><table class="report-table">
<thead><tr><th>Account</th><th>Status</th><th>Strategies</th><th>Daily PnL</th><th>Weekly PnL</th><th>Drawdown</th><th>Balance</th></tr></thead>
<tbody>${rows}</tbody></table></section>
<footer class="report-footer"><span>Generated</span><span>Vincere Trading · Confidential</span></footer>
</div></div>
<script type="module">
import '../src/index.css';
// The spacer carries a rule at its foot so it leaves ink: a page whose content
// is an invisible box would measure as blank and the sweep would lie.
window.setSpacer = (px) => {
  const spacer = document.getElementById('spacer');
  spacer.style.height = px + 'px';
  spacer.style.borderBottom = '1px solid #333';
};
</script></body></html>`);
}

async function sweepBoundary(browser, port) {
  console.log('\nTHE BOUNDARY — a section heading walked past the page edge in 10px steps');
  console.log('-'.repeat(78));
  const page = await browser.newPage({ viewport: { width: 1200, height: 1400 } });
  await page.goto(`http://localhost:${port}/${path.basename(WORK)}/sweep.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.setSpacer === 'function', null, { timeout: 30000 });
  const offences = [];
  let positions = 0;
  for (let spacer = 500; spacer <= 880; spacer += 10) {
    await page.evaluate((px) => window.setSpacer(px), spacer);
    const sheets = readPrintedPages(await page.pdf(PAPER));
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
  await page.close();
  for (const offence of offences.slice(0, 12)) console.log(`  ! ${offence}`);
  if (offences.length > 12) console.log(`  ! ...and ${offences.length - 12} more`);
  report('every break the browser chooses is one a reader would choose', !offences.length, `${positions} boundary positions`);
}

/* ------------------------------------------------------------------ */

async function main() {
  const hasBook = fs.existsSync(SNAPSHOT);
  if (!hasBook && !SWEEP_ONLY) {
    console.log('  public/local-snapshot.json is absent, so the book half cannot run.');
    console.log('  Running the boundary sweep only, which needs no book.');
  }
  process.env.VITE_LOCAL_SNAPSHOT = '1';
  const server = await createServer({ root: ROOT, server: { port: 5195, strictPort: false }, logLevel: 'error' });
  await server.listen();
  const port = server.config.server.port || server.httpServer.address().port;
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    if (hasBook && !SWEEP_ONLY) {
      const app = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      app.on('pageerror', (error) => console.error('  [page error]', error.message));
      await app.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
      const captured = await captureReports(app);
      await app.close();
      report('opened every listed client through the real UI', Object.keys(captured).length === CLIENTS.length,
        `${Object.keys(captured).length}/${CLIENTS.length} on ${DATE}`);
      writeHarness(captured);
      await measureBook(browser, port, captured);
    }
    writeSweep();
    await sweepBoundary(browser, port);
  } finally {
    await browser.close();
    await server.close();
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
