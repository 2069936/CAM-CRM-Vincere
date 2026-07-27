import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../..', import.meta.url).pathname;
const ADDON = join(ROOT, 'collector/src/Vincere.AutoExport.NinjaTrader');

async function productionSources() {
  const entries = await readdir(ADDON, { recursive: true, withFileTypes: true });
  return Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.cs'))
    .map((entry) => readFile(join(entry.parentPath, entry.name), 'utf8')));
}

describe('production NinjaTrader AddOn source boundary', () => {
  it('keeps CI disabled until the facade, pipe server, and AddOn entry point all exist', async () => {
    const workflow = await readFile(join(ROOT, '.github/workflows/collector-windows.yml'), 'utf8');
    expect(workflow).toContain('Capture/NinjaTraderFacade.cs');
    expect(workflow).toContain('Pipe/CapturePipeServer.cs');
    expect(workflow).toContain('VincereAutoExportAddOn.cs');
    expect(workflow).not.toContain("find collector/src/Vincere.AutoExport.NinjaTrader -type f -name '*.cs'");
  });

  it('reads all four supported collections and keeps realized and gross PnL distinct', async () => {
    const source = await readFile(join(ADDON, 'Capture/NinjaTraderFacade.cs'), 'utf8');
    expect(source).toContain('Account.All');
    expect(source).toContain('account.Strategies');
    expect(source).toContain('account.Orders');
    expect(source).toContain('account.Executions');
    expect(source).toContain('AccountItem.RealizedProfitLoss');
    expect(source).toContain('AccountItem.GrossRealizedProfitLoss');
    expect(source).toMatch(/decimal\? realized\s*=\s*AccountValue\([^;]+AccountItem\.RealizedProfitLoss/s);
    expect(source).toMatch(/decimal\? grossRealized\s*=\s*AccountValue\([^;]+AccountItem\.GrossRealizedProfitLoss/s);
    expect(source).toMatch(/RealizedPnl\s*=\s*realized/);
    expect(source).toMatch(/GrossRealizedPnl\s*=\s*grossRealized/);
  });

  it('contains no screen, mouse, native-export, or UIAutomation path', async () => {
    const source = (await productionSources()).join('\n');
    expect(source).not.toMatch(/System\.Windows\.Automation|user32\.dll|SendInput|SetCursorPos|mouse_event/i);
    expect(source).not.toMatch(/ExportTabViaNativeMenu|Export As|\.csv\b/i);
  });
});
