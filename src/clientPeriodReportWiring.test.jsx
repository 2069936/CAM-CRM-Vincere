// @vitest-environment jsdom
//
// Where the client period report is opened from, and what it replaced.
//
// The Dashboard half is rendered: the button is pressed and the handler runs.
// The App half is counted in source, because the shell is a 18,000 line
// component whose render needs a session and a database; what is asked of it
// is a question about the file anyway: that there is ONE mount of the panel,
// wired to the loader that fetches its closes, and that the monthly report
// which read empty closes as zeros is gone rather than left beside it.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Dashboard from './components/Dashboard';

// From the project root: under jsdom `import.meta.url` is not a file URL.
const APP = readFileSync(path.join(process.cwd(), 'src/App.jsx'), 'utf8');

afterEach(() => cleanup());

describe('the report buttons', () => {
  const dailyImport = {
    id: 'imp-1', date: '2026-10-16', clientId: 'c1', snapshots: [], strategies: [], orders: [], executions: [], flags: [],
  };

  it('offers the period report beside the daily one, and it opens', () => {
    const onBuildReport = vi.fn();
    const onBuildPeriodReport = vi.fn();
    render(
      <Dashboard
        dailyImport={dailyImport}
        rows={[]}
        title="Funded"
        mode="funded"
        client={{ id: 'c1', name: 'Jordan', accountRegistry: {} }}
        onRecalculate={() => {}}
        onBuildReport={onBuildReport}
        onBuildPeriodReport={onBuildPeriodReport}
      />,
    );
    const daily = screen.getByRole('button', { name: /Build Daily Report/ });
    const period = screen.getByRole('button', { name: /Build Period Report/ });
    // Side by side, daily first.
    expect(daily.nextElementSibling).toBe(period);
    fireEvent.click(period);
    expect(onBuildPeriodReport).toHaveBeenCalledTimes(1);
    expect(onBuildReport).not.toHaveBeenCalled();
  });

  it('shows no period button where nobody wired one', () => {
    render(
      <Dashboard
        dailyImport={dailyImport}
        rows={[]}
        title="Funded"
        mode="funded"
        client={{ id: 'c1', name: 'Jordan', accountRegistry: {} }}
        onRecalculate={() => {}}
        onBuildReport={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: /Build Period Report/ })).toBeNull();
  });
});

describe('the shell', () => {
  it('mounts the panel once, wired to the loader that fetches its closes and to its load state', () => {
    const mounts = APP.match(/<ClientPeriodReportPanel\b/g) || [];
    expect(mounts).toHaveLength(1);
    const at = APP.indexOf('<ClientPeriodReportPanel');
    const mount = APP.slice(at, APP.indexOf('/>', at));
    expect(mount).toContain('onNeedCloseRows={ensureCloseDetailFor}');
    expect(mount).toContain('closeRowsLoadFor={panelLoadFor}');
    expect(APP).toContain('const ensureCloseDetailFor = useMemo(() => createWindowDetailLoader({');
  });

  it('opens it from the workspace header, from the Dashboard, and from the overview\'s month on the Month window', () => {
    expect(APP).toMatch(/Build Period Report/);
    expect(APP).toContain('onBuildPeriodReport={() => setPeriodReport({ kind: "week" })}');
    expect(APP).toContain('setPeriodReport({ kind: "month", anchorDate: `${month}-01` })');
  });

  it('no longer carries the monthly report that read unloaded closes as zeros', () => {
    expect(APP).not.toMatch(/MonthlyReportPanel|monthlyReportMonth/);
  });
});
