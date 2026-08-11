import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import LiveAccountsPanel from './LiveAccountsPanel';
import { buildCrmStateFromTables } from '../domain/supabaseStore';
import { buildLiveAccounts } from '../domain/liveAccounts';

// Asserted against public/local-snapshot.json, the real redacted book. The
// panel is rendered and READ here, not just mounted: the assertions are about
// what a CAM would see on screen — a date on every row, three run states spelt
// out in words, and no header date claiming to speak for accounts that reported
// on a different day.

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
    .replace(/\s+/g, ' ')
    .trim();
}

const countOf = (html, pattern) => (html.match(pattern) || []).length;

/** The client with the most accounts on the book — the hardest single view. */
const busiest = [...clients].sort(
  (a, b) => Object.keys(b.accountRegistry || {}).length - Object.keys(a.accountRegistry || {}).length,
)[0];

describe('LiveAccountsPanel — one client', () => {
  const html = renderToStaticMarkup(<LiveAccountsPanel client={busiest} clients={clients} />);
  const text = strip(html);
  /** Everything above the stood-down <details>, i.e. what a CAM scans. */
  const surfaced = html.slice(0, html.indexOf('drift-rest'));

  it('renders the busiest client instead of an empty state', () => {
    // This is the whole fix. Today's workspace pins the wall-clock date, finds
    // no import for it, and renders "No daily close for this date".
    expect(busiest.name).toBe('Parker Pine');
    expect(text).not.toMatch(/No daily close/i);
    expect(text).toContain('last close 2026-07-30');
    expect(countOf(html, /<details>/g)).toBe(15);
    // This assertion used to read "2 of 15 accounts running". It was wrong, and
    // the panel rendered it: Parker Pine's two running accounts BOTH last
    // reported on 2026-07-27 and neither appears in the 2026-07-30 close the
    // header names three words earlier. Nothing on this client was running on
    // its own latest close. The number and the date it sits beside now belong
    // to each other, and the stale pair is stated as its own fact.
    expect(text).toContain('0 of 15 accounts had a strategy enabled on 2026-07-30');
    expect(text).toContain('2 more were running the last time they reported, up to 3 days before that close');
    expect(text).toContain('9 have every strategy off, and 4 sent no strategy data');
    expect(text).toContain('0 running on 2026-07-30');
    expect(text).toContain('2 last seen running on an older close');
  });

  it('puts an as-of date on every account row, not one in the header', () => {
    expect(countOf(surfaced, /as of 20\d\d-\d\d-\d\d/g)).toBe(countOf(html, /<details>/g));
    // Parker Pine's accounts do not share a date, and the panel says so.
    expect(text).toContain('3 different closes are on screen');
    expect(text).toMatch(/2026-07-30, 2026-07-27, 2026-07-13/);
    expect(text).toContain('10 on 2026-07-30, 5 behind it');
  });

  it('labels a stale row as stale rather than passing it off as current', () => {
    // The two facts the current UI cannot tell apart. Both accounts show real
    // balances; neither is dated today, and neither is blank.
    expect(text).toMatch(/as of 2026-07-13 — 17 days behind the last close/);
    expect(text).toMatch(/as of 2026-07-27 — 3 days behind the last close/);
    expect(countOf(surfaced, /days behind the last close/g)).toBe(5);
  });

  it('names the group each account is in', () => {
    expect(text).toContain('Period 0 10 accounts');
    expect(text).toContain('Period not stated 1 account');
    expect(text).toContain('No strategy data 4 accounts');
  });

  it('spells the three run states out in words, not only in colour', () => {
    expect(countOf(html, />running</g)).toBe(2);
    expect(countOf(html, />all off</g)).toBe(9);
    expect(countOf(html, />no strategy data</g)).toBe(4);
    // The existing Dashboard chip carries enabled in a CSS class alone
    // (.strategy vs .strategy.enabled). Here every chip also says the word.
    const chips = countOf(html, /class="strategy(?: enabled)?"/g);
    expect(chips).toBe(14);
    expect(countOf(html, /class="strategy[^"]*"[^>]*>[^<]*\b(?:on|off)<\/span>/g)).toBe(chips);
  });

  it('shows the period on the chip, so two periods of one algo do not collapse', () => {
    // `0 - URGO-4.5` and `1 - URGO-4.5` both render as "URGO 4.5" in the
    // existing Dashboard chips. Here they cannot be confused.
    expect(text).toMatch(/URGO 4\.5 P0/);
    // The unprefixed Bullet Bot row reads P?, not P0.
    expect(text).toMatch(/Bullet Bot 1\.1 P\?/);
    expect(text).toContain('Bullet Bot-1.1 not stated');
  });

  it('never prints a currency zero for something it did not measure', () => {
    expect(text).toContain('no strategy row on this close');
    expect(text).toContain('Not measured — this is not a reading of zero strategies');
  });

  it('says when the strategy rows do not add up to the account', () => {
    // 7 of these 15 accounts. One reads -$448 for the day beside a single
    // strategy row reading $0.00; without this line that looks like a bug.
    expect(countOf(html, /Strategy rows total/g)).toBe(7);
    expect(text).toContain('Strategy rows total $0; the account closed at -$448');
  });

  it('keeps the stood-down accounts reachable', () => {
    expect(text).toMatch(/26 accounts stood down/);
    expect(html).toContain('<details class="drift-rest">');
    expect(countOf(html, /Typed Inactive \/ Ignore|Account failed/g)).toBe(26);
  });
});

describe('LiveAccountsPanel — a client whose accounts scatter across dates', () => {
  const grayElm = clients.find((client) => client.name === 'Gray Elm');
  const html = renderToStaticMarkup(<LiveAccountsPanel client={grayElm} clients={clients} />);
  const text = strip(html);

  it('shows all eight dates rather than picking one', () => {
    expect(text).toContain('8 different closes are on screen');
    for (const date of ['2026-07-30', '2026-07-27', '2026-07-24', '2026-07-22', '2026-07-20', '2026-07-17', '2026-07-16', '2026-07-15']) {
      expect(text).toContain(date);
    }
  });
});

describe('LiveAccountsPanel — the whole book', () => {
  const html = renderToStaticMarkup(<LiveAccountsPanel clients={clients} />);
  const text = strip(html);

  it('leads with what is running, measured against what is not', () => {
    // 121 accounts carry an enabled strategy on the last close they appeared
    // in, but only 90 of those closes ARE their client's most recent one. The
    // other 31 were running up to 17 days ago and have not been seen since —
    // 90 and 31 are opposite instructions and were previously summed into one
    // present-tense 121.
    expect(text).toContain(
      '90 of 595 accounts were running at least one enabled strategy on their own client',
    );
    expect(text).toContain(
      '31 more were running as of an older close and have not reported since',
    );
    expect(text).toContain('295 have every strategy switched off');
    expect(text).toContain('179 sent no strategy data at all');
  });

  it('reconciles its own row count against the account registry', () => {
    // 33 accounts across 7 clients trade under a name with no registry row, so
    // any registry-derived count on the same screen — "Accounts (all time)" in
    // the client lifecycle panel directly above this one — is short by exactly
    // those 33. Stated, not left for a reader to guess which number is broken.
    expect(text).toContain('33 accounts across 7 clients report under a name the registry does not hold');
  });

  it('says when a client has no running account on its own latest close', () => {
    expect(text).toContain(
      "on 7 clients not one running account is on that client's own latest close",
    );
  });

  it('states the desk date and the spread around it', () => {
    expect(text).toContain('Most recent close on the desk is 2026-07-30');
    expect(text).toContain('420 are on their client');
    expect(text).toContain('158 are behind it');
    expect(text).toContain('17 have never reported');
    expect(text).toContain('12 clients have no close on file at all');
  });

  it('renders every client that has an account, and none that has not', () => {
    // 80 of the 96 clients hold at least one account. The other 16 have an
    // empty registry and no close, so there is nothing to be wrong about.
    expect(countOf(html, /<section class="drift-row">/g)).toBe(80);
  });

  it('never shows a running account without the date it was running on', () => {
    const rows = html.split('<details>').slice(1);
    expect(rows).toHaveLength(595);
    for (const row of rows) {
      const head = row.slice(0, row.indexOf('</summary>'));
      expect(head).toMatch(/as of 20\d\d-\d\d-\d\d|never reported/);
    }
  });
});

describe('LiveAccountsPanel — degenerate inputs', () => {
  it('says so when there is nothing at all', () => {
    expect(strip(renderToStaticMarkup(<LiveAccountsPanel clients={[]} />))).toBe('No accounts on file.');
  });

  it('does not empty out for a client that has never filed a close', () => {
    const orphan = {
      id: 'orphan',
      name: 'Never Reported',
      accountRegistry: { A1: { alias: 'A one', accountType: 'Funded', status: 'Active' } },
      dailyImports: [],
    };
    const text = strip(renderToStaticMarkup(<LiveAccountsPanel client={orphan} />));
    expect(text).toContain('no close on file');
    expect(text).toContain('none has ever reported');
    expect(text).not.toContain('$0');
  });
});

describe('LiveAccountsPanel — React keys on repeated strategy rows', () => {
  // Two accounts on the real book run the same algo twice on two data series,
  // so name + instrument + dataSeries is NOT unique: Avery Frost's
  // BDG9159854231060 has four strategy rows that collapse to three keys.
  // Duplicate keys make React warn and, on update, reuse or drop the wrong
  // node — the same class of bug as the segment row that remounted on every
  // render and destroyed the button just pressed.
  const averyFrost = clients.find((client) => client.name === 'Avery Frost');
  const html = renderToStaticMarkup(<LiveAccountsPanel client={averyFrost} clients={clients} />);

  it('renders every strategy row, not one fewer', () => {
    const view = buildLiveAccounts(averyFrost, { asOfDate: '' });
    const account = [...view.accounts, ...view.retired].find(
      (row) => row.accountName === 'BDG9159854231060',
    );
    expect(account.strategies).toHaveLength(4);
    const collapsed = new Set(
      account.strategies.map((s) => `${s.name}:${s.instrument}:${s.dataSeries}`),
    );
    expect(collapsed.size).toBe(3);
    // Four chips and four table rows reach the DOM all the same.
    const chipTitles = [...html.matchAll(/class="strategy(?: enabled)?" title="([^"]*)"/g)];
    expect(chipTitles.filter(([, title]) => title === account.strategies[0].name).length)
      .toBeGreaterThanOrEqual(1);
  });

  it('gives every rendered key a distinct value', () => {
    // Rendered markup carries no keys, so the keys are checked at the source
    // they are built from: index first makes them unique by construction.
    const view = buildLiveAccounts(averyFrost, { asOfDate: '' });
    for (const account of [...view.accounts, ...view.retired]) {
      const keys = account.strategies.map(
        (s, index) => `${index}:${s.name}:${s.instrument}:${s.dataSeries}`,
      );
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe('LiveAccountsPanel — a money value nobody sent is not a money value of zero', () => {
  // Both cases below survived a green suite until this block existed: the panel
  // renders `money(null)` in five places (realized, open, balance, and the two
  // strategy columns) and nothing asserted what came out of it. Swapping its
  // 'not measured' for '$0' changed no failing test.
  //
  // The real book cannot reach it today — all 2,934 snapshots carry a balance
  // and all 3,588 strategy rows carry a realized figure — so it takes a
  // constructed close, which is exactly what numberOrNull is written for: the
  // first grid exported without a P&L column would otherwise report every
  // account as having closed flat at $0.
  const noColumns = {
    id: 'no-columns',
    name: 'No Columns',
    accountRegistry: { A1: { alias: 'A one', accountType: 'Funded', status: 'Active' } },
    dailyImports: [{
      id: 'd1',
      date: '2026-07-30',
      orders: [],
      executions: [],
      snapshots: [{
        accountName: 'A1',
        accountBalance: null,
        grossRealizedPnl: null,
        unrealizedPnl: null,
        strategies: [{ strategyName: '0 - URGO-4.5', enabled: true, instrument: 'MNQ SEP26' }],
      }],
    }],
  };

  const html = renderToStaticMarkup(<LiveAccountsPanel client={noColumns} />);
  const text = strip(html);

  it('says "not measured" for a balance and a P&L the close never carried', () => {
    expect(text).toContain('not measured realized');
    expect(text).toContain('balance not measured');
    // The strategy table's Realized and Open columns for the same row: two
    // cells whose whole content is the words, with no currency symbol in either.
    expect(countOf(html, /<td>not measured<\/td>/g)).toBe(2);
  });

  it('never prints a dollar figure for any of them', () => {
    // A currency zero is the claim "this account closed flat", which is what a
    // CAM would repeat to the client. Nothing on this row was measured at all.
    expect(text).not.toContain('$0');
    expect(text).not.toMatch(/\$[\d,]/);
  });
});

describe('LiveAccountsPanel — the strategies-on denominator is strategy rows', () => {
  const parkerPine = clients.find((client) => client.name === 'Parker Pine');
  const text = strip(renderToStaticMarkup(<LiveAccountsPanel client={parkerPine} clients={clients} />));

  it('counts enabled strategies out of strategy rows, not out of accounts', () => {
    // Parker Pine's period-0 group holds 10 accounts carrying 13 strategy rows,
    // 2 of them enabled. "2 of 10" would be a third number that is neither the
    // rows nor the running accounts (which is 2 here, so the swap reads as a
    // 20% duty cycle on a group that is really 2 of 13 = 15%).
    expect(text).toContain('Period 0 10 accounts · 2 of 13 strategies on');
    expect(text).not.toContain('2 of 10 strategies on');
  });

  it('keeps the same denominator for every group on screen', () => {
    const view = buildLiveAccounts(parkerPine, { asOfDate: '' });
    for (const group of view.groups) {
      if (!group.totals.strategyRows) continue;
      expect(text).toContain(
        `${group.label} ${group.accounts.length} account${group.accounts.length === 1 ? '' : 's'}`
        + ` · ${group.totals.strategiesOn} of ${group.totals.strategyRows} strategies on`,
      );
    }
  });
});
