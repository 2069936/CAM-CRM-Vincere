// What the seven charts must say about what they drew.
//
// UNGATED: no snapshot is read here, so CI runs it. Every assertion below is a
// defect the pre-merge review found, and every one of them is invisible to a
// count — a chart that silently drops four rows still renders, an aria-label
// that reports the number it drew as the number that qualified still renders,
// and a cell painted darker for "did not run" than for "ran" still renders.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  AccountsPerCloseChart,
  BenchmarkCurves,
  ComboBarChart,
  DeploymentGrid,
  IntervalChart,
  SlopeChart,
} from './DeskPeriodReportCharts';

const combo = (key, avgPnl, { lowSample = false, days = 20, accounts = 5 } = {}) => ({
  key, avgPnl, lowSample, days, accounts,
});

describe('the combination bar chart says what it did not draw', () => {
  // Sixteen gated rows, as the real book's 2026-07 holds, against a limit of 12.
  const rows = [
    ...Array.from({ length: 16 }, (_, index) => combo(`GATED ${index}`, -index)),
    combo('THIN', 500, { lowSample: true, days: 2, accounts: 1 }),
  ];
  const html = renderToStaticMarkup(<ComboBarChart rows={rows} />);

  it('does not report the number it drew as the number that cleared the gate', () => {
    expect(html).toContain('the 12 best-performing of the 16 combinations that clear the sample gate');
    expect(html).not.toContain('for the 12 combinations that clear');
  });

  it('names the gated rows it removed, the way the other charts name theirs', () => {
    expect(html).toContain('Not drawn:');
    expect(html).toContain('GATED 12');
    expect(html).toContain('GATED 15');
  });

  it('says every gated row is drawn when every gated row is drawn', () => {
    const few = renderToStaticMarkup(<ComboBarChart rows={[combo('A', -1), combo('B', -2)]} />);
    expect(few).toContain('Drawn: every one of the 2 combinations');
    expect(few).not.toContain('Not drawn:');
  });
});

describe('the deployment grid', () => {
  const rows = [{
    algorithm: 'RBO 1.8',
    accountDaysInPeriod: 77,
    busiestClose: 76,
    accountsByClose: { '2026-07-27': 1, '2026-07-30': 76 },
  }];
  const closes = ['2026-07-27', '2026-07-28', '2026-07-30'];
  const html = renderToStaticMarkup(<DeploymentGrid rows={rows} closes={closes} />);

  it('draws absence as an outline, never as a filled cell heavier than a light one', () => {
    // An off cell filled #223142 at 0.4 over white reads as a medium grey; an
    // on cell at one account of 76 reads as a very pale blue. Absence was the
    // strongest mark on the row, which is this file's rule 4 inverted.
    const offCell = html.match(/class="period-grid-cell off"[^>]*style="([^"]*)"/);
    expect(offCell).not.toBeNull();
    expect(offCell[1]).toContain('background:transparent');
    expect(offCell[1]).toContain('inset 0 0 0 1px');
    expect(offCell[1]).not.toMatch(/opacity:0\.4/);
  });

  it('gives a single-account cell a floor it stays visible at', () => {
    const onCells = [...html.matchAll(/class="period-grid-cell on"[^>]*style="([^"]*)"/g)];
    expect(onCells).toHaveLength(2);
    const opacities = onCells
      .map(([, style]) => Number(style.match(/opacity:([\d.]+)/)[1]))
      .sort((a, b) => a - b);
    expect(opacities[0]).toBeGreaterThanOrEqual(0.35);
    expect(opacities[1]).toBeCloseTo(1, 5);
  });

  it('prints the dates under the grid, because a title attribute is not on paper', () => {
    const withoutTitles = html.replace(/title="[^"]*"/g, '');
    expect(withoutTitles).toContain('2026-07-27');
    expect(withoutTitles).toContain('2026-07-30');
    expect(withoutTitles).toContain('One column per close');
    expect(withoutTitles).toContain('which is not a zero');
  });
});

describe('the point estimates are not horizontal smears', () => {
  it('draws the interval chart’s mean as a vertical tick, not a circle', () => {
    // `preserveAspectRatio="none"` scales x by (pixel width / 100) and leaves y
    // alone, so an r=1.4 circle renders ~25px wide and ~2.8px tall on a 900px
    // sheet: the least precise mark on a chart captioned "compare the
    // intervals, not the dots".
    const html = renderToStaticMarkup(<IntervalChart rows={[{
      name: 'RBO', ranked: true, meanPerAccountDay: -10, accountDays: 40, accounts: 12,
      ci: { low: -20, high: 0 },
    }]} />);
    expect(html).not.toContain('<circle');
    expect(html).toContain('vector-effect="non-scaling-stroke"');
  });

  it('draws the slope chart’s endpoints the same way', () => {
    const html = renderToStaticMarkup(<SlopeChart rows={[{
      algorithm: 'RBO', priorMean: 10, periodMean: -10, priorAccountDays: 40, periodAccountDays: 44,
    }]} periodLabel="Week of 2026-07-27" priorLabel="Week of 2026-07-20" />);
    expect(html).not.toContain('<circle');
  });
});

describe('the coverage chart calls its bars what they are', () => {
  it('counts closes and weekdays without one, never "calendar days"', () => {
    const rows = [
      { date: '2026-07-27', noClose: false, accountsReporting: 10, clientsReporting: 2 },
      { date: '2026-07-28', noClose: true, noCloseReason: 'Inside the book’s range and no close was filed.' },
      { date: '2026-07-30', noClose: false, accountsReporting: 4, clientsReporting: 1 },
    ];
    const html = renderToStaticMarkup(
      <AccountsPerCloseChart rows={rows} period={{ from: '2026-07-27', to: '2026-08-02', label: 'Week of 2026-07-27' }} />,
    );
    expect(html).toContain('each of the 2 closes in Week of 2026-07-27');
    expect(html).toContain('1 weekdays that hold none');
    expect(html).not.toContain('calendar days');
  });
});

describe('the benchmark curve is drawn against time', () => {
  const curve = {
    key: 'RBO|1.8|M2K|Low',
    algorithm: 'RBO',
    version: '1.8',
    instrument: 'M2K',
    riskLevel: 'Low',
    basis: 'My Futures Book backtest of RBO 1.8.',
    from: '2026-01-01',
    to: '2026-07-30',
    // Two trades in January, five in the last week of July. By trade ordinal,
    // January occupies two sevenths of the width; by calendar it occupies none
    // of the last week's.
    points: [
      { date: '2026-01-05', cumulative: 100, net: 100, trades: 1 },
      { date: '2026-01-06', cumulative: 200, net: 100, trades: 1 },
      { date: '2026-07-27', cumulative: 300, net: 100, trades: 1 },
      { date: '2026-07-28', cumulative: 400, net: 100, trades: 1 },
      { date: '2026-07-29', cumulative: 500, net: 100, trades: 1 },
      { date: '2026-07-30', cumulative: 600, net: 100, trades: 1 },
    ],
  };
  const html = renderToStaticMarkup(
    <BenchmarkCurves curves={[curve]} period={{ from: '2026-07-27', to: '2026-07-30' }} />,
  );

  it('puts the first July point most of the way across, not a third of the way', () => {
    const path = html.match(/d="([^"]+)"/)[1];
    const xs = path.split(/[ML]/).filter(Boolean).map((pair) => Number(pair.split(',')[0]));
    // 2026-01-06 is five days into a curve that spans 2026-01-01 to 2026-07-30.
    // By trade ordinal it sat one fifth of the way across.
    expect(xs[1]).toBeLessThan(3);
    expect(xs[2]).toBeGreaterThan(95); // 2026-07-27
  });

  it('shades a band whose width is the period’s share of TIME, not of trades', () => {
    const band = html.match(/<rect x="([\d.]+)"[^>]*width="([\d.]+)"/);
    expect(Number(band[1])).toBeGreaterThan(95);
    expect(Number(band[2])).toBeLessThan(5);
  });

  it('says on the chart what the axis is, and prints its basis', () => {
    expect(html).toContain('Horizontal axis is calendar time');
    expect(html).toContain('My Futures Book backtest of RBO 1.8.');
  });
});
