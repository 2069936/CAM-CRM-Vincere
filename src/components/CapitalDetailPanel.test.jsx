import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import CapitalDetailPanel from './CapitalDetailPanel';
import { buildCrmStateFromTables } from '../domain/supabaseStore';

// Every figure asserted below is read off public/local-snapshot.json — the real
// redacted book — and not invented. This panel exists to keep two numbers apart
// that a reader would otherwise assume are one, so a test written against made-up
// data could let them collapse into each other and still pass.

/**
 * The domain is real by default. One test needs a capital figure that is null,
 * and no arrangement of `clients` can produce one: buildCapitalDetail coerces
 * every balance through Number()/round2, so money() is only ever handed a number
 * on this book. The null branch is still the house rule — a null must never
 * render as $0 — and the only way to exercise it from outside the module is to
 * hand the renderer the detail object directly. Off by default; see the test.
 */
const control = vi.hoisted(() => ({ detail: null }));

vi.mock('../domain/capitalDetail', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    buildCapitalDetail: (...args) => control.detail ?? actual.buildCapitalDetail(...args),
  };
});

const { buildCapitalDetail } = await import('../domain/capitalDetail');

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

/** Every <Figure> on the page, keyed by its label, as plain text. */
function figuresOf(html) {
  const out = new Map();
  for (const [, body] of html.matchAll(/<div class="capital-figure">([\s\S]*?)<\/div>/g)) {
    const pick = (pattern) => strip(pattern.exec(body)?.[1] ?? '');
    const label = pick(/<span class="capital-figure-label">([\s\S]*?)<\/span>/);
    out.set(label, {
      label,
      value: pick(/<strong class="capital-figure-value[^"]*">([\s\S]*?)<\/strong>/),
      rests: pick(/<span class="capital-rests">([\s\S]*?)<\/span>/),
      caveat: pick(/<span class="capital-caveat">([\s\S]*?)<\/span>/),
    });
  }
  return out;
}

/** Renders with a hand-supplied detail object instead of the real domain. */
function renderWithDetail(detail, segment = null) {
  control.detail = detail;
  try {
    return renderToStaticMarkup(<CapitalDetailPanel clients={clients} segment={segment} />);
  } finally {
    control.detail = null;
  }
}

const desk = renderToStaticMarkup(<CapitalDetailPanel clients={clients} />);
const deskFigures = figuresOf(desk);

describe('CapitalDetailPanel — the desk publishes no capital figure at all', () => {
  it('prints the refusal where $32,244,234 used to be', () => {
    // This panel used to head the desk view "Capital held $32,244,234" over 584
    // accounts. $30,287,682.82 of that — 93.93% — was prop plan size, a product
    // the firm simulates, and at most $1,956,551.34 was money anyone could
    // withdraw. There is no whole here, so there is no number: a count, and the
    // sentence saying why.
    const text = strip(desk);

    expect(deskFigures.get('Capital held')).toBeUndefined();
    // The number is allowed to appear once, inside the sentence explaining why
    // it is no longer published. It must not appear as a FIGURE.
    expect([...deskFigures.values()].map((figure) => figure.value))
      .not.toContain('$32,244,234');
    expect(text.match(/\$32,244,234/g) || []).toHaveLength(1);
    expect(text).toContain('two kinds of money that must not be added');
    expect(deskFigures.get('Accounts with a balance on record').value).toBe('584');
    expect(deskFigures.get('Accounts with a balance on record').rests)
      .toBe('311 of them reported on 2026-07-30');
  });

  it('keeps the two account counts two counts on the segment that does hold capital', () => {
    // The original point of the panel, now on the one segment entitled to the
    // word: held capital is each account's LAST observed balance across several
    // closes, and the cross-section is the one close everybody in it reported on.
    const cash = figuresOf(
      renderToStaticMarkup(<CapitalDetailPanel clients={clients} segment="Cash" />),
    );
    const held = cash.get('Capital held');
    const cross = cash.get('Reported on 2026-07-30');

    expect(held.value).toBe('$1,897,596');
    expect(held.rests).toBe('47 accounts');
    expect(cross.value).toBe('$1,369,036');
    expect(cross.rests).toBe('33 accounts');
    expect(cross.value).not.toBe(held.value);
  });

  it('says on the held figure that it is not one date, next to the number', () => {
    // 14 of the 47 cash accounts carry a balance from an earlier close. The
    // caveat is inline rather than a footnote because a reader who scrolls past
    // it has been told the desk holds $1.9m as of 2026-07-30, which it does not.
    const cash = figuresOf(
      renderToStaticMarkup(<CapitalDetailPanel clients={clients} segment="Cash" />),
    );
    const held = cash.get('Capital held');
    expect(held.caveat).toContain('Not one date');
    expect(held.caveat).toContain('different closes');
    expect(held.caveat).toContain('did not report on 2026-07-30');
    expect(cash.get('Reported on 2026-07-30').caveat)
      .toContain('one close, no carried-forward balances');
  });

  it('reports a prop segment as a plan size with its refusal, and gives it a movement', () => {
    // "A prop balance is never shown as capital. Prop gets movement."
    const bullet = figuresOf(renderToStaticMarkup(
      <CapitalDetailPanel clients={clients} segment="Evaluations - Bullet Bot" />,
    ));

    expect(bullet.get('Capital held')).toBeUndefined();
    const planSize = bullet.get('Plan size (not capital)');
    expect(planSize.value).toBe('$11,909,327');
    expect(planSize.rests).toBe('236 accounts');
    expect(planSize.caveat).toContain('plan size the firm simulates');
    expect(bullet.get('What it moved').value).toBe('−$118,039');
    expect(bullet.get('What it moved').rests).toContain('175 accounts of 236');
  });

  it('counts accounts with no balance on record instead of adding them as $0', () => {
    // 17 accounts have never appeared in a close. They are excluded from the
    // total and stated, so the 584 denominator is honest.
    expect(strip(desk)).toContain('17 no balance on record — excluded, not counted as $0');
  });
});

describe('CapitalDetailPanel — a missing figure is never a zero', () => {
  it('renders payouts as unrecorded, with the count of accounts that have none', () => {
    // payout_events holds 11 approved payouts, but all five of their accounts
    // belong to soft-deleted clients that never reach this state. Of the 601
    // accounts a manager can see, none has a payout written against it. "$0 paid
    // out" would be a lie in the most expensive direction.
    const paid = deskFigures.get('Paid out');

    expect(paid.value).toBe('Unrecorded');
    expect(paid.value).not.toBe('$0');
    expect(paid.value).not.toMatch(/^\$/);
    expect(paid.rests).toBe('601 accounts with no payout on record');
    expect(paid.caveat).toBe(
      'No payout has been recorded against any account here. That is an empty record, '
      + 'not a payout of $0.',
    );
  });

  it('renders money in and funding as silence rather than as amounts', () => {
    const moneyIn = deskFigures.get('Money in');
    const funded = deskFigures.get('Funded');

    expect(moneyIn.value).toBe('Not recorded');
    expect(moneyIn.caveat).toContain('This is silence, not zero.');
    expect(funded.value).toBe('No date recorded');
    expect(funded.rests).toBe('of 601 accounts');

    for (const figure of [moneyIn, funded]) {
      expect(figure.value).not.toMatch(/\$/);
      expect(figure.value).not.toMatch(/^0/);
    }
  });

  it('renders a null money figure as a placeholder, never as $0 and never as a bare $', () => {
    // The house rule, on the figures where breaking it costs the most. The real
    // book never hands money() a null, so the detail object is supplied directly
    // here: three money figures set to null, nothing else changed. A manager
    // reading "$0 paid out" against "no payout recorded" draws the opposite
    // conclusion, and the em-dash is the only thing standing between them.
    const detail = structuredClone(buildCapitalDetail(clients, { segment: 'Cash' }));
    detail.selected.held.capital = null;
    detail.selected.held.atLatestClose.capital = null;
    detail.selected.movement.payouts.recorded = {
      amount: null, events: 3, accounts: 2, firstDate: '2026-07-14', lastDate: '2026-07-28',
    };

    const figures = figuresOf(renderWithDetail(detail, 'Cash'));
    const nulled = [
      figures.get('Capital held'),
      figures.get('Reported on 2026-07-30'),
      figures.get('Paid out'),
    ];

    for (const figure of nulled) {
      expect(figure.value).toBe('—');
      expect(figure.value).not.toBe('$0');
      expect(figure.value).not.toBe('$');
      expect(figure.value).not.toMatch(/\$|\d/);
    }
  });

  it('renders a null balance inside the per-close table as a placeholder too', () => {
    // Same rule one level down. The close-by-close table is where a reader goes
    // to check the headline, so a $0 there corroborates a headline that is wrong.
    const detail = structuredClone(buildCapitalDetail(clients));
    detail.selected.held.asOfDates[0].capital = null;

    const html = renderWithDetail(detail);
    const row = /<tr><th scope="row">2026-07-30<\/th><td>311<\/td><td>([\s\S]*?)<\/td><\/tr>/
      .exec(html);

    expect(row).not.toBeNull();
    expect(strip(row[1])).toBe('—');
    expect(strip(row[1])).not.toBe('$0');
  });
});

describe('CapitalDetailPanel — refusals render as sentences', () => {
  it('refuses an unrecognised segment name instead of reporting it as empty', () => {
    // Found and fixed today. buildCapitalDetail answers an unknown segment with
    // an empty block, and rendering that block prints "$0 · 0 accounts · 0
    // current" — a claim that this segment holds nothing, rather than an
    // admission that nothing was found under that name.
    const html = renderToStaticMarkup(
      <CapitalDetailPanel clients={clients} segment="Prop Desk" />,
    );
    const text = strip(html);

    expect(text).toContain('No account on the book is classified as Prop Desk');
    expect(text).toContain('This is an unrecognised segment name, not a segment holding $0.');

    // Nothing that looks like a report may be on the page. The only "$0" allowed
    // is inside the sentence that disowns it, so that sentence is removed before
    // the page is checked for money at all.
    const withoutDisclaimer = text.replace(
      'This is an unrecognised segment name, not a segment holding $0.', '',
    );
    expect(html).not.toContain('capital-figure');
    expect(html).not.toContain('capital-panel');
    expect(withoutDisclaimer).not.toMatch(/\$/);
    expect(text).not.toContain('$0 · 0 accounts');
    expect(text).not.toContain('0 accounts');
    expect(text).not.toContain('0 current');
  });

  it('refuses an empty book as no observation rather than as zero capital', () => {
    const html = renderToStaticMarkup(<CapitalDetailPanel clients={[]} />);
    const text = strip(html);

    expect(text).toBe(
      'No close has been imported yet, so there is no balance to report. '
      + 'This is not zero capital — it is no observation.',
    );
    expect(text).not.toMatch(/\$/);
    expect(html).not.toContain('capital-figure');
  });

  it('lists the figures it will not produce, with the reason for each', () => {
    const text = strip(desk);
    expect(text).toContain('7 figures this panel will not produce, and why');
    expect(text).toContain('One capital figure for the desk');
    expect(text).toContain('Money in — deposits, withdrawals, funding fees');
    expect(text).toContain('Payouts paid, and payouts over time');
    expect(text).toContain('What the unexplained movements are');
  });
});

describe('CapitalDetailPanel — a segment is not the desk', () => {
  it('breaks the desk down by segment and a segment down by its own accounts', () => {
    // The desk view must use the segment axis. Falling through to byStatus — the
    // easy mistake, since a segment block does carry statuses — renders an empty
    // composition on the desk, because statuses are tallied per segment only.
    const text = strip(desk);
    expect(text).toContain('How it is composed');
    expect(text).toContain('Evaluations - Bullet Bot');
    expect(text).toContain('$11,909,327 236 accounts');
    expect(text).toContain('Funded');
    expect(text).toContain('$11,839,896 180 accounts');
    // Every row carries the kind of money it is, so the two prop rows above are
    // not read as $23.7m of capital.
    expect(text).toContain('Plan size (not capital)');
    expect(text).toContain('$1,897,596 47 accounts Capital held');
    expect(text).toContain('NOT parts of a whole');

    const cash = renderToStaticMarkup(<CapitalDetailPanel clients={clients} segment="Cash" />);
    const cashFigures = figuresOf(cash);
    expect(cashFigures.get('Capital held').value).toBe('$1,897,596');

    // A segment's figures are its own, and the desk has none to borrow.
    expect(deskFigures.get('Capital held')).toBeUndefined();
  });

  it('lists trading P&L per business and never nets one figure across them', () => {
    // -$118,039 of Bullet Bot, -$90,711 of cash and the rest are five different
    // quantities. Summing them is the arithmetic that printed the desk green on
    // 2026-07-21 while the prop desk had lost $5,505.46.
    const text = strip(desk);

    expect(text).toContain('one line per business, never added together');
    expect(text).toContain('Evaluations - Bullet BotPlan size (not capital)−$118,039');
    expect(text).toContain('CashCapital held−$90,711');
    // The netted figure those five would produce must not be anywhere on screen.
    expect(text).not.toContain('−$337,931');
  });

  it('names the one movement it can name and refuses to classify the rest', () => {
    const text = strip(desk);
    expect(text).toContain('1 movement identified.');
    expect(text).toContain('$98,220 moved from 2837222 to 9199785');
    expect(text).toContain(
      '8 balance changes across 7 accounts that trading does not account for',
    );
    // No in/out total across businesses: it would add a cash withdrawal to a
    // prop plan-size adjustment. The per-segment view still gives both.
    expect(text).toContain('No in/out total is given across businesses');
    const cashText = strip(
      renderToStaticMarkup(<CapitalDetailPanel clients={clients} segment="Cash" />),
    );
    expect(cashText).toMatch(/unaccounted in, .*out\./);
  });
});
