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
const rowsIn = (html) => countOf(html, /<section class="drift-row">/g);
const groupsIn = (html) => countOf(html, /<li class="drift-group">/g);

/**
 * What the panel puts on the surface against what it folds into the closing
 * <details>. Both halves are rendered markup, so counting the whole page cannot
 * tell them apart — and the difference between them is exactly what the `limit`
 * prop controls.
 */
function split(html) {
  const at = html.indexOf('<details class="drift-rest">');
  return at === -1
    ? { surfaced: html, collapsed: '' }
    : { surfaced: html.slice(0, at), collapsed: html.slice(at) };
}

/** Every parameter difference as { setting, cohort, here }, in render order. */
function differences(html) {
  const pattern = /<tr><th scope="row">([\s\S]*?)<\/th><td>([\s\S]*?)<\/td><td class="drift-here">([\s\S]*?)<\/td><\/tr>/g;
  return [...html.matchAll(pattern)].map(([, setting, cohort, here]) => ({
    setting: strip(setting),
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

describe('ConfigDriftPanel — the surfaced count follows the limit prop', () => {
  it('surfaces exactly the default limit and collapses the remainder, counted', () => {
    // Eight rows on the surface, two folded away, and the summary says how many
    // were folded. Forcing the limit to 1 leaves 1 on the surface and 9 folded,
    // which is what this pins.
    const { surfaced, collapsed } = split(html);

    expect(rowsIn(surfaced)).toBe(8);
    expect(rowsIn(collapsed)).toBe(2);
    expect(strip(collapsed)).toContain('2 more algorithms with fewer accounts to verify');
  });

  it('moves rows between the surface and the fold as the limit changes', () => {
    const three = split(render({ limit: 3 }));
    expect(rowsIn(three.surfaced)).toBe(3);
    expect(rowsIn(three.collapsed)).toBe(7);
    expect(strip(three.collapsed)).toContain('7 more algorithms');

    const five = split(render({ limit: 5 }));
    expect(rowsIn(five.surfaced)).toBe(5);
    expect(rowsIn(five.collapsed)).toBe(5);
    expect(strip(five.collapsed)).toContain('5 more algorithms');

    const one = split(render({ limit: 1 }));
    expect(rowsIn(one.surfaced)).toBe(1);
    expect(rowsIn(one.collapsed)).toBe(9);
    expect(strip(one.collapsed)).toContain('9 more algorithms');
  });

  it('drops the fold entirely once the limit covers every algorithm', () => {
    const all = render({ limit: 10 });
    expect(all).not.toContain('drift-rest');
    expect(rowsIn(all)).toBe(10);
    expect(groupsIn(all)).toBe(29);
  });

  it('keeps every finding rendered no matter where the limit falls', () => {
    // The limit decides what is open, never what exists. Both totals must hold
    // at every limit.
    for (const limit of [1, 3, 5, 8, 10]) {
      const out = render({ limit });
      expect(rowsIn(out)).toBe(10);
      expect(groupsIn(out)).toBe(29);
      expect(differences(out)).toHaveLength(267);
    }
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

    expect(html).toContain(
      '<tr><th scope="row">Stop loss<em>ticks</em></th>'
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
