import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { manifestFrom, manifestShapeOf, pathsOf } from './deepExportManifestShape.js';
import { identityOf, manifestSource, readCatalog, sameGeometry, toRow, usable } from './import_strategy_catalog.mjs';

// Synthetic only. Nothing here reads a real export. The manifest suite reads
// the agent's SOURCE - DeepExportRunner.cs - for the field names it writes,
// which is not an export either.

const SCRIPT = fileURLToPath(new URL('./import_strategy_catalog.mjs', import.meta.url));
// The runner moved out of the WPF Setup project into its own library, so that
// the Windows service could reach it. This was the only reference to the old
// folder outside collector/, and nothing in the .NET build would have caught it:
// `vitest run` did, with ENOENT.
const RUNNER = fileURLToPath(new URL('../collector/src/Vincere.AutoExport.DeepExport/DeepExportRunner.cs', import.meta.url));

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

/**
 * The reader against the writer, with nothing hand-written in between.
 *
 * The bug these cover: the import asked for `manifest.machineId` and
 * `manifest.createdAtUtc`; DeepExportRunner writes `source.machineId` and
 * `createdAt`. Both reads came back undefined on every real export and the
 * import said nothing, so every row landed with a null machine and a null
 * date. A fixture typed out by hand would have been typed from the same wrong
 * reading and would still be green, so the manifest here is built from the
 * names found in DeepExportRunner.cs instead.
 */
describe('the manifest, read the way the agent writes it', () => {
  const shape = manifestShapeOf(readFileSync(RUNNER, 'utf8'));
  const sample = (path) => `written-at-${path}`;

  it('actually found the agent\'s manifest, rather than nothing at all', () => {
    // The guard on the guard. A parser that quietly returned {} would build an
    // empty manifest, and every assertion below would be about nothing.
    const paths = pathsOf(shape);
    expect(paths).toContain('kind');
    expect(paths).toContain('exportId');
    expect(paths).toContain('timeZone');
    expect(paths.length).toBeGreaterThan(20);
    expect(Object.keys(shape.source)).toHaveLength(8);
  });

  it('takes the machine and the export time from where the agent puts them', () => {
    // Rename either side of this - the field in DeepExportRunner.cs, or the
    // key manifestSource asks for - and the two stop meeting here.
    expect(manifestSource(manifestFrom(shape, sample))).toEqual({
      machineId: 'written-at-source.machineId',
      exportedAt: 'written-at-createdAt',
    });
  });

  it('reads nothing from the shape the import used to assume', () => {
    // The old reading, exactly: machineId at the top level, the date under a
    // name nobody writes. This is what was passing silently.
    const drifted = manifestFrom(shape, sample);
    drifted.machineId = drifted.source.machineId;
    delete drifted.source.machineId;
    drifted.createdAtUtc = drifted.createdAt;
    delete drifted.createdAt;
    expect(manifestSource(drifted)).toEqual({ machineId: null, exportedAt: null });
  });

  it('carries both onto every row it imports', () => {
    const { machineId, exportedAt } = manifestSource(manifestFrom(shape, sample));
    expect(toRow(line(), machineId, exportedAt)).toMatchObject({
      source_machine_id: 'written-at-source.machineId',
      source_export_at: 'written-at-createdAt',
    });
  });

  it('says so out loud when an export carries no provenance', () => {
    const folder = mkdtempSync(join(tmpdir(), 'catalog-manifest-'));
    try {
      mkdirSync(join(folder, 'attribution'), { recursive: true });
      writeFileSync(join(folder, 'attribution', 'catalog.jsonl'), JSON.stringify(line()));
      const run = () => spawnSync(process.execPath, [SCRIPT, '--export', folder, '--dry-run'], {
        encoding: 'utf8',
        env: { ...process.env, SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '' },
      });

      writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifestFrom(shape, sample)));
      const complete = run();
      expect(complete.status).toBe(0);
      expect(complete.stderr).not.toMatch(/WARNING/);

      writeFileSync(join(folder, 'manifest.json'), JSON.stringify({ schemaVersion: 1, kind: 'deep_export' }));
      const bare = run();
      expect(bare.status).toBe(0);
      expect(bare.stderr).toMatch(/no source\.machineId and no createdAt in the manifest/);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
