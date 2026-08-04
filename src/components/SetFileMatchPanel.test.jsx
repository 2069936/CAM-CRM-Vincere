import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import SetFileMatchPanel from './SetFileMatchPanel';
import { buildCrmStateFromTables } from '../domain/supabaseStore';

// Rendered against public/local-snapshot.json, the real redacted book: 619
// latest strategy rows, 329 exact matches, 168 on a version with settings
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
    expect(text).toContain('329 on it exactly');
    expect(text).toContain('168 with settings changed');
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
    expect(text).toContain('107 prop-firm twins are identical');
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
    expect(text).toContain('in the closest file (RBO (M2K) · 10 Min Candle · Low Risk · v1)');
    // Both directions, always: the file's value and this account's.
    expect(text).toContain('Profit target 1 is 30 here and 150 in the closest file');
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
    expect(text).toContain('One question covers 43 of the 54 rows that differ');
    expect(text).toContain('43 accounts changed the same settings to the same values');
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
