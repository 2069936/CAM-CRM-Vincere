// Four panels the desk manager took off the operations screens, and the guard
// that keeps them off.
//
// WHY THIS IS A SOURCE-TEXT TEST. The same reason src/localSnapshotGate.test.js
// and src/domain/appSaveWiring.test.js are: the invariant is about which code
// exists, not about what a function returns. There is nothing left to call.
// A removal that leaves the component file on disk, or the domain builder that
// fed it, or a second render site nobody noticed, is a removal that comes back
// the next time someone reaches for a chart — and it comes back silently,
// because a dead component still compiles and still passes every test it had.
//
// Ungated: reads only the tree, so CI pins it.
//
// WHAT WENT, AND WHY, so that a future reader can tell a decision from an
// accident:
//
//   1. "Algorithm risk profile" / "Exposure by algorithm" — the reward:risk
//      against fills-per-day scatter (StrategyRiskScatter, fed by
//      buildStrategyRiskProfile). It was on the CAM overview and on the
//      manager's configuration review. The manager asked twice: he likes it and
//      cannot read it, and a chart nobody can read is one that gets believed or
//      ignored at random. strategyFamilyOf survived into
//      src/domain/strategyFamily.js because liveAccounts, setFileMatch and
//      strategyConfigDrift all needed it for a different question.
//
//   2. "Lifecycle by algo" (LifecycleByAlgo, fed by buildLifecycleByAlgo) — on
//      the manager overview, the CAM overview and the Stack Playbook. The CAM
//      was asked directly, because his dictation was contradictory, and chose
//      "add the deviation alert to the manager view, and remove lifecycle by
//      algo".
//
//   3. "Historical date drill-down" on the manager overview. What it actually
//      did is recorded in the describe below, because "it does not work" and
//      "nobody understands it" call for different follow-ups and this one was
//      mostly the second.
//
//   4. The Acknowledge action on flags. That one has its own file, because it
//      has a live half as well as a removed one:
//      src/domain/flagStatusWrites.test.js.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '.vercel']);

function sourceFilesUnder(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFilesUnder(full, out);
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) out.push(relative(ROOT, full));
  }
  return out;
}

/**
 * Non-comment lines only.
 *
 * Every removal above is explained in a comment somewhere near where it used to
 * live — that is the house style and it is worth more than the code was. A guard
 * that fails on its own explanation teaches people to delete the explanation.
 */
function codeLines(file) {
  const out = [];
  let inBlock = false;
  for (const [index, raw] of readFileSync(join(ROOT, file), 'utf8').split('\n').entries()) {
    const line = raw.trim();
    if (inBlock) {
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (line.startsWith('/*') || line.startsWith('{/*')) {
      if (!line.includes('*/')) inBlock = true;
      continue;
    }
    if (line.startsWith('//') || line.startsWith('*')) continue;
    out.push({ line: index + 1, text: line });
  }
  return out;
}

// Everything under src except the tests, which quote the removed names to say
// they are removed.
const SOURCES = sourceFilesUnder(join(ROOT, 'src'))
  .concat(sourceFilesUnder(join(ROOT, 'server')))
  .filter((file) => !/\.test\.[cm]?[jt]sx?$/.test(file));

function mentionsOf(needle) {
  const hits = [];
  for (const file of SOURCES) {
    for (const { line, text } of codeLines(file)) {
      if (text.includes(needle)) hits.push(`${file}:${line} ${text}`);
    }
  }
  return hits;
}

describe('the algorithm risk profile scatter', () => {
  it('has no component file and no render site', () => {
    expect(existsSync(join(ROOT, 'src/components/StrategyRiskScatter.jsx'))).toBe(false);
    expect(mentionsOf('StrategyRiskScatter')).toEqual([]);
  });

  it('has no builder left to feed it', () => {
    expect(existsSync(join(ROOT, 'src/domain/strategyRiskProfile.js'))).toBe(false);
    expect(mentionsOf('buildStrategyRiskProfile')).toEqual([]);
  });

  it('kept strategyFamilyOf, which three other modules read', () => {
    // The removal's one seam. buildStrategyRiskProfile owned the file, but
    // liveAccounts, setFileMatch and strategyConfigDrift import this one
    // function to know that `0 - OGX-PF-2.4` and `1 - OGX-PF-3.0` are the same
    // product. Deleting the module wholesale would have taken all three with it.
    expect(existsSync(join(ROOT, 'src/domain/strategyFamily.js'))).toBe(true);
    const importers = SOURCES.filter((file) => codeLines(file)
      .some(({ text }) => text.includes("from './strategyFamily'")));
    expect(importers.sort()).toEqual([
      'src/domain/liveAccounts.js',
      'src/domain/setFileMatch.js',
      'src/domain/strategyConfigDrift.js',
    ]);
  });
});

describe('lifecycle by algo', () => {
  it('has no component file and no render site', () => {
    expect(existsSync(join(ROOT, 'src/components/LifecycleByAlgo.jsx'))).toBe(false);
    expect(mentionsOf('LifecycleByAlgo')).toEqual([]);
  });

  it('has no builder left to feed it', () => {
    expect(mentionsOf('buildLifecycleByAlgo')).toEqual([]);
    const lifecycle = readFileSync(join(ROOT, 'src/domain/accountLifecycle.js'), 'utf8');
    expect(lifecycle).not.toContain('export function buildLifecycleByAlgo');
    // Its neighbour stays: StackPlaybook still draws one account's timeline,
    // where a reader can see the dates it is working from.
    expect(lifecycle).toContain('export function buildAccountLifecycle(');
  });

  it('is gone from all three screens that carried it', () => {
    for (const file of ['src/App.jsx', 'src/components/StackPlaybook.jsx']) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      expect({ file, has: /Lifecycle by algo/i.test(source) }).toEqual({ file, has: false });
    }
  });
});

/*
 * WHAT THE HISTORICAL DATE DRILL-DOWN ACTUALLY DID, before it was removed.
 *
 * The manager reported that it "does nothing". It was not broken. It rendered a
 * correct table: for a chosen date, every client that filed a close that day,
 * with its CAM, its account count, its realized P&L and a total row. Run against
 * public/local-snapshot.json it returned 58 rows for 2026-07-30, 62 for
 * 2026-07-23 and 60 for 2026-07-13, with no missing CAM and no empty row.
 *
 * Three things made it read as dead, and only the third is a defect:
 *
 *   1. Its date input was not its own. `value={asOfDate} onChange={setAsOfDate}`
 *      is the SAME state as the picker in the page header, which pins the whole
 *      Operations page to one trading day. So picking a date "in the panel"
 *      silently re-pinned every KPI, roster and money figure above it; and if
 *      the manager had used the header picker first, the panel was already full
 *      before he touched it and appeared to do nothing at all.
 *
 *   2. It duplicated the panel directly above it. With a date pinned,
 *      `closeAsOf` matches that date exactly, so the "Client roster" panel above
 *      already listed the same clients with the same CAM and the same daily P&L.
 *      Verified on the book: the drill-down's row set is exactly the roster's
 *      "has a close on that date" subset, on every date tried.
 *
 *   3. Its one unique column was wrong. "Critical flags" counted every Critical
 *      flag on the import, INCLUDING resolved ones — `.filter((f) => f.severity
 *      === 'Critical')` with no status test, the only flag count on the screen
 *      without one. On 2026-07-30 it printed 311 where 51 were open; on
 *      2026-07-23, 224 where 48 were open. The single number a manager could not
 *      get from the roster above was roughly six times the truth.
 *
 * So: mostly "nobody understands it", with a real over-count inside it. Worth
 * recording, because had the answer been "it is broken" the follow-up would have
 * been a fix rather than a deletion — and because the over-count is the shape of
 * bug that would come straight back if the panel were rebuilt from memory.
 */
describe('the historical date drill-down', () => {
  it('is gone from the manager overview', () => {
    expect(mentionsOf('Historical date drill-down')).toEqual([]);
    expect(mentionsOf('drillRows')).toEqual([]);
  });

  it('left the page date pin behind, which was always the real control', () => {
    // The panel's picker wrote this state and so does the header's. Removing the
    // panel must not have removed the page's ability to look at a past close.
    const app = readFileSync(join(ROOT, 'src/App.jsx'), 'utf8');
    expect(app).toContain('Show the whole page as of this day');
    expect(app).toContain("Back to each client's latest close");
  });

  it('never let its flag miscount escape into another panel', () => {
    // The drill-down counted `(imp.flags || []).filter((f) => f.severity ===
    // 'Critical')` — every Critical flag on the import, resolved ones included.
    // It printed 311 where the desk had 51 open. This finds the shape rather
    // than the panel: any filter over a stored import's raw flag list that does
    // not test the status, wherever it is written.
    //
    // Two exemptions, both named rather than left to a looser regex:
    //
    //   * a filter body that says `isFlagOpen` or `isOpen` IS the status test —
    //     overviewCharts.js applies the same rule under a local name.
    //   * `result.flags` is the output of a reconcile that has just run in
    //     memory, in the batch-import preview. Nothing has been triaged yet, so
    //     every flag on it is open by construction and there is no status to
    //     filter on. Filtering there would read as though some of a brand new
    //     import's flags had already been closed.
    const CALL = /(\w+)\??\.flags\s*\|\|\s*\[\]\s*\)?\s*\.filter\(/g;
    const unfiltered = [];
    let scanned = 0;
    for (const file of SOURCES) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      for (const match of source.matchAll(CALL)) {
        scanned += 1;
        if (match[1] === 'result') continue;
        // The whole callback, by brace-free paren matching from `filter(`.
        let depth = 0;
        let end = match.index;
        for (let i = match.index + match[0].length - 1; i < source.length; i += 1) {
          if (source[i] === '(') depth += 1;
          else if (source[i] === ')') {
            depth -= 1;
            if (depth === 0) { end = i; break; }
          }
        }
        const body = source.slice(match.index, end + 1);
        if (/status|isFlagOpen|isOpen/.test(body)) continue;
        unfiltered.push(`${file}:${source.slice(0, match.index).split('\n').length} ${body.replace(/\s+/g, ' ')}`);
      }
    }
    // 22 today. A scan that matched nothing would pass this test while checking
    // nothing — the "0 fields compared" failure this codebase keeps catching
    // elsewhere — so the floor is asserted, not the exact number.
    expect(scanned).toBeGreaterThan(15);
    expect(unfiltered).toEqual([]);
  });
});
