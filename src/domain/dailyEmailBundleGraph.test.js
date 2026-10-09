import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { describe, expect, it } from 'vitest';

/* ------------------------------------------------------------------------- *
 * WHAT THE DAILY EMAIL BUNDLE REACHES, AND WHAT IT MUST NOT.
 *
 * The Edge Function's bundle (supabase/functions/daily-report-email/_bundle.js)
 * is built from src/domain/dailyEmailEntry.js and runs with a service role.
 * supabaseStore.js is in its graph, and it used to import its one constant
 * from accountBuckets.js, which imports autoCollectionFleet.js: the bundler
 * kept every top level Object.freeze of both modules, about a hundred unused
 * lines of the live tracker's tables, in a process that sends email. The
 * defaults now live in accountObservationDefaults.js, which imports nothing.
 *
 * Two checks: the static import graph from the entry, which a rebuild cannot
 * hide; and the committed bundle itself, which CI rebuilds and diffs.
 * ------------------------------------------------------------------------- */

const ROOT = process.cwd();
const ENTRY = 'src/domain/dailyEmailEntry.js';
const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g;

function resolve(from, specifier) {
  const base = path.resolve(path.dirname(path.join(ROOT, from)), specifier);
  for (const candidate of [base, `${base}.js`, `${base}.jsx`, path.join(base, 'index.js')]) {
    if (existsSync(candidate) && !candidate.endsWith(path.sep) && path.extname(candidate)) return path.relative(ROOT, candidate);
  }
  return null;
}

function reachable(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(path.join(ROOT, file), 'utf8');
    for (const match of text.matchAll(IMPORT)) {
      const next = resolve(file, match[1]);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

describe('the daily email bundle', () => {
  const graph = reachable(ENTRY);

  it('reaches supabaseStore.js and the narrow defaults module, and neither accountBuckets.js nor autoCollectionFleet.js', () => {
    expect(graph.has('src/domain/supabaseStore.js')).toBe(true);
    expect(graph.has('src/domain/accountObservationDefaults.js')).toBe(true);
    expect(graph.has('src/domain/accountBuckets.js')).toBe(false);
    expect(graph.has('src/domain/autoCollectionFleet.js')).toBe(false);
  });

  it('the defaults module imports nothing, so it can bring nothing else along', () => {
    const text = readFileSync(path.join(ROOT, 'src/domain/accountObservationDefaults.js'), 'utf8');
    expect(text).not.toMatch(/^\s*import\s/m);
  });

  it('the committed bundle carries none of the live tracker\'s tables', () => {
    const bundle = readFileSync(path.join(ROOT, 'supabase/functions/daily-report-email/_bundle.js'), 'utf8');
    for (const words of [
      'Collector too old to sample',
      'strategies are enabled on this account right now',
      'still listed by NinjaTrader',
      'registeredNeverSeen',
    ]) {
      expect(bundle, words).not.toContain(words);
    }
    // Its single fflate region line is in the form CI's checkout writes.
    expect(bundle.match(/^\/\/#region .*fflate.*$/gm)).toEqual(['//#region node_modules/fflate/esm/browser.js']);
  });
});
