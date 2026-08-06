import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import SetFileMatchPanel from './SetFileMatchPanel';
import { buildCrmStateFromTables } from '../domain/supabaseStore';

// Rendered against public/local-snapshot.json, the real redacted book: 619
// latest strategy rows, 400 exact matches, 97 on a version with settings
// changed, 75 on no catalogued version, 47 not measured. The assertions are on
// what a CAM actually reads, because that is where the last panel's bugs were —
// 192 of 267 findings were computed correctly and never painted.

const snapshot = JSON.parse(
  readFileSync(new URL('../../public/local-snapshot.json', import.meta.url), 'utf8'),
);
const { clients } = buildCrmStateFromTables(snapshot.tables);

function strip(fragment) {
  return String(fragment)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#x2F;/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

const html = renderToStaticMarkup(<SetFileMatchPanel clients={clients} limit={20} />);
const text = strip(html);
const countOf = (pattern) => (html.match(pattern) || []).length;

describe('what the panel states about the book', () => {
  it('leads with how much of the book is on a version the desk ships', () => {
    expect(text).toContain('496 of 572 measured strategy rows run a version that is in the desk');
    expect(text).toContain('400 on it exactly');
    expect(text).toContain('97 with settings changed');
    expect(text).toContain('75 run no catalogued version');
  });

  it('never counts unmeasurable rows into the denominator', () => {
    // 496 of 572, not of 619. The 47 G4M rows are outside every share.
    expect(text).toContain('(47 more rows not measured)');
    expect(text).not.toContain('of 619');
  });

  it('names the families nothing could be measured on', () => {
    expect(text).toContain('Not measured: G4M (47 rows, 46 accounts)');
    expect(text).toContain('They are not uncatalogued — they are unmeasured');
  });

  it('asks rather than accuses', () => {
    // The panel's whole framing. A word that implies fault trains a CAM to
    // dismiss it, and the desk customises clients on purpose.
    expect(text).toContain('This is a list to verify, not a fault list');
    expect(text).not.toMatch(/\berror\b/i);
    expect(text).not.toMatch(/\bwrong\b/i);
    expect(text).not.toMatch(/\bincorrect\b/i);
    expect(text).not.toMatch(/\bviolation\b/i);
  });

  it('says a match names a configuration, not a file', () => {
    expect(text).toContain('A match names a parameter set, never one file');
    expect(text).toContain('292 named variants measured');
    expect(text).toContain('104 prop-firm twins are identical');
  });
});

describe('the roll-up a manager reads', () => {
  it('rolls up by algorithm and by instrument', () => {
    expect(text).toContain('By algorithm');
    expect(text).toContain('By instrument');
    // Per family, with the measured denominator.
    expect(text).toContain('Bullet Bot 137 (138) 118 of 138');
    expect(text).toContain('RBO 53 (54) 53 of 54');
    // Per instrument, including the symbol the library has no template for.
    expect(text).toContain('MNQ 151 (154) 134 of 154');
    expect(text).toContain('NQ no template for this symbol');
  });

  it('says "not measured" in the roll-up rather than a zero', () => {
    // A `0 of 47` for G4M would read as "none of these are on a catalogued
    // version", which is the opposite of what was measured.
    expect(text).toContain('G4M no folder in the library 46 (47) not measured');
  });

  it('leaves every cell of an unmeasured row blank rather than filling it with 0', () => {
    // The whole row, not just the share. G4M's 47 rows were never compared
    // against anything, so "exactly", "to verify" and "fields compared" have no
    // value — and a 0 in the fields column would read as "compared on nothing",
    // which is a measurement. Three em-dashes is the absence stated as absence.
    expect(text).toContain('G4M no folder in the library 46 (47) not measured — — —');
    // The contrast: NQ has no template either, but its rows WERE measured
    // against the instrument-less Bullet Bot files, so it carries real numbers.
    expect(text).toContain('NQ no template for this symbol 136 (137) 117 of 137 117 20 11');
  });

  it('states the field intersection beside every share', () => {
    expect(text).toContain('Fields compared');
    expect(text).toContain('both sides carry');
  });
});

describe('the findings', () => {
  it('keeps exact matches as a count and names the version each is on', () => {
    expect(text).toContain('118 rows match a set file exactly, across 6 configurations');
    // Bullet Bot's files carry no risk and no version in their names, so the
    // filename is the only name they have — `BulletBot` for six different
    // trading plans would be worse than no label.
    expect(text).toContain('2-L - Bullet Bot - (2 Day Pass 50 - 50) LONG - 2 Mini - 50K (3k Target)');
    expect(text).toContain('11 of 11 exported fields compared, file carries 19');
  });

  it('surfaces the rows on no catalogued version with the closest entry named', () => {
    expect(text).toContain('no catalogued version');
    expect(text).toContain('No catalogued version carries what');
    expect(text).toContain('in the closest file (ARPD (MGC) · 5 Min Candle · Low Risk · v1)');
    // Both directions, always: the file's value and this account's.
    expect(text).toContain('Profit target 1 is 30 here and 300 in the closest file');
  });

  it('marks the fields that decide a version rather than leaving them level', () => {
    // Profit targets and the stop are the version identity on this desk, so a
    // difference there is not a tweak — it is a different configuration.
    expect(text).toContain('version identity');
    expect(countOf(/version identity/g)).toBeGreaterThan(10);
  });

  it('reports the risk level a matched account runs', () => {
    expect(text).toContain('Runs the Low Risk sizing of this version');
    expect(text).toContain('Runs the Medium Risk sizing of this version');
  });

  it('never names the file\'s risk level for an account whose sizing differs from it', () => {
    // The risk level IS the position sizing on this desk, so it may only be
    // named when no sizing field differs. Six real SYFY / MES rows sit on
    // `SYFY (MES) · 5 Min Candle · Low Risk · v1` with PosSize1 2 against the
    // file's 1 — on that version at twice its size. Printing "Runs the Low Risk
    // sizing of this version" over a table row that shows 1 → 2 would state the
    // opposite of the evidence directly beneath it.
    //
    // Each chunk is one group: split on the group marker, then cut at the end of
    // the family section so the last group of a section cannot borrow the next
    // section's note.
    const groups = html.split('<li class="drift-group">').slice(1)
      .map((chunk) => chunk.split('</section>')[0]);
    const withSizing = groups.filter((chunk) => chunk.includes('>sizing</em>'));
    expect(withSizing.length).toBeGreaterThan(0);
    for (const chunk of withSizing) {
      expect(strip(chunk)).not.toContain('Risk sizing of this version');
    }
    // And the group really is the one described above, so this stays a test
    // about the book rather than about an empty set.
    expect(withSizing.some((chunk) => strip(chunk)
      .includes('SYFY (MES) · 5 Min Candle · Low Risk · v1'))).toBe(true);
  });

  it('prints the size of the claim under every finding', () => {
    // Required, not decorative: the same verdict is reached on 11 fields for
    // Bullet Bot and on 48 for MotusTemplar.
    expect(text).toContain('Compared on 31 parameters carried by both sides');
    expect(text).toContain('Compared on 11 parameters carried by both sides');
    expect(text).toContain('are not in this set file, so it could not be compared on them');
  });

  it('asks the recurring question once instead of once per account', () => {
    // The roll-up used to lead with RBO: 43 of 54 rows moving BreakEvenOffset and
    // EntryOrderTickOffset to the same values. The library was aligned to those
    // values and those 43 became exact matches, so the panel now leads with what
    // is actually left.
    //
    // What is left is a different KIND of finding, and the wording has to carry
    // the difference. RBO's was one setting at one value, which an edit to the
    // library settles. ARPD's 36 rows share the setting and NOT the value — 27
    // close at 15:45 and 9 at 16:30, against a catalogued 16:50 that not one
    // account runs. Printing a single arrow there would show 9 or 27 accounts a
    // time they do not close at, so the panel states the value set and says
    // plainly that this is one question, not one answer.
    expect(text).toContain('One question covers 36 of the 37 rows that differ');
    expect(text).toContain('2 different values here');
    expect(text).toContain('The value is not the same on all 36');
  });

  it('does not state one row\'s value as a group\'s when they differ', () => {
    // Bullet Bot's 20 differing rows run eight different targets. The old
    // grouping keyed on field names alone and printed `155 → 70` for all of
    // them; nine accounts would have read a number they do not run.
    expect(text).toContain('8 different values here');
    // Whitespace-insensitive: each value is its own <code> element, which strip
    // separates with a space.
    expect(text.replace(/\s+/g, '')).toContain('(30,60,70,82,90,110,125,140)');
    expect(text).toContain('The value is not the same on all 20');
  });

  it('names each account group by the value that group actually runs', () => {
    // The sharper form of the test below. Bullet Bot's 20 rows on no catalogued
    // version run eight different profit targets against the library's 155 and
    // 205, and they fall on only three catalogued configurations — so a grouping
    // keyed on the field NAME collapses them to three groups, each headed with
    // one member's target. Seventeen of the twenty accounts would then read a
    // number they do not run, in the headline, above their own name.
    //
    // Asserted on the headlines rather than on the presence of the digits: the
    // family's recurring paragraph lists all eight values whatever the grouping
    // does, so a digit-presence check passes on the collapsed panel too.
    const section = html.split('<section class="drift-row">')
      .find((part) => part.includes('<strong>Bullet Bot</strong>'));
    const headlines = [...section.matchAll(/<span class="drift-headline">([\s\S]*?)<\/span>/g)]
      .map((match) => strip(match[1]));
    const named = [...new Set(headlines
      .map((headline) => (headline.match(/is (\d+) here/) || [])[1])
      .filter(Boolean))].sort();
    expect(named).toEqual(['110', '125', '140', '30', '60', '70', '82', '90']);
    expect((section.match(/<li class="drift-group">/g) || []).length).toBe(10);
  });

  it('gives every finding its own row rather than merging different values', () => {
    const bullet = html.slice(html.indexOf('Bullet Bot'));
    // 110, 125, 70, 60, 30, 90, 140 and 82 against the library's 155 and 205 —
    // ten distinct findings, not one.
    for (const value of ['110', '125', '140', '82']) {
      expect(bullet).toContain(`>${value}<`);
    }
  });

  it('renders both dialects of a value as one readable thing', () => {
    // The XML writes `2020-01-01T16:45:00` and the export `1/1/2020 4:45:00 PM`.
    // Nine fields carry times, and un-normalised they render as machine strings.
    expect(text).toContain('16:45');
    expect(text).not.toContain('2020-01-01T');
    expect(text).not.toContain('1/1/2020');
    // Booleans are lower-cased by the normaliser; a toggle still reads on/off.
    expect(text).not.toMatch(/\| (true|false) \|/);
  });

  it('opens every finding rather than hiding some behind a count', () => {
    // The drift panel's lesson: 192 of 267 findings sat behind an inert
    // "+N more". Every group here is a <details>, and every difference in it is
    // a table row.
    const groups = countOf(/<li class="drift-group">/g);
    expect(groups).toBeGreaterThan(20);
    expect(countOf(/<details>/g)).toBeGreaterThanOrEqual(groups);
  });
});

describe('when there is nothing to show', () => {
  it('says so instead of rendering an empty frame', () => {
    const empty = strip(renderToStaticMarkup(<SetFileMatchPanel clients={[]} />));
    expect(empty).toBe('No strategy rows to compare against the set-file library.');
  });
});

describe('when the export carried nothing readable', () => {
  // Built from a real snapshot row: 98 of the 3805 strategy rows carry a null
  // parameters_raw. None is in a latest import today, so this renders on 0 of
  // the 619 rows above — and on all 98 the day one of them is.
  const sample = snapshot.tables.strategy_snapshots.find((row) => !row.parameters_raw);
  const clientsWithBlankExport = [{
    id: 'blank-export',
    name: 'Probe',
    dailyImports: [{
      date: '2026-07-01',
      strategies: [{
        accountName: 'A1',
        strategyName: sample.strategy_name,
        strategyFamily: sample.strategy_family,
        instrument: sample.instrument,
        parametersRaw: '',
      }],
    }],
  }];
  const blank = strip(renderToStaticMarkup(
    <SetFileMatchPanel clients={clientsWithBlankExport} asOfDate="2026-07-01" />,
  ));

  it('never prints a field count it did not measure', () => {
    // `comparedFields ?? 0` rendered "0 fields compared" here — a measurement
    // that never ran, painted identically to a genuine empty intersection. The
    // row's comparedFields is null and the panel has to say so.
    expect(blank).not.toMatch(/0 fields compared/);
    expect(blank).toContain('nothing to compare');
  });

  it('badges it as unreadable rather than as a thin intersection', () => {
    // Both are UNDETERMINED and neither is NONE, but "not enough shared fields"
    // asserts a comparison. The badge has to agree with the headline beside it.
    expect(blank).toContain('export not readable');
    expect(blank).not.toContain('not enough shared fields');
    expect(blank).toContain('no readable parameters');
    // And it is still not "runs no catalogued version".
    expect(blank).not.toMatch(/no catalogued version carries/i);
  });
});

/* ── The section for families the library does not hold ───────────────────── */

// Everything above this point is measured against files the desk wrote. This
// section is measured against what the accounts happen to do, and its failure
// mode is silent — a cohort that all moved together produces a reference that
// moved with it. The assertions are therefore mostly about what the reader is
// TOLD, not about the arithmetic.
const observedHtml = html.slice(html.indexOf('drift-observed'));
const observed = strip(observedHtml);

describe('the observed-reference section', () => {
  it('exists, and is the only place G4M appears with anything to verify', () => {
    expect(observed).toContain('Observed references');
    // 47 rows, no folder in the library, so nothing above may claim to have
    // measured them.
    expect(text).toContain('Not measured: G4M (47 rows, 46 accounts)');
  });

  it('says it is observed on the section, the cohort head and the reference table', () => {
    expect(observed).toContain('observed, not catalogued');
    expect(countOf(/badge observed/g)).toBeGreaterThanOrEqual(2);
    expect(observed).toContain('The observed reference');
    expect(observed).toContain('Observed reference');
  });

  it('states the weakness in words, not in a tooltip', () => {
    // The whole design problem in one paragraph. A caveat behind a hover is a
    // caveat nobody read, and 47 rows of this book land here.
    expect(observed).toContain('it is the configuration the accounts themselves converge on');
    expect(observed).toContain('never what the desk decided');
    expect(observed).toContain('if a cohort was changed together, the reference changed with it');
  });

  it('never borrows the library\'s vocabulary for a derived answer', () => {
    // No filename, no version number, no risk level: the library has none to
    // give for this family, and printing one would be the panel inventing the
    // very thing it is standing in for.
    expect(observed).not.toMatch(/\.xml/);
    expect(observed).not.toMatch(/Low Risk|Medium Risk|High Risk/);
    expect(observed).not.toMatch(/catalogued version/);
  });

  it('shows the evidence the reference rests on', () => {
    expect(observed).toContain('35 of 47 rows (74%) run the same configuration');
    expect(observed).toContain('3 configurations across 46 accounts');
    expect(observed).toContain('25 of the 27 compared settings are identical on every row and 2 vary');
    expect(observed).toContain('Position sizing (PosSize1, PosSize2, PosSize3) and the licence key are held out');
  });

  it('says the cohort is one version, using the desk\'s own definition of one', () => {
    expect(observed).toContain('All 47 rows agree on the 4 settings the desk uses to identify a version');
    expect(observed).toContain('Profit target 1 80 ticks');
    expect(observed).toContain('Stop loss 80 ticks');
  });

  it('checks the reference against the history and refuses to call that endorsement', () => {
    expect(observed).toContain('193 of 254 strategy rows across all imports (76%)');
    expect(observed).toContain('stability, not endorsement');
  });

  it('yields one account to verify, named, with the setting that differs', () => {
    expect(observed).toContain('1 account');
    expect(observed).toContain('1 setting differs from the cohort');
    expect(observed).toContain('Tatum Knoll');
    expect(observed).toContain('7128848');
  });

  it('calls the 11-account close-time group a second configuration, not a departure', () => {
    // 23% of the cohort, and `Close all open trades → 16:30` is already the most
    // recurring change on the whole book — 14 of 29 drift groups, 44 accounts.
    // Listing it as a deviation puts one desk decision on a review list 11 times.
    expect(observed).toContain('second configuration');
    expect(observed).toContain('23% of the cohort');
    expect(observed).toContain('Above the 15% floor');
    expect(observed).toContain('Close all open trades: 16:30 on these 11 accounts, 16:45 in the cohort');
  });

  it('is worded as a question everywhere, never as a fault', () => {
    expect(observed).toContain('A minority configuration is a question, not a fault');
    expect(observed).not.toMatch(/\berror\b|\bwrong\b|\bincorrect\b|\bviolation\b/i);
  });

  it('names how the cohort was assembled under it', () => {
    expect(observed).toContain('Derived from 47 strategy rows on 46 accounts across 36 clients');
    expect(observed).toContain('plus 1 row with no trading account on the import');
    expect(observed).toContain('The library has no folder for G4M.');
  });

  it('counts only the outlier into the head, never the second configuration', () => {
    // 1, not 12. The 11 accounts closing at 16:30 are deliberately NOT on the
    // verify list — 23% is above the floor and this is the book's most recurring
    // desk decision — so a head that included them would contradict the sentence
    // three lines below it. Both heads say the same number, and both say what
    // they are counting.
    const heads = observedHtml.match(/<span class="drift-count"[^>]*>(.*?)<\/span>/g) || [];
    expect(heads.map(strip)).toEqual(['1 account to verify', '1 account to verify']);
    expect(observed).not.toContain('12 account');
  });
});

describe('a cohort with no norm', () => {
  // 0 rows on today's book: G4M is the only uncovered family and it has a clear
  // majority. Rendered from a fixture because it is the case the section exists
  // to get right — a fragmented cohort and a clean one must not look the same,
  // and today nothing on the real book would reveal it if they did.
  const spread = ['4:45:00 PM', '4:30:00 PM', '4:15:00 PM', '3:45:00 PM', '3:30:00 PM'];
  const fragmented = Array.from({ length: 15 }, (unused, index) => ({
    id: `frag${index}`,
    name: `Frag ${index}`,
    dailyImports: [{
      date: '2026-08-03',
      strategies: [{
        strategyFamily: 'ZZZ',
        strategyName: '0 - ZZZ-1.0',
        instrument: 'MES SEP26',
        accountName: `F${index}`,
        parametersRaw: `False/1/1/2020 ${spread[index % spread.length]}/400/300 `
          + '(Backtest/CloseAllOpenTradeTime/ProfitTargetTicks1/StopLossTicks)',
      }],
    }],
  }));
  const fragmentedHtml = renderToStaticMarkup(<SetFileMatchPanel clients={fragmented} limit={20} />);
  const fragmentedText = strip(fragmentedHtml.slice(fragmentedHtml.indexOf('drift-observed')));

  it('states that no reference could be established, and why', () => {
    expect(fragmentedText).toContain('No reference could be established here');
    expect(fragmentedText).toContain('15 rows split across 5 configurations');
    expect(fragmentedText).toContain('the largest holds 3 of them (20%), under the 40%');
  });

  it('does not let that read as "everything is fine"', () => {
    expect(fragmentedText).toContain('This is "there is nothing to compare against", not "everything is fine"');
  });

  it('never prints a to-verify count for a section that established nothing', () => {
    // "0 to verify" beside a cohort with no norm is the same fabrication as
    // "0 fields compared" on an unreadable export: a zero where there is no
    // measurement, and a reader cannot tell it from a clean cohort.
    expect(fragmentedText).not.toContain('0 to verify');
    expect(fragmentedText).toContain('no reference established');
  });

  it('lists nobody against a norm that was never established', () => {
    expect(fragmentedText).not.toContain('second configuration');
    expect(fragmentedText).not.toContain('The observed reference');
    expect(fragmentedText).not.toContain('A minority configuration');
  });
});

describe('a cohort whose builds do not carry the same settings', () => {
  // 0 rows on today's UNCOVERED book — G4M's 3 configurations all carry the same
  // 27 names — but 7 of the 15 cohorts on this book whose configurations differ
  // at all differ in SHAPE: DJDR YM SEP26 and SYFY MES SEP26 hold 26 fields on
  // the dominant configuration and 33 in the union, IFSP-PF NG SEP26 holds 33
  // and 36. The moment one of those families leaves the library this section
  // renders it, and every count below is over the union while the reference's
  // own field count is over the dominant. Printing one under the other's name
  // produced "4 of the 4 compared settings are identical on every row and 3
  // vary" — a sentence that does not add up to its own total.
  const short = (close) => `False/1/1/2020 ${close}/400/300 `
    + '(Backtest/CloseAllOpenTradeTime/ProfitTargetTicks1/StopLossTicks)';
  const long = (close) => `False/1/1/2020 ${close}/400/300/True/2/5 `
    + '(Backtest/CloseAllOpenTradeTime/ProfitTargetTicks1/StopLossTicks/'
    + 'Martingale/MartingaleMultiplier/MaxMartingales)';
  const client = (index, raw) => ({
    id: `sh${index}`,
    name: `Shape ${index}`,
    dailyImports: [{
      date: '2026-08-03',
      strategies: [{
        strategyFamily: 'ZZZ',
        strategyName: '0 - ZZZ-1.0',
        instrument: 'MES SEP26',
        accountName: `S${index}`,
        parametersRaw: raw,
      }],
    }],
  });
  const shaped = [
    ...Array.from({ length: 14 }, (unused, index) => client(index, short('4:45:00 PM'))),
    ...Array.from({ length: 2 }, (unused, index) => client(100 + index, long('4:45:00 PM'))),
  ];
  const shapedHtml = renderToStaticMarkup(<SetFileMatchPanel clients={shaped} limit={20} />);
  const shapedText = strip(shapedHtml.slice(shapedHtml.indexOf('drift-observed')));
  // The reference table only. The diff table under the group has always said
  // "not in the reference", so an assertion over the whole section passes
  // whatever the reference table does.
  const referenceTable = strip(
    shapedHtml.slice(shapedHtml.indexOf('drift-rest')).split('<tbody>')[1].split('</tbody>')[0],
  );

  it('counts unanimous and varying settings against the same total', () => {
    // 4 + 3 = 7, and 7 is the number stated. Against the reference's own 4 this
    // read "4 of the 4 ... and 3 vary".
    expect(shapedText).toContain('4 of the 7 compared settings are identical on every row and 3 vary');
  });

  it('heads the reference table with the number of rows the table has', () => {
    expect(shapedText).toContain('The observed reference — 7 settings, 4 of them carried by the reference itself, and how many rows carry each');
  });

  it('compares the diff against the settings it actually compared', () => {
    // The 3 differences are settings the reference has no field for, so "3 of
    // the reference's 4 differ" names a subset none of them belong to.
    expect(shapedText).toContain('Compared field by field across the 7 settings this cohort carries between its builds; 3 differ');
  });

  it('says a setting is not in the reference rather than dashing it', () => {
    // An em dash in a value column reads as blank, or as zero. "The reference
    // has no field for this" is neither, and it is the whole finding here: three
    // of the seven rows in this table are settings the reference does not carry.
    expect(referenceTable).toContain('Martingale');
    expect((referenceTable.match(/not in the reference/g) || []).length).toBe(3);
    expect(referenceTable).not.toContain('—');
  });

  it('never renders a value spread as "on on 2 rows"', () => {
    // Martingale is a toggle, so `${value} on ${rows} rows` reads "on on 2
    // rows"; every toggle on this desk hits it as soon as it varies.
    expect(shapedText).not.toMatch(/\bon on \d+ rows?\b/);
    expect(shapedText).toContain('· 2 rows');
  });
});

describe('a cohort where one account exports twice', () => {
  // The mismatch this repo has already shipped once: a head counting strategy
  // rows over chips counting accounts. `Avery Frost · BDG9159854231060` exports
  // twice on this book with byte-identical parameters, and one drift group is 5
  // rows over 4 accounts because of it. G4M's outlier is 1 and 1, so nothing on
  // the real book would reveal a head that went back to counting rows.
  const raw = (edge) => `False/1/1/2020 4:45:00 PM/${edge}/400/300 `
    + '(Backtest/CloseAllOpenTradeTime/EdgeLeverage/ProfitTargetTicks1/StopLossTicks)';
  const strategy = (accountName, edge) => ({
    strategyFamily: 'ZZZ',
    strategyName: '0 - ZZZ-1.0',
    instrument: 'MES SEP26',
    accountName,
    parametersRaw: raw(edge),
  });
  const majority = Array.from({ length: 20 }, (unused, index) => ({
    id: `maj${index}`,
    name: `Maj ${index}`,
    dailyImports: [{ date: '2026-08-03', strategies: [strategy(`M${index}`, 'False')] }],
  }));
  const duplicated = {
    id: 'dup',
    name: 'Dup Client',
    // One account, two strategy rows, same parameters — two rows, one account.
    dailyImports: [{
      date: '2026-08-03',
      strategies: [strategy('D1', 'True'), strategy('D1', 'True')],
    }],
  };
  const dupHtml = renderToStaticMarkup(
    <SetFileMatchPanel clients={[...majority, duplicated]} limit={20} />,
  );
  const dupObservedHtml = dupHtml.slice(dupHtml.indexOf('drift-observed'));

  it('heads the section and the cohort with the same number the group chip shows', () => {
    const heads = dupObservedHtml.match(/<span class="drift-count"[^>]*>(.*?)<\/span>/g) || [];
    expect(heads.map(strip)).toEqual(['1 account to verify', '1 account to verify']);
    // And the group below really is 2 rows on 1 account, so this is a test about
    // the difference rather than about a case where there is none.
    // 2 of 22 rows is 9%, and the chip beside it counts 1 account. Two numbers
    // over two different denominators, each saying which it is.
    expect(strip(dupObservedHtml)).toContain('9% of the cohort');
    expect(strip(dupObservedHtml)).toContain('20 of 22 rows (91%)');
  });
});
