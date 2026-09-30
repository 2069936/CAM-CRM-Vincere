// @vitest-environment jsdom
//
// buildAlgoComboPerformance is the alias the component keeps over
// src/domain/comboPerformance.js with the OLD rules (enabled at export, family
// keys, current-status population, all history); the rules themselves are
// pinned in comboPerformance.test.js. The two rendering tests at the bottom
// are synthetic on purpose so this file stays off the local-snapshot gate.

import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import StackPlaybook, { buildAlgoComboPerformance } from './StackPlaybook';

afterEach(cleanup);

function makeClient({ id, accountName, accountType = 'Funded', strategyName = '1 - RBO-1.8', pnls = [] }) {
  return {
    id,
    accountRegistry: {
      [accountName]: { accountName, accountType, status: 'Active' },
    },
    dailyImports: pnls.map((pnl, i) => ({
      date: `2026-06-${String(i + 1).padStart(2, '0')}`,
      snapshots: [{
        accountName,
        grossRealizedPnl: pnl,
        strategies: [{ strategyName, strategyFamily: 'RBO', enabled: true }],
      }],
    })),
  };
}

describe('buildAlgoComboPerformance', () => {
  it('returns empty array when no clients provided', () => {
    expect(buildAlgoComboPerformance([])).toEqual([]);
  });

  it('aggregates funded account combos across clients', () => {
    const clients = [
      makeClient({ id: 'c1', accountName: 'ACC1', pnls: [100, 200, 150] }),
      makeClient({ id: 'c2', accountName: 'ACC2', pnls: [50, 100] }),
    ];
    const result = buildAlgoComboPerformance(clients);
    expect(result).toHaveLength(1);
    expect(result[0].totalDays).toBe(5);
    expect(result[0].accounts).toBe(2);
    expect(result[0].clients).toBe(2);
    expect(result[0].avgPnl).toBeCloseTo((100 + 200 + 150 + 50 + 100) / 5);
  });

  it('excludes non-funded account types from combo performance', () => {
    const clients = [
      makeClient({ id: 'c1', accountName: 'EVAL1', accountType: 'Evaluation - Standard', pnls: [500, 600] }),
    ];
    expect(buildAlgoComboPerformance(clients)).toEqual([]);
  });

  it('resolves account registry case-insensitively when CSV name differs from registry key', () => {
    const client = {
      id: 'c-ci',
      accountRegistry: {
        APEX1234: { accountName: 'APEX1234', accountType: 'Funded', status: 'Active' },
      },
      dailyImports: [{
        date: '2026-06-25',
        snapshots: [{ accountName: 'apex1234', grossRealizedPnl: 300, strategies: [{ strategyName: '1 - RBO-1.8', strategyFamily: 'RBO', enabled: true }] }],
      }],
    };
    const result = buildAlgoComboPerformance([client]);
    expect(result).toHaveLength(1);
    expect(result[0].totalDays).toBe(1);
  });

  it('computes the recent-window average by real date, not array position', () => {
    // 6 closes 2026-06-01..06; a 3-day window covers only the last three dates
    const clients = [makeClient({ id: 'c1', accountName: 'ACC1', pnls: [10, 20, 30, 40, 50, 60] })];
    const result = buildAlgoComboPerformance(clients, { windowDays: 3 });
    expect(result[0].recentDays).toBe(3);
    expect(result[0].recentAvg).toBeCloseTo((40 + 50 + 60) / 3);
  });

  it('aligns the window across clients with different import cadences (date, not tail)', () => {
    const c1 = makeClient({ id: 'c1', accountName: 'A1', pnls: [1, 2, 3, 4, 5, 6] }); // 06-01..06-06
    const c2 = makeClient({ id: 'c2', accountName: 'A2', pnls: [100, 200] }); // 06-01..06-02
    const result = buildAlgoComboPerformance([c1, c2], { windowDays: 2 });
    // anchor = 2026-06-06; the 2-day window is 06-05/06-06 — c2 has nothing there,
    // so its tail (100,200) must NOT leak into the recent window.
    expect(result[0].recentDays).toBe(2);
    expect(result[0].recentAvg).toBeCloseTo((5 + 6) / 2);
  });
});

// One funded account with a close per day, URGO 4.5 enabled on every one.
function tenCloseClient() {
  const accountName = 'FUND1';
  return {
    id: 'c-ten',
    name: 'Ten closes',
    accountRegistry: { [accountName]: { accountName, accountType: 'Funded', status: 'Active' } },
    dailyImports: Array.from({ length: 10 }, (_, i) => ({
      id: `di-${i}`,
      date: `2026-06-${String(i + 1).padStart(2, '0')}`,
      accounts: {},
      flags: [],
      executions: [],
      snapshots: [{
        accountName,
        grossRealizedPnl: i % 3 === 0 ? -40 : 25,
        accountBalance: 50000,
        trailingMaxDrawdown: -500,
        strategies: [{ strategyName: '0 - URGO-4.5', strategyFamily: 'URGO', strategyVersion: '4.5', enabled: true, realized: 0 }],
      }],
    })),
  };
}

function renderPlaybook(client = tenCloseClient(), extra = {}) {
  return render(createElement(StackPlaybook, {
    client,
    dailyImport: client.dailyImports[client.dailyImports.length - 1],
    allClients: [client],
    hiddenClientCount: 3,
    ...extra,
  }));
}

// The team table, found by the column that only it carries.
function teamTable() {
  return screen.getByText('Account days').closest('table');
}

function accountDaysOf(key) {
  const table = teamTable();
  const headers = [...table.querySelectorAll('thead th')].map((th) => th.textContent);
  const column = headers.indexOf('Account days');
  const tr = [...table.querySelectorAll('tbody tr')].find((r) => r.querySelector('td strong')?.textContent === key);
  return tr.querySelectorAll('td')[column].textContent;
}

describe('the rendered team panel', () => {
  it('26. labels the figures as client account results and heads the average column honestly', () => {
    const { container } = renderPlaybook();
    expect(container.textContent).toContain('Not comparable to My Futures Book');
    expect(container.textContent).toContain('Client account results while the combo was running. Not the algorithm\'s own track record. Not comparable to My Futures Book.');
    const headers = [...teamTable().querySelectorAll('thead th')].map((th) => th.textContent);
    expect(headers).toEqual([
      'Combo', 'Range', 'Account days', 'Traded days', 'Accounts', 'Clients',
      'Avg P&L per account day', 'Avg P&L per traded day', 'Win rate on traded days',
      'Flat days', 'Trend in window', 'Sample',
    ]);
    // The caption carries the live numbers, the hidden-client count included.
    expect(container.textContent).toContain('10 of 10 funded account days in range');
    expect(container.textContent).toContain('3 inactive clients are not loaded');
    // No dash of any kind in the panel's own copy.
    const panel = teamTable().closest('section');
    expect(panel.textContent).not.toMatch(/[\u2013\u2014]/);
    expect(panel.textContent).not.toMatch(/\s-\s/);
    // The window, grouping and attribution controls carry their exact labels.
    expect([...panel.querySelectorAll('select.window-select option')].map((o) => o.textContent)).toEqual([
      'Last 7 days', 'Last 30 days', 'Last 90 days', 'All history', 'Custom range',
    ]);
    expect([...panel.querySelectorAll('.playbook-toggles button')].map((b) => b.textContent)).toEqual([
      'By version', 'By family', 'Traded (enabled or filled)', 'Enabled at export',
    ]);
    // And the client panel beside it says the same thing in the same words.
    const insight = screen.getByText('Client Config vs Team Avg').closest('section');
    expect([...insight.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual([
      'Account', 'Combo on this close', 'This account on this combo, avg per account day',
      'Team on this combo, avg per account day', 'Difference', 'Suggestion',
    ]);
    expect(insight.textContent).toContain('Team figures are client account results, not the algorithm\'s own track record.');
    expect(insight.textContent).toContain('No suggestion passes the gate');
    expect(insight.textContent).toContain('10 of 10 days in range');
    expect(insight.textContent).not.toMatch(/[\u2013\u2014]/);
  });

  it('27. changes every column when the window select moves from 30 to 7 days', () => {
    renderPlaybook();
    const select = screen.getByLabelText('Window');
    expect(select.value).toBe('30');
    expect(within(select).getByText('Last 30 days')).toBeTruthy();
    // 'URGO', not 'URGO 4.5': this screen opens at family level now. See the
    // grouping test below for why the default moved and what still moves it.
    expect(accountDaysOf('URGO')).toBe('10');

    fireEvent.change(select, { target: { value: '7' } });
    expect(select.value).toBe('7');
    expect(accountDaysOf('URGO')).toBe('7');
  });

  it('28. prefills the custom range from the book and measures the range it is given', () => {
    renderPlaybook();
    const select = screen.getByLabelText('Window');
    expect(screen.queryByLabelText('From')).toBeNull();

    fireEvent.change(select, { target: { value: 'custom' } });
    const from = screen.getByLabelText('From');
    const to = screen.getByLabelText('To');
    // Prefilled with the range the closes cover, not with the 30 day preset's
    // 2026-05-12, and neither input can be pushed outside the book.
    expect(from.value).toBe('2026-06-01');
    expect(to.value).toBe('2026-06-10');
    expect(from.getAttribute('min')).toBe('2026-06-01');
    expect(from.getAttribute('max')).toBe('2026-06-10');
    expect(to.getAttribute('max')).toBe('2026-06-10');
    expect(accountDaysOf('URGO')).toBe('10');

    fireEvent.change(from, { target: { value: '2026-06-05' } });
    expect(accountDaysOf('URGO')).toBe('6');
    fireEvent.change(to, { target: { value: '2026-06-07' } });
    expect(accountDaysOf('URGO')).toBe('3');
  });
});

/* ── The algorithm temperature panel, wired into this screen ────────────────
 *
 * The panel's own behaviour is pinned by AlgorithmTemperaturePanel.test.jsx and
 * the measurement by algorithmTemperature.test.js. What can only go wrong HERE
 * is the wiring, and there are exactly three ways it can:
 *
 *   * the panel is not on the screen, or is below the combo table it was added
 *     to lead;
 *   * it is fed a build of its own and drifts off the window control, so one
 *     screen shows a 7 day panel above a 30 day table and the reader compares
 *     them;
 *   * the combo table loses the sentence that says which question IT answers,
 *     leaving two tables of algorithm money under one heading with nothing
 *     distinguishing them.
 *
 * The fixture is synthetic, like the two at the top of this file and for the
 * same reason: this suite is NOT on `localSnapshotTests`, so it has to run on a
 * clone that does not hold the book.
 */

// One client, two funded accounts, ten closes each, each account running ONE
// algorithm on every close. Single algorithm days are the SOLE case, so both
// rows are credited their account's whole day and no day lands unsplit: the
// heat ordering is then a fact about the fixture and not about the partition.
// URGO makes +$300 a day and G4M loses $300, so heat over the last three
// credited dates is +$900 against -$900: Hot above Cold, which is the order
// the panel must print and must not re-derive.
//
// The hot row is the one that sorts LAST alphabetically and is built SECOND, on
// purpose. Both rows carry the same ten credited days and the same one account,
// so nothing but signed heat separates them, and the three orders a component
// re-sort would plausibly produce are all different from the right one: by key
// and by insertion both put G4M on top, and by MAGNITUDE the two tie at $900 and
// fall back to the key, which puts G4M on top as well.
function twoAlgoClient() {
  const algos = [
    ['G4M1', 'G4M', '1.0', -300],
    ['URGO1', 'URGO', '4.5', 300],
  ];
  return {
    id: 'c-two-algo',
    name: 'Two algos',
    accountRegistry: Object.fromEntries(algos.map(([accountName]) => [
      accountName, { accountName, accountType: 'Funded', status: 'Active', dateFailed: '' },
    ])),
    dailyImports: Array.from({ length: 10 }, (_, i) => ({
      id: `di-${i}`,
      date: `2026-06-${String(i + 1).padStart(2, '0')}`,
      accounts: {},
      flags: [],
      executions: [],
      snapshots: algos.map(([accountName, family, version, pnl]) => ({
        accountName,
        grossRealizedPnl: pnl,
        accountBalance: 50000,
        trailingMaxDrawdown: -500,
        strategies: [{
          strategyName: `0 - ${family}-${version}`,
          strategyFamily: family,
          strategyVersion: version,
          enabled: true,
          realized: pnl,
        }],
      })),
    })),
  };
}

// The temperature panel, found by the heading only it carries.
function tempPanel() {
  return screen.getByText('Algorithm temperature').closest('section');
}

// Its table, found by the column the combo table deliberately does not share:
// the combo table's is "Account days", and a second element with that text
// would break `teamTable()` above for every test in this file.
function tempTable() {
  return within(tempPanel()).getByText('Credited days').closest('table');
}

function tempRowKeys() {
  return [...tempTable().querySelectorAll('tbody tr')]
    .map((tr) => tr.querySelector('th strong').textContent);
}

// The first text node of a cell, not its textContent: these cells carry a
// figure followed by <small> notes, and "10" plus "10 sole, 0 measured" reads
// as "1010" when concatenated.
function tempCell(key, header) {
  const table = tempTable();
  const headers = [...table.querySelectorAll('thead th')].map((th) => th.textContent);
  // The row's own first cell is a <th scope="row">, so the <td> list starts one
  // column later than the header list.
  const column = headers.indexOf(header) - 1;
  const tr = [...table.querySelectorAll('tbody tr')]
    .find((r) => r.querySelector('th strong')?.textContent === key);
  return tr.querySelectorAll('td')[column].childNodes[0].textContent;
}

describe('the algorithm temperature panel on the playbook', () => {
  it('29. leads the screen with one row per algorithm, hottest first, above the combo table', () => {
    renderPlaybook(twoAlgoClient());

    // Present, and the reader meets it BEFORE the combo table: that placement
    // is the whole ask, and a panel appended to the end of the screen would
    // satisfy every other assertion here.
    const temperature = tempPanel();
    const combo = teamTable().closest('section');
    expect(temperature).toBeTruthy();
    expect(temperature).not.toBe(combo);
    expect(temperature.compareDocumentPosition(combo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Rows are REAL ALGORITHMS, not combinations, in the domain's heat order.
    // Sorting in the component is the mutation this pins: both rows carry the
    // same ten days and the same account count, so any order but this one is a
    // re-sort.
    expect(tempRowKeys()).toEqual(['URGO', 'G4M']);
    expect(tempCell('URGO', 'Heat')).toBe('+$900');
    expect(tempCell('G4M', 'Heat')).toBe('-$900');
    expect(tempCell('URGO', 'Temperature')).toBe('Hot');
    expect(tempCell('G4M', 'Temperature')).toBe('Cold');

    // No dash of any kind, the rule the combo section below is already held to.
    expect(temperature.textContent).not.toMatch(/[–—]/);
    expect(temperature.textContent).not.toMatch(/\s-\s/);
  });

  it('30. keeps the combo table, and says which question it is the one that answers', () => {
    const { container } = renderPlaybook(twoAlgoClient());

    // Not deleted: deskPeriodReport.js and buildClientComboInsights still read
    // buildComboPerformance, and a combination is a question the panel above
    // cannot answer.
    expect(teamTable()).toBeTruthy();
    const combo = teamTable().closest('section');
    expect(combo.textContent).toContain(
      'A row here is a COMBINATION: what a whole client account day was worth while that stack was running, '
      + 'which is the question the Algorithm temperature panel above does not answer.',
    );
    // And the panel above states the rule that makes the two non interchangeable.
    expect(container.textContent).toContain('It is never divided equally.');
  });

  it('31. reads the combo table\'s window control, and moves with it', () => {
    renderPlaybook(twoAlgoClient());
    const select = screen.getByLabelText('Window');

    // One window picker on the screen, not two. A second select would let the
    // two panels disagree while both printed a window.
    expect(screen.getAllByLabelText('Window')).toHaveLength(1);
    // The shared controls, named in the panel's own words. The 30 day preset
    // resolves to 2026-05-12 over a book whose first close is 2026-06-01, which
    // is the resolved window and not the book's range: both builds go through
    // comboPerformance.resolveWindow, so both get that one.
    expect(tempPanel().textContent).toContain(
      'Window 2026-05-12 to 2026-06-10. Grouping: By family. Attribution: Traded (enabled or filled).',
    );
    expect(tempCell('G4M', 'Credited days')).toBe('10');
    expect(accountDaysOf('G4M')).toBe('10');

    fireEvent.change(select, { target: { value: '7' } });
    expect(tempCell('G4M', 'Credited days')).toBe('7');
    expect(accountDaysOf('G4M')).toBe('7');
    expect(tempPanel().textContent).toContain('Window 2026-06-04 to 2026-06-10.');

    // Including the custom range, which resolves through the same
    // comboPerformance.resolveWindow for both builds.
    fireEvent.change(select, { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-06-05' } });
    expect(tempCell('G4M', 'Credited days')).toBe('6');
    expect(accountDaysOf('G4M')).toBe('6');
    expect(tempPanel().textContent).toContain('Window 2026-06-05 to 2026-06-10.');
  });

  it('32. opens at family, and regroups with the combo table\'s toggle rather than holding a level of its own', () => {
    renderPlaybook(twoAlgoClient());

    /* THE COLD OPEN IS FAMILY, ON BOTH PANELS.
     *
     * This screen held `useState('version')`, so the first rows a user met read
     * `URGO 4.5` and `G4M 1.0`: the fragmentation the whole panel exists to
     * undo, under a new heading. `algorithmTemperature.DEFAULT_OPTIONS` says
     * family and its comment says why. On this fixture each family carries one
     * version, so the two levels give the same two rows and only the KEYS move;
     * that is what makes this assertion the whole test.
     */
    expect(tempRowKeys()).toEqual(['URGO', 'G4M']);
    expect(accountDaysOf('URGO')).toBe('10');
    expect(tempPanel().textContent).toContain('Grouping: By family.');

    // One toggle, both panels. The state is shared on purpose: two grouping
    // controls on one screen is how a reader ends up comparing family rows
    // above against version rows below and calling the difference a result.
    const toggle = (label) => [...teamTable().closest('section').querySelectorAll('.playbook-toggles button')]
      .find((b) => b.textContent === label);
    fireEvent.click(toggle('By version'));
    expect(tempRowKeys()).toEqual(['URGO 4.5', 'G4M 1.0']);
    expect(accountDaysOf('URGO 4.5')).toBe('10');
    expect(tempPanel().textContent).toContain('Grouping: By version.');

    fireEvent.click(toggle('By family'));
    expect(tempRowKeys()).toEqual(['URGO', 'G4M']);
  });

  it('34. carries the fills caveat only under the attribution that reads fills', () => {
    // These closes carry no executions and no `detailLoaded`, so
    // fillsLoadedAcross is false and traded attribution is reading the strategy
    // grid alone. Both panels say so, in their own words.
    renderPlaybook(twoAlgoClient());
    const combo = teamTable().closest('section');
    expect(tempPanel().textContent).toContain(
      'Fills are not loaded for every close in this window, so attribution is reading the strategy '
      + 'grid alone and these figures move when trade history finishes loading.',
    );
    expect(combo.textContent).toContain('No fills are loaded for these closes');

    // Under "Enabled at export" nothing reads a fill, so the sentence would be
    // false rather than merely absent: these figures do NOT move when trade
    // history lands. The combo table has always gated it on the basis; the
    // panel above is gated the same way and not left saying it always.
    const enabled = [...combo.querySelectorAll('.playbook-toggles button')]
      .find((b) => b.textContent === 'Enabled at export');
    fireEvent.click(enabled);
    expect(tempPanel().textContent).not.toMatch(/Fills are not loaded/);
    expect(teamTable().closest('section').textContent).not.toMatch(/No fills are loaded/);
  });

  /* One client, two funded accounts, ten closes, and the two acceptance rules
   * deliberately disagreeing on one of the accounts.
   *
   *   M-1 runs URGO alone: exactly one algorithm ran, so the temperature panel
   *        credits the whole day to it (SOLE) and the combo table names the
   *        stack `URGO`.
   *   M-2 runs URGO and G4M, each reporting $100 against a close worth $500.
   *        Two ran and their figures do not reconcile with the account day, so
   *        the temperature panel credits NOBODY (UNSPLIT) while the combo table
   *        still has a nameable stack and takes the day.
   *
   * That is the whole of the gap between the two badges, reproduced small: one
   * funded population, two rules, two different subsets credited. */
  function mixedBookClient() {
    const accounts = ['M-1', 'M-2'];
    return {
      id: 'c-mixed',
      name: 'Mixed book',
      accountRegistry: Object.fromEntries(accounts.map((accountName) => [
        accountName, { accountName, accountType: 'Funded', status: 'Active', dateFailed: '' },
      ])),
      dailyImports: Array.from({ length: 10 }, (_, i) => ({
        id: `dm-${i}`,
        date: `2026-06-${String(i + 1).padStart(2, '0')}`,
        accounts: {},
        flags: [],
        executions: [],
        snapshots: [
          {
            accountName: 'M-1',
            grossRealizedPnl: 200,
            accountBalance: 50000,
            trailingMaxDrawdown: -500,
            strategies: [{
              strategyName: '0 - URGO-4.5', strategyFamily: 'URGO', strategyVersion: '4.5', enabled: true, realized: 200,
            }],
          },
          {
            accountName: 'M-2',
            grossRealizedPnl: 500,
            accountBalance: 50000,
            trailingMaxDrawdown: -500,
            strategies: [
              { strategyName: '0 - URGO-4.5', strategyFamily: 'URGO', strategyVersion: '4.5', enabled: true, realized: 100 },
              { strategyName: '0 - G4M-1.0', strategyFamily: 'G4M', strategyVersion: '1.0', enabled: true, realized: 100 },
            ],
          },
        ],
      })),
    };
  }

  // The badge in a panel heading, by the heading it sits beside.
  const badgesOf = (section) => [...section.querySelectorAll('.panel-heading .badge')]
    .map((b) => b.textContent.replace(/\s+/g, ' ').trim());

  it('35. names the population under both badges, so the gap between them is the rule and not a loss', () => {
    /* THE CONTRADICTION THIS SCREEN USED TO MANUFACTURE.
     *
     * On the stored book the temperature badge read "113 accounts · 37 clients"
     * and the combo badge 40 lines below read "149 accounts · 44 clients", with
     * a sentence between them promising the two panels "are never measuring two
     * different books". Neither badge said which population it counted, so 36
     * accounts and 7 clients vanished across one screen with nothing accounting
     * for them, and the likeliest reading was that the new panel had dropped
     * data. It had not: it had refused to attribute it.
     */
    renderPlaybook(mixedBookClient());

    // Both badges in the `N of M` shape, against the SAME funded population.
    expect(badgesOf(tempPanel())).toContain('2 algorithms · 1 of 2 accounts · 1 of 1 client credited');
    const combo = teamTable().closest('section');
    expect(badgesOf(combo)).toContain('2 combos · 2 of 2 accounts · 1 of 1 clients attributed');

    // And the sentence between them no longer claims the two cannot differ. It
    // names the shared denominator once and both acceptance rules beside it.
    expect(tempPanel().textContent).not.toMatch(/never measuring two different books/);
    expect(tempPanel().textContent).toContain(
      'Both walk the same funded population, 2 accounts and 1 client in this window, and credit '
      + 'different parts of it: this panel takes an account day only when the day can be given to '
      + 'a single algorithm (1 account, 1 client), and the table below takes it whenever the '
      + 'whole stack that ran is nameable (2 accounts, 1 client). The gap between the two badges '
      + 'is that rule and nothing else: the same book goes into both, and the second rule accepts '
      + 'more of it, 20 account days against 10 account days. Every account day this panel '
      + 'credits is credited by the table too. The days the table has and this panel does '
      + 'not are the ones named above as credited to nobody.',
    );

    /* AND THE REASSURANCE THAT REPLACED THE FIRST ONE IS GONE TOO. The fix for
     * the badges swapped "never measuring two different books" for "No client
     * and no account day is in one build and absent from the other", which is
     * the same shape one clause further down and false for the same reason: the
     * sentence before it uses "build" to mean what each panel CREDITS, and on
     * the stored book 214 account days and 7 clients are credited by the table
     * and not by the panel. Both falsifying counts are printed on this screen.
     * The caption now states the direction, which is true and is a subset
     * claim mirrored on the real book in algorithmTemperature.book.test.js. */
    expect(tempPanel().textContent).not.toMatch(/in one build and absent from the other/);
  });

  it('36. discloses the clients neither build loaded, on the panel that sits first', () => {
    /* `hiddenClientCount` was passed to buildComboPerformance and not to
     * buildAlgorithmTemperature, so `population.hiddenClients` was a hardcoded
     * 0 on the panel a reader meets FIRST while the caption 80 lines below
     * disclosed 40 excluded clients on the stored book. One screen, one
     * population, one panel disclosing the exclusion and one silently taking
     * it.
     *
     * `failedAccountDays` is printed as TWO figures rather than one because the
     * two builds count it over the days each of them credited: on the stored
     * book that is 14 here against 26 below. One number under a caption reading
     * "in both" would be the same defect this test exists to close, one field
     * over. */
    renderPlaybook(twoAlgoClient());
    expect(tempPanel().textContent).toContain(
      '3 inactive clients are loaded into neither panel. Accounts now marked Failed are kept in '
      + 'both, and they carry 0 of the account days credited here against 0 of the account days '
      + 'the table below attributes.',
    );
    // The same two figures the combo caption prints, off the same inputs.
    expect(teamTable().closest('section').textContent).toContain('3 inactive clients are not loaded');
  });

  it('37. says whose book it is, in both roles, in the heading and in the caption', () => {
    /* `allClients` is `state.clients`, scoped by camScopeFor(session) in the
     * browser and by row level security in the database since step 52, which
     * measured a CAM named Peter seeing 36 clients of 212. Nothing on this
     * screen said so, under a heading reading "Team Algo Performance". */
    const client = twoAlgoClient();
    renderPlaybook(client, { scope: { kind: 'cam', camName: 'Peter' } });

    // The heading of BOTH panels carries it, not a paragraph three below.
    expect(badgesOf(tempPanel())).toContain('Your book · 1 client');
    expect(badgesOf(teamTable().closest('section'))).toContain('Your book · 1 client');
    // And the caption says what cannot be rescued by a hidden-client count:
    // RLS removes the rest before this browser counts anything.
    expect(tempPanel().textContent).toContain(
      "Your book, not the desk: the 1 client assigned to Peter. Another CAM's clients are removed "
      + 'by the database before this browser counts anything, so the rest of the desk is not '
      + 'missing from these figures, it was never in them, and nothing on this screen can say how '
      + 'large it is.',
    );
    expect(teamTable().closest('section').textContent).toContain('Your book, not the desk:');

    cleanup();
    renderPlaybook(client, { scope: { kind: 'desk', camName: '' } });
    expect(badgesOf(tempPanel())).toContain('Every client loaded · 1');
    expect(tempPanel().textContent).toContain(
      'This login is not scoped to one CAM: it loads every client the database will hand it, '
      + '1 client here, so these are desk figures.',
    );
    expect(tempPanel().textContent).not.toMatch(/Your book, not the desk/);
  });

  it('33. draws the selected algorithm underneath, live on this screen', () => {
    renderPlaybook(twoAlgoClient());
    const panel = tempPanel();
    expect(panel.textContent).toContain('Select one or more algorithms above to draw their combined curve');

    fireEvent.click(within(tempTable()).getByRole('button', { name: 'URGO' }));
    expect(panel.querySelector('svg')).toBeTruthy();
    expect(panel.textContent).toContain('Combined credited P&L of 1 algorithm');
    expect(panel.textContent).toContain('Deepest dip inside this window');
    // And never the word the CAM reads as a prop firm breach.
    expect(panel.textContent).not.toMatch(/drawdown/i);
  });
});
