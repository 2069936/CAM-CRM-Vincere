import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import QuietAccountsPanel from './QuietAccountsPanel';
import { buildCrmStateFromTables } from '../domain/supabaseStore';

/**
 * Rendered against public/local-snapshot.json, the real redacted book: 122
 * accounts that stopped filing for two or more of their client's closes, 80 of
 * them healthy on the close they went quiet and 42 past their trailing drawdown.
 *
 * The assertions here are about what a CAM can READ, not about what the model
 * computed — the model has its own file. The two things this panel can get wrong
 * are (a) rendering a reading as a verdict and (b) hiding rows behind a count,
 * which is the mistake ConfigDriftPanel had to fix after it buried 72% of its
 * own findings behind an inert "+N more". Both are asserted on the markup.
 */

const snapshot = JSON.parse(
  readFileSync(new URL('../../public/local-snapshot.json', import.meta.url), 'utf8'),
);
const { clients } = buildCrmStateFromTables(snapshot.tables);

const html = renderToStaticMarkup(<QuietAccountsPanel clients={clients} />);

function strip(fragment) {
  return String(fragment)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const countOf = (pattern) => (html.match(pattern) || []).length;

describe('QuietAccountsPanel', () => {
  /**
   * 122 is what is listed; 195 is what was measured.
   *
   * The headline used to read "122 of 718 accounts have filed nothing for 2 or
   * more of their client's own closes". Recomputed off the raw tables, 195 of
   * the 718 have — the other 73 are the 61 shelved and the 12 with no registry
   * row that the block at the foot of this same panel counts. A first sentence
   * that states the listed number as the measured one is contradicted by its own
   * footer, so both are printed.
   */
  it('states the count with its denominator and the date the evidence reaches', () => {
    const text = strip(html);
    expect(text).toContain(
      "122 of the 195 accounts that have filed nothing for 2 or more of their client's own closes are listed here",
    );
    expect(text).toContain('the other 73 are set aside below: 61 shelved, 12 with no registry row');
    expect(text).toContain('out of 718 accounts on record');
    // A client with no import at all has no close for an account to be absent
    // from, so 96 is not the denominator this ratio has.
    expect(text).toContain('across 32 of the 84 clients that have any close at all');
    expect(text).not.toContain('across 32 of 96 clients');
    // The date the book actually reaches, not the wall clock the ops screen
    // seeds its picker from.
    expect(text).toContain('closes to 2026-07-30');
  });

  it('renders the two shapes as separate, differently coloured groups', () => {
    expect(html).toContain('quiet-shape quiet-shape-past');
    expect(html).toContain('quiet-shape quiet-shape-healthy');
    // Colour is never the only carrier: every row repeats its shape in words.
    expect(countOf(/class="quiet-chip quiet-chip-past"/g)).toBeGreaterThan(0);
    expect(strip(html)).toContain('Past its drawdown when it went quiet');
    expect(strip(html)).toContain('Healthy when it went quiet');
  });

  it('never calls a missing account failed', () => {
    const headlines = html.match(/<span class="drift-headline">[^<]*<\/span>/g) || [];
    expect(headlines.length).toBeGreaterThan(0);
    for (const headline of headlines) {
      expect(headline.toLowerCase()).not.toMatch(/fail/);
    }
  });

  /**
   * The same constraint, on every label the panel DERIVES — not only on the
   * evidence sentence.
   *
   * The test above scans `drift-headline`, which is the evidence line alone.
   * That left unguarded the two labels a CAM actually reads first: the shape
   * group heading and the per-row chip. Renaming the healthy group heading to
   * "Failed on the close it went quiet" — 80 of the 122 rows on this book, every
   * one of them inside its trailing drawdown on the close it went quiet — kept
   * all 1,916 tests green, while the panel's own paragraph two inches above it
   * still read "Not one row here says failed".
   *
   * The declared registry status is deliberately NOT covered. "status Failed" is
   * quoted from the registry on 7 of these rows, it is what the desk wrote, and
   * printing it beside a healthy reading is the point. What this asserts is that
   * nothing the panel concludes ITSELF is rendered as a verdict.
   */
  it('never labels its own reading of an account as failure', () => {
    const titles = [...html.matchAll(
      /class="drift-row quiet-shape quiet-shape-[a-z]+"><div class="drift-head"><strong>([^<]*)</g,
    )].map((match) => match[1]);
    const chips = [...html.matchAll(
      /<span class="quiet-chip quiet-chip-[a-z]+">([^<]*)</g,
    )].map((match) => match[1]);
    // The two shape groups this book produces (42 past drawdown, 80 healthy,
    // 0 never measured, 0 cash) and one chip per listed account.
    expect(titles).toHaveLength(2);
    expect(chips).toHaveLength(122);
    for (const label of [...titles, ...chips]) {
      expect(label.toLowerCase()).not.toMatch(/fail/);
    }
  });

  it('puts the four facts on the row a CAM reads first', () => {
    // The account this panel exists for: healthy, six figures, gone for 7
    // closes, and nothing in the product said so before.
    expect(strip(html)).toContain(
      'Last seen 2026-07-13 with $2,171 of buffer left on a $148,223 balance — absent for the 7 closes since.',
    );
  });

  it('reaches every finding — nothing is hidden behind an inert count', () => {
    // 122 rows across the four shape groups, whatever the `limit` prop folds
    // into a <details>. A <details> is reachable; a "+N more" span is not.
    expect(countOf(/<li class="drift-group">/g)).toBe(122);
  });

  it('puts the collection failures above the accounts and counts them as clients', () => {
    const text = strip(html);
    expect(html).toContain('quiet-collection');
    expect(text).toContain('Chase the collection, not the accounts');
    expect(text).toContain('24 clients · 136 accounts');
    expect(html.indexOf('quiet-collection')).toBeLessThan(html.indexOf('quiet-shape-past'));
  });

  it('says an empty close covered no accounts rather than implying a lost day', () => {
    expect(strip(html)).toContain('none of its 7 accounts existed yet on that date');
  });

  /**
   * A client can be in the collection block AND own rows in the account list.
   * The panel used to claim it could not; on this book 2 of the 122 accounts are
   * exactly that, and the claim was simply false.
   */
  it('states the overlap between a stopped client and its own quiet accounts', () => {
    expect(strip(html)).toContain(
      '2 of the 122 accounts below belong to a client on this list as well',
    );
    expect(strip(html)).toContain('client has since stopped filing');
  });

  it('groups accounts of one client that stopped on the same close', () => {
    const text = strip(html);
    expect(text).toContain('Stopped together, on the same close');
    expect(text).toContain('13 accounts last filed 2026-07-22');
    expect(text).toContain('13 of the 20 that filed that close never filed again');
    expect(text).toContain('every account that filed it stopped');
  });

  it('renders the simulation section as a measured zero rather than omitting it', () => {
    const text = strip(html);
    expect(html).toContain('quiet-simulation');
    expect(text).toContain('Simulation accounts');
    expect(text).toContain('Every one of the 718 accounts on this book was classified');
    expect(text).toContain('none came back simulated, and none was left undecided');
    expect(text).toContain('That is a measured zero, not an unchecked one.');
  });

  it('counts what it left off the list, with reasons', () => {
    const text = strip(html);
    expect(text).toContain('10 accounts have never appeared in any close');
    expect(text).toContain('5 went quiet and came back');
    expect(text).toContain('84 · Shelved as Inactive / Ignore');
    expect(text).toContain('33 · No registry row');
    expect(text).toContain('7 · Registered after the last close');
    // How many of each bucket the headline is actually leaving out. 84 accounts
    // are shelved and 61 of those went quiet; printing only 84 leaves a reader
    // unable to reconcile 122 with 195.
    expect(text).toContain(
      '84 · Shelved as Inactive / Ignore 61 of them went quiet for two or more closes',
    );
    expect(text).toContain(
      '33 · No registry row 12 of them went quiet for two or more closes',
    );
  });

  /**
   * The line that used to contradict itself inside one sentence.
   *
   * Reese North rendered as "has imports but has never filed a single account
   * row · no import on 14 of the 14 dates the desk filed". It has an import on
   * 2026-07-13 — one that carried zero account rows, which is the whole reason
   * it is on this list. 5 of the 24 clients here were in that state.
   */
  it('says "no account rows" where that is what was measured, not "no import"', () => {
    const text = strip(html);
    expect(text).toContain(
      'Reese North has imports but has never filed a single account row · no account rows on 14 of the 14 dates the desk filed',
    );
    expect(text).not.toContain('no import on 14 of the 14 dates');
    // And the same client's 2026-07-13 import is printed a few lines below, so
    // the two statements have to agree.
    expect(text).toContain('Reese North 2026-07-13');
  });

  /**
   * A buffer read on an earlier close than the one the account went quiet on.
   *
   * 2 of the 122 rows: Harper Juniper's, both reading 0 on their final close and
   * carrying a 2026-07-13 buffer instead — 7 and 14 days stale. The evidence line
   * always said so; the chip beside the account name did not, and the chip is
   * what gets read at a glance.
   */
  it('marks the rows whose buffer predates the close they went quiet on', () => {
    expect(countOf(/reading predates that close/g)).toBe(2);
    const text = strip(html);
    expect(text).toContain(
      'Healthy when it went quiet reading predates that close Last seen 2026-07-27 with $2,000 of buffer left on a $50,000 balance (that reading is from 2026-07-13, the last close that carried the column)',
    );
  });

  it('says so rather than rendering an empty shell when there are no accounts', () => {
    const empty = renderToStaticMarkup(<QuietAccountsPanel clients={[]} />);
    expect(strip(empty)).toBe('No accounts on file for this book yet.');
  });
});
