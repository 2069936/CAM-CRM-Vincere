// The book-backed half of quietAccounts's suite.
//
// Split out for one reason: it reads public/local-snapshot.json, so
// vite.config.js drops it on every clone that does not hold the export. A test
// that only runs here is not a test CI can hold anyone to, and the synthetic
// half of this suite was being dropped alongside it for no reason at all. The
// rules live in quietAccounts.test.js, which runs everywhere; the NUMBERS
// live here, where the book is.

// The fixtures pin the RULES — an account that did not exist yet, a client that
// filed nothing, a buffer that reads exactly 0 — because those cases are one or
// two rows each on the real data and a regression in them would not move a
// single headline number. They are in quietAccounts.test.js. The assertions
// below pin the NUMBERS: every one was read off printed output before it was
// written down, and they are what would catch a change that keeps every fixture
// green while quietly reclassifying 40 accounts.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { QUIET_SHAPES, buildQuietAccounts, quietEvidenceForFlag } from './quietAccounts';
import { buildCamFlagQueue } from './camFlagQueue';
import { buildCrmStateFromTables } from './supabaseStore';

const snapshot = JSON.parse(
  readFileSync(new URL('../../public/local-snapshot.json', import.meta.url), 'utf8'),
);
const realClients = buildCrmStateFromTables(snapshot.tables).clients;

describe('the real book', () => {
  const model = buildQuietAccounts(realClients);

  it('finds the accounts that went quiet, split by what the last close said', () => {
    expect(model.asOf).toBe('2026-07-30');
    expect(model.counts.quiet).toBe(122);
    expect(model.counts.quietShapes[QUIET_SHAPES.HEALTHY]).toBe(80);
    expect(model.counts.quietShapes[QUIET_SHAPES.PAST_DRAWDOWN]).toBe(42);
    // Two thirds of them were inside their drawdown when they stopped, which is
    // the whole reason "missing" may not be rendered as "failed".
    expect(model.counts.quietShapes[QUIET_SHAPES.HEALTHY])
      .toBeGreaterThan(model.counts.quietShapes[QUIET_SHAPES.PAST_DRAWDOWN]);
  });

  it('keeps the shelved, the unregistered and the not-yet-registered out of that count', () => {
    expect(model.countedApart).toEqual({
      ignore: 84, simulation: 0, notYetRegistered: 7, existenceUnknown: 0, unregistered: 33,
    });
  });

  /**
   * The headline is 122 and the measured answer is 195, and the panel has to say
   * both. Recomputed from public/local-snapshot.json with a script that imports
   * nothing from this module: 195 accounts filed nothing for two or more of
   * their client's own closes, 61 of them shelved as Inactive / Ignore and 12
   * with no registry row. 122 + 61 + 12 = 195, and a headline that printed only
   * 122 against a denominator of 718 stated the listed count as the measured one
   * while the block at the foot of the same panel counted 84 shelved accounts.
   */
  it('counts every account that went quiet, not only the ones worth listing', () => {
    expect(model.counts.quietOnRecord).toBe(195);
    expect(model.counts.quiet).toBe(122);
    expect(model.setAsideQuiet).toEqual({ ignore: 61, simulation: 0, unregistered: 12 });
    expect(model.counts.quietSetAside).toBe(73);
    expect(model.counts.quiet + model.counts.quietSetAside).toBe(model.counts.quietOnRecord);
    // 84 accounts are shelved; 61 of them went quiet. Those are different
    // numbers and the panel prints both.
    expect(model.countedApart.ignore).toBe(84);
  });

  /**
   * A client with no import at all cannot have an account that is absent from
   * one of its closes, so it can never appear in `clientsWithQuiet`. 84 of the
   * 96 clients here have closes; the 12 that do not hold 0 registered accounts
   * between them, which is why nothing is hidden by leaving them out.
   */
  it('measures "clients with a quiet account" against the clients that have closes', () => {
    expect(model.counts.clients).toBe(96);
    expect(model.counts.clientsWithCloses).toBe(84);
    expect(model.counts.clientsWithQuiet).toBe(32);
  });

  /**
   * The two rows whose buffer is older than the close they went quiet on.
   *
   * Judged on the last close each account filed, the 195 split 52 breached /
   * 139 healthy / 4 never measured. Judged on the last close that carried a
   * trailing-drawdown column — which is what accountLifecycle.readingOf gives,
   * because it reads 0 as "no column" — it is 52 / 141 / 2. The two accounts
   * that move are both Harper Juniper's, and both carry a buffer read 7 and 14
   * days before they went quiet. The row must say so: "healthy when it went
   * quiet" on a fortnight-old reading is the one claim on this panel that can
   * send a CAM away from an account that is already past its limit.
   */
  it('flags a buffer that was read on an earlier close than the one it went quiet on', () => {
    const stale = model.accounts.filter(
      (row) => row.buffer.value !== null && !row.buffer.fromLastSeenClose,
    );
    expect(stale).toHaveLength(2);
    expect(stale.map((row) => row.accountName).sort()).toEqual([
      'CCF23009250154227', 'EKG54594881787638',
    ]);
    for (const row of stale) {
      expect(row.buffer.date).toBe('2026-07-13');
      expect(row.buffer.date < row.lastSeenDate).toBe(true);
      expect(row.evidenceLine).toContain('that reading is from 2026-07-13');
    }
    // And every other row's buffer really is from the close it went quiet on, so
    // the absence of the badge is a statement too.
    for (const row of model.accounts) {
      if (row.buffer.value === null) continue;
      if (stale.includes(row)) continue;
      expect(row.buffer.date).toBe(row.lastSeenDate);
    }
  });

  it('reports the clients that stopped filing as clients, not as accounts', () => {
    expect(model.counts.stoppedFiling).toBe(24);
    expect(model.counts.stoppedFilingAccounts).toBe(136);
    // 5 of the 24 have imports and have never filed a single account row.
    expect(model.collection.stoppedFiling.filter((entry) => entry.neverFiledAnyRow)).toHaveLength(5);
  });

  it('finds that not one of the 8 zero-row closes covers an account that existed', () => {
    expect(model.counts.filedNothing).toBe(8);
    // The measurement that changes the reading: those closes look like lost days
    // and are not. 22 registry rows on those clients were added AFTER the close
    // they are flagged absent from.
    expect(model.counts.filedNothingAccounts).toBe(0);
    expect(model.counts.filedNothingNotYetRegistered).toBe(22);
  });

  it('groups accounts that stopped on the same close of the same client', () => {
    expect(model.counts.accountsInCohortsOfThreeOrMore).toBe(60);
    const biggest = model.cohorts[0];
    expect(biggest.accounts).toBe(13);
    expect(biggest.lastSeenDate).toBe('2026-07-22');
    expect(biggest.reportedThatClose).toBe(20);
    // One close where every account that filed it never filed again.
    expect(model.counts.cohortsWholeClose).toBe(1);
  });

  it('holds the $148,223 account that was healthy and vanished', () => {
    const row = model.accounts.find((entry) => entry.balanceThen === 148223);
    expect(row.shape).toBe(QUIET_SHAPES.HEALTHY);
    expect(row.evidenceLine).toBe(
      'Last seen 2026-07-13 with $2,171 of buffer left on a $148,223 balance — absent for the 7 closes since.',
    );
  });

  it('answers every open Missing account flag the book carries', () => {
    const queue = buildCamFlagQueue(realClients, { today: '2026-08-11' });
    const rows = queue.groups
      .filter((group) => group.type === 'Missing account')
      .flatMap((group) => group.rows);
    expect(rows).toHaveLength(106);

    const tally = {};
    let unanswered = 0;
    for (const row of rows) {
      const evidence = quietEvidenceForFlag(model, row);
      if (!evidence) { unanswered += 1; continue; }
      tally[evidence.shape] = (tally[evidence.shape] || 0) + 1;
    }
    // 2 name an account with no registry row and no snapshot under that name.
    expect(unanswered).toBe(2);
    expect(tally).toEqual({
      [QUIET_SHAPES.HEALTHY]: 42,
      [QUIET_SHAPES.PAST_DRAWDOWN]: 24,
      [QUIET_SHAPES.NOT_YET_REGISTERED]: 20,
      [QUIET_SHAPES.NEVER_REPORTED]: 12,
      [QUIET_SHAPES.REPORTING_AGAIN]: 6,
    });
    // 38 of the 106 — a third of the queue — are flags with nothing behind them:
    // the account did not exist on that close, has never reported at all, or is
    // back in the client's latest close.
    const nothingToDo = tally[QUIET_SHAPES.NOT_YET_REGISTERED]
      + tally[QUIET_SHAPES.NEVER_REPORTED]
      + tally[QUIET_SHAPES.REPORTING_AGAIN];
    expect(nothingToDo).toBe(38);
  });

  /**
   * `buffer.fromLastSeenClose` claims "the buffer quoted on this row was read on
   * the same close the account was last seen on". An account that has never
   * appeared in any close has no last close and no reading, so the only honest
   * answer is false — house rule 2 applied to a boolean.
   *
   * Dropping the `date !== null` guard flips it to true on exactly these 29 rows
   * (null === null), which is the field asserting that a reading that does not
   * exist was taken on a close that does not exist. Nothing renders it today:
   * both call sites — evidenceLineOf and the panel's "that reading is from"
   * branch — gate on `buffer.date` being truthy first, so all 29 short-circuit
   * before reaching it, and the mutation moves nothing on screen. This pins the
   * row contract rather than the rendering, because the row is exported through
   * `evidenceByAccount` and read by CamFlagQueue, where the next consumer that
   * trusts the boolean on its own would be told something false about 29 of the
   * 718 accounts on this book.
   */
  it('never claims a reading came from the last close when there is neither', () => {
    const neverSeen = [...model.evidenceByAccount.values()]
      .filter((row) => row.shape === QUIET_SHAPES.NEVER_REPORTED);
    expect(neverSeen).toHaveLength(29);
    for (const row of neverSeen) {
      expect(row.lastSeenDate).toBeNull();
      expect(row.buffer.date).toBeNull();
      expect(row.buffer.value).toBeNull();
      expect(row.buffer.fromLastSeenClose).toBe(false);
    }
  });

  it('is a measured zero on simulation accounts, not an unchecked one', () => {
    // The redaction renames every account, and NinjaTrader's Sim<number> naming
    // is the only signal that recognises a simulator today (11 of 11 on the
    // unredacted exports). A non-zero here would mean the classifier changed.
    expect(model.counts.simulation).toBe(0);
    expect(model.counts.simulationUndetermined).toBe(0);
  });
});
