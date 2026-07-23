import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourcePath = fileURLToPath(new URL('./Vincere.AutoExport.Probe.cs', import.meta.url));
const source = readFileSync(sourcePath, 'utf8');
const workflowPath = fileURLToPath(new URL('../../.github/workflows/collector-windows.yml', import.meta.url));
const workflow = readFileSync(workflowPath, 'utf8');

describe('supported-API NinjaTrader probe source', () => {
  it('does not depend on desktop or grid automation', () => {
    for (const forbidden of [
      'System.Windows.Automation',
      'AutomationElement',
      'UIAutomationClient',
      'mouse_event',
      'SetCursorPos',
      'SendKeys',
      'Export As',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it('uses supported account collections and keeps realized and gross PnL separate', () => {
    expect(source).toContain('Account.All');
    expect(source).toContain('account.Strategies');
    expect(source).toContain('account.Orders');
    expect(source).toContain('account.Executions');
    expect(source).toContain('AccountItem.RealizedProfitLoss');
    expect(source).toContain('AccountItem.GrossRealizedProfitLoss');
  });

  it('emits every parity field that the CRM preserves from the four grids', () => {
    for (const field of [
      '"trailingMaxDrawdown"',
      '"dataSeries"',
      '"sync"',
      '"entryExit"',
      '"name"',
      '"rate"',
      '"connectionName"',
    ]) {
      expect(source).toContain(field);
    }
  });

  it('publishes a bounded diagnostic ZIP with installation and review files', () => {
    expect(workflow).toContain('Vincere-NinjaTrader-Parity-Probe.zip');
    expect(workflow).toContain('ninjatrader-parity-probe-${{ github.run_number }}');
    for (const file of [
      'Vincere.AutoExport.Probe.cs',
      'install-probe.ps1',
      'uninstall-probe.ps1',
      'parity-review.template.json',
      'README.md',
    ]) {
      expect(workflow).toContain(file);
    }
  });
});
