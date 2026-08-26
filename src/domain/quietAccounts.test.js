import { describe, expect, it } from 'vitest';
import {
  QUIET_SHAPES,
  buildQuietAccounts,
  quietEvidenceForFlag,
  shapeOf,
} from './quietAccounts';

/**
 * Half of this file is synthetic and half is the real redacted book, and the two
 * halves check different things. The fixtures pin the RULES — an account that
 * did not exist yet, a client that filed nothing, a buffer that reads exactly 0
 * — because those cases are one or two rows each on the real data and a
 * regression in them would not move a single headline number. The real-book
 * assertions pin the NUMBERS, because every one of them was read off printed
 * output before it was written down here, and they are what would catch a change
 * that keeps every fixture green while quietly reclassifying 40 accounts.
 */

function close(date, rows, extra = {}) {
  return {
    id: `import-${date}`,
    date,
    snapshots: rows.map((row) => ({
      accountName: row.name,
      accountBalance: row.balance ?? 50000,
      grossRealizedPnl: row.pnl ?? 0,
      trailingMaxDrawdown: row.dd ?? 0,
    })),
    orders: [],
    executions: [],
    strategies: [],
    flags: [],
    ...extra,
  };
}

function client(id, registry, closes) {
  return { id, name: id, accountRegistry: registry, dailyImports: closes };
}

const meta = (overrides = {}) => ({
  accountName: 'A',
  alias: 'A',
  accountType: 'Funded',
  status: 'Active',
  dateAdded: '2026-01-01',
  maxDrawdownLimit: '',
  ...overrides,
});

describe('shape of a quiet account', () => {
  const base = {
    seenCloses: 3,
    closesSinceSeen: 4,
    cash: false,
    drawdown: { value: 1200, breached: false, date: '2026-07-13' },
  };

  it('is healthy when the last reading was inside the limit', () => {
    expect(shapeOf(base)).toBe(QUIET_SHAPES.HEALTHY);
  });

  it('is past-drawdown when the last reading was a breach', () => {
    expect(shapeOf({ ...base, drawdown: { value: -19, breached: true, date: '2026-07-17' } }))
      .toBe(QUIET_SHAPES.PAST_DRAWDOWN);
  });

  // The defect this whole module is built around: a trailing drawdown of
  // exactly 0 is the import having no column, not a buffer of nothing left.
  it('is never-measured, not zero-buffer, when nothing was ever read', () => {
    expect(shapeOf({ ...base, drawdown: { value: null, breached: null, date: null } }))
      .toBe(QUIET_SHAPES.NEVER_MEASURED);
  });

  it('separates cash, which has no trailing rule to be inside or outside', () => {
    expect(shapeOf({ ...base, cash: true, drawdown: { value: null, breached: null, date: null } }))
      .toBe(QUIET_SHAPES.NO_DRAWDOWN_RULE);
  });

  it('says never-reported before it says anything about a reading', () => {
    expect(shapeOf({ ...base, seenCloses: 0, closesSinceSeen: null }))
      .toBe(QUIET_SHAPES.NEVER_REPORTED);
  });

  it('says reporting-again before it says anything about a reading', () => {
    expect(shapeOf({ ...base, closesSinceSeen: 0 })).toBe(QUIET_SHAPES.REPORTING_AGAIN);
  });
});

describe('the evidence a row carries', () => {
  // KEEP files on every close throughout, so the client is being collected and
  // the two absences below are the accounts' own.
  const model = buildQuietAccounts([
    client('c1', {
      HEALTHY: meta({ accountName: 'HEALTHY' }),
      BREACHED: meta({ accountName: 'BREACHED' }),
      KEEP: meta({ accountName: 'KEEP' }),
    }, [
      close('2026-07-13', [
        { name: 'HEALTHY', balance: 148223, dd: 2171 },
        { name: 'BREACHED', balance: 47980, dd: -19 },
        { name: 'KEEP', dd: 900 },
      ]),
      close('2026-07-14', [{ name: 'KEEP', dd: 900 }]),
      close('2026-07-15', [{ name: 'KEEP', dd: 900 }]),
    ]),
  ]);

  const rowFor = (name) => model.accounts.find((row) => row.accountName === name);

  it('carries the last close, the reading THEN, the balance THEN and the gap', () => {
    const row = rowFor('HEALTHY');
    expect(row.lastSeenDate).toBe('2026-07-13');
    expect(row.buffer.value).toBe(2171);
    expect(row.balanceThen).toBe(148223);
    expect(row.closesSinceSeen).toBe(2);
    expect(row.closes).toBe(3);
  });

  it('reads the two shapes differently in the first six words', () => {
    expect(rowFor('HEALTHY').evidenceLine).toBe(
      'Last seen 2026-07-13 with $2,171 of buffer left on a $148,223 balance — absent for the 2 closes since.',
    );
    expect(rowFor('BREACHED').evidenceLine).toBe(
      'Last seen 2026-07-13 already $19 past its trailing drawdown on a $47,980 balance — absent for the 2 closes since.',
    );
  });

  // "Failed" is a verdict and this module is not allowed to reach one.
  it('never uses the word failed about a breach', () => {
    for (const row of model.accounts) expect(row.evidenceLine.toLowerCase()).not.toContain('fail');
  });

  it('dates the reading separately when it is older than the last close', () => {
    // A last close whose drawdown column reads exactly 0: the account filed, but
    // its buffer was not measured that day, so the last MEASURED reading is the
    // earlier one and the row has to say so instead of quoting the wrong date.
    const drifted = buildQuietAccounts([
      client('c2', { A: meta({ accountName: 'A' }), KEEP: meta({ accountName: 'KEEP' }) }, [
        close('2026-07-13', [{ name: 'A', balance: 50000, dd: 900 }, { name: 'KEEP', dd: 900 }]),
        close('2026-07-14', [{ name: 'A', balance: 50000, dd: 0 }, { name: 'KEEP', dd: 900 }]),
        close('2026-07-15', [{ name: 'KEEP', dd: 900 }]),
        close('2026-07-16', [{ name: 'KEEP', dd: 900 }]),
      ]),
    ]);
    const row = drifted.accounts.find((entry) => entry.accountName === 'A');
    expect(row.lastSeenDate).toBe('2026-07-14');
    expect(row.buffer.date).toBe('2026-07-13');
    expect(row.buffer.fromLastSeenClose).toBe(false);
    expect(row.evidenceLine).toContain('that reading is from 2026-07-13');
  });

  it('reports a buffer that was never measured as never measured, not as zero', () => {
    const unmeasured = buildQuietAccounts([
      client('c3', { A: meta({ accountName: 'A' }), KEEP: meta({ accountName: 'KEEP' }) }, [
        close('2026-07-13', [{ name: 'A', balance: 50000, dd: 0 }, { name: 'KEEP', dd: 900 }]),
        close('2026-07-14', [{ name: 'KEEP', dd: 900 }]),
        close('2026-07-15', [{ name: 'KEEP', dd: 900 }]),
      ]),
    ]);
    const row = unmeasured.accounts.find((entry) => entry.accountName === 'A');
    expect(row.shape).toBe(QUIET_SHAPES.NEVER_MEASURED);
    expect(row.buffer.value).toBeNull();
    expect(row.evidenceLine).toContain('buffer never measured');
    expect(row.evidenceLine).not.toContain('$0');
  });
});

describe('a client going dark is one problem, not N', () => {
  it('does not list accounts of a client that filed no import at all', () => {
    // Two clients, one desk calendar. The second stops filing after 07-13, so
    // its accounts have no close of their own to be absent from and would look
    // perfect to any per-client rule.
    const model = buildQuietAccounts([
      client('busy', { X: meta({ accountName: 'X' }) }, [
        close('2026-07-13', [{ name: 'X', dd: 900 }]),
        close('2026-07-14', [{ name: 'X', dd: 900 }]),
        close('2026-07-15', [{ name: 'X', dd: 900 }]),
      ]),
      client('gone', { Y: meta({ accountName: 'Y' }), Z: meta({ accountName: 'Z' }) }, [
        close('2026-07-13', [{ name: 'Y', dd: 900 }, { name: 'Z', dd: 900 }]),
      ]),
    ]);
    expect(model.accounts).toHaveLength(0);
    expect(model.collection.stoppedFiling).toHaveLength(1);
    expect(model.collection.stoppedFiling[0]).toMatchObject({
      clientId: 'gone',
      lastFiled: '2026-07-13',
      deskDatesMissed: 2,
      deskDates: 3,
      registered: 2,
    });
  });

  it('counts a close with an import and no account rows once, with its coverage', () => {
    const model = buildQuietAccounts([
      client('c', { A: meta({ accountName: 'A' }), B: meta({ accountName: 'B', dateAdded: '2026-07-20' }) }, [
        close('2026-07-13', [{ name: 'A', dd: 900 }]),
        close('2026-07-14', []),
        close('2026-07-15', []),
      ]),
    ]);
    expect(model.collection.filedNothing).toHaveLength(2);
    // A existed on 07-14, B was added on 07-20 and could not have filed.
    expect(model.collection.filedNothing[0]).toMatchObject({
      date: '2026-07-14',
      accountsCovered: 1,
      notYetRegistered: 1,
      registered: 2,
    });
  });

  it('marks a cohort where every account that filed a close stopped on it', () => {
    const model = buildQuietAccounts([
      client('c', {
        A: meta({ accountName: 'A' }), B: meta({ accountName: 'B' }), C: meta({ accountName: 'C' }),
      }, [
        close('2026-07-13', [{ name: 'A', dd: 900 }, { name: 'B', dd: 900 }, { name: 'C', dd: 900 }]),
        close('2026-07-14', []),
        close('2026-07-15', []),
      ]),
    ]);
    expect(model.cohorts).toHaveLength(1);
    expect(model.cohorts[0]).toMatchObject({
      accounts: 3,
      reportedThatClose: 3,
      neverReturnedThatClose: 3,
      wholeClose: true,
    });
  });
});

describe('what is never listed as gone quiet', () => {
  const registry = {
    SHELF: meta({ accountName: 'SHELF', accountType: 'Inactive / Ignore' }),
    SIM101: meta({ accountName: 'Sim101', accountType: 'Unassigned' }),
    LATER: meta({ accountName: 'LATER', dateAdded: '2026-08-01' }),
    REAL: meta({ accountName: 'REAL' }),
  };
  const model = buildQuietAccounts([
    client('c', { ...registry, Sim101: registry.SIM101 }, [
      close('2026-07-13', [{ name: 'SHELF', dd: 900 }, { name: 'REAL', dd: 900 }]),
      close('2026-07-14', []),
      close('2026-07-15', []),
    ]),
  ]);

  it('lists the real one and counts the rest apart', () => {
    expect(model.accounts.map((row) => row.accountName)).toEqual(['REAL']);
    expect(model.countedApart.ignore).toBe(1);
    expect(model.countedApart.simulation).toBe(1);
    expect(model.countedApart.notYetRegistered).toBe(1);
  });

  it('puts the simulation account in its own list rather than dropping it', () => {
    expect(model.simulation.map((row) => row.accountName)).toContain('Sim101');
    // Never loaded in any close: null, and never a $0 balance nobody reported.
    expect(model.simulation[0].balance).toBeNull();
    expect(model.simulation[0].heuristic).toBe(true);
  });

  /**
   * A simulator that REPORTED and then stopped — the only case in which the
   * simulation guard actually decides anything.
   *
   * The fixture above cannot test it: its Sim101 never appears in a close, so it
   * is never-reported and could not reach the gone-list however the guard is
   * written. The real book cannot test it either — redaction renames every
   * account and `Sim<number>` is the only signal that recognises a simulator
   * today, so it fires on 0 of the 685 registry rows here. Between the two, the
   * guard was load-bearing and unexercised: deleting its `continue` kept all
   * 1,922 tests green while a play-money account joined 122 real ones on a list
   * a CAM works through.
   *
   * A simulator is absent from most closes BY DESIGN — it only appears in the
   * grid while somebody has it loaded — which is why absence must never be read
   * as a finding for one.
   */
  it('keeps a simulator that stopped reporting off the gone-list', () => {
    const withGap = buildQuietAccounts([
      client('c', {
        Sim101: meta({ accountName: 'Sim101', accountType: 'Unassigned' }),
        REAL: meta({ accountName: 'REAL' }),
        KEEP: meta({ accountName: 'KEEP' }),
      }, [
        close('2026-07-13', [
          { name: 'Sim101', dd: 900 }, { name: 'REAL', dd: 900 }, { name: 'KEEP', dd: 900 },
        ]),
        close('2026-07-14', [{ name: 'KEEP', dd: 900 }]),
        close('2026-07-15', [{ name: 'KEEP', dd: 900 }]),
      ]),
    ]);
    // Both went quiet on the same close and by the same measure. Only the real
    // one is a finding.
    expect(withGap.accounts.map((row) => row.accountName)).toEqual(['REAL']);
    expect(withGap.countedApart.simulation).toBe(1);
    // Counted as set aside, not silently dropped: 2 accounts met the absence
    // test, 1 is listed, and the panel has to be able to say where the other went.
    expect(withGap.setAsideQuiet.simulation).toBe(1);
    expect(withGap.counts.quietOnRecord).toBe(2);
    expect(withGap.counts.quiet).toBe(1);
    expect(withGap.simulation.map((row) => row.accountName)).toContain('Sim101');
  });
});

describe('the evidence behind a Missing account flag', () => {
  const flagRow = (clientId, accountName, lastSeen) => ({ clientId, accountName, lastSeen });

  it('answers a flag standing on a close the account did not exist on', () => {
    const model = buildQuietAccounts([
      client('c', { NEW: meta({ accountName: 'NEW', dateAdded: '2026-07-16' }) }, [
        close('2026-07-13', []),
      ]),
    ]);
    const evidence = quietEvidenceForFlag(model, flagRow('c', 'NEW', '2026-07-13'));
    expect(evidence.shape).toBe(QUIET_SHAPES.NOT_YET_REGISTERED);
    expect(evidence.evidenceLine).toContain('2026-07-16');
    expect(evidence.evidenceLine).toContain('could not have appeared');
    // The collection fact is carried beside it, never instead of it.
    expect(evidence.collection.date).toBe('2026-07-13');
  });

  it('answers a flag on an account that is reporting again', () => {
    // KEEP files on every close, so the client is collecting normally and A's
    // gap is A's own. A close with no rows at all is a different finding and is
    // covered by the collection tests above.
    const model = buildQuietAccounts([
      client('c', { A: meta({ accountName: 'A' }), KEEP: meta({ accountName: 'KEEP' }) }, [
        close('2026-07-13', [{ name: 'A', dd: 900 }, { name: 'KEEP', dd: 900 }]),
        close('2026-07-14', [{ name: 'KEEP', dd: 900 }]),
        close('2026-07-15', [{ name: 'A', dd: 900 }, { name: 'KEEP', dd: 900 }]),
      ]),
    ]);
    const evidence = quietEvidenceForFlag(model, flagRow('c', 'A', '2026-07-14'));
    expect(evidence.shape).toBe(QUIET_SHAPES.REPORTING_AGAIN);
    expect(evidence.evidenceLine).toContain('Nothing is missing now');
  });

  // A sentence invented for an account nobody can see would be the same defect
  // in the other direction.
  it('returns null rather than a reassuring sentence for an account it cannot find', () => {
    const model = buildQuietAccounts([
      client('c', { KEEP: meta({ accountName: 'KEEP' }) }, [
        close('2026-07-13', [{ name: 'KEEP', dd: 900 }]),
      ]),
    ]);
    expect(quietEvidenceForFlag(model, flagRow('c', 'GHOST', '2026-07-13'))).toBeNull();
  });

  it('matches the flag account name case-insensitively', () => {
    const model = buildQuietAccounts([
      client('c', { Abc: meta({ accountName: 'Abc' }), KEEP: meta({ accountName: 'KEEP' }) }, [
        close('2026-07-13', [{ name: 'Abc', dd: 900 }, { name: 'KEEP', dd: 900 }]),
        close('2026-07-14', [{ name: 'KEEP', dd: 900 }]),
        close('2026-07-15', [{ name: 'KEEP', dd: 900 }]),
      ]),
    ]);
    expect(quietEvidenceForFlag(model, flagRow('c', 'ABC', '2026-07-15')).shape)
      .toBe(QUIET_SHAPES.HEALTHY);
  });

  /**
   * The distinction the current flag cannot make, on the row itself: the account
   * did not go quiet, the client stopped being collected. Nothing about the
   * account's own state is asserted.
   */
  it('says so when every close an account has missed carried no rows at all', () => {
    const model = buildQuietAccounts([
      client('c', { A: meta({ accountName: 'A' }) }, [
        close('2026-07-13', [{ name: 'A', balance: 50000, dd: 900 }]),
        close('2026-07-14', []),
        close('2026-07-15', []),
      ]),
    ]);
    const row = model.accounts[0];
    expect(row.absentClosesWithRows).toBe(0);
    expect(row.evidenceLine).toBe(
      'Last seen 2026-07-13, and every one of the 2 closes since carried no account rows at all. Nothing here is about this account.',
    );
  });
});

/**
 * Everything below was read off printed output against public/local-snapshot.json
 * before it was written here. 96 clients, 685 registry rows, 485 closes,
 * 14 trading dates, last close 2026-07-30.
 */
