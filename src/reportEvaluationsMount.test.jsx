// @vitest-environment jsdom
// Does the evaluations section land inside the element the PDF is made from, and
// does the pool it takes over print ONCE — asked of a rendered document.
//
// WHY THIS FILE EXISTS, and it is not "for completeness". The two guarantees it
// holds were asserted by regexes over App.jsx read as a string, and a verifier
// escaped both with every test green:
//
//   MUTATION F. The gated mount was moved out of `<div className="report-sheet">`
//   and into the enclosing `.report-overlay`, immediately after the sheet's
//   closing tag. The section still renders on screen; `sheetRef.current.outerHTML`
//   — which src/domain/reportPdfDownload.js:89 posts to /api/report/pdf — no
//   longer contains it, so it is absent from every client's PDF. That is the CAM's
//   complaint reproduced exactly ("no sale en el PDF"), and the gate's PDF half
//   passed, because `APP.indexOf('className="report-sheet"')` took the FIRST of
//   three occurrences in App.jsx — MonthlyReportPanel's sheet, 400 lines above a
//   different component — so `mountAt > sheetAt` proved only that the mount came
//   somewhere after another panel's opening tag.
//
//   MUTATION G. The two handoff filters were deleted from the code and left inside
//   a block comment. The regexes matched the comment. With the toggle on, every
//   evaluation row then printed twice on one page and the segment tile stated a
//   second balance for the same pool beside the section's own subtotal.
//
// Both of those are questions about a document, so they are asked of a document.
// `ReportPanel` is rendered with its real props and the result is parsed and
// walked: `closest('.report-sheet')`, ancestors checked for `.no-print`, and the
// rows counted. A regex cannot be made to answer either question, and the repo has
// now shipped four tests that passed against prose — simulationReportGate.test.js
// exists because `{true ? ...}` and `{false ? ...}` both passed 1,782 tests.
//
// THE LEXICAL HALF IS STILL THERE, in src/domain/evaluationReportGate.test.js, and
// it still earns its place: it needs no DOM, it is the one that says "exactly one
// mount, and it is the consequent of a cfg.showEvaluations conditional", and a
// second unguarded mount is a thing you count in source and not in one render.
// What it must never again be is the only thing standing between a client's PDF
// and a missing section.

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { ReportPanel } from './App';
import { ACCOUNT_TYPES } from './domain/reconcile';
import { DEFAULT_REPORT_CONFIG } from './domain/reportConfig';

/* ------------------------------------------------------------------ *
 * One client, built here rather than read from the book.
 *
 * Deliberately NOT book-backed: vite.config.js drops every snapshot-reading
 * suite on a clone without the export, and its own comment says what that costs —
 * "the two guards that stop a partial or an over-summing derived per-algo split
 * from reaching a screen lived in a gated file, and both mutations that break them
 * passed a full CI run". This guard runs everywhere.
 *
 * The shape is the one the mutations need to be visible in: two evaluation
 * accounts and one funded account, so the per-account table still has a group of
 * its own after the handoff; both pools tileable, so the tile handoff is visible
 * too; and one evaluation whose Start Bal $ is blank with an earlier close on
 * record, which is the row whose percentage rests on an inferred start.
 * ------------------------------------------------------------------ */

const REGISTRY = {
  EVAL1: {
    accountName: 'EVAL1',
    accountType: ACCOUNT_TYPES.EVALUATION_STANDARD,
    alias: 'Legends - 7045',
    status: 'Active',
    startBalance: 50000,
    targetProfit: 54100,
  },
  // No startBalance: the start is recovered from the earliest close below, which is
  // what makes its percentage an inferred-floor one.
  EVAL2: {
    accountName: 'EVAL2',
    accountType: ACCOUNT_TYPES.EVALUATION_STANDARD,
    alias: 'Legends - 0658',
    status: 'Active',
    targetProfit: 54100,
  },
  FUND1: {
    accountName: 'FUND1',
    accountType: ACCOUNT_TYPES.FUNDED,
    alias: 'TOF - 2928',
    status: 'Active',
    startBalance: 100000,
    targetProfit: 107300,
  },
};

const snapshot = (accountName, accountBalance) => ({
  accountName,
  accountBalance,
  grossRealizedPnl: 0,
  weeklyPnl: 0,
  trailingMaxDrawdown: 1850,
  strategies: [],
});

const EARLIER = {
  id: 'imp-1',
  date: '2026-07-01',
  status: 'Closed',
  accounts: REGISTRY,
  snapshots: [snapshot('EVAL1', 50000), snapshot('EVAL2', 50000), snapshot('FUND1', 100000)],
  flags: [],
};
const LATEST = {
  id: 'imp-2',
  date: '2026-07-30',
  status: 'Closed',
  accounts: REGISTRY,
  snapshots: [snapshot('EVAL1', 52050), snapshot('EVAL2', 52050), snapshot('FUND1', 103000)],
  flags: [],
};

function clientWith(registry = REGISTRY, imports = [EARLIER, LATEST]) {
  return { name: 'Amanda', accountRegistry: registry, dailyImports: imports };
}

/**
 * The report sheet as a DOM, and the string the Download button posts.
 *
 * `renderToStaticMarkup` rather than a test renderer with effects: ReportPanel's
 * effects write a report row to Supabase and read the note back, none of which the
 * sheet's SHAPE depends on, and a guard that needed a mocked database to answer
 * "is this element inside that div" would be a guard nobody trusts. What comes
 * back is the markup React produces for these props; it is parsed and walked.
 */
function renderSheet({ cfg = {}, client = clientWith(), dailyImport = LATEST } = {}) {
  const html = renderToStaticMarkup(
    <ReportPanel
      client={client}
      dailyImport={dailyImport}
      camConfig={{ ...DEFAULT_REPORT_CONFIG, ...cfg }}
      clientConfig={null}
      camName="Pedro"
      onSaveConfig={() => {}}
      onClose={() => {}}
    />,
  );
  const host = document.createElement('div');
  host.innerHTML = html;
  const overlay = host.querySelector('.report-overlay');
  const sheet = host.querySelector('.report-sheet');
  return { host, overlay, sheet };
}

/** Every account name the sheet prints in a table body, in order, with repeats. */
const rowNames = (root) => [...root.querySelectorAll('.report-table tbody tr td strong')]
  .map((node) => node.textContent.trim());

/** The `<h2>` of every account-group section the per-account table draws. */
const groupHeadings = (sheet) => [...sheet.querySelectorAll('.report-section > h2')]
  .map((node) => node.textContent.trim());

const tileLabels = (sheet) => [...sheet.querySelectorAll('.report-segments > div > span')]
  .map((node) => node.textContent.trim());

describe('the evaluations section lands inside the DOM the PDF is made from', () => {
  let rendered;
  beforeEach(() => { rendered = renderSheet({ cfg: { showEvaluations: true } }); });

  it('is in the sheet, not merely somewhere on the screen', () => {
    /* MUTATION F FAILS HERE. Moved into `.report-overlay` the section is still in
     * the document and still visible; it is not in `.report-sheet`, and
     * `.report-sheet` is the whole of what the client receives. */
    const section = rendered.sheet.querySelector('.report-evaluations');
    expect(section).not.toBeNull();
    expect(section.closest('.report-sheet')).toBe(rendered.sheet);
    // And asked the other way round, of the overlay, so a section that escaped
    // the sheet but stayed on screen cannot satisfy this file by being found.
    expect(rendered.overlay.querySelectorAll('.report-evaluations')).toHaveLength(1);
  });

  it('is in the exact string reportPdfDownload posts, which is the paper', () => {
    // src/domain/reportPdfDownload.js:89 sends `sheet?.outerHTML`. Nothing else
    // about the page reaches the endpoint, so this is the assertion the CAM's
    // complaint was actually about.
    expect(rendered.sheet.outerHTML).toContain('report-evaluations');
    expect(rendered.sheet.outerHTML).toContain('Challenge-capital total');
    // The 9 body rows a client reads are in it too, not just the heading.
    expect(rendered.sheet.outerHTML).toContain('Legends - 7045');
  });

  it('is outside every .no-print subtree between it and the sheet', () => {
    // The print block is `.no-print { display: none !important }`, and the PDF is
    // that stylesheet applied to the posted DOM. A mount inside the action bar or
    // the design drawer renders on screen and prints nothing.
    const section = rendered.sheet.querySelector('.report-evaluations');
    const hidden = [];
    for (let node = section; node && node !== rendered.sheet.parentElement; node = node.parentElement) {
      if (node.classList.contains('no-print')) hidden.push(node.className);
    }
    expect(hidden).toEqual([]);
  });

  it('is below the money and above the footer, which is what keeps the two apart', () => {
    // Its figures are challenge capital and reach neither `report.totals` nor the
    // tiles, and the structural half of that separation is its position: nothing
    // above it can be read as including it.
    const children = [...rendered.sheet.children];
    const section = rendered.sheet.querySelector('.report-evaluations');
    expect(children).toContain(section);
    const metrics = rendered.sheet.querySelector('.report-metrics');
    const footer = rendered.sheet.querySelector('.report-footer');
    expect(children.indexOf(section)).toBeGreaterThan(children.indexOf(metrics));
    expect(children.indexOf(section)).toBeLessThan(children.indexOf(footer));
  });

  it('is absent from the sheet entirely while the toggle is off', () => {
    // The default, and the thing the default protects: a CAM who changed nothing
    // sees yesterday's report.
    const off = renderSheet();
    expect(off.sheet.querySelector('.report-evaluations')).toBeNull();
    expect(off.sheet.outerHTML).not.toContain('report-evaluations');
  });

  it('renders no section at all for a client holding no challenge account', () => {
    const funded = { FUND1: REGISTRY.FUND1 };
    const only = {
      ...LATEST, accounts: funded, snapshots: [snapshot('FUND1', 103000)],
    };
    const { sheet } = renderSheet({
      cfg: { showEvaluations: true },
      client: clientWith(funded, [{ ...EARLIER, accounts: funded, snapshots: [snapshot('FUND1', 100000)] }, only]),
      dailyImport: only,
    });
    expect(sheet.querySelector('.report-evaluations')).toBeNull();
  });
});

describe('the pool it takes over prints once on the page', () => {
  it('hands the rows over: each evaluation account appears exactly once', () => {
    /* MUTATION G FAILS HERE. With the two filters deleted, the per-account table
     * keeps its evaluations group and the section draws the same rows again: 203
     * rows across 47 clients printed twice on one page on the book's latest
     * closes. Counted in the rendered sheet rather than matched in App.jsx,
     * because the filters' TEXT survives inside a comment and the rows do not. */
    const { sheet } = renderSheet({ cfg: { showEvaluations: true } });
    const names = rowNames(sheet);
    const counted = {};
    for (const name of names) counted[name] = (counted[name] || 0) + 1;
    expect(counted['Legends - 7045']).toBe(1);
    expect(counted['Legends - 0658']).toBe(1);
    // The funded account is untouched by the handoff and also appears once.
    expect(counted['TOF - 2928']).toBe(1);
    // The per-account table keeps every other pool and loses only this one.
    expect(groupHeadings(sheet)).toContain('Funded Accounts');
    expect(groupHeadings(sheet)).not.toContain('Evaluations');
  });

  it('hands the tile over: no second balance for the same pool', () => {
    // The tile covers `evalStandard` only — 39 of the 203 rows — so leaving it
    // beside the section states a different number for one pool on one page.
    const { sheet } = renderSheet({ cfg: { showEvaluations: true } });
    expect(tileLabels(sheet).some((label) => label.startsWith('Evaluations'))).toBe(false);
    expect(tileLabels(sheet).some((label) => label.startsWith('Funded'))).toBe(true);
    // And exactly one element on the page states a challenge-capital subtotal.
    expect(sheet.outerHTML.match(/Challenge-capital total/g)).toHaveLength(1);
  });

  it('keeps both of them exactly where they were while the toggle is off', () => {
    const { sheet } = renderSheet();
    const names = rowNames(sheet);
    expect(names.filter((name) => name === 'Legends - 7045')).toHaveLength(1);
    expect(groupHeadings(sheet)).toContain('Evaluations');
    expect(tileLabels(sheet).some((label) => label.startsWith('Evaluations'))).toBe(true);
  });
});

describe('what the sheet does with an empty strip and a guessed start', () => {
  it('draws no tile strip at all when the section took the only tile', () => {
    /* THE SILENT EMPTY SHELL, in the one case this change creates. The strip was
     * emitted whenever the toggle was on and only its children were filtered, so a
     * client whose only tileable pool is Evaluation - Standard got an empty
     * <section class="report-metrics report-segments"> on the sheet and in the PDF:
     * 0 children, 0px tall, and still 12px of margin top and bottom under print
     * media. 31 closes on the book are in that state with the toggle on, 5 of them
     * a client's latest. */
    const evalsOnly = { EVAL1: REGISTRY.EVAL1, EVAL2: REGISTRY.EVAL2 };
    const imports = [
      { ...EARLIER, accounts: evalsOnly, snapshots: [snapshot('EVAL1', 50000), snapshot('EVAL2', 50000)] },
      { ...LATEST, accounts: evalsOnly, snapshots: [snapshot('EVAL1', 52050), snapshot('EVAL2', 52050)] },
    ];
    const args = { client: clientWith(evalsOnly, imports), dailyImport: imports[1] };
    // Off: the strip holds its one Evaluations tile, as it always has.
    const off = renderSheet({ ...args });
    expect(off.sheet.querySelector('.report-segments')).not.toBeNull();
    expect(tileLabels(off.sheet).some((label) => label.startsWith('Evaluations'))).toBe(true);
    // On: the tile moved into the section, so there is no strip to draw.
    const on = renderSheet({ ...args, cfg: { showEvaluations: true } });
    expect(on.sheet.querySelector('.report-segments')).toBeNull();
    expect(on.sheet.querySelector('.report-evaluations')).not.toBeNull();
  });

  it('names the inferred start in the progress table, which ships on in Simplified', () => {
    /* `showProgressToTarget` is `true` in SIMPLIFIED_REPORT_CONFIG, so this column
     * reaches clients from a config nobody touched, and 797 of the 1,623
     * percentages it draws across the book rest on a start recovered from the
     * earliest close on record rather than one the desk typed. EVAL2 below is that
     * row: no Start Bal $, an earlier close at 50,000, so its 50% is measured from
     * a number nobody confirmed. EVAL1 has the same balance and a stored start, so
     * it prints the same 50% and carries no label. */
    const { sheet } = renderSheet({ cfg: { showProgressToTarget: true } });
    const progress = [...sheet.querySelectorAll('.report-section')]
      .find((node) => node.querySelector('h2')?.textContent.trim() === 'Progress to target');
    expect(progress).toBeDefined();
    const cells = [...progress.querySelectorAll('tbody tr')].map((tr) => ({
      name: tr.children[0].textContent.trim(),
      progress: tr.children[3].textContent.replace(/\s+/g, ' ').trim(),
    }));
    const stored = cells.find((cell) => cell.name === 'Legends - 7045');
    const observed = cells.find((cell) => cell.name === 'Legends - 0658');
    expect(stored.progress).toBe('50%');
    expect(observed.progress).toBe('50%start taken from its earliest close');
  });

  it('names it in the evaluations section too, on the same row', () => {
    const { sheet } = renderSheet({ cfg: { showEvaluations: true } });
    const section = sheet.querySelector('.report-evaluations');
    const rows = [...section.querySelectorAll('tbody tr')].map((tr) => tr.textContent.replace(/\s+/g, ' '));
    expect(rows.find((row) => row.includes('Legends - 0658'))).toContain('start taken from its earliest close');
    expect(rows.find((row) => row.includes('Legends - 7045'))).not.toContain('start taken from its earliest close');
    expect(section.textContent.replace(/\s+/g, ' '))
      .toContain("Each percentage is measured from the account's starting balance: 1 on record, 1 taken from its earliest close on record");
  });
});
