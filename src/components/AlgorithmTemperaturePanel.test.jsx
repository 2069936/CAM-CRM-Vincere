// @vitest-environment jsdom
//
// The desk's per algorithm temperature panel, asserted on rendered text.
//
// EVERY FIXTURE HERE IS SYNTHETIC and the result under test is built by running
// the real `buildAlgorithmTemperature` over it, not by hand writing a result
// literal. Both halves of that matter. Synthetic keeps the file off
// `localSnapshotTests` in vite.config.js, so it runs on CI and on every clone
// rather than only on the machine holding public/local-snapshot.json, which is
// where the guards that matter belong: vite.config.js:14 records two guards that
// lived in a gated file and whose breaking mutations both passed a full CI run.
// Running the real builder keeps the fixture honest about SHAPE, so a field this
// panel reads cannot quietly stop existing while a hand written literal keeps
// the tests green.
//
// WHAT THESE TESTS ARE FOR. The panel does no arithmetic, so the bugs available
// to it are presentation bugs, and every one of them is invisible to a render
// that merely succeeds:
//
//   * re-sorting rows in the component, which would put a Cold row above a Hot
//     one or a one day row at the top, when ordering is the domain's business
//     and the domain has already fixed the magnitude sort bug once
//     (App.jsx:836);
//   * printing a reduction without the caveat that says the denominator is not
//     a portfolio anyone held, on a panel whose figures go to a paying client;
//   * dropping the unsplit disclosure, which on the stored book is more money
//     than the largest row carries;
//   * rendering an unmeasured row as $0, which is the zero versus unmeasured
//     conflation the chart house rules forbid.
//
// Assertions are on TEXT, never on props or on SVG geometry, following
// DeskPeriodReportCharts.test.jsx: a chart that silently drops four rows still
// renders, so the thing worth pinning is what the panel SAYS it drew.
//
// `@testing-library/jest-dom` is not a dependency of this repo, so assertions
// are `toBeTruthy()` and never `toBeInTheDocument()`.

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import AlgorithmTemperaturePanel from './AlgorithmTemperaturePanel';
import { buildAlgorithmTemperature } from '../domain/algorithmTemperature';

afterEach(cleanup);

/* ---------------------------------------------------------------- */
/* Fixture. Same builders as src/domain/algorithmTemperature.test.js. */

const strategy = (family, version, { enabled = true, realized = 0 } = {}) => ({
  strategyName: `0 - ${family.replace('_PF', '-PF')}-${version}`,
  strategyFamily: family,
  strategyVersion: version,
  enabled,
  realized,
});

function client({ id, accountName, days }) {
  return {
    id,
    accountRegistry: {
      [accountName]: { accountName, accountType: 'Funded', status: 'Active', dateFailed: '' },
    },
    dailyImports: days.map(({ date, pnl = 0, strategies }) => ({
      date,
      accounts: {},
      snapshots: [{ accountName, grossRealizedPnl: pnl, strategies }],
      executions: [],
    })),
  };
}

const june = (day) => `2026-06-${String(day).padStart(2, '0')}`;
const solo = (family) => [strategy(family, '1.0')];

// Three accounts over three clients, ten closes each, so the row clears the
// ten day and three account gate. G4M's last three credited dates are strongly
// positive, so it reads Hot; URGO loses every day, so it reads Cold.
const spread = (family, pnlFor) => [1, 2, 3].map((n) => client({
  id: `${family}${n}`,
  accountName: `${family}${n}`,
  days: Array.from({ length: 10 }, (_, i) => ({
    date: june(i + 1),
    pnl: pnlFor(i),
    strategies: solo(family),
  })),
}));

const hotClients = spread('G4M', (i) => (i >= 7 ? 300 : -20));
const coldClients = spread('URGO', () => -100);

// One account, one close: below both halves of the sample gate.
const thinClient = client({
  id: 'ogx1',
  accountName: 'OGX1',
  days: [{ date: june(5), pnl: 120, strategies: solo('OGX') }],
});

// Two algorithms, both carrying a figure, and the figures do not add up to the
// close. Neither can be credited, so both rows are credited on no day at all
// and the money is counted out of every curve.
const unsplitClient = client({
  id: 'x1',
  accountName: 'X1',
  days: [
    {
      date: june(4),
      pnl: -500,
      strategies: [strategy('SYFY', '1.0', { realized: -100 }), strategy('RBO', '2.0', { realized: -100 })],
    },
    {
      date: june(6),
      pnl: -300,
      strategies: [strategy('SYFY', '1.0', { realized: -50 }), strategy('RBO', '2.0', { realized: -50 })],
    },
  ],
});

const ALL = { window: { preset: 'all' } };
const build = (clients) => buildAlgorithmTemperature(clients, ALL);

// The whole book: Hot, Stable and low sample, Cold, and two unmeasured rows.
const book = () => build([...hotClients, ...coldClients, thinClient, unsplitClient]);

// The same book with nothing that fails to partition.
const cleanBook = () => build([...hotClients, ...coldClients, thinClient]);

const panel = (props = {}) => render(<AlgorithmTemperaturePanel result={book()} {...props} />);

// Every query below is scoped to the ranked table. A selected algorithm's name
// appears twice on purpose, once as the row's control and once as the caption
// of its own plot, so an unscoped getByText would be ambiguous exactly when a
// selection exists, which is most of this file.
const table = () => screen.getByRole('table');

// The algorithm name is the control, so the rows in visual order are the
// pressable buttons in DOM order.
const rowNames = () => within(table()).getAllByRole('button')
  .filter((node) => node.getAttribute('aria-pressed') !== null)
  .map((node) => node.textContent);

const rowFor = (name) => within(table()).getByText(name).closest('tr');
const algoButton = (name) => within(table()).getByText(name).closest('button');

/* ---------------------------------------------------------------- */

describe('the order is the domain\'s and the panel does not re-sort it', () => {
  it('lists the algorithms hottest first, exactly as the domain handed them over', () => {
    const result = book();
    panel({ result });
    expect(rowNames()).toEqual(result.rows.map((row) => row.key));
  });

  it('never puts a Cold row above a Hot one', () => {
    // The bug this forbids is real and this repo has paid for it once: sorting
    // by magnitude rather than by signed heat listed OGX at -$405 Cold above
    // G4M at +$360 Hot (App.jsx:836). A panel that re-sorts reintroduces it
    // whatever the domain does.
    panel();
    const order = rowNames();
    const temperature = (name) => rowFor(name).querySelector('em').textContent;
    const hottest = order.findIndex((name) => temperature(name) === 'Hot');
    const coldest = order.findIndex((name) => temperature(name) === 'Cold');
    expect(hottest).toBeGreaterThanOrEqual(0);
    expect(coldest).toBeGreaterThan(hottest);
  });

  it('sinks a row that was credited on no day below every row that was measured', () => {
    const result = book();
    panel({ result });
    const unmeasured = result.rows.filter((row) => row.unmeasured).map((row) => row.key);
    expect(unmeasured.length).toBeGreaterThan(0);
    const rendered = rowNames();
    const firstUnmeasured = Math.min(...unmeasured.map((key) => rendered.indexOf(key)));
    const lastMeasured = Math.max(
      ...result.rows.filter((row) => !row.unmeasured).map((row) => rendered.indexOf(row.key)),
    );
    expect(firstUnmeasured).toBeGreaterThan(lastMeasured);
  });

  it('puts the one day row below the gated rows rather than at the top', () => {
    // It is Stable and positive, so a panel ordering on money alone would rank
    // it above every losing row. The gate is what keeps a single account day
    // from reading as the desk's best algorithm.
    panel();
    const order = rowNames();
    expect(order.indexOf('OGX')).toBeGreaterThan(order.indexOf('G4M'));
    expect(within(rowFor('OGX')).getByText('Low sample')).toBeTruthy();
  });
});

describe('the sample gate is on the screen, not only in the data', () => {
  it('marks a row under the gate and leaves a gated row unmarked', () => {
    panel();
    expect(within(rowFor('OGX')).getByText('Low sample')).toBeTruthy();
    expect(within(rowFor('G4M')).queryByText('Low sample')).toBeNull();
    expect(within(rowFor('URGO')).queryByText('Low sample')).toBeNull();
  });

  it('states the thresholds it marked against', () => {
    const result = book();
    panel({ result });
    expect(
      screen.getByText(new RegExp(`under ${result.minDays} credited days`)),
    ).toBeTruthy();
  });
});

describe('selection', () => {
  it('toggles a row in and back out, and says so on the control', async () => {
    const user = userEvent.setup();
    panel();
    const g4m = algoButton('G4M');
    expect(g4m.getAttribute('aria-pressed')).toBe('false');

    await user.click(g4m);
    expect(g4m.getAttribute('aria-pressed')).toBe('true');

    await user.click(g4m);
    expect(g4m.getAttribute('aria-pressed')).toBe('false');
  });

  it('holds more than one algorithm at a time, which is the whole point', async () => {
    const user = userEvent.setup();
    panel();
    await user.click(algoButton('G4M'));
    await user.click(algoButton('URGO'));
    expect(algoButton('G4M').getAttribute('aria-pressed')).toBe('true');
    expect(algoButton('URGO').getAttribute('aria-pressed')).toBe('true');
  });

  it('is reachable from the keyboard, because the control is a real button', async () => {
    const user = userEvent.setup();
    panel();
    const g4m = algoButton('G4M');
    g4m.focus();
    await user.keyboard('{Enter}');
    expect(g4m.getAttribute('aria-pressed')).toBe('true');
  });

  it('hands the toggle to the parent when the parent owns the selection', async () => {
    const user = userEvent.setup();
    const seen = [];
    render(
      <AlgorithmTemperaturePanel
        result={book()}
        selected={new Set(['URGO'])}
        onToggleAlgorithm={(key) => seen.push(key)}
      />,
    );
    expect(algoButton('URGO').getAttribute('aria-pressed')).toBe('true');
    await user.click(algoButton('G4M'));
    expect(seen).toEqual(['G4M']);
  });

  it('asks for a selection before it draws anything', () => {
    panel();
    expect(screen.getByText(/Select one or more algorithms above/)).toBeTruthy();
  });
});

describe('the comparison a client will be shown', () => {
  it('never prints the reduction without the caveat that travels with it', async () => {
    const user = userEvent.setup();
    const result = book();
    panel({ result });
    await user.click(algoButton('G4M'));
    await user.click(algoButton('URGO'));

    // The figure is on the screen.
    expect(screen.getByText(/lower\./)).toBeTruthy();
    // And so is the sentence the domain publishes beside it, in full. This is
    // the assertion that stops the caveat being summarised into a phrase that
    // loses the point, which is that the denominator is not a portfolio.
    expect(screen.getByText(result.unsplit.note)).toBeTruthy();
    const caveat = screen.getByText(
      'The sum of the parts is not a portfolio anyone held: it adds up each selected '
      + 'algorithm’s own deepest dip as though each had fallen alone, on its own dates, so '
      + 'that total never shrinks as algorithms are added and this figure belongs to the selection '
      + 'rather than to the algorithms. Read it as a statement about these algorithms over these '
      + 'dates, never as a property that survives selecting a fifth one.',
    );
    expect(caveat).toBeTruthy();
  });

  it('prints the composite fall and the sum of the parts as the domain measured them', async () => {
    const user = userEvent.setup();
    const result = build([...hotClients, ...coldClients]);
    render(<AlgorithmTemperaturePanel result={result} />);
    await user.click(algoButton('G4M'));
    await user.click(algoButton('URGO'));

    // -$2,520 combined against -$3,420 for the two parts added together, and
    // all three read off one sentence rather than found anywhere on the page:
    // the figure and its denominator have to be printed together or the
    // percentage is quotable against the wrong one.
    const sentence = screen.getByText(/lower\./).closest('p').textContent;
    expect(sentence).toContain('-$2,520');
    expect(sentence).toContain('-$3,420');
    expect(sentence).toContain('26.32%');
  });

  it('refuses the comparison rather than calling it 100% when nothing fell', async () => {
    const user = userEvent.setup();
    // One account, one credited day, a gain: a curve that never falls.
    render(<AlgorithmTemperaturePanel result={build([thinClient])} />);
    await user.click(algoButton('OGX'));
    expect(screen.getByText(/it is no comparison/)).toBeTruthy();
  });

  it('calls the fall a dip and never a drawdown, which on these screens means a breach', async () => {
    const user = userEvent.setup();
    const result = book();
    panel({ result });
    await user.click(algoButton('G4M'));
    const panelNode = screen.getByText('Algorithm temperature').closest('section');
    expect(panelNode.textContent).toContain(result.dipLabel);
    expect(panelNode.textContent).not.toMatch(/drawdown/i);
  });
});

describe('what could not be partitioned', () => {
  it('states the days and the money on the face of the panel', () => {
    const result = book();
    panel({ result });
    // Two account days, -$800, and the refusal itself spelled out. Read off the
    // heading of the block rather than from anywhere on the page, so a figure
    // that only survives inside the collapsed breakdown does not satisfy it.
    const head = screen.getByText('Not on any curve').closest('.board-head');
    expect(within(head).getByText(/2 account days, -\$800/)).toBeTruthy();
    expect(screen.getByText(result.unsplit.note)).toBeTruthy();
    expect(screen.getByText('Not on any curve')).toBeTruthy();
  });

  it('shows it without anything selected, because it is not a property of the selection', () => {
    panel();
    expect(screen.getByText('Not on any curve')).toBeTruthy();
  });

  it('names why, in the domain\'s own words', () => {
    const result = book();
    panel({ result });
    expect(screen.getByText(new RegExp(result.unsplit.reasons.mismatched.note.slice(0, 60)))).toBeTruthy();
  });

  it('says nothing at all when every account day was partitioned', () => {
    const result = cleanBook();
    expect(result.unsplit.days).toBe(0);
    render(<AlgorithmTemperaturePanel result={result} />);
    expect(screen.queryByText('Not on any curve')).toBeNull();
  });
});

describe('nothing unmeasured is printed as a zero', () => {
  it('reads a row credited on no day as unmeasured, not as Stable at $0', async () => {
    panel();
    const syfy = rowFor('SYFY');
    // Twice on purpose: the temperature cell reads Unmeasured in place of a
    // reading, and the sample cell badges it.
    expect(within(syfy).getAllByText('Unmeasured').length).toBe(2);
    expect(within(syfy).queryByText('Stable')).toBeNull();
    expect(within(syfy).getAllByText('not measured').length).toBeGreaterThan(0);
    expect(within(syfy).queryByText('$0')).toBeNull();
  });

  it('refuses to draw a curve for a selection nothing measured', async () => {
    const user = userEvent.setup();
    panel();
    await user.click(algoButton('SYFY'));
    expect(screen.getByText(/Nothing in this selection was measured/)).toBeTruthy();
    expect(screen.getByText(/it is not a zero/)).toBeTruthy();
  });

  it('names an unmeasured member of a mixed selection instead of dropping it silently', async () => {
    const user = userEvent.setup();
    panel();
    await user.click(algoButton('G4M'));
    await user.click(algoButton('SYFY'));
    expect(screen.getByText(/SYFY: credited on no account day/)).toBeTruthy();
  });
});

describe('the curve', () => {
  it('draws the composite and one plot per selected algorithm, each with its own figures', async () => {
    const user = userEvent.setup();
    panel();
    await user.click(algoButton('G4M'));
    await user.click(algoButton('URGO'));

    const figures = document.querySelectorAll('figure.period-benchmark-curve');
    expect(figures.length).toBe(2);
    // The composite plus the two parts.
    expect(document.querySelectorAll('svg[role="img"]').length).toBe(3);
    // Every drawn value is also printed in the key, so colour is never the only
    // cue and nothing that matters lives in a title attribute alone.
    const key = document.querySelector('ol.period-chart-key');
    expect(within(key).getByText('Combined')).toBeTruthy();
    expect(within(key).getByText('G4M')).toBeTruthy();
    expect(within(key).getByText('URGO')).toBeTruthy();
  });

  it('says the axis is calendar time and that the plots share one scale', async () => {
    const user = userEvent.setup();
    panel();
    await user.click(algoButton('G4M'));
    expect(screen.getByText(/Horizontal axis is calendar time/)).toBeTruthy();
    expect(screen.getByText(/every plot below shares it/)).toBeTruthy();
  });

  it('keeps the stroke non scaling and draws no circle, which this aspect would distort', async () => {
    const user = userEvent.setup();
    panel();
    await user.click(algoButton('G4M'));
    const svg = document.querySelector('svg[role="img"]');
    expect(svg.innerHTML).toContain('non-scaling-stroke');
    expect(svg.querySelector('circle')).toBeNull();
  });
});

describe('empty states', () => {
  it('names an empty window instead of rendering an empty table', () => {
    render(<AlgorithmTemperaturePanel result={build([])} />);
    expect(screen.getByText(/No funded account day in this window carries an attributable algorithm/))
      .toBeTruthy();
  });

  it('warns while the book is still loading fills, because the figures will move', () => {
    render(<AlgorithmTemperaturePanel result={book()} fillsLoaded={false} />);
    expect(screen.getByText(/Fills are not loaded for every close/)).toBeTruthy();
  });

  it('drops that warning once the fills are in', () => {
    render(<AlgorithmTemperaturePanel result={book()} fillsLoaded />);
    expect(screen.queryByText(/Fills are not loaded for every close/)).toBeNull();
  });

  it('renders without a result at all rather than throwing', () => {
    expect(() => render(<AlgorithmTemperaturePanel />)).not.toThrow();
  });
});

describe('the copy this section is asserted against', () => {
  it('carries no dash of any kind, which the Stack Playbook section is pinned on', async () => {
    // StackPlaybook.test.js asserts the whole enclosing section's text matches
    // neither /[–—]/ nor /\s-\s/, and this panel is going to be rendered inside
    // it. A caption reading "63 days - 19 algorithms" fails that there and is
    // cheaper to catch here.
    const user = userEvent.setup();
    panel();
    await user.click(algoButton('G4M'));
    await user.click(algoButton('URGO'));
    const text = screen.getByText('Algorithm temperature').closest('section').textContent;
    expect(text).not.toMatch(/[–—]/);
    expect(text).not.toMatch(/\s-\s/);
  });

  it('does not collide with the combo table, which is found by its own column name', () => {
    // StackPlaybook.test.js:128 locates the team combo table with
    // getByText('Account days'), which throws on a second match. This panel
    // renders beside it and must not introduce one.
    panel();
    expect(screen.queryByText('Account days')).toBeNull();
    expect(screen.getByText('Credited days')).toBeTruthy();
  });
});
