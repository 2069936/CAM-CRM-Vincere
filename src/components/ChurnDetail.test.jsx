// @vitest-environment jsdom
//
// The click that has to reach the data, and the filters that have to be the
// panel's own.
//
// clientLifecycle.test.js pins what buildChurnDetail computes. This pins that a
// manager can actually get to it: that the churn stat is a control and not a
// label, that opening it lists the clients the number is made of, and that
// typing a date into this panel changes this panel and nothing else.
//
// THAT LAST ONE IS THE POINT OF THE FILE. The drill-down deleted from the
// Operations screen one round ago was not broken — it rendered the right rows —
// it was wired to the PAGE's as-of date, the same state the header picker
// writes, so choosing a date inside it silently re-pinned every KPI, roster and
// money figure above it. The manager reported that panel as doing nothing. A
// filter that belongs to a panel must be state the panel owns, and the only way
// to see that is a real render with a real change event, so this opts into jsdom
// the way ReportNoteSwitch.test.jsx does.
//
// It also pins the two places a churn REASON is drawn — the drill-down's own
// column and the header of a single client's lifecycle panel — against the same
// rule, because "not 'Other'" has to hold on both or it holds on neither.
//
// Synthetic fixtures only, so CI runs every line of it.

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ChurnDetail from './ChurnDetail';
import { ClientLifecyclePanel, LifecycleRollupPanel } from './ClientLifecyclePanel';
import {
  buildChurnRetention,
  buildClientLifecycle,
  buildLifecycleRollup,
} from '../domain/clientLifecycle';

afterEach(cleanup);

const churnedClient = (id, name, { reason, note, at } = {}) => ({
  id,
  name,
  profile: { stage: 'Inactive', startDate: '2026-01-10' },
  accountRegistry: {},
  dailyImports: [],
  ...(reason || note || at ? { churn: { reason, note, at } } : {}),
});

const BOOK = [
  churnedClient('b1', 'Bea', { reason: 'cost', note: 'Wanted a cheaper stack.', at: '2026-06-02' }),
  churnedClient('b2', 'Cal', { reason: 'cost', at: '2026-07-20' }),
  churnedClient('b3', 'Dee', { reason: 'unresponsive', at: '2026-07-02' }),
  churnedClient('b4', 'Eli'),
  { id: 'a1', name: 'Active one', profile: { stage: 'Active' }, accountRegistry: {}, dailyImports: [] },
];

const CAMS = { b1: 'Oakley Ash', b2: 'Oakley Ash', b3: 'Reese Glen', b4: 'Reese Glen' };

const rowsWithCams = () => buildChurnRetention(BOOK, { camNameByClientId: CAMS }).churnedClients;
const rowsWithoutCams = () => buildChurnRetention(BOOK).churnedClients;

const bodyNames = () => within(screen.getByRole('table'))
  .getAllByRole('row')
  .slice(1)
  .map((row) => row.cells[0].textContent);

/* ── The number opens ─────────────────────────────────────────────────────── */

describe('the churn number is a control, not a label', () => {
  it('opens the clients it is made of', () => {
    render(
      <LifecycleRollupPanel
        rollup={buildLifecycleRollup(BOOK, { camNameByClientId: CAMS })}
        title="Team lifecycle & retention"
      />,
    );
    // Closed to begin with: this panel is nine stats and a table under one of
    // them, not a table with nine stats on top.
    expect(screen.queryByRole('table')).toBeNull();

    const toggle = screen.getByRole('button', { name: /Churned/ });
    expect(toggle).toHaveProperty('ariaExpanded', 'false');
    fireEvent.click(toggle);

    expect(bodyNames()).toEqual(['Cal', 'Dee', 'Bea', 'Eli']);
    // Four rows behind a stat that reads 4.
    expect(toggle.textContent).toContain('4');
    // Rendered from a ROLL-UP, so this is the only assertion that walks the
    // whole chain the manager's page actually uses — buildLifecycleRollup into
    // buildChurnRetention into buildChurnDetail into the column. The map is an
    // optional argument at every hop, and dropped at any of them the CAM column
    // empties out with every count on the panel still correct.
    expect(within(screen.getByRole('table')).getAllByRole('row')[1].cells[1].textContent)
      .toBe('Oakley Ash');
    fireEvent.click(toggle);
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('still opens when the count is zero, and says why it is zero', () => {
    // The real desk book is exactly this case: 96 clients, nobody marked
    // Inactive, so the panel reads 0. An affordance that vanished at zero would
    // hide the one thing worth saying there — that churn is recorded by hand and
    // nobody has recorded any.
    render(<LifecycleRollupPanel rollup={buildLifecycleRollup([BOOK[4]])} />);
    fireEvent.click(screen.getByRole('button', { name: /Churned/ }));
    expect(screen.getByText(/No client here has been marked Inactive/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('leaves retention alone', () => {
    // Retention is the complement of the same set. A second button onto the
    // same list from the other end teaches a reader that every figure on this
    // panel hides something, and eight of them do not.
    render(<LifecycleRollupPanel rollup={buildLifecycleRollup(BOOK, { camNameByClientId: CAMS })} />);
    expect(screen.queryByRole('button', { name: /Retention/ })).toBeNull();
    expect(screen.getByText('Retention')).toBeTruthy();
  });

  it('opens one client from the row', () => {
    const onSelectClient = vi.fn();
    render(<ChurnDetail churnedClients={rowsWithCams()} onSelectClient={onSelectClient} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dee' }));
    expect(onSelectClient).toHaveBeenCalledWith('b3');
  });

  it('prints a plain name when there is nowhere to click through to', () => {
    render(<ChurnDetail churnedClients={rowsWithCams()} />);
    expect(screen.queryByRole('button', { name: 'Dee' })).toBeNull();
    expect(screen.getByText('Dee')).toBeTruthy();
  });
});

/* ── The filters are this panel's ─────────────────────────────────────────── */

describe('the detail filters by CAM and by when they churned', () => {
  it('filters by CAM', () => {
    render(<ChurnDetail churnedClients={rowsWithCams()} />);
    fireEvent.change(screen.getByLabelText('Filter by CAM'), { target: { value: 'Reese Glen' } });
    expect(bodyNames()).toEqual(['Dee', 'Eli']);
  });

  it('filters by churn date without touching anything outside itself', () => {
    // The rendered tree is the panel and a sibling that stands in for every KPI
    // the page draws above it. The sibling is asserted unchanged because the
    // defect being guarded against is not "the filter does not work" — it did —
    // but "the filter works on the whole page".
    const Page = () => (
      <div>
        <p data-testid="page-kpi">as-of 2026-08-21</p>
        <ChurnDetail churnedClients={rowsWithCams()} />
      </div>
    );
    render(<Page />);
    const before = screen.getByTestId('page-kpi').textContent;

    fireEvent.change(screen.getByLabelText('Churned on or after'), { target: { value: '2026-07-01' } });
    expect(bodyNames()).toEqual(['Cal', 'Dee']);
    expect(screen.getByTestId('page-kpi').textContent).toBe(before);

    fireEvent.change(screen.getByLabelText('Churned on or before'), { target: { value: '2026-07-10' } });
    expect(bodyNames()).toEqual(['Dee']);
    expect(screen.getByTestId('page-kpi').textContent).toBe(before);
  });

  it('says how many undated clients a date range is hiding', () => {
    render(<ChurnDetail churnedClients={rowsWithCams()} />);
    expect(screen.queryByText(/carries no churn date/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Churned on or after'), { target: { value: '2026-01-01' } });
    expect(screen.getByText(/1 churned client carries no churn date/)).toBeTruthy();
    expect(bodyNames()).toEqual(['Cal', 'Dee', 'Bea']);
  });

  it('clears every filter at once and comes back to the whole list', () => {
    render(<ChurnDetail churnedClients={rowsWithCams()} />);
    fireEvent.change(screen.getByLabelText('Filter by CAM'), { target: { value: 'Oakley Ash' } });
    fireEvent.change(screen.getByLabelText('Churned on or after'), { target: { value: '2026-07-01' } });
    expect(bodyNames()).toEqual(['Cal']);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(bodyNames()).toEqual(['Cal', 'Dee', 'Bea', 'Eli']);
  });

  it('offers a reason filter whose options carry their counts', () => {
    render(<ChurnDetail churnedClients={rowsWithCams()} />);
    const select = screen.getByLabelText('Filter by reason');
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'All reasons',
      'Cost of the service (2)',
      'Not recorded (1)',
      'Stopped responding (1)',
    ]);
    fireEvent.change(select, { target: { value: 'unrecorded' } });
    expect(bodyNames()).toEqual(['Eli']);
  });

  it('says how many of how many are showing', () => {
    render(<ChurnDetail churnedClients={rowsWithCams()} />);
    expect(screen.getByText('4 of 4 churned')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Filter by CAM'), { target: { value: 'Reese Glen' } });
    expect(screen.getByText('2 of 4 churned')).toBeTruthy();
  });

  it('says so rather than drawing an empty table when the filters match nothing', () => {
    render(<ChurnDetail churnedClients={rowsWithCams()} />);
    fireEvent.change(screen.getByLabelText('Churned on or after'), { target: { value: '2027-01-01' } });
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('No churned client matches these filters.')).toBeTruthy();
  });
});

/* ── Attribution, or none ─────────────────────────────────────────────────── */

describe('the CAM column appears only where it says something', () => {
  it('is drawn on the manager view', () => {
    render(<ChurnDetail churnedClients={rowsWithCams()} />);
    const header = within(screen.getByRole('table')).getAllByRole('row')[0];
    expect([...header.cells].map((c) => c.textContent))
      .toEqual(['Client', 'CAM', 'Churned', 'Reason', 'Note', 'Client since']);
    expect(screen.getByLabelText('Filter by CAM')).toBeTruthy();
  });

  it('is not drawn on the CAM\'s own book', () => {
    // Same rule as DeviationAlertList: on his own page the answer is always him,
    // so a column of his own name and a filter with one option are noise.
    render(<ChurnDetail churnedClients={rowsWithoutCams()} />);
    const header = within(screen.getByRole('table')).getAllByRole('row')[0];
    expect([...header.cells].map((c) => c.textContent))
      .toEqual(['Client', 'Churned', 'Reason', 'Note', 'Client since']);
    expect(screen.queryByLabelText('Filter by CAM')).toBeNull();
    expect(bodyNames()).toEqual(['Cal', 'Dee', 'Bea', 'Eli']);
  });
});

/* ── Absent stays absent ──────────────────────────────────────────────────── */

describe('a client nobody was asked about', () => {
  it('reads Not recorded, never Other, and shows no invented date', () => {
    // The manager's instruction, on screen: "Existing rows have no reason and
    // must not be given a fabricated one: absent is a real state and the panel
    // must show it as such, not as 'Other'."
    render(<ChurnDetail churnedClients={rowsWithCams()} />);
    const eli = within(screen.getByRole('table')).getAllByRole('row')
      .find((row) => row.cells[0].textContent === 'Eli');
    expect([...eli.cells].map((c) => c.textContent))
      .toEqual(['Eli', 'Reese Glen', '—', 'Not recorded', '—', '2026-01-10']);
    expect(eli.textContent).not.toContain('Other');
  });

  it('prints the recorded reason and the note beside it when there is one', () => {
    render(<ChurnDetail churnedClients={rowsWithCams()} />);
    const bea = within(screen.getByRole('table')).getAllByRole('row')
      .find((row) => row.cells[0].textContent === 'Bea');
    expect([...bea.cells].map((c) => c.textContent))
      .toEqual(['Bea', 'Oakley Ash', '2026-06-02', 'Cost of the service', 'Wanted a cheaper stack.', '2026-01-10']);
  });

  it('says the same nothing on the client\'s own lifecycle panel', () => {
    // The SECOND place a churn reason is rendered, and the one that is easy to
    // forget: the header line of a single client's lifecycle. "Absent is a real
    // state and the panel must show it as such, not as 'Other'" is a rule about
    // the desk's screens, not about one table on one of them — a client page
    // that fills the silence in would be a CAM reading an answer nobody gave,
    // about a client in front of him.
    const { rerender } = render(
      <ClientLifecyclePanel lifecycle={buildClientLifecycle(BOOK[3], { camName: 'Reese Glen' })} />,
    );
    expect(screen.getByText(/· Churned$/)).toBeTruthy();
    expect(screen.queryByText(/Other/)).toBeNull();

    rerender(
      <ClientLifecyclePanel lifecycle={buildClientLifecycle(BOOK[0], { camName: 'Oakley Ash' })} />,
    );
    expect(screen.getByText(/· Churned \(Cost of the service, 2026-06-02\)/)).toBeTruthy();
  });

  it('says nothing at all about churn on a client who is still here', () => {
    render(<ClientLifecyclePanel lifecycle={buildClientLifecycle(BOOK[4], { camName: 'Oakley Ash' })} />);
    expect(screen.queryByText(/Churned/)).toBeNull();
  });
});
