import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import AccountLifecyclePanel from './AccountLifecyclePanel';
import { buildCrmStateFromTables } from '../domain/supabaseStore';
import { buildAccountLifecycleStates } from '../domain/accountLifecycle';

// Asserted against public/local-snapshot.json, the real redacted book: 718
// accounts across 96 visible clients, 179 retire suggestions, 539 accounts left
// off the list with a counted reason. The numbers are the point of the file. A
// panel of this kind is only worth anything if a CAM can trust that the 539 were
// considered and declined rather than dropped.

const snapshot = JSON.parse(
  readFileSync(new URL('../../public/local-snapshot.json', import.meta.url), 'utf8'),
);
const { clients } = buildCrmStateFromTables(snapshot.tables);
const view = buildAccountLifecycleStates(clients);

function strip(fragment) {
  return String(fragment)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const html = renderToStaticMarkup(<AccountLifecyclePanel clients={clients} />);
const text = strip(html);
const countOf = (pattern) => (html.match(pattern) || []).length;

describe('AccountLifecyclePanel on the real book', () => {
  it('renders every suggestion, none of them behind an inert "+N more"', () => {
    // ConfigDriftPanel shipped a version that painted 75 of 267 findings and hid
    // the rest behind a plain <span>. Everything past the per-group limit here
    // lives inside a <details>, so this count is the whole list.
    expect(view.suggestions.length).toBe(179);
    expect(countOf(/<li class="drift-group">/g)).toBe(view.suggestions.length);
    expect(countOf(/<section class="drift-row">/g)).toBe(3);
  });

  it('never says delete, and says retire and confirm', () => {
    // Wording is load-bearing: nothing in this feature removes a registry row, a
    // snapshot or an import, and the one control in the product that does
    // (AccountManager's trash icon) is what created the 33 orphaned accounts
    // this panel has to report as unretirable.
    expect(html).not.toMatch(/delete/i);
    expect(html).not.toMatch(/remove from registry/i);
    expect(text).toMatch(/retiring them/);
    expect(text).toMatch(/to confirm/);
  });

  it('states the split between what the desk declared and what the closes show', () => {
    expect(text).toContain('47 accounts are marked Failed today and 0 of them carry a failure date');
    expect(text).toContain('41 of those are on the list below');
    expect(text).toContain('25 of them were still trading in their latest close');
    expect(text).toContain('21 of those are on the list anyway');
    expect(text).toContain('the other 4 are the real disagreement');
  });

  it('counts every account it declined to suggest, with the reason', () => {
    expect(view.withheldTotal).toBe(539);
    expect(text).toContain('539 accounts were deliberately NOT suggested');
    for (const entry of view.withheld) {
      expect(text).toContain(`${entry.count} · ${entry.reason}`);
    }
    expect(text).toMatch(/104 · stale-only/);
    expect(text).toMatch(/33 · not-in-registry/);
  });

  it('keeps the four written-off-but-healthy accounts off the list entirely', () => {
    // Marked Failed, still trading in the latest close, no breach on record.
    // Buffers $1,567, $999, $81 and one never measured on a $47,380 balance.
    // Retiring these on the strength of the status column is the expensive
    // direction of this error, so they must not appear as suggestions at all.
    // Keyed by client AND account name, because account names are not unique
    // across the book: CEGFHGFFKFHBBF90863 belongs to both Kai Pine (Failed,
    // trading) and Oakley Larch (Active, stale), and EDHCGGKED277608289 to both
    // Harper Dune and Parker Pine. Looking one up by name alone finds the wrong
    // client's account, which is why the classifier keys per client too.
    const healthy = [
      ['Parker Dune', 'EAGGHCKBEGABBCJGAK68289'],
      ['Kai Pine', 'CEGFHGFFKFHBBF90863'],
      ['Harper Dune', 'EDHCGGKED277608289'],
      ['Marlow Iris', 'DJ89861-74!Ggdbkfh!Becggbe'],
    ];
    for (const [clientName, accountName] of healthy) {
      const row = view.accounts.find(
        (entry) => entry.accountName === accountName && entry.clientName === clientName,
      );
      expect(row.declaredFailed).toBe(true);
      expect(row.suggestion).toBeNull();
      expect(row.withheldReason).toBe('declared-failed-still-reporting');
      expect(html).not.toContain(accountName);
    }
  });

  it('prints the state counts, all five of them', () => {
    expect(text).toContain(`Running ${view.counts.running}`);
    expect(text).toContain(`Quiet ${view.counts.quiet}`);
    expect(text).toContain(`Breached / finished ${view.counts.finished}`);
    expect(text).toContain(`Stale (not reporting) ${view.counts.stale}`);
    expect(text).toContain(`Not enough to say ${view.counts.unknown}`);
  });

  it('gives every suggested row its evidence line and a client name', () => {
    for (const row of view.suggestions) {
      expect(text).toContain(row.evidenceLine);
      expect(html).toContain(row.accountName);
    }
  });
});

describe('AccountLifecyclePanel wording for values that were never measured', () => {
  const closes = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09']
    .map((date, index) => ({
      date,
      snapshots: index ? [] : [{
        accountName: 'A1', trailingMaxDrawdown: 0, accountBalance: 50000, grossRealizedPnl: 0, strategies: [],
      }],
      orders: index ? [] : [{ accountName: 'A1', filled: 1, state: 'Filled' }],
      executions: [],
      strategies: [],
    }));
  const local = [{
    id: 'c1',
    name: 'Test Client',
    accountRegistry: { A1: { accountType: 'Evaluation - Bullet Bot', status: 'Failed', alias: 'A1' } },
    dailyImports: closes,
  }];

  it('renders a drawdown that was never measured as absent, not as $0', () => {
    // "Not measured" and "no buffer left" are different claims. The trailing
    // column reads exactly 0 on every close for 89 accounts on the real book
    // because the import carried no column, and rendering that as $0 next to a
    // real -$263 would make the two look like the same fact.
    const markup = renderToStaticMarkup(<AccountLifecyclePanel clients={local} />);
    expect(markup).toContain('<span class="drift-absent">never reported</span>');
    expect(strip(markup)).not.toMatch(/trailing buffer \$0/);
  });

  it('shows an empty book as an empty book', () => {
    const markup = renderToStaticMarkup(<AccountLifecyclePanel clients={[]} />);
    expect(strip(markup)).toBe('No accounts on file for this book yet.');
  });
  it('does not date its evidence to a day with no close on it', () => {
    // Mounted on the ops screen with that screen's asOfDate, which is seeded
    // from the wall clock. The book stops on 2026-07-30 and this used to render
    // "closes to 2026-08-11" — twelve days nobody looked at, printed as if they
    // had been.
    const markup = renderToStaticMarkup(
      <AccountLifecyclePanel clients={clients} asOfDate="2026-08-11" />,
    );
    const text = strip(markup);
    expect(text).toContain('closes to 2026-07-30');
    expect(text).toContain('nothing closed between 2026-07-30 and 2026-08-11');
    expect(text).not.toContain('closes to 2026-08-11');
  });

  it('says nothing about a gap when there is none', () => {
    const markup = strip(renderToStaticMarkup(<AccountLifecyclePanel clients={clients} />));
    expect(markup).toContain('closes to 2026-07-30');
    expect(markup).not.toContain('nothing closed between');
  });
});
