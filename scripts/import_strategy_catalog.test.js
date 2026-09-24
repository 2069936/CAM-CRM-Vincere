import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { identityOf, readCatalog, sameGeometry, toRow, usable } from './import_strategy_catalog.mjs';

// Synthetic only. Nothing here reads a real export.

const SCRIPT = fileURLToPath(new URL('./import_strategy_catalog.mjs', import.meta.url));

const line = (over = {}) => ({
  family: 'G4M', version: 'v1', risk: 'Low', propFirm: false, instrument: 'MES',
  sizes: [2, 1, 1], stopTicks: 80, targetTicks: [80, 120, 160], ...over,
});

describe('reading a catalogue line', () => {
  it('spreads the two arrays across the columns that hold them', () => {
    expect(toRow(line(), null, null)).toMatchObject({
      family: 'G4M', instrument: 'MES', prop_firm: false,
      size_1: 2, size_2: 1, size_3: 1,
      stop_ticks: 80, target_1_ticks: 80, target_2_ticks: 120, target_3_ticks: 160,
    });
  });

  it('writes null for a version it does not have, never an empty string', () => {
    // The identity index folds nulls with coalesce. An '' would sit beside a
    // null as a second row for the same template and both would match.
    const row = toRow(line({ version: '', risk: null }), null, null);
    expect(row.version).toBeNull();
    expect(row.risk).toBeNull();
    expect(identityOf(row)).toBe(identityOf(toRow(line({ version: null, risk: '' }), null, null)));
  });

  it('separates an algorithm from its prop firm variant', () => {
    expect(identityOf(toRow(line(), null, null)))
      .not.toBe(identityOf(toRow(line({ propFirm: true }), null, null)));
  });

  it('refuses a template with nothing to match on', () => {
    // Such a row fits every trade ever placed, which is worse than no row.
    expect(usable(toRow(line({ stopTicks: 0, targetTicks: [0, 0, 0] }), null, null))).toBe(false);
    expect(usable(toRow(line({ family: '  ' }), null, null))).toBe(false);
    expect(usable(toRow(line({ instrument: '' }), null, null))).toBe(false);
    expect(usable(toRow(line(), null, null))).toBe(true);
  });

  it('compares geometry and nothing else', () => {
    const a = toRow(line(), 'machine-a', '2026-01-01');
    const b = toRow(line(), 'machine-b', '2026-09-01');
    expect(sameGeometry(a, b)).toBe(true);
    expect(sameGeometry(a, toRow(line({ stopTicks: 85 }), null, null))).toBe(false);
  });
});

describe('the file on disk', () => {
  let folder;
  beforeEach(() => { folder = mkdtempSync(join(tmpdir(), 'catalog-')); });
  afterEach(() => { rmSync(folder, { recursive: true, force: true }); });

  it('ignores blank lines and names the line it cannot read', () => {
    const file = join(folder, 'catalog.jsonl');
    writeFileSync(file, `${JSON.stringify(line())}\n\n${JSON.stringify(line({ family: 'OGX' }))}\n`);
    expect(readCatalog(file)).toHaveLength(2);

    writeFileSync(file, `${JSON.stringify(line())}\nnot json\n`);
    expect(() => readCatalog(file)).toThrow(/:2 is not JSON/);
  });

  it('stops rather than importing nothing over a good catalogue', () => {
    // An agent before 1.0.9 writes no attribution folder at all. Treating that
    // as an empty catalogue would erase the desk's library.
    mkdirSync(join(folder, 'attribution'), { recursive: true });
    let failed = null;
    try {
      execFileSync(process.execPath, [SCRIPT, '--export', folder, '--dry-run'], { encoding: 'utf8', stdio: 'pipe' });
    } catch (problem) {
      failed = problem;
    }
    expect(failed).not.toBeNull();
    expect(failed.status).toBe(1);
    expect(failed.stderr).toMatch(/Only agent 1\.0\.9 and later write it/);
  });

  it('reads and counts without a database when asked only to look', () => {
    mkdirSync(join(folder, 'attribution'), { recursive: true });
    writeFileSync(join(folder, 'attribution', 'catalog.jsonl'),
      [line(), line({ version: 'v2', targetTicks: [90, 120, 160] }), line({ stopTicks: 0, targetTicks: [0, 0, 0] })]
        .map((one) => JSON.stringify(one)).join('\n'));
    const out = execFileSync(process.execPath, [SCRIPT, '--export', folder, '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '' },
    });
    expect(out).toMatch(/Read 3 template\(s\)/);
    expect(out).toMatch(/1 skipped/);
    expect(out).toMatch(/2 distinct template identities/);
    expect(out).toMatch(/nothing was compared/);
  });
});
