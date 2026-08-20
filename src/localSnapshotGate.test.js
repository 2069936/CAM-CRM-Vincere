// The gate that decides which suites CI actually runs.
//
// vite.config.js drops `localSnapshotTests` from every run that cannot see
// public/local-snapshot.json — the untracked, gitignored export of the book. On
// this machine the file is there and all of it runs; on CI and on every other
// clone it is not, and everything on that list silently disappears. A guard
// pinned only by a listed test is therefore not pinned at all.
//
// That is not hypothetical in either direction:
//
//   * The two refusals that stop a partial or an over-summing derived per-algo
//     split from reaching a screen lived in a listed file. Both mutations that
//     break them passed a full CI run — the same "broke 0 of N tests" condition
//     the derivation work was supposed to have closed, one level up.
//   * quietAccounts.test.js and QuietAccountsPanel.test.jsx read the snapshot at
//     import time while ABSENT from the list, so a snapshot-less `vitest run`
//     did not merely lose coverage, it failed outright.
//
// So this file checks the list against the tree in both directions, and it
// deliberately does NOT read the snapshot itself, so it is one of the tests that
// survives on a clone without the book.
//
// What it cannot check is the judgement call: a file that reads the book may
// still hold synthetic tests that do not need it, and those belong in an
// ungated sibling. That is the `.book.test.js` convention, and it is on the
// author to apply it.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localSnapshotTests } from '../vite.config.js';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '.vercel']);

function testFilesUnder(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) testFilesUnder(full, out);
    else if (/\.test\.[cm]?[jt]sx?$/.test(entry.name)) out.push(relative(ROOT, full));
  }
  return out;
}

// A suite "needs the book" when it resolves the snapshot path at all. Reading it
// under an existsSync guard would be a different design; nothing in the tree
// does that today, and if something starts to, this test is where the exception
// gets stated rather than left implicit.
const SELF = 'src/localSnapshotGate.test.js';

const readsSnapshot = (file) => file !== SELF && readFileSync(join(ROOT, file), 'utf8')
  .split('\n')
  .some((line) => !line.trimStart().startsWith('//')
    && !line.trimStart().startsWith('*')
    && line.includes('local-snapshot.json'));

const allTests = testFilesUnder(ROOT).sort();

describe('the local-snapshot gate', () => {
  it('lists every suite that reads the book', () => {
    // Failing here means a suite reads public/local-snapshot.json and is not
    // excluded, so `vitest run` on a clone without it errors out on an ENOENT.
    const readers = allTests.filter(readsSnapshot);
    const unlisted = readers.filter((f) => !localSnapshotTests.includes(f));
    expect(unlisted).toEqual([]);
  });

  it('lists nothing that does not read the book', () => {
    // Failing here means a suite is being dropped from CI for no reason — the
    // exact shape of the defect this file exists for. Take it off the list, or
    // if it genuinely mixes both kinds, split the book half into a
    // `.book.test.js` sibling and list only that.
    const listedButSynthetic = localSnapshotTests.filter((f) => !readsSnapshot(f));
    expect(listedButSynthetic).toEqual([]);
  });

  it('keeps the derived per-algo guards outside the gate', () => {
    // Named rather than left to the rule above, because these two are the ones
    // that were unpinned: they are the last check before a wrong per-algo split
    // is published as an exact one, and they need no book to run.
    const guardFiles = [
      'src/domain/algoContribution.test.js',
      'src/components/AlgoContributionPanel.test.jsx',
    ];
    for (const file of guardFiles) {
      expect(allTests).toContain(file);
      expect(localSnapshotTests).not.toContain(file);
    }
    const guards = readFileSync(join(ROOT, 'src/domain/algoContribution.test.js'), 'utf8');
    expect(guards).toContain('refuses a partial split even when some algos on the roster do carry one');
    expect(guards).toContain('refuses a day whose derived rows add up to more than the account made');
    // The third of the same class, found later and by the same method: dropping
    // the `!== 0` from `anyReported` broke 4 tests, every one of them in a gated
    // file, so on CI the guard was not pinned at all. Its ungated replacement is
    // named here for the same reason as the two above.
    expect(guards).toContain('does not call a flat day reported just because zero equals zero');
  });

  it('points every listed path at a file that exists', () => {
    // A stale entry is worse than no entry: it excludes nothing, and it reads
    // like the file it names is covered.
    for (const file of localSnapshotTests) expect(allTests).toContain(file);
  });
});
