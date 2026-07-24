import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArguments, runComparison } from './compare-ninjatrader-probe.mjs';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeGrid(directory, name, text) {
  const path = join(directory, name);
  writeFileSync(path, text, 'utf8');
  return path;
}

describe('probe comparison command', () => {
  it('parses every required named command-line argument', () => {
    expect(parseArguments([
      '--snapshot', 'probe.json', '--accounts', 'accounts.csv',
      '--strategies', 'strategies.csv', '--orders', 'orders.csv',
      '--executions', 'executions.csv', '--out', 'report',
    ])).toEqual({
      snapshotPath: 'probe.json', accountsPath: 'accounts.csv',
      strategiesPath: 'strategies.csv', ordersPath: 'orders.csv',
      executionsPath: 'executions.csv', outDir: 'report',
    });
    expect(() => parseArguments(['--snapshot', 'probe.json'])).toThrow(/--accounts/);
  });

  it('writes JSON and Markdown reports for four header-detected grids', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'vincere-probe-'));
    temporaryDirectories.push(directory);
    const outDir = join(directory, 'report');
    const snapshotPath = fileURLToPath(new URL('../test/fixtures/auto-export/snapshot-v1.json', import.meta.url));
    const paths = {
      accountsPath: writeGrid(directory, 'a.csv', [
        'Display name,Cash value,Realized PnL,Gross realized PnL,Connection',
        'SIM-REDACTED-01,"$51,245.75",$125.50,$140.25,Simulated Data Feed',
      ].join('\n')),
      strategiesPath: writeGrid(directory, 'b.csv', [
        'Strategy,Account display name,Parameters,Instrument,State,Enabled,Realized,Unrealized',
        'RBO-1.8,SIM-REDACTED-01,params,NQ 09-26,Realtime,True,$125.50,',
      ].join('\n')),
      ordersPath: writeGrid(directory, 'c.csv', [
        'ID,Account display name,Instrument,Action,Type,Quantity,Filled,Remaining,State',
        'order-redacted-01,SIM-REDACTED-01,NQ 09-26,Buy,Limit,2,1,1,Working',
      ].join('\n')),
      executionsPath: writeGrid(directory, 'd.csv', [
        'ID,Order ID,Ex.,Account display name,Instrument,Action,Quantity,Price,Time',
        'execution-redacted-01,order-redacted-01,Entry,SIM-REDACTED-01,NQ 09-26,Buy,1,20120.25,7/23/2026 4:44:46 PM',
      ].join('\n')),
    };

    const report = await runComparison({ snapshotPath, ...paths, outDir });

    expect(report.inputTypes).toEqual(['accounts', 'strategies', 'orders', 'executions']);
    expect(existsSync(join(outDir, 'comparison.json'))).toBe(true);
    expect(readFileSync(join(outDir, 'comparison.md'), 'utf8')).toContain('## Executions');
  });
});
