// Aligns the set-file library with the configuration the desk is actually running.
//
// The set-file cross-check found RBO, B2X and ARPD with ZERO exact matches against
// the library, yet 34 to 53 rows each on one version with the SAME settings changed
// to the SAME values. That shape is the library trailing a desk-wide decision, not a
// hundred separate customisations, so the fix belongs in the library.
//
// SCOPE IS DELIBERATELY NARROW, and the two exclusions matter more than the edits:
//
//   1. Only settings every affected row agrees on. CloseAllOpenTradeTime is NOT
//      touched: RBO splits 41 at 16:50 against 10 at 16:30, B2X 28 at 16:45 against
//      6, and ARPD runs 27 at 15:45 and 8 at 16:30 with not one account on the
//      catalogued 16:50. Two competing values is an open decision, and picking one
//      here would change the hour real accounts flatten. It stays on the panel as
//      the one question it is.
//
//   2. Only files live accounts match against — v1 at Low and Medium risk, plus the
//      family Default.xml that carries the same parameters. The other versions in
//      each folder are untouched, because whether this was a policy for the whole
//      family or a decision about v1 is not something the book can answer.
//
// Every file is backed up before it is written, values are verified to be exactly
// what was expected before any edit lands, and the whole run aborts if a single file
// disagrees. These files drive real money.

import fs from 'node:fs';
import path from 'node:path';

const LIBRARY = '/Users/pedro/Desktop/PEDRO/Trabajo/app/Vincere Trading 6.0/3 - Set Files';

/**
 * Files carrying a configuration live accounts run, per family, and the settings the
 * whole affected cohort moved. `expect` is the value the file must currently hold —
 * a mismatch means the library is not what the cross-check measured, and the run
 * stops rather than writing over something unrecognised.
 */
const PLAN = [
  {
    family: 'RBO',
    rows: 53,
    files: [
      'Default.xml',
      '1 - RBO (M2K) - 10 Min Candle - Low Risk - v1 - Period 0.xml',
      '1 - RBO (M2K) - 10 Min Candle - Low Risk - v1 - Period 1.xml',
      '1 - RBO (M2K) - 10 Min Candle - Low Risk - v1 - Period 2.xml',
      '2 - RBO (M2K) - 10 Min Candle - Medium Risk - v1 - Period 0.xml',
      '2 - RBO (M2K) - 10 Min Candle - Medium Risk - v1 - Period 1.xml',
      '2 - RBO (M2K) - 10 Min Candle - Medium Risk - v1 - Period 2.xml',
    ],
    changes: [
      { tag: 'BreakEvenOffset', expect: '50', value: '25' },
      { tag: 'EntryOrderTickOffset', expect: '1', value: '0' },
    ],
  },
  {
    family: 'B2X',
    rows: 34,
    files: [
      'Default.xml',
      '1 - B2X (M2K) - 10 Min Candle - Low Risk - v1 - Period 0.xml',
      '1 - B2X (M2K) - 10 Min Candle - Low Risk - v1 - Period 1.xml',
      '1 - B2X (M2K) - 10 Min Candle - Low Risk - v1 - Period 2.xml',
      '2 - B2X (M2K) - 10 Min Candle - Medium Risk - v1 - Period 0.xml',
      '2 - B2X (M2K) - 10 Min Candle - Medium Risk - v1 - Period 1.xml',
      '2 - B2X (M2K) - 10 Min Candle - Medium Risk - v1 - Period 2.xml',
    ],
    changes: [
      { tag: 'BreakEvenAfterTicks', expect: '30', value: '100' },
      { tag: 'BreakEvenOffset', expect: '2', value: '20' },
      { tag: 'StartTrailAfterTicks', expect: '127', value: '126' },
      { tag: 'TrailFrequency', expect: '15', value: '10' },
    ],
  },
  {
    family: 'ARPD',
    rows: 35,
    files: [
      'Default.xml',
      '1 - ARPD (MGC) - 5 Min Candle - Low Risk - v1 - Period 0.xml',
      '1 - ARPD (MGC) - 5 Min Candle - Low Risk - v1 - Period 1.xml',
      '1 - ARPD (MGC) - 5 Min Candle - Low Risk - v1 - Period 2.xml',
    ],
    changes: [{ tag: 'BreakEvenOffset', expect: '3', value: '0' }],
  },
];

const apply = process.argv.includes('--apply');
const stamp = process.argv.find((a) => a.startsWith('--stamp='))?.slice(8) || 'backup';

/**
 * Read as a byte string, not as text.
 *
 * RBO/Default.xml and ARPD/Default.xml carry a UTF-8 BOM and B2X/Default.xml does
 * not. Round-tripping through a decoder that strips or adds one would rewrite the
 * first byte of a file NinjaTrader parses, for no reason connected to the change.
 */
function read(file) {
  return fs.readFileSync(file, 'latin1');
}

function tagValue(text, tag) {
  const match = text.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return match ? match[1] : null;
}

const problems = [];
const edits = [];

for (const family of PLAN) {
  for (const name of family.files) {
    const file = path.join(LIBRARY, family.family, name);
    if (!fs.existsSync(file)) {
      problems.push(`MISSING ${family.family}/${name}`);
      continue;
    }
    const text = read(file);
    let next = text;
    const applied = [];
    for (const change of family.changes) {
      const current = tagValue(text, change.tag);
      if (current === null) {
        problems.push(`${family.family}/${name}: no <${change.tag}>`);
        continue;
      }
      if (current === change.value) {
        applied.push(`${change.tag} already ${change.value}`);
        continue;
      }
      if (current !== change.expect) {
        problems.push(
          `${family.family}/${name}: <${change.tag}> is ${current}, expected ${change.expect}`,
        );
        continue;
      }
      // Anchored on the closing tag so a value can never be written into a
      // different element that happens to share a prefix.
      next = next.replace(
        new RegExp(`<${change.tag}>${change.expect}</${change.tag}>`),
        `<${change.tag}>${change.value}</${change.tag}>`,
      );
      applied.push(`${change.tag} ${change.expect} -> ${change.value}`);
    }
    edits.push({ file, family: family.family, name, text, next, applied, changed: next !== text });
  }
}

if (problems.length) {
  console.error('ABORTED — the library is not what the cross-check measured:');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`${edits.length} files, ${edits.filter((e) => e.changed).length} to change\n`);
for (const family of PLAN) {
  console.log(`${family.family} — ${family.rows} rows ran this already`);
  for (const edit of edits.filter((e) => e.family === family.family)) {
    console.log(`  ${edit.changed ? 'CHANGE' : 'skip  '} ${edit.name}`);
    for (const line of edit.applied) console.log(`           ${line}`);
  }
  console.log();
}

if (!apply) {
  console.log('Dry run. Pass --apply to write, with a backup taken first.');
  process.exit(0);
}

const backupRoot = path.join(LIBRARY, `_backup-${stamp}`);
if (fs.existsSync(backupRoot)) {
  console.error(`ABORTED — ${backupRoot} exists. Refusing to overwrite a backup.`);
  process.exit(1);
}

for (const edit of edits) {
  if (!edit.changed) continue;
  const target = path.join(backupRoot, edit.family, edit.name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, edit.text, 'latin1');
}
for (const edit of edits) {
  if (!edit.changed) continue;
  fs.writeFileSync(edit.file, edit.next, 'latin1');
}

// Read back from disk rather than trusting the write: the whole point of this
// script is that nobody should have to take its word for what is in the library.
let verified = 0;
for (const edit of edits) {
  if (!edit.changed) continue;
  const after = read(edit.file);
  const family = PLAN.find((f) => f.family === edit.family);
  for (const change of family.changes) {
    if (tagValue(after, change.tag) !== change.value) {
      console.error(`VERIFY FAILED ${edit.family}/${edit.name} <${change.tag}>`);
      process.exit(1);
    }
  }
  verified += 1;
}

console.log(`Written and read back: ${verified} files verified.`);
console.log(`Backup: ${backupRoot}`);
