#!/usr/bin/env node
/**
 * House rule 1: verify by printing real output.
 *
 * This drives the two new report sections in a REAL browser, through the app's
 * own module graph, over a REAL client's four NinjaTrader CSVs, and then prints
 * the page to PDF through the same path the desk uses — printWithTitle()
 * (App.jsx:1721) is nothing but window.print() on the live report DOM, which is
 * why every one of the 11 real PDFs in the export folder carries Chrome's own
 * print header in its text stream.
 *
 * It answers three questions that no unit test can:
 *
 *   1. Does the note SURVIVE A REOPEN? The component is unmounted, a blank
 *      `reports` row is inserted the way ReportPanel's mount effect does, and
 *      the component is mounted again. The text has to come back out of the
 *      store, not out of React state.
 *   2. Is the note IN THE PDF? The PDF is generated and its text extracted, and
 *      the sentence has to be in there.
 *   3. Is the EDITOR out of the PDF? The textarea, the Save button and the
 *      status pill must not be.
 *
 *   node scripts/verify-report-note-print.mjs [--keep]
 *
 * Requires the playwright dev dependency and a Chrome on the machine.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(ROOT, '.report-verify');
const KEEP = process.argv.includes('--keep');

// Daniel Swanson, 2026-08-11: the close this whole feature was written for.
// 5 accounts, 2 orders, 0 executions, $0 realized, and both orders refused.
const SOURCE = process.env.VERIFY_CLIENT_DIR
  || '/Users/pedro/Desktop/PEDRO/Trabajo/untitled folder/untitled folder 3';
const DATE = '2026-08-11';
const NOTE = 'Both orders sent today were refused by the platform, so no positions were opened. '
  + 'The two Legends accounts are past their trailing drawdown and I have paused new entries on them. '
  + 'Nothing else changed on the account.';

/* ------------------------------------------------------------------ *
 * How "does it print" is actually checked, and why not by reading the PDF.
 *
 * The obvious check is to generate the PDF and grep its text. That works on the
 * 11 real PDFs in the export folder — they extract cleanly, 742 characters for
 * Daniel Swanson's — because they were printed from Chrome's own print dialog,
 * which embeds fonts and emits Tj/TJ text operators.
 *
 * Chrome's CDP printToPDF, which is what playwright's page.pdf() drives, does
 * not do that on this machine: it converts every glyph to a filled path. Measured
 * here, one line of text per font, counting string literals inside content
 * streams that contain a text operator:
 *
 *     Helvetica 0 · Arial 0 · Times New Roman 0 · Courier 0 · Verdana 0
 *
 * — against 118,601 bytes of `m`/`c`/`l`/`f` path data. So a PDF-text assertion
 * here would be asserting on Chrome's font backend, not on the report.
 *
 * What IS checked instead is the print LAYOUT, which is the thing the PDF is
 * rendered from: the page is switched to print media and the same stylesheet
 * that produces the PDF is asked, through getComputedStyle and innerText, what
 * is visible. `innerText` honours `display: none`, so it is exactly the set of
 * words that reach the paper. The PDF is still generated and kept as an
 * artifact, and its page count is reported.
 * ------------------------------------------------------------------ */

/** The words that reach the paper: innerText under print media. */
async function printedText(page) {
  await page.emulateMedia({ media: 'print' });
  // Lower-cased on the way out: `.report-section h2` is `text-transform:
  // capitalize`, and innerText returns the TRANSFORMED text, so a heading match
  // on the source casing fails against a heading that prints perfectly well.
  const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
  const styles = await page.evaluate(() => {
    const shown = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return 'absent';
      return getComputedStyle(node).display;
    };
    return {
      section: shown('.report-note-section'),
      editor: shown('.report-note-editor'),
      printed: shown('.report-note-print'),
      reasons: shown('.report-reasons'),
      actions: shown('.report-actions'),
    };
  });
  await page.emulateMedia({ media: 'screen' });
  return { text, styles };
}

function writeHarness() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(path.join(WORK, 'csv'), { recursive: true });
  const csvs = fs.readdirSync(SOURCE).filter((name) => name.toLowerCase().endsWith('.csv'));
  if (!csvs.length) throw new Error(`No CSVs in ${SOURCE}`);
  for (const name of csvs) fs.copyFileSync(path.join(SOURCE, name), path.join(WORK, 'csv', name));

  fs.writeFileSync(path.join(WORK, 'index.html'), `<!doctype html>
<html><head><meta charset="utf-8"><title>report verify</title></head>
<body><div id="root"></div><script type="module" src="./main.jsx"></script></body></html>
`);

  fs.writeFileSync(path.join(WORK, 'main.jsx'), `
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import { parseNinjaTraderCsvText } from '../src/domain/csvImport';
import { reconcileDailyImport } from '../src/domain/reconcile';
import { buildReportReasons } from '../src/domain/reportReasons';
import { createReportNoteStore } from '../src/domain/reportNote';
import ReportReasonsSection from '../src/components/ReportReasonsSection';
import ReportNoteSection from '../src/components/ReportNoteSection';

const FILES = ${JSON.stringify(csvs)};
const DATE = ${JSON.stringify(DATE)};

// An in-memory 'reports' table with the two properties of the real one that
// matter: no unique key, and rows pile up because ReportPanel inserts on mount.
const rows = [];
let clock = 0;
window.__rows = rows;
window.__panelMountInsert = () => {
  clock += 1;
  rows.push({
    id: 'mount-' + clock,
    clientId: 'c1',
    dailyImportId: 'di1',
    reportType: 'daily_close',
    content: { title: 'Daily close report', reportDate: DATE, summary: {}, source: {}, message: '' },
    createdAt: new Date(Date.now() + clock * 1000).toISOString(),
  });
};
const store = createReportNoteStore({
  listReports: async (clientId, dailyImportId) =>
    rows.filter((r) => r.clientId === clientId && r.dailyImportId === dailyImportId).map((r) => ({ ...r })),
  updateReportContent: async (id, content) => {
    const row = rows.find((r) => r.id === id);
    if (!row) return null;
    row.content = content;
    return { ...row };
  },
  createReport: async (clientId, dailyImportId, reportType, content) => {
    clock += 1;
    const row = { id: 'created-' + clock, clientId, dailyImportId, reportType, content, createdAt: new Date().toISOString() };
    rows.push(row);
    return { ...row };
  },
});

async function boot() {
  const parsed = { accounts: [], strategies: [], orders: [], executions: [] };
  for (const name of FILES) {
    const text = await (await fetch('./csv/' + name)).text();
    const p = parseNinjaTraderCsvText(text, name);
    if (parsed[p.type]) parsed[p.type].push(...p.rows);
  }
  // The registry as the CRM holds it: every account name the day's grids name.
  const registry = {};
  for (const row of [...parsed.accounts, ...parsed.strategies, ...parsed.orders, ...parsed.executions]) {
    if (row.accountName && !registry[row.accountName]) {
      registry[row.accountName] = { accountName: row.accountName, alias: row.accountName, accountType: '', status: 'Active', dateAdded: '2026-08-01' };
    }
  }
  const di = reconcileDailyImport({ clientId: 'c1', date: DATE, registry, parsed, history: [] });
  const client = { id: 'c1', name: 'Daniel Swanson', accountRegistry: registry, dailyImports: [di] };
  const reasons = buildReportReasons(client, di);
  window.__reasons = reasons;

  function App() {
    const [mounted, setMounted] = useState(true);
    return (
      <div className="report-overlay">
        <div className="report-sheet">
          <div className="report-actions no-print">
            <button id="reopen" onClick={() => {
              // Close + reopen: unmount, insert the blank row the panel's mount
              // effect writes, remount.
              setMounted(false);
              window.__panelMountInsert();
              setTimeout(() => setMounted(true), 0);
            }}>reopen</button>
          </div>
          <header className="report-header"><h1>Daniel Swanson</h1><span>Daily close report · {DATE}</span></header>
          <ReportReasonsSection reasons={reasons} />
          {mounted ? (
            <ReportNoteSection clientId="c1" dailyImportId="di1" authorName="Pedro" suggestedText="generated message" store={store} />
          ) : null}
          <footer className="report-footer"><span>Vincere Trading · Confidential</span></footer>
        </div>
      </div>
    );
  }

  window.__panelMountInsert();
  createRoot(document.getElementById('root')).render(<App />);
  window.__ready = true;
}
boot();
`);
  return csvs;
}

function report(label, ok, extra = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  return ok;
}

async function main() {
  writeHarness();
  const server = await createServer({ root: ROOT, server: { port: 5199, strictPort: false }, logLevel: 'error' });
  await server.listen();
  const port = server.config.server.port || server.httpServer.address().port;
  const browser = await chromium.launch({ channel: 'chrome' });
  let ok = true;
  try {
    const page = await browser.newPage();
    page.on('pageerror', (error) => console.error('  [page error]', error.message));
    await page.goto(`http://localhost:${port}/.report-verify/index.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
    await page.waitForSelector('.report-note-input');

    console.log('\nREASONS SECTION, as rendered in the browser');
    console.log('-'.repeat(72));
    console.log((await page.locator('.report-reasons').innerText()).split('\n').map((line) => `  ${line}`).join('\n'));

    console.log('\nROUND TRIP');
    await page.fill('.report-note-input', NOTE);
    await page.click('.report-note-editor button.primary-button');
    await page.waitForFunction(() => document.querySelector('.report-note-editor .remote-pill')?.textContent?.startsWith('Saved'), null, { timeout: 10000 });
    ok = report('saved, and the status says so', true, await page.locator('.report-note-editor .remote-pill').innerText()) && ok;

    const rowsAfterSave = await page.evaluate(() => window.__rows.map((r) => ({ id: r.id, note: r.content.note?.text || null })));
    ok = report('written onto an existing row, no extra row inserted', rowsAfterSave.length === 1, JSON.stringify(rowsAfterSave)) && ok;

    await page.click('#reopen');
    await page.waitForSelector('.report-note-input');
    await page.waitForFunction(() => document.querySelector('.report-note-input')?.value?.length > 0, null, { timeout: 10000 });
    const reloaded = await page.inputValue('.report-note-input');
    ok = report('reopening the day shows what was typed', reloaded === NOTE, `${reloaded.length} chars back`) && ok;

    const rowsNow = await page.evaluate(() => window.__rows.map((r) => ({ id: r.id, note: r.content.note?.text ? 'yes' : 'no' })));
    ok = report('the note survives a newer, blank report row', rowsNow.length === 2 && rowsNow[1].note === 'no', JSON.stringify(rowsNow)) && ok;

    console.log('\nPRINT');
    const printed = await printedText(page);
    console.log(`  computed display under @media print: ${JSON.stringify(printed.styles)}`);
    console.log('-'.repeat(72));
    console.log(printed.text.replace(/ · /g, '\n  · ').split('\n').map((line) => `  ${line.trim()}`).join('\n'));
    console.log('-'.repeat(72));

    ok = report('the note is on the printed page', printed.text.includes('Both orders sent today were refused by the platform')) && ok;
    ok = report('the whole note prints, not the first line', printed.text.includes('Nothing else changed on the account')) && ok;
    const lower = printed.text.toLowerCase();
    ok = report('the heading prints', lower.includes('note from your account manager')) && ok;
    ok = report('the reasons print', lower.includes('what shaped this close')) && ok;
    ok = report("the platform's own words print", printed.text.includes('liquidation only due to Drawdown level breached')) && ok;
    ok = report('the editor chrome does NOT print', printed.styles.editor === 'none' && !printed.text.includes('Save note') && !printed.text.includes('Start from the generated message')) && ok;
    ok = report('the note section itself is NOT no-print', printed.styles.section !== 'none' && printed.styles.printed !== 'none') && ok;
    ok = report('the panel actions do not print', printed.styles.actions === 'none') && ok;

    // An empty note must not print its heading at all.
    await page.fill('.report-note-input', '');
    const empty = await printedText(page);
    ok = report('an unwritten note prints nothing at all', empty.styles.section === 'none' && !empty.text.toLowerCase().includes('note from your account manager')) && ok;
    ok = report('the reasons still print when the note is empty', empty.text.toLowerCase().includes('what shaped this close')) && ok;

    // The PDF itself, kept as the artifact a CAM would actually hand over.
    await page.fill('.report-note-input', NOTE);
    const pdfPath = path.join(WORK, 'Daniel Swanson - 2026-08-11 daily report.pdf');
    await page.pdf({ path: pdfPath, format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } });
    const bytes = fs.readFileSync(pdfPath);
    const pages = (bytes.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    console.log(`\n  PDF written: ${(bytes.length / 1024).toFixed(0)} KB, ${pages} page(s) — ${pdfPath}`);

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
