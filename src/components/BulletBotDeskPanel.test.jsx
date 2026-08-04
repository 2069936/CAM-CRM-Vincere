import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  afterEach, describe, expect, it, vi,
} from 'vitest';
import { buildBulletBotDeskStats } from '../domain/bulletBotDeskStats';
import { buildCrmStateFromTables } from '../domain/supabaseStore';
import BulletBotDeskPanel from './BulletBotDeskPanel';

// These tests assert numbers and placeholders, not labels. A label test on this
// panel passes on a card whose Long and Short columns have been swapped, whose
// denominator is the wrong field, and whose "no rate yet" placeholder has turned
// into 0% — all three shipped that way.
//
// buildBulletBotDeskStats is mocked as a pass-through so every test runs against
// the real builder. Exactly one test swaps in a hand-built stats object, because
// the value it needs cannot be produced by the real builder; see that test.
const injected = { stats: null };

vi.mock('../domain/bulletBotDeskStats', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    buildBulletBotDeskStats: (clients, options) => (
      injected.stats ?? actual.buildBulletBotDeskStats(clients, options)
    ),
  };
});

const BULLET = 'Evaluation - Bullet Bot';
const d = (n) => `2026-07-${String(n).padStart(2, '0')}`;

// day = { date, balance, direction, traded }
function makeClient({ id, name = id, accounts = [] }) {
  const registry = {};
  for (const a of accounts) {
    registry[a.name] = {
      accountName: a.name,
      accountType: BULLET,
      status: a.status ?? 'Active',
      alias: a.name,
      ...(a.target === undefined ? {} : { targetProfit: a.target }),
    };
  }
  const dates = [...new Set(accounts.flatMap((a) => (a.days || []).map((x) => x.date)))].sort();
  return {
    id,
    name,
    accountRegistry: registry,
    dailyImports: dates.map((date) => ({
      date,
      accounts: registry,
      executions: accounts.flatMap((a) => ((a.days || []).find((x) => x.date === date)?.traded
        ? [{ accountName: a.name }] : [])),
      snapshots: accounts.flatMap((a) => {
        const day = (a.days || []).find((x) => x.date === date);
        if (!day) return [];
        return [{
          accountName: a.name,
          accountBalance: day.balance,
          strategies: day.direction
            ? [{ strategyFamily: 'Bullet Bot', direction: day.direction, realized: 0 }]
            : [],
        }];
      }),
    })),
  };
}

const open = (name, direction) => ({
  name, target: 53000, days: [{ date: d(1), balance: 50000, direction }],
});
const passesOn = (name, direction, day) => ({
  name,
  target: 53000,
  days: [
    { date: d(1), balance: 50000, direction },
    { date: d(day), balance: 53500, direction },
  ],
});
const failedAccount = (name, direction) => ({
  name, target: 53000, status: 'Failed', days: [{ date: d(1), balance: 41000, direction }],
});
// No target, and a first balance too far from 50k / 100k / 150k for the standard
// Bullet Bot target to be inferred, so the account is genuinely unscorable: it
// is neither a pass nor a failure and must stay out of the denominator.
const targetless = (name, direction) => ({
  name, days: [{ date: d(1), balance: 30000, direction }],
});

/**
 * A book whose four direction buckets all carry different numbers, so that
 * swapping two of them — or reading a count off the wrong field — changes what
 * is rendered.
 *
 *   Long       8 accounts, 6 scorable (2 targetless), 1 pass  -> 16.7%
 *   Short     10 accounts, 10 scorable,               4 passes -> 40%
 *   Unknown    4 accounts, 4 scorable  -> under the cohort floor, no rate
 *   Ambiguous  1 account,  1 scorable  -> under the cohort floor, no rate
 *
 * The two rate-less buckets are what the "0 is a claim" rule is about: they have
 * to render the em-dash placeholder and never 0%. Long's 8 accounts against its
 * 6 scorable is what makes the denominator field observable.
 */
const alpha = makeClient({
  id: 'alpha',
  name: 'Alpha Ridge',
  accounts: [
    passesOn('LP1', 'Long', 4),
    failedAccount('LF1', 'Long'), failedAccount('LF2', 'Long'),
    open('LR1', 'Long'), open('LR2', 'Long'), open('LR3', 'Long'),
    targetless('LU1', 'Long'), targetless('LU2', 'Long'),

    passesOn('SP1', 'Short', 3), passesOn('SP2', 'Short', 3),
    passesOn('SP3', 'Short', 3), passesOn('SP4', 'Short', 3),
    failedAccount('SF1', 'Short'),
    open('SR1', 'Short'), open('SR2', 'Short'), open('SR3', 'Short'),
    open('SR4', 'Short'), open('SR5', 'Short'),

    open('U1', undefined), open('U2', undefined),

    {
      name: 'A1',
      target: 53000,
      days: [
        { date: d(1), balance: 50000, direction: 'Long' },
        { date: d(2), balance: 50100, direction: 'Short' },
      ],
    },
  ],
});

// Two scorable accounts and one pass: ranks on count, but sits below the
// per-client cohort floor, so its rate cell has to stay empty. B1 was already
// above target the first day it appears and has no strategy rows, which is the
// real book's shape for an unattributed pass.
const beta = makeClient({
  id: 'beta',
  name: 'Beta Hollow',
  accounts: [
    { name: 'B1', target: 53000, days: [{ date: d(1), balance: 53500 }] },
    open('B2', undefined),
  ],
});

const book = [alpha, beta];

/**
 * The four direction cards in render order: Long, Short, Unknown, Ambiguous.
 * Split on the card wrapper only — `bbdesk-card-head` shares the prefix and is
 * excluded by requiring a space or a quote right after "bbdesk-card".
 */
function directionCards(html) {
  return html.split(/<div class="bbdesk-card[ "]/).slice(1);
}

// The headline number on a card: a percentage, or the em-dash placeholder.
function rateValue(card) {
  return card.match(/class="bbdesk-rate-value[^"]*"[^>]*>([^<]*)</)[1];
}

// Width of the pass-rate bar, in percent.
function barWidth(card) {
  return Number(card.match(/style="width:([\d.]+)%/)[1]);
}

// Every rate the panel states: the four card headlines plus the per-client table
// cells. Bar widths are deliberately excluded — the string "100%" contains "0%",
// which is what let the old `not.toContain('0%')` assertion be written against
// an empty book instead of a real one.
function renderedRates(html) {
  const cards = directionCards(html).map(rateValue);
  const cells = [...html.matchAll(/<td>(?:<span[^>]*>(—)<\/span>|([\d.]+%))<\/td>/g)]
    .map((m) => m[1] ?? m[2]);
  return [...cards, ...cells];
}

const html = renderToStaticMarkup(<BulletBotDeskPanel clients={book} />);

const realClients = buildCrmStateFromTables(
  JSON.parse(readFileSync('public/local-snapshot.json', 'utf8')).tables,
).clients;
const realHtml = renderToStaticMarkup(<BulletBotDeskPanel clients={realClients} />);

afterEach(() => { injected.stats = null; });

describe('BulletBotDeskPanel — rates the data cannot support', () => {
  it('renders the em-dash placeholder, never a percentage, for a bucket under the cohort floor', () => {
    // Unknown holds 4 scorable accounts and Ambiguous 1, both under
    // minDirectionCohort = 5, so the builder hands the panel a null passRate for
    // each. Null means "no rate yet"; 0% means "the rate is zero". A manager
    // chases one and writes off the other.
    const cards = directionCards(html);
    expect(cards).toHaveLength(4);
    expect(rateValue(cards[2])).toBe('—');
    expect(rateValue(cards[3])).toBe('—');
  });

  it('prints no 0% anywhere on a non-empty book that contains no zero rate', () => {
    // Every rate this book can legitimately produce is non-zero, so a 0% on the
    // page can only be a null rendered as a number. Asserted on a NON-empty
    // render: the empty book returns one sentence and reaches no card at all.
    expect(renderedRates(html)).toEqual(['16.7%', '40%', '—', '—', '26.3%', '—', '15.8%']);
    expect(renderedRates(html)).not.toContain('0%');
  });

  it('keeps the placeholder tooltip attached to a placeholder, not to a number', () => {
    // The tooltip says why there is no rate. If the value beside it becomes 0%,
    // the tooltip is explaining away a number that contradicts it.
    const unknown = directionCards(html)[2];
    expect(unknown).toContain('too few for a rate.');
    expect(unknown).toMatch(/title="Only 4 scorable accounts/);
    expect(unknown).not.toMatch(/class="bbdesk-rate-value[^"]*"[^>]*>\s*\d/);
  });

  it('withholds the per-client rate below the client cohort floor', () => {
    // Beta Hollow: 1 pass in 2 scorable accounts. That is two accounts, not a
    // 50% pass rate, and it is certainly not 0%.
    const row = html.match(/<tr><td>Beta Hollow<\/td>(.*?)<\/tr>/)[1];
    expect(row).toContain('<td><strong>1</strong></td>');
    expect(row).toMatch(/title="2 scorable accounts/);
    expect(row).not.toMatch(/\d%/);
  });

  it('leaves both streak slots empty rather than reporting a run of 0', () => {
    // stats.streaks is null by construction: no outcome on this book carries a
    // date to order it by. A 0 in these slots reads as "this desk is on a cold
    // run", which is a claim the data cannot make.
    const streaks = html.slice(
      html.indexOf('bbdesk-streaks'),
      html.indexOf('</div><p class="muted chart-empty">Not derivable'),
    );
    expect([...streaks.matchAll(/<dd class="muted">([^<]*)<\/dd>/g)].map((m) => m[1]))
      .toEqual(['—', '—']);
  });
});

describe('BulletBotDeskPanel — the numbers on the cards', () => {
  it('puts Long first with Long\'s numbers and Short second with Short\'s', () => {
    // Swapping the two cards swaps their labels along with them, so only the
    // numbers in position catch it. Long and Short differ on every field here.
    const [long, short] = directionCards(html);

    expect(rateValue(long)).toBe('16.7%');
    expect(long).toContain('<span class="muted">8 accounts</span>');
    expect(long).toContain('<strong>1</strong><span class="muted"> of 6 scorable</span>');
    expect(long).toContain('<strong>2</strong><span class="muted"> marked Failed</span>');

    expect(rateValue(short)).toBe('40%');
    expect(short).toContain('<span class="muted">10 accounts</span>');
    expect(short).toContain('<strong>4</strong><span class="muted"> of 10 scorable</span>');
    expect(short).toContain('<strong>1</strong><span class="muted"> marked Failed</span>');
  });

  it('divides the passes by the scorable cohort, not by the account count', () => {
    // Long holds 8 accounts but only 6 can be scored: 2 carry no target, so they
    // are neither passes nor failures. "1 of 8 scorable" would mislabel the
    // denominator and contradict the 16.7% printed above it (1/8 is 12.5%).
    const long = directionCards(html)[0];
    expect(long).toContain(' of 6 scorable');
    expect(long).not.toContain(' of 8 scorable');
    expect(long).toContain('<strong>2</strong><span class="muted"> no target</span>');
    expect(rateValue(long)).toBe('16.7%');
  });

  it('draws each bar on an absolute 0-100 scale, not scaled to the leading bucket', () => {
    const [long, short] = directionCards(html);
    expect(barWidth(long)).toBeCloseTo(16.667, 2);
    expect(barWidth(short)).toBeCloseTo(40, 5);
    // Short leads and is still nowhere near a full track. A bar normalised to
    // the leader makes every leader look complete.
    expect(barWidth(short)).toBeLessThan(100);
  });

  it('clamps the bar to the track when handed a rate above 1', () => {
    // The real builder cannot emit a passRate above 1: scorable is
    // passed + failed + running + reserve, so passed / scorable <= 1 always.
    // The clamp is therefore unreachable through the `clients` prop, and a
    // mutation deleting it survives every data-driven test in this file. It is a
    // rendering guarantee about the value the stats module hands over, so it is
    // tested at that seam. Without it, 3.4 paints a 340%-wide bar.
    const stats = buildBulletBotDeskStats(book);
    stats.direction = {
      ...stats.direction,
      long: { ...stats.direction.long, passRate: 3.4 },
    };
    injected.stats = stats;

    const long = directionCards(renderToStaticMarkup(<BulletBotDeskPanel clients={book} />))[0];
    expect(rateValue(long)).toBe('340%');
    expect(barWidth(long)).toBe(100);
  });
});

describe('BulletBotDeskPanel — the real book', () => {
  const cards = directionCards(realHtml);

  it('reports Long at 6.7% over 75 accounts and Short at 17.2% over 94, in that order', () => {
    expect(rateValue(cards[0])).toBe('6.7%');
    expect(cards[0]).toContain('<span class="muted">75 accounts</span>');
    expect(rateValue(cards[1])).toBe('17.2%');
    expect(cards[1]).toContain('<span class="muted">94 accounts</span>');
  });

  it('scores Short over its 93 scorable accounts, not its 94 records', () => {
    // One Short account carries no target. It is excluded from the rate rather
    // than counted as a non-pass, and the denominator on screen says so.
    expect(cards[1]).toContain('<strong>16</strong><span class="muted"> of 93 scorable</span>');
    expect(cards[1]).not.toContain(' of 94 scorable');
  });

  it('keeps the desk headline on 240 accounts across 46 clients', () => {
    expect(realHtml).toContain('240 Bullet Bot accounts across 46 clients');
    expect(realHtml).toContain('37 reached target, 27 are marked Failed');
  });

  it('prints the days-to-pass median with its sample size', () => {
    expect(realHtml).toContain('>9d</span>');
    expect(realHtml).toContain('median of 18 accounts');
  });

  it('leaves the streak slots empty on the real book too', () => {
    const streaks = realHtml.slice(
      realHtml.indexOf('bbdesk-streaks'),
      realHtml.indexOf('</div><p class="muted chart-empty">Not derivable'),
    );
    expect([...streaks.matchAll(/<dd class="muted">([^<]*)<\/dd>/g)].map((m) => m[1]))
      .toEqual(['—', '—']);
  });
});

describe('BulletBotDeskPanel — counts that are not rates', () => {
  it('states the cohort, the outcomes and the excluded accounts as numbers', () => {
    expect(html).toContain('23 Bullet Bot accounts across 2 clients');
    expect(html).toContain('6 reached target, 3 are marked Failed, 12 still open');
    expect(html).toContain('2 accounts carry no target and no outcome');
  });

  it('counts the passes that belong to neither direction column', () => {
    // 1 of the 6 passes sits in the unknown bucket, so Long + Short does not add
    // up to the desk. The caveat has to carry both numbers, not just the words.
    expect(html).toContain('<strong>1 of 6 passes belong to neither column.</strong>');
  });

  it('separates the traded count from the failure count, and never calls it "fired"', () => {
    // "fired" on the old card meant "the account traded" and sat next to the
    // failure count. Long here: 2 marked Failed, 0 traded — different numbers
    // under different words.
    const long = directionCards(html)[0];
    expect(long).toContain('<strong>2</strong><span class="muted"> marked Failed</span>');
    expect(long).toContain('<strong>0</strong><span class="muted"> took a trade</span>');
    expect(html).not.toMatch(/fired/i);
  });

  it('splits observed passes from the ones already above target on day one', () => {
    // Long's single pass was watched crossing; Beta's was already above target
    // when we first saw it, so its duration is unknown and it is excluded from
    // the median rather than counted as zero days.
    expect(directionCards(html)[0]).toContain('1 seen crossing the target');
    expect(html).toContain('1 further pass');
    expect(html).toContain('median of 5 accounts');
    expect(html).toContain('>2d</span>');
  });

  it('declines the median below the sample floor and says how many it had', () => {
    const thin = [makeClient({
      id: 'thin',
      name: 'Thin Vale',
      accounts: [
        passesOn('T1', 'Short', 3), passesOn('T2', 'Short', 5),
        open('T3', 'Short'), open('T4', 'Short'), open('T5', 'Short'),
      ],
    })];
    const out = renderToStaticMarkup(<BulletBotDeskPanel clients={thin} />);
    expect(out).toContain('Only 2 accounts reached target on a day after we first saw it');
    expect(out).toContain('Below 5 observations there is no median worth printing');
    expect(out).not.toMatch(/>\d+d<\/span>/);
  });
});

describe('BulletBotDeskPanel — an empty book', () => {
  it('renders a sentence, not a page of zeroes', () => {
    const out = renderToStaticMarkup(<BulletBotDeskPanel clients={[]} />);
    expect(out).toContain('No Bullet Bot evaluation accounts');
    expect(out).not.toMatch(/\d/);
  });
});
