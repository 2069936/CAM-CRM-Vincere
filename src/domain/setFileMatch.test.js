import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { resolveCatalogFamily, setFileById } from './setFileCatalog';
import { MATCH, buildSetFileMatch, matchStrategyRow } from './setFileMatch';
import { buildConfigDrift, configKeyOf } from './strategyConfigDrift';
import { buildCrmStateFromTables } from './supabaseStore';

// Every number below is read off public/local-snapshot.json, the real redacted
// book, and every parameter string is copied out of it verbatim. The drift panel
// was wrong for a week while its suite was green, so nothing here is invented.

const snapshot = JSON.parse(
  readFileSync(new URL('../../public/local-snapshot.json', import.meta.url), 'utf8'),
);
const { clients } = buildCrmStateFromTables(snapshot.tables);
const view = buildSetFileMatch(clients);

const ANCHOR = 'URGO/1 - URGO (MNQ) - 15 Min Candle - Low Risk - v1 - Period 0.xml';
const ANCHOR_MEDIUM = 'URGO/2 - URGO (MNQ) - 15 Min Candle - Medium Risk - v1 - Period 0.xml';

/** A real Bullet Bot export, verbatim. 12 names, 11 after the licence key. */
const BULLET_BOT = 'False/10/KEY/Short/2/155/1/1/2020 9:29:30 AM/1/1/2020 9:27:00 AM/110/1/1/2020 9:30:20 AM/1/1/2020 9:27:00 AM/True (Backtest/EntryOrderTickOffset/LicenseKey/MyTradeDirection/PositionSize/ProfitTargetTicks/RangeEnd/RangeStart/StopLossTicks/TradeEnd1/TradeStart1/TradeWindow1IsOn)';

const filesOf = (match) => match.variants.flatMap((variant) => variant.files);

describe('the URGO anchor — the regression test for the whole job', () => {
  // Reproduce the drift panel's own grouping, then check the matcher against it.
  // The drift panel finds 78 URGO / MNQ SEP26 rows with 64 on one configuration.
  const cohort = [];
  for (const client of clients) {
    const imports = (client.dailyImports || []).slice()
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const latest = imports[imports.length - 1];
    if (!latest) continue;
    for (const strategy of latest.strategies || []) {
      if ((strategy.strategyFamily || '') !== 'URGO') continue;
      if (strategy.instrument !== 'MNQ SEP26') continue;
      cohort.push({ client, strategy });
    }
  }
  const groups = new Map();
  for (const row of cohort) {
    const key = configKeyOf(row.strategy.parametersRaw);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const dominant = [...groups.values()].sort((a, b) => b.length - a.length)[0];

  const rowFor = (entry) => view.rows.find((row) => row.clientId === entry.client.id
    && row.accountName === (entry.strategy.accountName || '')
    && row.strategyName === (entry.strategy.strategyName || '')
    && row.instrument === entry.strategy.instrument);

  it('reproduces the cohort the drift panel reports', () => {
    expect(cohort.length).toBe(78);
    expect(dominant.length).toBe(64);
  });

  it('puts all 64 on the anchor file — at whatever risk each runs', () => {
    // The stated regression: PT 400/450/500, SL 300, TrailByTicks 200, close
    // 16:45. 62 run it at the anchor's own sizing (PosSize 1/1/0); the other 2
    // run PosSize 2/1/1 and match the Medium Risk file of the SAME version.
    // Both answers are "on version 1" — the drift panel cannot see the second
    // because its key excludes PosSize by design.
    const matched = dominant.map(rowFor);
    expect(matched.every((row) => row && row.classification === MATCH.EXACT)).toBe(true);

    const versions = new Set(matched.map((row) => row.match.versionHash));
    expect(versions.size).toBe(1);

    const onAnchorFile = matched.filter((row) => filesOf(row.match).includes(ANCHOR));
    const onMediumFile = matched.filter((row) => filesOf(row.match).includes(ANCHOR_MEDIUM));
    expect(onAnchorFile.length).toBe(62);
    expect(onMediumFile.length).toBe(2);
    expect(onAnchorFile.length + onMediumFile.length).toBe(64);

    // Same version identity for both halves — the whole point of the split.
    expect(onMediumFile[0].match.versionHash).toBe(onAnchorFile[0].match.versionHash);
    expect(onAnchorFile[0].match.risk).toBe('Low');
    expect(onMediumFile[0].match.risk).toBe('Medium');
    expect(onAnchorFile[0].match.version).toBe(1);
    expect(onMediumFile[0].match.version).toBe(1);
  });

  it('states the field intersection it decided the anchor match on', () => {
    // 25 of the 30 names the export carries, and 25 of the file's 32. Presenting
    // that as the same claim as 31 of 31 would be the dishonest move.
    const row = dominant.map(rowFor).find((entry) => filesOf(entry.match).includes(ANCHOR));
    expect(row.comparedFields).toBe(25);
    expect(row.liveFieldCount).toBe(30);
    expect(row.match.parameterCount).toBe(32);
    expect(row.liveOnly).toEqual([
      'EdgeLeverage', 'LimitDailyEntries', 'MaxDailyEntries', 'ReEntryIsOn', 'ReEntryWaitBars',
    ]);
  });

  it('names the configuration rather than one of its three period files', () => {
    const row = dominant.map(rowFor).find((entry) => filesOf(entry.match).includes(ANCHOR));
    expect(row.match.periods).toEqual([0, 1, 2]);
    expect(row.match.fileCount).toBe(3);
    expect(row.match.label).toBe('URGO (MNQ) · 15 Min Candle · Low Risk · v1');
  });

  it('finds an account the drift panel calls an outlier and the library does not', () => {
    // Indigo Glen exports 25 names instead of 30 — an older strategy build with
    // no EdgeLeverage/LimitDailyEntries/MaxDailyEntries/ReEntryIsOn/
    // ReEntryWaitBars — so the drift panel's key differs and it lands outside
    // the dominant group. It agrees with the anchor on all 25 fields it carries.
    const outside = view.rows.filter((row) => row.bookFamily === 'URGO'
      && row.instrument === 'MNQ SEP26'
      && row.classification === MATCH.EXACT
      && filesOf(row.match).includes(ANCHOR)
      && !dominant.some((entry) => rowFor(entry) === row));
    expect(outside.length).toBe(1);
    expect(outside[0].comparedFields).toBe(25);
    expect(outside[0].liveFieldCount).toBe(25);
  });
});

describe('the whole book', () => {
  it('classifies every latest strategy row exactly once', () => {
    const { totals } = view;
    expect(totals.rows).toBe(619);
    expect(totals.exact + totals.ambiguous + totals.near + totals.none
      + totals.undetermined + totals.notMeasured).toBe(619);
    expect(totals.exact).toBe(398);
    expect(totals.near).toBe(99);
    expect(totals.none).toBe(75);
    expect(totals.ambiguous).toBe(0);
    expect(totals.undetermined).toBe(0);
    expect(totals.notMeasured).toBe(47);
  });

  it('counts accounts and rows separately', () => {
    // 619 rows are 349 client-and-account pairs plus 16 rows carrying no
    // trading account on the import. Two unidentifiable rows are not one
    // account and they are not two either.
    expect(view.totals.accounts).toBe(349);
    expect(view.totals.unnamedRows).toBe(16);
    expect(view.totals.clients).toBe(77);
  });

  it('excludes unmeasurable rows from the denominator', () => {
    // 496 of 572, never 496 of 619: the 47 G4M rows have no library family, and
    // counting them as "not on a catalogued version" would state a measurement
    // that was never made.
    expect(view.totals.measuredRows).toBe(572);
    expect(view.totals.onCatalogedVersion).toBe(496);
  });

  it('reports the field intersection everywhere a match is claimed', () => {
    const matched = view.rows.filter((row) => row.match);
    expect(matched.length).toBeGreaterThan(0);
    expect(matched.every((row) => Number.isInteger(row.comparedFields) && row.comparedFields > 0))
      .toBe(true);
    expect(view.totals.fieldsCompared).toEqual({ min: 11, max: 48, median: 25 });
  });

  it('never claims a match on fewer fields than the floor allows', () => {
    const decided = view.rows.filter((row) => row.classification === MATCH.EXACT
      || row.classification === MATCH.NEAR
      || row.classification === MATCH.NONE);
    expect(decided.every((row) => row.comparedFields >= 8)).toBe(true);
  });
});

describe('what the library cannot speak to', () => {
  it('reports a family with no folder as not measured, never as uncatalogued', () => {
    const g4m = view.families.find((family) => family.family === 'G4M');
    expect(g4m.measured).toBe(false);
    expect(g4m.catalogFamily).toBeNull();
    expect(g4m.rows).toBe(47);
    expect(g4m.none).toBe(0);
    expect(g4m.notMeasured).toBe(47);
    // The denominator is zero, not 47 — nothing was measured, so no share of it
    // can be reported.
    expect(g4m.measuredRows).toBe(0);
    expect(view.notMeasuredFamilies).toEqual([{ family: 'G4M', rows: 47, accounts: 46 }]);
  });

  it('names the reason rather than collapsing four refusals into one', () => {
    const reasons = new Set(view.rows
      .filter((row) => row.classification === MATCH.NOT_MEASURED)
      .map((row) => row.reason));
    expect([...reasons]).toEqual(['family-not-in-library']);
  });

  it('says UNDETERMINED, not NONE, when the export carries nothing readable', () => {
    // 98 rows in the snapshot carry a null parameters_raw. None of them is a
    // latest row today, so this is a guard rather than a live path — and an
    // unreadable export is not evidence that an account runs no catalogued
    // version.
    const row = matchStrategyRow({ strategyFamily: 'URGO', instrument: 'MNQ SEP26', parametersRaw: null });
    expect(row.classification).toBe(MATCH.UNDETERMINED);
    expect(row.reason).toBe('no-readable-parameters');
    expect(row.match).toBeNull();
    expect(row.comparedFields).toBeNull();
  });

  it('says UNDETERMINED when too few fields are shared to tell', () => {
    // The same real Bullet Bot export cut to three parameters. 3 shared fields
    // is not a version identification, and calling it one — in either direction
    // — would be the panel inventing evidence.
    const thin = 'False/10/Short (Backtest/EntryOrderTickOffset/MyTradeDirection)';
    const row = matchStrategyRow({ strategyFamily: 'Bullet Bot', instrument: 'NQ SEP26', parametersRaw: thin });
    expect(row.classification).toBe(MATCH.UNDETERMINED);
    expect(row.reason).toBe('too-few-shared-fields');
    expect(row.comparedFields).toBe(3);
    // Distinct from NONE: the panel must be able to say "cannot tell" instead of
    // "runs nothing catalogued".
    expect(row.classification).not.toBe(MATCH.NONE);
  });

  it('says null for an instrument the library holds no template for', () => {
    // The full-size NQ contract on a family whose files are per-symbol.
    const row = matchStrategyRow({
      strategyFamily: 'URGO',
      instrument: 'NQ SEP26',
      parametersRaw: BULLET_BOT,
    });
    expect(row.classification).toBe(MATCH.NOT_MEASURED);
    expect(row.reason).toBe('instrument-not-in-library');
    expect(row.instrumentRoot).toBeNull();
  });
});

describe('more than one version fitting', () => {
  it('names all of them and what would separate them, instead of picking one', () => {
    // The real Bullet Bot export with MyTradeDirection removed. The library's
    // LONG and SHORT plans are identical in every other parameter, so on the 10
    // remaining fields both fit perfectly — which is a fact about the export,
    // not about the account.
    const withoutDirection = BULLET_BOT
      .replace('KEY/Short/2/', 'KEY/2/')
      .replace('LicenseKey/MyTradeDirection/PositionSize', 'LicenseKey/PositionSize');
    const row = matchStrategyRow({
      strategyFamily: 'Bullet Bot',
      instrument: 'NQ SEP26',
      parametersRaw: withoutDirection,
    });
    expect(row.classification).toBe(MATCH.AMBIGUOUS);
    expect(row.matches.length).toBe(2);
    expect(row.ambiguity).toBe('version');
    expect(row.comparedFields).toBe(10);
    const separating = row.separating.map((field) => field.name);
    expect(separating).toEqual(['MyTradeDirection']);
    // Flagged as outside the export, because the fix differs: a field the
    // export does not carry needs a wider export, not a human reading two
    // values.
    expect(row.separating[0].inLiveExport).toBe(false);
    expect(row.separating[0].values.sort()).toEqual(['Long', 'Short']);
  });
});

describe('near and none', () => {
  it('never calls a row NEAR when its targets or stop differ from the file', () => {
    // Version identity is what separates the two classes: ProfitTargetTicks*
    // and StopLossTicks are the version on this desk.
    const near = view.rows.filter((row) => row.classification === MATCH.NEAR);
    expect(near.length).toBe(99);
    const withIdentityDiff = near.filter((row) => row.differences.some((d) => d.identity));
    expect(withIdentityDiff).toEqual([]);
  });

  it('always names the closest entry and what differs, in both directions', () => {
    const none = view.rows.filter((row) => row.classification === MATCH.NONE);
    expect(none.length).toBe(75);
    expect(none.every((row) => row.match && row.differences.length > 0)).toBe(true);
    // Every NONE row on this book differs on a version-identity field. That is
    // the finding: no catalogued version carries these targets.
    expect(none.every((row) => row.differences.some((d) => d.identity))).toBe(true);
    for (const row of none) {
      for (const difference of row.differences) {
        expect(difference).toHaveProperty('catalogValue');
        expect(difference).toHaveProperty('liveValue');
        expect(difference.catalogValue).not.toBe(difference.liveValue);
      }
    }
  });

  it('reads a Bullet Bot target the library does not carry as NONE, not NEAR', () => {
    // 20 of the 138 Bullet Bot rows run a profit target no plan carries — 30,
    // 60, 70, 82, 90, 110, 125 and 140 against the library's 155 and 205 — while
    // agreeing on all 10 other fields. A "few fields differ" rule would have
    // called every one of them a near miss.
    const bullet = view.rows.filter((row) => row.bookFamily === 'Bullet Bot');
    expect(bullet.length).toBe(138);
    const none = bullet.filter((row) => row.classification === MATCH.NONE);
    expect(none.length).toBe(20);
    expect(none.every((row) => row.differences.length === 1)).toBe(true);
    expect(new Set(none.flatMap((row) => row.differences.map((d) => d.name))))
      .toEqual(new Set(['ProfitTargetTicks']));
    expect([...new Set(none.map((row) => row.differences[0].liveValue))].sort())
      .toEqual(['110', '125', '140', '30', '60', '70', '82', '90']);
  });

  it('leaves the risk level null when the files carrying the configuration disagree', () => {
    // Measured on the library: 2 of the 190 configurations are carried by named
    // variants at DIFFERENT risk levels — `PLPI (PL) 5 Min Candle v4` and `v5`
    // are byte-identical at Medium and at High, PosSize included, so nothing in
    // the parameters can say which of the two an account is on. The rule is
    // null, never a pick: answering `Medium` because it sorts first would tell a
    // CAM a risk level that was never measured.
    //
    // No live row reaches these two today — the book runs no PLPI at all — so
    // the export below is built from the catalogued file's OWN values, in the
    // export's `v1/.../vN (n1/.../nN)` shape. Every value is read from the
    // library, none is invented. Safe to join on '/' only because it was checked
    // that this configuration carries no value containing a slash; the times are
    // already in the normaliser's ISO form.
    const entry = setFileById('PLPI/2 - PLPI (PL) - 5 Min Candle - Medium Risk - v4 - Period 0');
    expect(entry).not.toBeNull();
    const names = [...entry.parameterNames];
    expect(names.some((name) => String(entry.parameters[name]).includes('/'))).toBe(false);
    const parametersRaw = `${names.map((name) => entry.parameters[name]).join('/')} (${names.join('/')})`;

    const row = matchStrategyRow({
      strategyFamily: 'PLPI',
      instrument: 'PL SEP26',
      parametersRaw,
    });
    expect(row.classification).toBe(MATCH.EXACT);
    expect(row.comparedFields).toBe(35);
    // The version IS determined — both variants are v4 — and the risk is not.
    // Two answers of different strength, reported as two different answers.
    expect(row.match.version).toBe(4);
    expect(row.match.risk).toBeNull();
    expect(row.match.variants.map((variant) => variant.risk)).toEqual(['Medium', 'High']);
    // And the label names both rather than the first, because two names for one
    // parameter set is a fact about the library, not a tie to break.
    expect(row.match.label).toBe(
      'PLPI (PL) · 5 Min Candle · Medium Risk · v4  ·  PLPI (PL) · 5 Min Candle · High Risk · v4',
    );
  });

  it('reports the risk level a matched account runs rather than calling it a mismatch', () => {
    const medium = view.rows.filter((row) => row.match?.risk === 'Medium');
    expect(medium.length).toBeGreaterThan(0);
    // Risk is expected to vary per account. A Medium-sizing account matching a
    // Medium file is EXACT, not NEAR, and its sizing is never in the diff.
    for (const row of medium) {
      expect(row.differences.filter((difference) => difference.sizing)).toEqual([]);
    }
  });
});

describe('the roll-ups a manager reads', () => {
  it('rolls up per family with its own denominator', () => {
    const byFamily = new Map(view.families.map((family) => [family.family, family]));
    expect(byFamily.get('Bullet Bot')).toMatchObject({ rows: 138, exact: 118, none: 20, near: 0 });
    expect(byFamily.get('IFSP')).toMatchObject({ rows: 95, exact: 78, near: 16, none: 1 });
    expect(byFamily.get('URGO')).toMatchObject({ rows: 89, exact: 72, near: 12, none: 5 });
    expect(byFamily.get('RBO')).toMatchObject({ rows: 54, exact: 43, near: 10, none: 1 });
    expect(byFamily.get('B2X')).toMatchObject({ rows: 38, exact: 28, near: 6, none: 4 });
    // The book spells three families differently from the library.
    expect(byFamily.get('Bullet Bot').catalogFamily).toBe('BulletBot');
    // And a base family must not resolve to its prop-firm twin: they are
    // parameter-identical, so the name is all that separates them.
    expect(byFamily.get('OGX').catalogFamily).toBe('OGX');
    expect(byFamily.get('OGX_PF').catalogFamily).toBe('OGX_PF');
  });

  it('rolls up per instrument, flagging the symbols the library has no template for', () => {
    const byInstrument = new Map(view.instruments.map((row) => [row.instrument, row]));
    expect(byInstrument.get('MNQ')).toMatchObject({ rows: 154, catalogued: true });
    expect(byInstrument.get('NG')).toMatchObject({ rows: 110, catalogued: true });
    // Bullet Bot runs the full-size NQ contract and the library holds no
    // full-size template, so the symbol is grouped for display and flagged.
    expect(byInstrument.get('NQ')).toMatchObject({ rows: 137, catalogued: false });
    expect(view.instruments.reduce((sum, row) => sum + row.rows, 0)).toBe(619);
  });

  it('finds the question a whole family shares', () => {
    // This assertion is what the roll-up is FOR, and it has now caught the thing
    // twice over.
    //
    // It first read 43 of RBO's 54 rows differing from their closest file in the
    // same two settings with the same values — BreakEvenOffset 50 to 25 and
    // EntryOrderTickOffset 1 to 0. One question about whether the library was
    // behind the book, not 43 questions about clients. The library was aligned to
    // those two values, and those 43 rows became exact matches.
    //
    // What is left is the next question down, and only that one: 10 rows on the
    // same version differing on the close time alone. It stands because the desk
    // does not agree on a value — 41 RBO rows close at 16:50 and these 10 at
    // 16:30 — so no edit to the library can settle it. The same split runs
    // through ARPD, B2X, URGO, IFSP and OGX.
    const rbo = view.families.find((family) => family.family === 'RBO');
    expect(rbo.recurring.rows).toBe(10);
    expect(rbo.recurring.names).toEqual(['CloseAllOpenTradeTime']);
    expect(rbo.recurring.sameValues).toBe(true);
    expect(rbo.recurring.changes[0]).toEqual({
      name: 'CloseAllOpenTradeTime',
      catalogValues: ['2020-01-01T16:50:00'],
      liveValues: ['2020-01-01T16:30:00'],
    });
  });

  it('does not report one row\'s value as the family\'s when they differ', () => {
    // Bullet Bot's 20 differing rows share the field and not the value. Stating
    // `ProfitTargetTicks 155 → 70` for all 20 would show 19 of them a number
    // they do not run.
    const bullet = view.families.find((family) => family.family === 'Bullet Bot');
    expect(bullet.recurring.rows).toBe(20);
    expect(bullet.recurring.names).toEqual(['ProfitTargetTicks']);
    expect(bullet.recurring.sameValues).toBe(false);
    expect(bullet.recurring.changes[0].liveValues.length).toBe(8);
    expect(bullet.recurring.changes[0].catalogValues).toEqual(['155', '205']);
  });

  it('carries the catalog\'s own admission of what it cannot decide', () => {
    expect(view.catalogProvenance.files).toBe(911);
    expect(view.catalogProvenance.distinctConfigurations).toBe(190);
    expect(view.catalogProvenance.ambiguity.periodsIdentical).toBe(292);
    expect(view.catalogProvenance.ambiguity.pfTwinsIdentical).toBe(107);
  });
});

describe('agreement with the drift panel', () => {
  it('leaves no drift-panel dominant configuration uncatalogued without a reason', () => {
    // Both panels read the same book. Where the drift panel says a large cohort
    // agrees, the matcher should be able to name what they agree on — or say
    // why it cannot. This is the check that the two do not quietly disagree.
    const drift = buildConfigDrift(clients);
    expect(drift.length).toBeGreaterThan(0);
    for (const row of drift) {
      // The two panels reach the family by different routes — the drift panel
      // reads `0 - OGX-PF-2.4` off the strategy name, the matcher reads the
      // import's own `strategy_family` column — so they are compared on the
      // library folder both resolve to.
      const family = resolveCatalogFamily(row.family);
      const rows = view.rows.filter((entry) => entry.catalogFamily === family
        && entry.instrument === row.instrument);
      if (!family) continue;
      expect(rows.length).toBeGreaterThan(0);
      const measured = rows.filter((entry) => entry.classification !== MATCH.NOT_MEASURED);
      // Either the family is in the library and every row was compared, or it
      // is not and none of them was. A partial answer would mean the family
      // resolution is inconsistent.
      expect(measured.length === rows.length || measured.length === 0).toBe(true);
    }
  });

  it('is empty and honest when there is nothing to read', () => {
    const empty = buildSetFileMatch([]);
    expect(empty.rows).toEqual([]);
    expect(empty.families).toEqual([]);
    expect(empty.totals.rows).toBe(0);
    // No rows compared means no range to report — null, never 0.
    expect(empty.totals.fieldsCompared).toBeNull();
  });
});
