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
import {
  REDUCTION_REFUSALS,
  buildAlgorithmComposite,
  buildAlgorithmTemperature,
} from '../domain/algorithmTemperature';
import { formatCurrency } from '../domain/report';

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

// Rank 1 on the real book is ARPD_PF: ONE credited account day, seventeen days
// before the window closes, and the only row of fourteen with positive heat.
// Heat is the last three CREDITED dates, so a sparse row can be arbitrarily
// stale and still sort to the top of a table a CAM reads as "hottest right now".
// This is that row.
const staleTopClient = client({
  id: 'arpd1',
  accountName: 'ARPD1',
  days: [{ date: june(5), pnl: 430, strategies: solo('ARPD_PF') }],
});

// Two algorithms on one close, each carrying its own figure, and the two add up
// to the account day, so both are credited MEASURED. The winner is larger than
// the loser, so the COMBINED curve never falls while one of the parts did.
//
// This is the defect reproduced on the real book two clicks from a cold open:
// ARPD_PF and DJDR are rank 1 and rank 2 of the default view, both credited only
// on 2026-07-13, and the panel printed "Combined $0 against -$26 for the sum of
// the parts, 100.00% lower" off a $25.50 denominator. `thinClient` cannot catch
// it: one selected algorithm is a different refusal entirely.
const neverFellClient = client({
  id: 'nf1',
  accountName: 'NF1',
  days: [{
    date: june(3),
    pnl: 404.5,
    strategies: [
      strategy('ARPD_PF', '1.0', { realized: 430 }),
      strategy('DJDR', '1.0', { realized: -25.5 }),
    ],
  }],
});

// Two algorithms never credited on the same date. Each falls on its own and
// neither ever offset anything the other did, so a ratio between the two curves
// is arithmetic about unrelated curves.
const apartClients = [
  client({ id: 'ap1', accountName: 'AP1', days: [{ date: june(2), pnl: -100, strategies: solo('B2X') }] }),
  client({ id: 'ap2', accountName: 'AP2', days: [{ date: june(8), pnl: -150, strategies: solo('RBO_PF') }] }),
];

// G4M over ten dates plus an algorithm credited on only the first two of them,
// so the dates the comparison SPANS (10) and the dates on which more than one
// algorithm was credited (2) are different numbers. The G4M/URGO fixture cannot
// catch a basis sentence that names the wrong one, because those two run on all
// ten of the same dates and the two counts coincide: that is exactly why the
// committed panel shipped printing the overlap count as the basis.
const shortOverlapClient = client({
  id: 'ogxpf1',
  accountName: 'OGXPF1',
  days: [
    { date: june(1), pnl: -100, strategies: solo('OGX_PF') },
    { date: june(2), pnl: 50, strategies: solo('OGX_PF') },
  ],
});

const ALL = { window: { preset: 'all' } };
const build = (clients) => buildAlgorithmTemperature(clients, ALL);

// The panel's own `money()`, rebuilt here so the money assertions read the
// rendered string rather than a number the test formatted its own way.
const dollars = (value) => `${value < 0 ? '-' : ''}${formatCurrency(Math.abs(value))}`;

// A published measurement, which is the thing a refusal must not print. Asserted
// on the shape the panel states a figure in and never on the character '%',
// because one of the refusals says in words that the figure would be 0% by
// construction.
const FIGURE = /% lower/;

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

/* ---------------------------------------------------------------- */
/* The five refusals, each printed as ITS OWN reason.                 */
/*                                                                    */
/* The domain publishes `reductionRefusal` and `reductionNote` and    */
/* guarantees that exactly one of the two sides is populated, so the  */
/* panel can neither fall through to a number nor print a percentage  */
/* and a refusal at once. What is still available to the panel is     */
/* printing ONE sentence for all five, which is what the committed    */
/* version did: on every refusal it said "No algorithm in this        */
/* selection fell below where it opened", which is false in three of  */
/* the five cases and false on the exact selection a CAM reaches from */
/* a cold open. Each test below pins the rendered reason, not merely  */
/* the absence of a figure.                                           */

describe('a refusal prints the reason the domain gave, never a percentage', () => {
  it('refuses a one algorithm selection instead of measuring a curve against itself', async () => {
    const user = userEvent.setup();
    const result = book();
    panel({ result });
    await user.click(algoButton('G4M'));

    const composite = buildAlgorithmComposite(result, new Set(['G4M']));
    expect(composite.reduction).toBeNull();
    expect(composite.reductionRefusal).toBe('singleAlgorithm');

    expect(screen.queryByText(FIGURE)).toBeNull();
    expect(screen.getByText(REDUCTION_REFUSALS.singleAlgorithm)).toBeTruthy();
    // And not the one sentence the panel used to print for every refusal. G4M
    // fell -$420 inside this window, so "nothing fell" is a false statement
    // about the selection on the screen.
    expect(screen.queryByText(/No algorithm in this selection fell below where it opened/)).toBeNull();
  });

  it('refuses when the combined curve never fell, though one of the parts did', async () => {
    const user = userEvent.setup();
    const result = build([neverFellClient]);
    render(<AlgorithmTemperaturePanel result={result} />);
    await user.click(algoButton('ARPD_PF'));
    await user.click(algoButton('DJDR'));

    const composite = buildAlgorithmComposite(result, new Set(['ARPD_PF', 'DJDR']));
    expect(composite.reductionRefusal).toBe('compositeNeverFell');
    // A part DID fall, which is what made this case print a number: the
    // denominator is real and only the numerator is zero.
    expect(composite.sumOfPartDips).toBeCloseTo(-25.5, 2);
    expect(composite.deepestDip).toBe(0);

    expect(screen.queryByText(/100\.00% lower/)).toBeNull();
    expect(screen.queryByText(FIGURE)).toBeNull();
    expect(screen.getByText(REDUCTION_REFUSALS.compositeNeverFell)).toBeTruthy();
  });

  it('refuses algorithms that were never credited on the same date', async () => {
    const user = userEvent.setup();
    const result = build(apartClients);
    render(<AlgorithmTemperaturePanel result={result} />);
    await user.click(algoButton('B2X'));
    await user.click(algoButton('RBO_PF'));

    const composite = buildAlgorithmComposite(result, new Set(['B2X', 'RBO_PF']));
    expect(composite.reductionRefusal).toBe('noSharedDate');
    expect(composite.overlapDays).toBe(0);

    expect(screen.queryByText(FIGURE)).toBeNull();
    expect(screen.getByText(REDUCTION_REFUSALS.noSharedDate)).toBeTruthy();
    // Both of them fell, so here too the old single sentence was false.
    expect(screen.queryByText(/No algorithm in this selection fell below where it opened/)).toBeNull();
  });

  it('still refuses a selection nothing measured, in the words that case has', async () => {
    const user = userEvent.setup();
    panel();
    await user.click(algoButton('SYFY'));
    expect(screen.queryByText(FIGURE)).toBeNull();
    expect(screen.getByText(/Nothing in this selection was measured/)).toBeTruthy();
  });
});

describe('the basis sentence names the dates the figure was measured over', () => {
  it('names every credited date, not only the dates more than one algorithm was credited on', async () => {
    const user = userEvent.setup();
    const result = build([...hotClients, shortOverlapClient]);
    render(<AlgorithmTemperaturePanel result={result} />);
    await user.click(algoButton('G4M'));
    await user.click(algoButton('OGX_PF'));

    // Both counts derived from the data rather than read off the copy: the
    // comparison spans every date either row was credited on, and the overlap
    // is the strictly smaller subset on which both were.
    const seriesOf = (key) => result.rows.find((row) => row.key === key).series.map((p) => p.date);
    const spanned = new Set([...seriesOf('G4M'), ...seriesOf('OGX_PF')]);
    const composite = buildAlgorithmComposite(result, new Set(['G4M', 'OGX_PF']));
    expect(spanned.size).toBe(10);
    expect(composite.overlapDays).toBe(2);
    expect(composite.reduction).not.toBeNull();

    // The figure and the sentence stating its basis are one paragraph, so the
    // basis cannot be quoted away from the number it belongs to.
    const sentence = screen.getByText(FIGURE).closest('p').textContent;
    expect(sentence).toContain(`Measured over ${spanned.size} dates`);
    expect(sentence).toContain(`not only the ${composite.overlapDays} dates`);
    // The committed panel printed the overlap count as the basis of the figure,
    // which on the real book claimed 18.16% was measured over 4 dates when it
    // was measured over 12.
    expect(sentence).not.toMatch(/Measured over 2 dates on which more than one/);
  });

  it('says the same thing on a selection whose two counts happen to coincide', async () => {
    const user = userEvent.setup();
    const result = build([...hotClients, ...coldClients]);
    render(<AlgorithmTemperaturePanel result={result} />);
    await user.click(algoButton('G4M'));
    await user.click(algoButton('URGO'));

    const composite = buildAlgorithmComposite(result, new Set(['G4M', 'URGO']));
    expect(composite.reductionDateCount).toBe(composite.overlapDays);
    const sentence = screen.getByText(FIGURE).closest('p').textContent;
    expect(sentence).toContain(`Measured over ${composite.reductionDateCount} dates`);

    // AND IT DOES NOT CONTRAST THAT COUNT WITH ITSELF. The one shape sentence
    // ended "not only the N dates on which more than one of them was" whatever N
    // was, so on a selection whose two counts coincide it named a number and
    // then denied the same number. This test used to pass under that wording,
    // because it only checked the first half; the clause is what a CAM reads
    // aloud, and on the real book this shape carries BOTH figures the domain
    // module quotes, the 4.44% over the ten gated rows and the 5.52% over all
    // fourteen.
    expect(sentence).not.toContain('not only');
    expect(sentence).toContain(
      `Measured over ${composite.reductionDateCount} dates on which at least one selected `
      + 'algorithm was credited, and more than one of them was credited on every one of those dates.',
    );
  });

  it('never prints a reduction as "-0.00% lower", which a float residue used to reach', async () => {
    /* THE LAST MEMBER OF THE "100.00% lower" FAMILY. `percent` here is
     * `(ratio * 100).toFixed(2)`, which renders a ratio of -2.22e-16 as
     * "-0.00", and the panel prints the figure in <strong>. The domain's
     * `FELL_AT_ALL` floor guards the two INPUTS of the ratio against a residue;
     * it does not guard the ratio between two inputs that are both large and
     * equal, which is what two monotonically falling curves produce when the
     * same money is summed in two different orders.
     *
     * On the stored book six selections reached it, the smallest being IFSP +
     * RBO, two ordinary gated rows two clicks apart, at a dip of
     * -$20,642.200000000008 against a sum of -$20,642.200000000004. The domain
     * clamps the published figure at 0 now; this pins the SCREEN, because the
     * defect was only ever visible as a rendered string. */
    const user = userEvent.setup();
    // Two accounts, two dates, both curves only ever falling. The composite
    // accumulates -(0.1+0.2) then -(0.1+0.3) to -0.7000000000000001 while the
    // parts' dips are -(0.1+0.1) + -(0.2+0.3) = -0.7. Same money, two doubles.
    const falling = [
      client({
        id: 'fa',
        accountName: 'FA1',
        days: [
          { date: june(1), pnl: -0.1, strategies: [strategy('G4M', '1.2')] },
          { date: june(2), pnl: -0.1, strategies: [strategy('G4M', '1.2')] },
        ],
      }),
      client({
        id: 'fb',
        accountName: 'FB1',
        days: [
          { date: june(1), pnl: -0.2, strategies: [strategy('OGX', '2.4')] },
          { date: june(2), pnl: -0.3, strategies: [strategy('OGX', '2.4')] },
        ],
      }),
    ];
    const result = build(falling);
    const composite = buildAlgorithmComposite(result, new Set(['G4M', 'OGX']));
    // The fixture really does reach the case: unclamped the ratio is negative.
    expect(1 - (composite.deepestDip / composite.sumOfPartDips)).toBeLessThan(0);
    expect(composite.reduction).toBe(0);

    render(<AlgorithmTemperaturePanel result={result} />);
    await user.click(algoButton('G4M'));
    await user.click(algoButton('OGX'));

    expect(document.body.textContent).not.toContain('-0.00%');
    expect(document.body.textContent).toContain('0.00% lower.');
  });
});

describe('the reduction sentence carries its own sample qualifier', () => {
  it('names the thin rows a published figure leans on, in the sentence itself', async () => {
    /* DEFECT 1 asked for this and only half of it was done: the Low sample badge
     * was carried onto the selected row's own plot, which is right, but the
     * PERCENTAGE is what gets read aloud and pasted into a client document, and
     * it sat two lines from the badge with nothing joining them.
     *
     * On the stored book the largest three algorithm reduction anywhere, ARPD_PF
     * + OGX_PF + ARPD at 20.69%, leans on ARPD_PF, whose whole contribution is
     * ONE credited account day. A reader who carries the number away without the
     * badge is carrying the number the badge was about.
     *
     * Named rather than counted, because "which rows are thin" is the question a
     * CAM has to answer when the figure is questioned. */
    const user = userEvent.setup();
    const result = build([...hotClients, ...coldClients, client({
      id: 'thin',
      accountName: 'THIN1',
      days: [{ date: june(2), pnl: -400, strategies: [strategy('SYFY', '1.4')] }],
    })]);
    render(<AlgorithmTemperaturePanel result={result} />);
    await user.click(algoButton('G4M'));
    await user.click(algoButton('SYFY'));

    const thin = result.rows.find((row) => row.key === 'SYFY');
    expect(thin.lowSample).toBe(true);
    expect(result.rows.find((row) => row.key === 'G4M').lowSample).toBe(false);

    const sentence = screen.getByText(FIGURE).closest('p').textContent;
    expect(sentence).toContain('1 row in this selection is below the sample gate');
    expect(sentence).toContain('SYFY, 1 credited day');
    expect(sentence).toContain('leans on it as heavily as on the rest');
    // The qualifier lives in the SAME paragraph as the figure, so it cannot be
    // quoted away from the percentage it qualifies.
    expect(sentence).toContain('lower.');
    // The Stack Playbook section is asserted against dashes of every kind.
    expect(sentence).not.toMatch(/[–—]/);
    expect(sentence).not.toMatch(/\s-\s/);
  });

  it('says nothing when every selected row cleared the gate', async () => {
    const user = userEvent.setup();
    const result = build([...hotClients, ...coldClients]);
    render(<AlgorithmTemperaturePanel result={result} />);
    await user.click(algoButton('G4M'));
    await user.click(algoButton('URGO'));

    expect(result.rows.filter((row) => row.lowSample)).toHaveLength(0);
    const sentence = screen.getByText(FIGURE).closest('p').textContent;
    expect(sentence).not.toContain('below the sample gate');
  });
});

describe('the heading badge counts the population it walked', () => {
  it('names the funded accounts and clients, with the credited counts as a share of them', () => {
    const result = book();
    panel({ result });

    // The fixture holds an account whose only days could not be partitioned, so
    // the credited counts are genuinely short of the funded population, exactly
    // as they are on the real book at 113 of 180 accounts and 37 of 48 clients.
    expect(result.population.accounts).toBeLessThan(result.population.fundedAccounts);
    expect(result.population.clients).toBeLessThan(result.population.fundedClients);

    const badge = document.querySelector('.panel-heading .badge');
    expect(badge.textContent).toContain(
      `${result.population.accounts} of ${result.population.fundedAccounts} accounts`,
    );
    expect(badge.textContent).toContain(
      `${result.population.clients} of ${result.population.fundedClients} clients`,
    );
    // And never the credited count standing alone as though it were the
    // population, which is what this badge shipped printing and what
    // DeskPeriodReportSheet.jsx records having fixed one panel down.
    expect(badge.textContent).not.toContain(`${result.population.accounts} accounts`);
    expect(badge.textContent).not.toContain(`${result.population.clients} clients`);
  });
});

describe('the caption sizes the money, not only the days', () => {
  it('prints the money share wherever it prints the day share', () => {
    for (const result of [book(), cleanBook()]) {
      cleanup();
      render(<AlgorithmTemperaturePanel result={result} />);
      const caption = screen.getByText(/funded account days in this window/);
      expect(caption.textContent).toContain(
        `${result.population.includedDays} of ${result.population.fundedDays} funded account days`,
      );
      // -$53,417 of unsplit money has nothing to be a fraction of while the
      // funded total is off the screen. Both halves are published and both are
      // printed, in the sentence that carries the day counts.
      expect(caption.textContent).toContain(dollars(result.population.includedPnl));
      expect(caption.textContent).toContain(dollars(result.population.fundedPnl));
    }
  });
});

describe('a sparse row cannot read as the desk\'s best algorithm without saying so', () => {
  it('badges the one day row that sorts to the top and names the date behind its heat', () => {
    const result = build([...coldClients, staleTopClient]);
    render(<AlgorithmTemperaturePanel result={result} />);

    // Rank 1 is one credited account day, which is the shape of ARPD_PF on the
    // real book: the only row with positive heat, credited once.
    expect(rowNames()[0]).toBe('ARPD_PF');
    const top = rowFor('ARPD_PF');
    expect(within(top).getByText('Hot')).toBeTruthy();
    expect(within(top).getByText('Low sample')).toBeTruthy();
    expect(top.textContent).toContain(june(5));

    // And every row names the dates its own heat figure was summed over, so
    // "hottest" is never read as "hottest right now".
    for (const row of result.rows) {
      expect(rowFor(row.key).textContent).toContain(row.heatDates.join(', '));
    }
  });

  it('carries the Low sample badge onto the plot of a selected thin row', async () => {
    const user = userEvent.setup();
    const result = build([...coldClients, staleTopClient]);
    render(<AlgorithmTemperaturePanel result={result} />);
    await user.click(algoButton('ARPD_PF'));
    await user.click(algoButton('URGO'));

    // The curve and the reduction sentence are where a CAM lingers, and the
    // qualifier that a part rests on one account day has to be there too, not
    // only in the table the reader has scrolled past.
    const figures = [...document.querySelectorAll('figure.period-benchmark-curve')];
    const arpd = figures.find((figure) => figure.textContent.includes('ARPD_PF'));
    const urgo = figures.find((figure) => figure.textContent.includes('URGO'));
    expect(within(arpd).getByText('Low sample')).toBeTruthy();
    expect(within(urgo).queryByText('Low sample')).toBeNull();
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
