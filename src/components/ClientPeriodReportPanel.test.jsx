// @vitest-environment jsdom
//
// The client period report as the CAM opens it and the client reads it.
//
// UNGATED: fixtures only (src/domain/clientPeriodReportFixtures.test-helpers.js).
// What is pinned here is what only a rendered document can show: the sections
// in the order the report was designed in, nothing printed or downloadable
// while the closes are on their way, a failure that says why and can be tried
// again, the window control changing the window, and a client's paper free of
// dashes and of anything the desk uses internally.

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ClientPeriodReportPanel from './ClientPeriodReportPanel';
import { AS_OF, periodClient } from '../domain/clientPeriodReportFixtures.test-helpers';

const NOW = new Date('2026-10-19T13:40:00Z');

function mount(props = {}) {
  const client = props.client || periodClient();
  return render(
    <ClientPeriodReportPanel
      client={client}
      selectedDate="2026-10-16"
      accountManager="Peter"
      asOf={AS_OF}
      now={NOW}
      onClose={() => {}}
      {...props}
    />,
  );
}

const sheetOf = (view) => view.container.querySelector('.report-sheet');
const headings = (view) => [...view.container.querySelectorAll('.cpr-body h2')].map((h) => h.textContent);

/** Everything a reader can see or hover: the text, and every tooltip. */
function readable(element) {
  const titles = [...element.querySelectorAll('[title], title')]
    .map((node) => (node.tagName.toLowerCase() === 'title' ? node.textContent : node.getAttribute('title')));
  return [element.textContent, ...titles].join('\n');
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('the report, read top to bottom', () => {
  it('renders every section, in order', () => {
    const view = mount();
    expect(view.container.querySelector('.cpr-body h1').textContent).toBe('Weekly performance report');
    expect(headings(view)).toEqual([
      'What this report is built from',
      'Summary',
      'Day by day',
      'Accounts',
      'Performance by algorithm',
      'Algorithm activity',
      'Running at the last close',
      'Daily record',
      'Simulation*',
    ]);
    const body = view.container.querySelector('.cpr-body');
    expect(body.firstElementChild.className).toBe('cpr-head');
    expect(body.lastElementChild.className).toBe('cpr-notes');
  });

  it('prints the header, the coverage and the gap', () => {
    const view = mount();
    const sheet = sheetOf(view);
    expect(sheet.textContent).toContain('Vincere Trading');
    expect(sheet.textContent).toContain('Built Oct 19, 2026, 9:40 am ET · last close Fri, Oct 16');
    expect(sheet.textContent).toContain('Client Jordan Ellis');
    expect(sheet.textContent).toContain('Account manager Peter');
    expect(sheet.textContent).toContain('Period Mon, Oct 12 to Fri, Oct 16, 2026');
    expect(sheet.textContent).toContain('4of 5 trading days');
    expect(sheet.textContent).toContain('No close on Mon, Oct 12. That day is a gap in every chart and table, never a zero.');
    // The gap is a row of its own and a labelled hole in the bar chart.
    expect(screen.getByText('No close this day')).toBeTruthy();
    expect([...sheet.querySelectorAll('svg text')].map((node) => node.textContent)).toContain('gap');
  });

  it('prints the figures the domain worked out', () => {
    const view = mount();
    const sheet = sheetOf(view);
    expect(sheet.textContent).toContain('+$750.00');
    expect(sheet.textContent).toContain('$125,750.00');
    expect(sheet.textContent).toContain('from $125,000.00');
    expect(sheet.textContent).toContain('$1,900.00 of $2.5k');
    const algorithms = sheet.querySelector('[aria-labelledby="cpr-algorithms"]');
    expect(within(algorithms).getByText('NSTAR 2.1')).toBeTruthy();
    expect(algorithms.textContent).toContain('+$550.00');
    // What the algorithms did not place has its own row, and the rows add up to
    // the accounts' realized P&L.
    expect(algorithms.textContent).toContain('Fees and other account charges');
    expect(algorithms.textContent).toContain('-$10.00');
    expect(algorithms.querySelector('tfoot').textContent).toContain('+$750.00');
    expect(algorithms.textContent).not.toContain('Not split');
    // The simulated account is in its own row and in nothing above it.
    const simulation = sheet.querySelector('[aria-labelledby="cpr-simulation"]');
    expect(simulation.textContent).toContain('Sim101');
    expect(simulation.textContent).toContain('+$3,108.00');
    expect(sheet.querySelector('[aria-labelledby="cpr-summary"]').textContent).not.toContain('3,108');
  });

  it('offers the PDF of the sheet once the report is built', () => {
    mount();
    expect(screen.getByRole('button', { name: /Download PDF/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Print/ })).toBeTruthy();
  });
});

describe('while the closes are on their way', () => {
  const unloaded = () => periodClient({ unloaded: ['2026-10-09', '2026-10-15'], noFills: ['2026-10-16'] });

  it('asks for every close it needs under a key of its own window, and prints no figure and offers no PDF', () => {
    const onNeedCloseRows = vi.fn(() => new Promise(() => {}));
    const view = mount({
      client: unloaded(),
      onNeedCloseRows,
      closeRowsLoadFor: () => ({ status: 'loading', error: '' }),
    });
    expect(onNeedCloseRows).toHaveBeenCalledWith(
      'client-period-report:jordan:2026-10-12:2026-10-18',
      ['uuid-jordan-2026-10-09', 'uuid-jordan-2026-10-15', 'uuid-jordan-2026-10-16'],
      { withAccountRows: true, withFills: true },
    );
    const sheet = sheetOf(view);
    expect(sheet.textContent).toContain('Loading the account figures and fills of 3 closes');
    expect(view.container.querySelector('.cpr-body')).toBeNull();
    expect(sheet.textContent).not.toContain('$');
    expect(screen.queryByRole('button', { name: /Download PDF/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Print/ })).toBeNull();
    // The window can still be changed.
    expect(screen.getByRole('button', { name: '2 weeks' })).toBeTruthy();
  });

  it('treats a window nobody has asked about yet as loading, not loaded', () => {
    const view = mount({
      client: unloaded(),
      onNeedCloseRows: () => new Promise(() => {}),
      closeRowsLoadFor: () => ({ status: 'idle', error: '' }),
    });
    expect(view.container.querySelector('.cpr-body')).toBeNull();
  });

  it('says what failed and offers to try again, which asks again', () => {
    const onNeedCloseRows = vi.fn(() => Promise.resolve(null));
    const view = mount({
      client: unloaded(),
      onNeedCloseRows,
      closeRowsLoadFor: () => ({ status: 'error', error: 'Could not load the closes for this report: timeout' }),
    });
    expect(sheetOf(view).textContent).toContain('Could not load the closes for this report: timeout');
    expect(view.container.querySelector('.cpr-body')).toBeNull();
    expect(screen.queryByRole('button', { name: /Download PDF/ })).toBeNull();
    const calls = onNeedCloseRows.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onNeedCloseRows.mock.calls.length).toBe(calls + 1);
  });

  it('builds the report once the fetch has answered, naming what is still missing', () => {
    const view = mount({
      client: unloaded(),
      onNeedCloseRows: () => Promise.resolve(null),
      closeRowsLoadFor: () => ({ status: 'loaded', error: '' }),
    });
    const sheet = sheetOf(view);
    expect(view.container.querySelector('.cpr-body')).not.toBeNull();
    expect(sheet.textContent).toContain('That close is missing from every figure, not counted as zero.');
    expect(sheet.textContent).toContain('Account figures not loaded for this close');
    expect(sheet.textContent).toContain('could not be loaded');
  });

  it('renders straight away when every close is already held', () => {
    const onNeedCloseRows = vi.fn();
    const view = mount({ onNeedCloseRows, closeRowsLoadFor: () => ({ status: 'idle', error: '' }) });
    expect(onNeedCloseRows).not.toHaveBeenCalled();
    expect(view.container.querySelector('.cpr-body')).not.toBeNull();
  });
});

describe('the window control', () => {
  it('switches the window, and the load state is asked under the new window\'s key', () => {
    const keys = [];
    const view = mount({ closeRowsLoadFor: (key) => { keys.push(key); return { status: 'idle', error: '' }; } });
    expect(screen.getByRole('button', { name: 'Week' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: '2 weeks' }));
    expect(view.container.querySelector('.cpr-body h1').textContent).toBe('Two week performance report');
    expect(screen.getByRole('button', { name: '2 weeks' }).getAttribute('aria-pressed')).toBe('true');
    expect(keys).toContain('client-period-report:jordan:2026-10-05:2026-10-18');

    fireEvent.click(screen.getByRole('button', { name: '4 weeks' }));
    expect(view.container.querySelector('.cpr-body h1').textContent).toBe('Four week performance report');

    fireEvent.click(screen.getByRole('button', { name: 'Month' }));
    expect(view.container.querySelector('.cpr-body h1').textContent).toBe('Monthly performance report');
    expect(sheetOf(view).textContent).toContain('Period Thu, Oct 1 to Fri, Oct 30, 2026');

    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    expect(view.container.querySelector('.cpr-body h1').textContent).toBe('Performance report');
    const from = view.container.querySelector('input[type="date"]');
    expect(from.value).toBe('2026-10-01');
    fireEvent.change(from, { target: { value: '2026-10-14' } });
    expect(sheetOf(view).textContent).toContain('Period Wed, Oct 14 to Fri, Oct 30, 2026');
  });

  it('steps a week back and forth', () => {
    const view = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Earlier period' }));
    expect(sheetOf(view).textContent).toContain('Period Mon, Oct 5 to Fri, Oct 9, 2026');
    fireEvent.click(screen.getByRole('button', { name: 'Later period' }));
    expect(sheetOf(view).textContent).toContain('Period Mon, Oct 12 to Fri, Oct 16, 2026');
  });

  it('opens on the month it was asked for', () => {
    const view = mount({ initialKind: 'month', anchorDate: '2026-09-01' });
    expect(view.container.querySelector('.cpr-body h1').textContent).toBe('Monthly performance report');
    expect(sheetOf(view).textContent).toContain('Period Tue, Sep 1 to Wed, Sep 30, 2026');
  });

  it('keeps every control off the paper', () => {
    const view = mount();
    const controls = view.container.querySelector('.cpr-controls');
    expect(controls.closest('.no-print')).not.toBeNull();
    expect(view.container.querySelector('.cpr-body').closest('.no-print')).toBeNull();
    // And the body is inside the element the PDF is made from.
    expect(view.container.querySelector('.cpr-body').closest('.report-sheet')).not.toBeNull();
  });
});

describe('client facing paper', () => {
  const variants = [
    {},
    { unloaded: ['2026-10-15'] },
    { noFills: ['2026-10-16'] },
    { failsOn: '2026-10-14', undetermined: true },
  ];

  it('has no em or en dash, and no hyphen used as a dash, in anything a reader sees', () => {
    for (const options of variants) {
      const view = mount({ client: periodClient(options) });
      const body = view.container.querySelector('.cpr-body');
      const text = readable(body);
      expect(text).not.toMatch(/[–—]/);
      expect(text).not.toMatch(/\s-\s/);
      cleanup();
    }
  });

  it('says nothing the desk uses internally', () => {
    for (const options of variants) {
      const view = mount({ client: periodClient(options) });
      const text = readable(view.container.querySelector('.cpr-body'));
      expect(text).not.toMatch(/flag|desk|misalign|outlier|drift|internal|looks failed/i);
      cleanup();
    }
  });
});

/* A PROVISIONAL DAY ON THE CLIENT'S PAPER (step 73). The close lost the
 * account, the tracker's reading stands in for it, and the account's row says
 * so, without a dash and without a $0 balance. */
describe('an account the tracker filled in', () => {
  it('says which day came from the tracker on the account\'s own row', () => {
    const client = periodClient();
    const close = client.dailyImports.find((entry) => entry.date === '2026-10-14');
    close.snapshots = close.snapshots.map((snapshot) => (snapshot.accountName === 'LUC-1002'
      ? { ...snapshot, source: 'tracker', accountBalance: 0, strategies: snapshot.strategies.map((row) => ({ ...row, source: 'tracker' })) }
      : snapshot));
    const view = mount({ client });
    const text = readable(view.container.querySelector('.cpr-body'));
    expect(text).toMatch(/Funded 02\s*From the tracker, no fills \([^)]*14[^)]*\)/);
    expect(text.match(/From the tracker, no fills/g)).toHaveLength(1);
    expect(text).not.toMatch(/[–—]/);
    cleanup();
  });
});
