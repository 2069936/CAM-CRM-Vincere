// The configuration review's legibility rules, on synthetic fixtures, so CI
// runs them.
//
// ConfigDriftPanel.book.test.jsx holds the numbers — 10 algorithms, 29 findings,
// 267 differences — and is dropped on every clone that does not carry
// public/local-snapshot.json. That is the whole reason this file exists: the
// rules below are what the second readability pass changed, and a rule pinned
// only by a gated suite is not pinned.
//
// Each one is here because it can be broken silently. A row that stops
// collapsing still renders every finding. A key that renders per row instead of
// once still says the right thing. A lead marker on the wrong row looks exactly
// like a lead marker on the right one. None of those fail a count.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ConfigDriftPanel from './ConfigDriftPanel';

/**
 * A NinjaTrader parameter string: values, then the names in brackets.
 * `extra` appends pairs, which is how an unmapped parameter gets into a diff.
 */
const params = ({ pt = '400/450/500', sl = '300', extra = {} } = {}) => {
  const [pt1, pt2, pt3] = pt.split('/');
  const names = ['LicenseKey', 'ProfitTargetTicks1', 'ProfitTargetTicks2',
    'ProfitTargetTicks3', 'StopLossTicks', 'TrailByTicks'];
  const values = ['V-8F5D54-C32866C2-3DB348W', pt1, pt2, pt3, sl, '200'];
  for (const [name, value] of Object.entries(extra)) {
    names.push(name);
    values.push(String(value));
  }
  return `${values.join('/')} (${names.join('/')})`;
};

const strategyRow = (family, account, opts) => ({
  strategyName: `0 - ${family}-4.5`,
  instrument: 'MNQ SEP26',
  accountName: account,
  parametersRaw: params(opts),
});

const client = (id, rows) => ({
  id,
  name: id,
  dailyImports: [{ date: '2026-08-03', strategies: rows }],
});

/**
 * Two algorithms, each a 12-account majority against 3 outliers, which clears
 * buildConfigDrift's guards (cohort >= 8, outlier share >= 0.15, dominant share
 * >= 0.4) without depending on any of them.
 */
function book() {
  const clients = [];
  for (const family of ['URGO', 'OGX']) {
    for (let i = 0; i < 12; i += 1) {
      clients.push(client(`${family}-maj-${i}`, [strategyRow(family, `${family}A${i}`)]));
    }
    // A stop-loss outlier that also differs in a parameter with no plain name.
    clients.push(client(`${family}-stop`, [
      strategyRow(family, `${family}S1`, { sl: '315', extra: { URGO2: '4' } }),
    ]));
    // A pair whose profit target moved, so the group has more than one member.
    clients.push(client(`${family}-target-a`, [strategyRow(family, `${family}T1`, { pt: '30/60/90' })]));
    clients.push(client(`${family}-target-b`, [strategyRow(family, `${family}T2`, { pt: '30/60/90' })]));
  }
  return clients;
}

const clients = book();
const render = (props = {}) => renderToStaticMarkup(
  <ConfigDriftPanel clients={clients} {...props} />,
);
const html = render();

const strip = (fragment) => String(fragment)
  .replace(/<[^>]*>/g, ' ')
  .replace(/&#x27;/g, "'")
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();

const countOf = (markup, pattern) => (markup.match(pattern) || []).length;
const rowsIn = (markup) => countOf(markup, /<details class="drift-row"/g);
const openRowsIn = (markup) => countOf(markup, /<details class="drift-row" open=""/g);
const groupsIn = (markup) => countOf(markup, /<li class="drift-group">/g);
const changesIn = (markup) => countOf(markup, /<tr class="drift-change/g);

describe('the fixture actually exercises the panel', () => {
  it('produces two algorithm rows with findings in them', () => {
    // Stated first because every assertion below is vacuous on an empty view,
    // and buildConfigDrift declines a cohort with no clear majority.
    expect(rowsIn(html)).toBe(2);
    expect(groupsIn(html)).toBeGreaterThanOrEqual(4);
    expect(changesIn(html)).toBeGreaterThan(0);
  });
});

describe('every algorithm is a row; the limit only decides what opens', () => {
  it('opens one by default and leaves the rest listed and closed', () => {
    expect(openRowsIn(html)).toBe(1);
    expect(rowsIn(html)).toBe(2);
  });

  it('opens exactly the limit, and never changes how many rows exist', () => {
    for (const limit of [0, 1, 2]) {
      const out = render({ limit });
      expect(openRowsIn(out)).toBe(limit);
      expect(rowsIn(out)).toBe(2);
    }
    expect(openRowsIn(render({ limit: 9 }))).toBe(2);
  });

  it('renders every finding at every limit, open or closed', () => {
    // A <details> holds its children whether or not it is open, so collapsing is
    // a reading affordance and never a filter. If that ever stops being true the
    // counts move.
    const at = (limit) => {
      const out = render({ limit });
      return [groupsIn(out), changesIn(out)];
    };
    expect(at(0)).toEqual(at(2));
    expect(at(1)).toEqual(at(2));
  });

  it('has no second fold to hide a row behind', () => {
    // `N more algorithms with fewer accounts to verify` was itself the fix for a
    // version that dropped those rows outright. One list, one disclosure level.
    expect(html).not.toContain('drift-rest');
    expect(strip(html)).not.toContain('more algorithms with fewer accounts');
  });

  it('says how many algorithms are in the list before listing them', () => {
    expect(strip(html)).toContain('2 algorithms to review, worst first.');
  });
});

describe('a closed row can be skipped or opened on sight', () => {
  it('states its name, how much it is asking about, and its worst finding', () => {
    // The closed one, whichever of the two ranked second — the point is that a
    // row nobody has expanded still says what it is.
    const closed = html.slice(html.lastIndexOf('<details class="drift-row"><summary>'));
    const summary = strip(closed.slice(0, closed.indexOf('</summary>')));
    expect(summary).toMatch(/^(URGO|OGX) MNQ SEP26/);
    expect(summary).toContain('to verify');
    expect(summary).toMatch(/\d+ findings?/);
    // The worst finding in words, not just a count. Without it a collapsed row
    // is a name and a number and every row has to be opened.
    expect(summary).toContain('Stop loss: 315 ticks on this account, 300 in the cohort.');
  });

  it('leads with the worst finding, not the biggest group', () => {
    // The 2-account profit-target group is larger than the 1-account stop-loss
    // group. Ranking is by what costs money, so the stop leads.
    const first = html.slice(html.indexOf('<details class="drift-row"'));
    const summary = strip(first.slice(0, first.indexOf('</summary>')));
    expect(summary).toContain('Stop loss');
    expect(summary).not.toContain('Profit target 1');
  });
});

describe('the shorthand every configuration is named by', () => {
  it('spells out PT and SL once, above a surface that repeats them', () => {
    const text = strip(html);
    expect(text).toContain('PT is the three profit-target legs the strategy scales out at');
    expect(text).toContain('SL the stop loss, both in ticks');
    // Once. A key repeated per row is the repetition it exists to remove.
    expect(countOf(html, /profit-target legs the strategy scales out at/g)).toBe(1);
    // And the shorthand is on screen often enough to be worth the line.
    expect(countOf(html, /PT \d/g)).toBeGreaterThan(3);
  });
});

describe('the expanded table connects to the sentence above it', () => {
  it('marks the one change the headline names, and only that one', () => {
    expect(countOf(html, /class="drift-change drift-change-lead"/g)).toBeGreaterThan(0);
    // At most one lead per group: the headline names a single change.
    expect(countOf(html, /class="drift-change drift-change-lead"/g))
      .toBeLessThanOrEqual(groupsIn(html));
    expect(strip(html)).toContain('the difference named above');
  });

  it('marks the row the headline is about and not a neighbouring one', () => {
    // The failure this catches is silent: a marker on the wrong row reads
    // exactly like a marker on the right one. The stop-loss group's headline
    // names the stop, so the stop is the marked row and the trail is not.
    const lead = html.match(
      /<tr class="drift-change drift-change-lead"><th scope="row">[\s\S]*?<\/th>/,
    );
    expect(lead).not.toBeNull();
    expect(strip(lead[0])).toContain('Stop loss');
    expect(strip(lead[0])).not.toContain('Trail by');
  });

  it('captions the parameters with no established meaning instead of tooltipping each', () => {
    // `URGO2 2 → 4` is the strategy name plus a digit. It used to sit in the
    // same table as a stop loss with only a hover to say so.
    expect(countOf(html, /<tbody class="drift-unnamed">/g)).toBeGreaterThan(0);
    expect(strip(html)).toContain(
      'in parameters with no established meaning — shown exactly as the strategy writes them',
    );
  });

  it('still renders every difference it captions', () => {
    // Captioning is not hiding: the unnamed rows are in the same table, under
    // the note, in the same <tr class="drift-change"> shape as the rest.
    expect(html).toContain('<code>URGO2</code>');
    const unnamed = html.slice(html.indexOf('<tbody class="drift-unnamed">'));
    expect(countOf(unnamed.slice(0, unnamed.indexOf('</tbody>')), /<tr class="drift-change/g))
      .toBeGreaterThan(0);
  });

  it('never marks an opaque parameter as the lead', () => {
    // `leadChangeOf` refuses an unranked name for the same reason `headlineFor`
    // does. If the two ever forked, the marked row would be a parameter the
    // sentence above it does not mention.
    const leads = [...html.matchAll(
      /<tr class="drift-change drift-change-lead"><th scope="row">([\s\S]*?)<\/th>/g,
    )];
    expect(leads.length).toBeGreaterThan(0);
    for (const [, cell] of leads) expect(cell).not.toContain('<code>');
  });
});

describe('nothing to review', () => {
  it('renders a sentence rather than an empty list', () => {
    const empty = renderToStaticMarkup(<ConfigDriftPanel clients={[]} />);
    expect(strip(empty)).toBe(
      'Every algorithm cohort with a clear majority is running one configuration.',
    );
    expect(rowsIn(empty)).toBe(0);
    expect(empty).not.toContain('drift-panel');
    expect(strip(empty)).not.toMatch(/\d/);
  });
});
