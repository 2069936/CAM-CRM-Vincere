// What the Operations screen is allowed to print about the desk's money.
//
// Ungated on purpose — synthetic clients, no book — so CI pins it. The figures
// are chosen so that every rule this panel exists to enforce, when broken,
// produces one specific wrong string that the assertions name.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import DeskMoneyPanel, { CAPITAL_DETAIL_ID } from './DeskMoneyPanel';
import { buildDeskMoney, buildDeskMoneyForMonth } from '../domain/deskMoney';

const snapshot = (accountName, gross, balance) => ({
  accountName, grossRealizedPnl: gross, weeklyPnl: gross, accountBalance: balance,
});

/**
 * Bullet Bot up $1,000, the ordinary algorithms down $1,200, cash up $300 and
 * $50 lost on an account somebody marked Inactive / Ignore.
 *
 * The old single figure for this book is +$50 and green.
 */
const clients = [
  {
    id: 'c1',
    name: 'One',
    accountRegistry: {
      B1: { accountType: 'Evaluation - Bullet Bot' },
      F1: { accountType: 'Funded' },
      C1: { accountType: 'Cash - Straight' },
      X1: { accountType: 'Inactive / Ignore' },
    },
    dailyImports: [
      { date: '2026-07-29', snapshots: [snapshot('C1', 7, 41700)] },
      {
        date: '2026-07-30',
        snapshots: [
          snapshot('B1', 1000, 150000),
          snapshot('F1', -1200, 50000),
          snapshot('C1', 300, 42000),
          snapshot('X1', -50, 9000),
        ],
      },
    ],
  },
  {
    id: 'c2',
    name: 'Two',
    accountRegistry: { U1: { accountType: 'Unassigned' } },
    dailyImports: [{ date: '2026-07-13', snapshots: [snapshot('U1', -25, 7000)] }],
  },
];

const strip = (html) => String(html)
  .replace(/<[^>]*>/g, ' ')
  .replace(/&#x27;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, '&')
  .replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const desk = buildDeskMoney(clients);
const month = buildDeskMoneyForMonth(clients, { month: '2026-07' });
const html = renderToStaticMarkup(<DeskMoneyPanel desk={desk} month={month} />);
const text = strip(html);

describe('DeskMoneyPanel — no number for "the desk" reaches the screen', () => {
  it('prints the four businesses and never their sum', () => {
    expect(text).toContain('Bullet Bot');
    expect(text).toContain('$1,000');
    expect(text).toContain('Other prop algos');
    expect(text).toContain('-$1,200');
    expect(text).toContain('Cash');
    expect(text).toContain('$300');
    expect(text).toContain('Unclassified');
    expect(text).toContain('-$25');

    // +1000 - 1200 + 300 - 25 = +$75, the figure the old headline would print,
    // and +$25 with the ignored account in it as the old clipboard text had.
    expect(text).not.toContain('$75');
    expect(text).not.toMatch(/(^|[^-\d,])\$25\b/);
    expect(text).not.toContain('Team daily P&L');
  });

  it('says on the panel that the rows are not added', () => {
    expect(text).toContain('never summed');
    expect(text).toContain('no total');
  });
});

describe('DeskMoneyPanel — every figure states its date basis', () => {
  it('prints the basis line, with the date count and the clients off the newest close', () => {
    expect(text).toContain('Latest close per client across 2 dates');
    expect(text).toContain('1 of them last closed before 2026-07-30');
  });

  it('prints the month block under its own basis line', () => {
    expect(text).toContain('Month to date');
    expect(text).toContain('Every close in 2026-07 · 3 dates');
  });
});

describe('DeskMoneyPanel — a refusal is rendered as a sentence, never as a number', () => {
  it('shows a prop row its plan size, labelled, in place of a balance', () => {
    expect(text).toContain('plan size $150,000 — not capital');
    expect(html).toContain('A prop account balance is the plan size the firm simulates');
    // The one thing it must never say about a prop balance.
    expect(text).not.toMatch(/Capital held \$150,000/);
  });

  it('shows cash its balance, because cash is the client’s real money', () => {
    expect(text).toContain('$42,000');
    // And only cash: the balance cell of every other row is a refusal, not a
    // number the reader could add to it.
    expect(html.match(/class="desk-refusal"/g)).toHaveLength(7);
  });

  it('refuses the weekly column and the balance over a month, with the reason', () => {
    expect(html).toContain('Monday-to-Friday accumulator');
    expect(html).toContain('A balance is a level, not a flow');
    expect(text).toContain('Account closes');
  });

  it('reports ignored and orphan closes as a count with no money against them', () => {
    expect(text).toContain('Reconciliation, not money:');
    expect(text).toContain('1 marked inactive / ignore');
    // -$50 is the ignored account's P&L and must not be on screen as money.
    expect(text).not.toContain('-$50.00');
  });
});

describe('DeskMoneyPanel — the drill-down opens the right segment', () => {
  it('hands back the long domain segment name, not the short row label', () => {
    // buildCapitalDetail keys its blocks off segmentFor(). "Bullet Bot" would
    // match nothing and silently open a segment reading $0.
    const clickable = renderToStaticMarkup(
      <DeskMoneyPanel desk={desk} onToggleSegment={() => {}} />,
    );

    expect(clickable).toContain('>Evaluations - Bullet Bot</button>');
    expect(clickable).toContain('Capital detail for Evaluations - Bullet Bot');
    expect(clickable).not.toContain('Capital detail for Bullet Bot');
  });

  it('points aria-controls at the panel that actually opens, only when open', () => {
    const open = renderToStaticMarkup(
      <DeskMoneyPanel
        desk={desk}
        openSegment="Cash"
        onToggleSegment={() => {}}
      />,
    );

    expect(open).toContain(`aria-controls="${CAPITAL_DETAIL_ID}"`);
    expect(open).toContain('aria-expanded="true"');
    // Exactly one row is open, and it is the one asked for.
    expect(open.match(/aria-expanded="true"/g)).toHaveLength(1);
  });

  it('renders the chips as plain text when there is nothing to open', () => {
    expect(html).not.toContain('<button');
  });
});
