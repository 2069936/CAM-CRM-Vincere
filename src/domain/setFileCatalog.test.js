import { describe, expect, it } from 'vitest';

import {
  catalogInstrumentOf,
  getSetFileCatalog,
  normaliseLiveParameters,
  resolveCatalogFamily,
  setFileById,
  setFileEntries,
  setFilesForFamily,
  setFilesForFamilyInstrument,
  sharedParameterNames,
} from './setFileCatalog';
import { normaliseSetFileValue, SIZING } from './setFileNormalise';

// Every string below is copied out of public/local-snapshot.json or out of the
// desk's set-file library, not invented. The drift panel was wrong for a week
// while its tests passed, so nothing here is a value someone made up.

/**
 * The configuration 62 of 78 URGO / MNQ SEP26 accounts export, verbatim.
 * 31 named parameters.
 */
const URGO_DOMINANT = 'False/30/False/2/True/1/1/2020 4:45:00 PM/False/KEY/True/1/Both/1/1/0/400/450/500/False/1/300/300/1/1/2020 2:00:00 PM/1/1/2020 9:30:00 AM/True/200/25/True/33/2/20/3 (Backtest/BreakEvenAfterTicks/BreakEvenIsOn/BreakEvenOffset/CloseAllOpenTrades/CloseAllOpenTradeTime/EdgeLeverage/LicenseKey/LimitDailyEntries/MaxDailyEntries/MyTradeDirection/PosSize1/PosSize2/PosSize3/ProfitTargetTicks1/ProfitTargetTicks2/ProfitTargetTicks3/ReEntryIsOn/ReEntryWaitBars/StartTrailAfterTicks/StopLossTicks/TradeEndTime/TradeStartTime/TradeWindowIsOn/TrailByTicks/TrailFrequency/TrailIsOn/URGO1/URGO2/URGO3/URGO4)';

/**
 * One account in the same cohort on an older strategy build: same settings, but
 * the export carries 26 names instead of 31 — no EdgeLeverage, LimitDailyEntries,
 * MaxDailyEntries, ReEntryIsOn or ReEntryWaitBars.
 */
const URGO_OLDER_BUILD = 'False/30/False/2/True/1/1/2020 4:45:00 PM/KEY/Both/1/1/0/400/450/500/300/300/1/1/2020 2:00:00 PM/1/1/2020 9:30:00 AM/True/200/25/True/33/2/20/3 (Backtest/BreakEvenAfterTicks/BreakEvenIsOn/BreakEvenOffset/CloseAllOpenTrades/CloseAllOpenTradeTime/LicenseKey/MyTradeDirection/PosSize1/PosSize2/PosSize3/ProfitTargetTicks1/ProfitTargetTicks2/ProfitTargetTicks3/StartTrailAfterTicks/StopLossTicks/TradeEndTime/TradeStartTime/TradeWindowIsOn/TrailByTicks/TrailFrequency/TrailIsOn/URGO1/URGO2/URGO3/URGO4)';

const ANCHOR_ID = 'URGO/1 - URGO (MNQ) - 15 Min Candle - Low Risk - v1 - Period 0';

describe('normaliseSetFileValue', () => {
  it('reads the two datetime dialects as one value', () => {
    // The known format mismatch. Without this every account mismatches every
    // file: nine fields carry times and all nine disagree on format alone.
    expect(normaliseSetFileValue('2020-01-01T16:45:00'))
      .toBe(normaliseSetFileValue('1/1/2020 4:45:00 PM'));
    expect(normaliseSetFileValue('1/1/2020 12:00:00 AM')).toBe('2020-01-01T00:00:00');
    expect(normaliseSetFileValue('1/1/2020 12:00:00 PM')).toBe('2020-01-01T12:00:00');
    expect(normaliseSetFileValue('1/1/2020 9:29:30 AM')).toBe('2020-01-01T09:29:30');
  });

  it('reads the two boolean dialects as one value', () => {
    // 36 of the 113 unmatched values on the real book were only this.
    expect(normaliseSetFileValue('True')).toBe(normaliseSetFileValue('true'));
    expect(normaliseSetFileValue('False')).toBe(normaliseSetFileValue('false'));
  });

  it('does not turn an unknown value into a guess', () => {
    // 40 live values have no catalogued counterpart, and that is the signal the
    // panel exists to show. Normalisation must not quietly erase it.
    expect(normaliseSetFileValue('Target2Hit')).toBe('Target2Hit');
    expect(normaliseSetFileValue('')).toBe('');
  });
});

describe('normaliseLiveParameters', () => {
  it('keeps a timestamp whole instead of splitting it on its slashes', () => {
    const parsed = normaliseLiveParameters(URGO_DOMINANT);
    expect(parsed.CloseAllOpenTradeTime).toBe('2020-01-01T16:45:00');
    expect(parsed.TradeEndTime).toBe('2020-01-01T14:00:00');
    // A '/' split gives 37 fragments against 31 names and every value after the
    // first date lands under the wrong name.
    expect(parsed.StopLossTicks).toBe('300');
    expect(parsed.ProfitTargetTicks1).toBe('400');
  });

  it('drops the per-client licence key', () => {
    expect(normaliseLiveParameters(URGO_DOMINANT)).not.toHaveProperty('LicenseKey');
  });

  it('returns null rather than an empty set when nothing can be read', () => {
    // "Nothing readable" and "an empty configuration" are different answers.
    expect(normaliseLiveParameters('')).toBeNull();
    expect(normaliseLiveParameters(null)).toBeNull();
    expect(normaliseLiveParameters('400/450/500')).toBeNull();
    // Values and names that do not line up are dropped whole, never zipped.
    expect(normaliseLiveParameters('1/2 (A/B/C)')).toBeNull();
  });
});

describe('the URGO anchor', () => {
  const anchor = setFileById(ANCHOR_ID);

  it('is in the catalog with the values the desk verified', () => {
    expect(anchor).not.toBeNull();
    expect(anchor.family).toBe('URGO');
    expect(anchor.instrument).toBe('MNQ');
    expect(anchor.risk).toBe('Low');
    expect(anchor.version).toBe(1);
    expect(anchor.period).toBe(0);
    expect(anchor.parameters.ProfitTargetTicks1).toBe('400');
    expect(anchor.parameters.ProfitTargetTicks2).toBe('450');
    expect(anchor.parameters.ProfitTargetTicks3).toBe('500');
    expect(anchor.parameters.StopLossTicks).toBe('300');
    expect(anchor.parameters.TrailByTicks).toBe('200');
    expect(anchor.parameters.CloseAllOpenTradeTime).toBe('2020-01-01T16:45:00');
    expect(anchor.parameters.PosSize1).toBe('1');
    expect(anchor.parameters.PosSize2).toBe('1');
    expect(anchor.parameters.PosSize3).toBe('0');
  });

  it('matches the configuration 62 of 78 URGO MNQ accounts actually run', () => {
    // The regression test for the whole job. The drift panel independently found
    // 64 of 78 URGO / MNQ SEP26 accounts on this configuration; 62 of those 64
    // run it at this file's sizing, and the other two at Medium sizing.
    const live = normaliseLiveParameters(URGO_DOMINANT);
    const { shared } = sharedParameterNames(live, anchor);
    expect(shared.length).toBe(25);
    expect(shared.every((name) => live[name] === anchor.parameters[name])).toBe(true);
  });

  it('reports how much of the export it could actually compare', () => {
    // 25 of the 31 exported names, and 25 of the file's 32. Presenting that as
    // the same claim as a full match would be the dishonest move.
    const live = normaliseLiveParameters(URGO_DOMINANT);
    const { shared, liveOnly, catalogOnly } = sharedParameterNames(live, anchor);
    expect(Object.keys(live).length).toBe(30);
    expect(anchor.parameterCount).toBe(32);
    expect(shared.length).toBe(25);
    // Five export fields exist in no set file in the library, so no entry can
    // ever be compared on them.
    expect(liveOnly).toEqual([
      'EdgeLeverage', 'LimitDailyEntries', 'MaxDailyEntries', 'ReEntryIsOn', 'ReEntryWaitBars',
    ]);
    expect(catalogOnly.length).toBe(7);
  });

  it('separates a narrower match from a wider one', () => {
    // The account on the older build agrees on every field it exports, but it
    // exports fewer of them. Same verdict, weaker evidence — the caller needs
    // both numbers to say so.
    const older = normaliseLiveParameters(URGO_OLDER_BUILD);
    const wide = sharedParameterNames(normaliseLiveParameters(URGO_DOMINANT), anchor);
    const narrow = sharedParameterNames(older, anchor);
    expect(narrow.shared.every((name) => older[name] === anchor.parameters[name])).toBe(true);
    expect(narrow.shared.length).toBe(25);
    expect(Object.keys(older).length).toBe(25);
    expect(wide.shared.length / 30).toBeLessThan(narrow.shared.length / 25);
  });

  it('shares a version identity with the Medium-risk file at the same version', () => {
    // Two accounts differing only in PosSize are the same version at different
    // sizing. Of 127 config-and-risk combinations on the real book, 17 were only
    // risk, and reporting those as different versions is wrong.
    const medium = setFileById('URGO/2 - URGO (MNQ) - 15 Min Candle - Medium Risk - v1 - Period 0');
    expect(medium).not.toBeNull();
    expect(medium.versionHash).toBe(anchor.versionHash);
    expect(medium.configHash).not.toBe(anchor.configHash);
  });
});

describe('lookups', () => {
  it('resolves the three spellings of a family the book actually uses', () => {
    expect(resolveCatalogFamily('URGO')).toBe('URGO');
    expect(resolveCatalogFamily('Bullet Bot')).toBe('BulletBot');
    expect(resolveCatalogFamily('FSA')).toBe('FossaAssassin');
    expect(resolveCatalogFamily('MST')).toBe('MotusTemplar');
    // strategyFamilyOf produces OGX-PF; the snapshot column says OGX_PF.
    expect(resolveCatalogFamily('OGX-PF')).toBe('OGX_PF');
    expect(resolveCatalogFamily('OGX_PF')).toBe('OGX_PF');
  });

  it('never answers a base family with its prop-firm twin', () => {
    // The bug this guards: familyCode `OGX` is carried by both the OGX and the
    // OGX_PF folders, and one lookup table written in a single pass let the
    // later folder win. `resolveCatalogFamily('OGX')` answered `OGX_PF`, and so
    // did RBO, IFSP, ARPD, SYFY and DJDR — 293 of the 619 latest strategy rows
    // on the real book. The parameters are identical between twins, so nothing
    // mismatched; every one of those accounts would simply have been told it
    // runs a prop-firm file. The name is the ONLY thing that separates them.
    for (const family of ['OGX', 'RBO', 'IFSP', 'ARPD', 'SYFY', 'DJDR', 'PLPI']) {
      expect(resolveCatalogFamily(family)).toBe(family);
      expect(resolveCatalogFamily(`${family}_PF`)).toBe(`${family}_PF`);
    }
    // Short codes still resolve — they are the only name these three have.
    expect(resolveCatalogFamily('FSA')).toBe('FossaAssassin');
    expect(resolveCatalogFamily('TDC')).toBe('TendoCentinel');
  });

  it('says null for a family the library does not hold', () => {
    // G4M runs on 257 strategy rows and has no set files at all. Answering with
    // the nearest string would put a quarter of the book on someone else's algo.
    expect(resolveCatalogFamily('G4M')).toBeNull();
    expect(setFilesForFamily('G4M')).toEqual([]);
    expect(resolveCatalogFamily('')).toBeNull();
  });

  it('reduces a live contract to a catalogued root symbol', () => {
    expect(catalogInstrumentOf('MNQ SEP26')).toBe('MNQ');
    expect(catalogInstrumentOf('MNQ 09-26')).toBe('MNQ');
    expect(catalogInstrumentOf('MNQU6')).toBe('MNQ');
    // M2K contains a digit, so a "letters then digits" rule reads M2KU6 as M.
    expect(catalogInstrumentOf('M2KU6')).toBe('M2K');
    expect(catalogInstrumentOf('MGC AUG26')).toBe('MGC');
    // The full-size NQ contract: the library holds no full-size templates.
    expect(catalogInstrumentOf('NQ SEP26')).toBeNull();
    expect(catalogInstrumentOf('')).toBeNull();
  });

  it('finds a family on an instrument through a live contract string', () => {
    const files = setFilesForFamilyInstrument('URGO', 'MNQ SEP26');
    expect(files.length).toBe(45);
    expect(files.every((entry) => entry.family === 'URGO' && entry.instrument === 'MNQ')).toBe(true);
    expect(setFilesForFamilyInstrument('URGO', 'NQ SEP26')).toEqual([]);
  });
});

describe('the catalog itself', () => {
  const catalog = getSetFileCatalog();

  it('holds every file in the library', () => {
    expect(setFileEntries().length).toBe(911);
    expect(catalog.counts.families).toBe(20);
    expect(catalog.unreadableFiles).toEqual([]);
  });

  it('records the 35 filenames that do not fit the desk pattern', () => {
    // 17 Default.xml plus 18 BulletBot files on a different naming scheme. They
    // are catalogued with nulls, not dropped: they are real configurations.
    expect(catalog.unparsedFilenames.length).toBe(35);
    const defaults = setFileEntries().filter((entry) => entry.isDefaultTemplate);
    expect(defaults.length).toBe(17);
    expect(defaults.every((entry) => entry.risk === null && entry.version === null)).toBe(true);
    const bullet = setFileEntries().filter((entry) => entry.family === 'BulletBot');
    expect(bullet.length).toBe(18);
    expect(bullet.every((entry) => entry.risk === null)).toBe(true);
  });

  it('carries no per-client value', () => {
    for (const config of catalog.configurations) {
      expect(config.parameterNames).not.toContain('LicenseKey');
    }
    expect(catalog.excludedFields.perClient).toEqual(['LicenseKey']);
  });

  it('declares what a parameter match cannot decide', () => {
    // Both measured on the library, not assumed.
    expect(catalog.ambiguity.namedVariants).toBe(292);
    expect(catalog.ambiguity.periodsIdentical).toBe(292);
    expect(catalog.ambiguity.periodsDiffer).toEqual([]);

    // Every _PF variant is parameter-identical to its base, and this assertion is
    // what keeps it that way. Aligning RBO and ARPD to the configuration 53 and 35
    // rows already ran moved the base files first and left the twins behind, and
    // this list caught it: three tuples divergent, pfTwinsIdentical down to 104.
    // The twins were then aligned too. It costs two RBO_PF rows their exact match,
    // correctly — those accounts still run the pre-change values, so they are now
    // reported as differing from a library that moved without them.
    expect(catalog.ambiguity.pfTwinsDiffer).toEqual([]);
    expect(catalog.ambiguity.pfTwinsIdentical).toBe(107);
  });

  it('is smaller than its file count suggests', () => {
    // 911 files, 190 distinct parameter sets, 85 distinct version identities.
    // The matcher's ambiguity depends on these numbers, not on 911.
    //
    // 85, not the 82 counted before the library was aligned: moving RBO's two
    // v1 tuples and ARPD's one away from their _PF twins split three shared
    // version identities into six. It is 82, not the 92 counted before that:
    // `SIZING` matched only `PosSize\d*`, so
    // TendoCentinel's sizing axis — spelled `Position1Size`/`Position2Size`/
    // `Position3Size` — was being read as version identity, and its 5 versions
    // counted as 15, one per risk level. Sizing is the risk level, not the
    // version, so those 15 are 5. No other family moved, and no row on the book
    // changed classification: 619 of 619 identical before and after.
    expect(catalog.counts.distinctConfigurations).toBe(190);
    expect(catalog.counts.distinctVersionIdentities).toBe(85);
    expect(catalog.configurations.length).toBe(190);
  });

  it('treats every spelling of position size as the risk level', () => {
    // The library writes a contract count four ways. Measured across all 911
    // files, these are exactly the fields whose value is a position size, and
    // every one of them must be sizing rather than version identity — otherwise
    // the same version at two risk levels reports as two versions.
    for (const name of ['PosSize1', 'PosSize3', 'PositionSize', 'Position1Size', 'Position3Size', 'ScaleInSize']) {
      expect(SIZING.test(name)).toBe(true);
    }
    // Not everything with "size" in the name: these are thresholds in ticks and
    // a platform flag, and swallowing them would hide real configuration.
    for (const name of ['MinBarSizeTicks', 'MinGapSizeTicks', 'SetOrderQuantity']) {
      expect(SIZING.test(name)).toBe(false);
    }

    // And every sizing field the library actually carries is covered: a file
    // whose sizing spelling is missed compares as a version difference.
    const sizingLike = new Set();
    for (const entry of catalog.entries) {
      for (const name of entry.parameterNames) {
        if (/^(PosSize|Position|ScaleIn)/i.test(name) && /Size$/i.test(name)) sizingLike.add(name);
      }
    }
    expect([...sizingLike].filter((name) => !SIZING.test(name))).toEqual([]);
  });
});
