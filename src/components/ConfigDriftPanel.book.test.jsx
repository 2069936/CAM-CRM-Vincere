import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ConfigDriftPanel from './ConfigDriftPanel';
import { buildCrmStateFromTables } from '../domain/supabaseStore';

// Asserted against public/local-snapshot.json, the real redacted book: 10
// algorithm rows, 29 outlier groups, 267 individual parameter differences. The
// previous panel painted 75 of those 267 and hid the rest behind an inert
// "+N more", so the counts here are the point of the file, not decoration.

const snapshot = JSON.parse(
  readFileSync(new URL('../../public/local-snapshot.json', import.meta.url), 'utf8'),
);
const { clients } = buildCrmStateFromTables(snapshot.tables);

function strip(fragment) {
  return String(fragment)
    .replace(/<[^>]*>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const countOf = (html, pattern) => (html.match(pattern) || []).length;
const rowsIn = (html) => countOf(html, /<details class="drift-row"/g);
const groupsIn = (html) => countOf(html, /<li class="drift-group">/g);

/**
 * How many algorithm rows arrive already expanded.
 *
 * Every algorithm is a row either way — that is the change this file was
 * rewritten for. `limit` no longer decides whether a row is on the page, only
 * whether it opens on its own, so the thing to count is the `open` attribute and
 * not a second disclosure the panel no longer has.
 */
const openRowsIn = (html) => countOf(html, /<details class="drift-row" open=""/g);

/** Every parameter difference as { setting, cohort, here }, in render order. */
function differences(html) {
  const pattern = /<tr class="drift-change[^"]*"><th scope="row">([\s\S]*?)<\/th><td>([\s\S]*?)<\/td><td class="drift-here">([\s\S]*?)<\/td><\/tr>/g;
  return [...html.matchAll(pattern)].map(([, setting, cohort, here]) => ({
    // The lead row carries a marker and a note saying it is the one the headline
    // names. Neither is part of the setting's name, so both come off here.
    setting: strip(setting).replace(/^▸\s*/, '').replace(/ — the difference named above$/, ''),
    cohort: strip(cohort),
    here: strip(here),
    cohortAbsent: cohort.includes('drift-absent'),
    hereAbsent: here.includes('drift-absent'),
  }));
}

const render = (props = {}) => renderToStaticMarkup(
  <ConfigDriftPanel clients={clients} {...props} />,
);

const html = render();

describe('ConfigDriftPanel — every finding is rendered and reachable', () => {
  it('renders all 29 findings across all 10 algorithm rows', () => {
    expect(rowsIn(html)).toBe(10);
    expect(groupsIn(html)).toBe(29);
    expect(differences(html)).toHaveLength(267);
  });

  it('states the same finding count in prose that it renders', () => {
    // The recurring-question line counts the findings below it. If the list and
    // the sentence ever disagree, one of them is lying about the book.
    expect(strip(html)).toContain('One question covers 14 of the 29 findings below.');
    expect(groupsIn(html)).toBe(29);
  });

  it('names what the totals count, in rows and accounts and clients', () => {
    // 72 strategy rows are 42 identifiable accounts plus 2 rows with no account
    // number. Calling rows accounts inflated the headline by two thirds.
    const text = strip(html);
    expect(text).toContain(
      '72 strategy rows across 10 algorithms run settings the rest of their cohort '
      + 'does not — 42 accounts, 23 clients (+2 rows with no account number).',
    );
  });
});

describe('ConfigDriftPanel — every algorithm is a row, the limit only opens them', () => {
  it('lists all ten algorithms and opens one by default', () => {
    // The measured reason this was rewritten: with eight rows open and each one
    // printing every group summary underneath it, the panel put 1,241 words on
    // screen before a click — and the ten-item list a reader picks from could
    // not be seen at once. Ten rows, one open, is that list.
    expect(rowsIn(html)).toBe(10);
    expect(openRowsIn(html)).toBe(1);
  });

  it('opens exactly as many rows as the limit asks for, and lists all ten at every limit', () => {
    for (const limit of [0, 1, 3, 5, 8, 10]) {
      const out = render({ limit });
      expect(openRowsIn(out)).toBe(limit);
      expect(rowsIn(out)).toBe(10);
    }
    // Past the end is clamped rather than counted: asking for 25 open rows on a
    // ten-row book is not an error, and it is not 25 either.
    expect(openRowsIn(render({ limit: 25 }))).toBe(10);
  });

  it('has no second fold left to hide a row behind', () => {
    // `2 more algorithms with fewer accounts to verify` was itself the fix for a
    // version that dropped those rows outright. A closed row that states its own
    // worst finding needs neither, and one disclosure level is the point.
    expect(html).not.toContain('drift-rest');
    expect(strip(html)).not.toContain('more algorithms with fewer accounts');
  });

  it('keeps every finding rendered no matter where the limit falls', () => {
    // The limit decides what is open, never what exists. Both totals must hold
    // at every limit, including zero.
    for (const limit of [0, 1, 3, 5, 8, 10]) {
      const out = render({ limit });
      expect(rowsIn(out)).toBe(10);
      expect(groupsIn(out)).toBe(29);
      expect(differences(out)).toHaveLength(267);
    }
  });

  it('lets a closed row be skipped on sight: name, size and its worst finding', () => {
    // A collapsed algorithm that says only its name forces the reader to open
    // all ten to find the one worth opening.
    const closed = html.slice(html.indexOf('<details class="drift-row"><summary>'));
    const text = strip(closed.slice(0, closed.indexOf('</summary>')));
    expect(text).toContain('OGX');
    expect(text).toContain('MNQ SEP26');
    expect(text).toContain('13 to verify');
    expect(text).toContain('4 findings');
    expect(text).toContain('Stop loss: 181 ticks on this account, 200 in the cohort.');
  });

  it('says how many algorithms the list holds before listing them', () => {
    expect(strip(html)).toContain('10 algorithms to review, worst first.');
  });
});

describe('ConfigDriftPanel — the shorthand every row is named by is spelled out', () => {
  it('states what PT and SL are, once, above a surface that uses them 50 times', () => {
    const text = strip(html);
    expect(text).toContain('PT is the three profit-target legs the strategy scales out at');
    expect(text).toContain('SL the stop loss, both in ticks');
    // Once. A key repeated per row is the repetition it exists to remove.
    expect(countOf(html, /profit-target legs the strategy scales out at/g)).toBe(1);
    // And it is worth its line: the shorthand really is everywhere.
    expect(countOf(html, /PT \d/g)).toBeGreaterThan(20);
  });
});

describe('ConfigDriftPanel — the table connects to the sentence above it', () => {
  it('marks the one change of 22 that the headline names', () => {
    // OGX MNQ SEP26's first group differs in 22 settings and the headline names
    // exactly one of them. Nothing linked the two, so a reader re-derived it on
    // every group they opened.
    const marks = countOf(html, /class="drift-change drift-change-lead"/g);
    expect(marks).toBeGreaterThan(0);
    expect(strip(html)).toContain('the difference named above');
    // Never more than one per group: the headline names a single change.
    expect(marks).toBeLessThanOrEqual(groupsIn(html));
  });

  it('captions the parameters with no established meaning as a block', () => {
    // `URGO2 2 → 4` is the strategy name plus a digit. It used to sit in the
    // same table as a stop loss with only a hover to say so.
    const text = strip(html);
    expect(text).toContain('in parameters with no established meaning — shown exactly as the strategy writes them');
    expect(countOf(html, /<tbody class="drift-unnamed">/g)).toBeGreaterThan(0);
  });

  it('still renders every unnamed difference it captions', () => {
    // Captioning is not hiding: the rows are in the same table, under the note.
    expect(differences(html)).toHaveLength(267);
  });
});

describe('ConfigDriftPanel — a row states how many accounts it is asking about', () => {
  it('adds its groups up to the count in its own header', () => {
    // URGO MNQ SEP26: five outlier groups of 1, 2, 1, 1 and 9 accounts against a
    // 78-account cohort, 64 of which run one configuration.
    const urgo = html.slice(
      html.indexOf('<strong>URGO</strong>'),
      html.indexOf('<strong>OGX</strong>'),
    );
    const counts = [...urgo.matchAll(/class="drift-group-count"[^>]*>(\d+) accounts?</g)]
      .map(([, count]) => Number(count));

    expect(groupsIn(urgo)).toBe(5);
    expect(counts).toEqual([1, 2, 1, 1, 9]);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(14);
    expect(strip(urgo)).toContain('14 to verify');
    expect(strip(urgo)).toContain('Cohort: 64 of 78 (82%) run');
    expect(strip(urgo)).toContain('PT 400/450/500 · SL 300');
  });

  it('separates strategy rows from accounts where they differ', () => {
    // IFSP NG SEP26 is 10 strategy rows over 9 accounts, because one account
    // carries two snapshot rows. A header of "10 accounts" above 9 account
    // numbers is the mismatch that costs a panel its credibility.
    expect(html).toContain(
      '<span class="drift-count" title="10 strategy rows, 9 accounts'
      + ' — some accounts carry more than one snapshot row.">9 to verify</span>',
    );
  });
});

describe('ConfigDriftPanel — both sides of a difference are on screen', () => {
  it('renders the cohort value and this account’s value in separate cells', () => {
    // The bug the rewrite exists to fix: an outlier rendered identically to the
    // majority. Wren Larch’s single URGO account runs a 315-tick stop against a
    // cohort on 300, and both numbers have to be readable side by side.
    const stop = differences(html).find((row) => row.setting === 'Stop lossticks');

    expect(stop.cohort).toBe('300');
    expect(stop.here).toBe('315');
    expect(stop.here).not.toBe(stop.cohort);

    // Exact markup, because this is the row the headline of that group names,
    // so it also pins the marker that ties the two together.
    expect(html).toContain(
      '<tr class="drift-change drift-change-lead"><th scope="row">'
      + '<span class="drift-lead-mark" aria-hidden="true">▸</span>Stop loss<em>ticks</em>'
      + '<span class="drift-lead-note"> — the difference named above</span></th>'
      + '<td>300</td><td class="drift-here">315</td></tr>',
    );
    // The columns name whose value each is, and how many accounts are behind it.
    expect(html).toContain('<th scope="col">Cohort<em>64 accounts</em></th>');
    expect(html).toContain('<th scope="col">These 1<em>account</em></th>');
    expect(strip(html)).toContain('Stop loss: 315 ticks on this account, 300 in the cohort.');
  });

  it('never renders the two sides of a difference as the same value', () => {
    // Across all 267 differences on the book. A row whose sides read alike is an
    // outlier presented as the majority, which is worse than not listing it.
    const identical = differences(html).filter((row) => row.here === row.cohort);
    expect(identical).toEqual([]);
  });

  it('never leaves a side blank when the parameter is absent from one build', () => {
    // 97 of the 267 rows have one side missing. The old panel printed "absent"
    // for a dropped parameter and, because JSX renders null as nothing, printed
    // an empty cell for an added one. Both are a build difference, not a value.
    const rows = differences(html);
    const oneSided = rows.filter((row) => row.cohortAbsent || row.hereAbsent);

    expect(oneSided).toHaveLength(97);
    for (const row of rows) {
      expect(row.cohort).not.toBe('');
      expect(row.here).not.toBe('');
    }
    for (const row of oneSided) {
      expect(row.cohortAbsent && row.hereAbsent).toBe(false);
      expect(row.cohortAbsent ? row.cohort : row.here).toBe('not in this build');
    }
  });

  it('reports the cohort values as a set when the cohort has no single one', () => {
    // Close all open trades is 16:30 on 44 accounts across 7 algorithms, and
    // their cohorts run three different values. Naming one of them would be the
    // panel inventing a norm the book does not have.
    const text = strip(html);
    expect(text).toContain('Close all open trades is 16:30 on 44 of these accounts, across 7 algorithms');
    expect(text).toContain('3 different values (15:45, 16:45, 16:50)');
  });
});

describe('ConfigDriftPanel — wording', () => {
  it('asks the reader to verify and never calls a minority configuration a fault', () => {
    // A minority configuration is often a deliberate customisation. Fault
    // wording trains a CAM to dismiss the panel, so the only place the words
    // appear at all is the sentence that disowns them.
    const disclaimer = 'For each line, confirm the setting is what the client asked for. '
      + 'Different is not wrong — unexplained is. Customisation is legitimate; '
      + 'this is a list to verify, not a fault list.';
    const text = strip(html);

    expect(text).toContain(disclaimer);
    expect(text).toContain('to verify');
    expect(text).toContain('14 to verify');
    expect(text.replace(disclaimer, ''))
      .not.toMatch(/\b(error|wrong|fault|invalid|violation|breach|incorrect|misconfigur)/i);
  });
});

describe('ConfigDriftPanel — nothing to review', () => {
  it('renders a sentence rather than an empty list', () => {
    const empty = renderToStaticMarkup(<ConfigDriftPanel clients={[]} />);

    expect(strip(empty)).toBe(
      'Every algorithm cohort with a clear majority is running one configuration.',
    );
    expect(rowsIn(empty)).toBe(0);
    expect(groupsIn(empty)).toBe(0);
    expect(empty).not.toContain('drift-panel');
    expect(empty).not.toContain('drift-rest');
    expect(strip(empty)).not.toMatch(/\d/);
  });
});
