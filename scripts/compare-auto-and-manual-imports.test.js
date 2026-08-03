import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import fixture from '../test/fixtures/auto-export/snapshot-v1.json';
import { csvForSection } from '../server/apiLib/autoExportDownload.js';
import {
  parseArguments,
  runShadowComparison,
  validateComparisonContext,
} from './compare-auto-and-manual-imports.mjs';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';

function context(overrides = {}) {
  return {
    schemaVersion: 1,
    purpose: 'vincere-auto-manual-shadow-comparison',
    expectedClientUuid: CLIENT_ID,
    autoClientUuid: CLIENT_ID,
    manualCapturedAt: '2026-07-23T16:45:30-04:00',
    registry: {},
    ...overrides,
  };
}

describe('automatic versus manual shadow comparison CLI', () => {
  it('requires every private input path and rejects unknown secret-bearing arguments', () => {
    expect(() => parseArguments(['--snapshot', 'snapshot.json'])).toThrow('Missing required argument --context.');
    expect(() => parseArguments([
      '--snapshot', 'snapshot.json', '--context', 'context.json', '--accounts', 'a.csv',
      '--strategies', 's.csv', '--orders', 'o.csv', '--executions', 'e.csv', '--out', 'report.json',
      '--token', 'secret',
    ])).toThrow('Unknown argument: --token');
  });

  it('rejects extra context fields, malformed clients, and invalid capture timestamps', () => {
    expect(() => validateComparisonContext(context({ productKey: 'secret' }))).toThrow('comparison_context_unknown_field');
    expect(() => validateComparisonContext(context({ autoClientUuid: 'bad' }))).toThrow('comparison_client_uuid_invalid');
    expect(() => validateComparisonContext(context({ manualCapturedAt: 'not-a-time' }))).toThrow('comparison_manual_capture_invalid');
  });

  it('writes only one sanitized aggregate report with private file permissions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vincere-shadow-'));
    const value = structuredClone(fixture);
    const accountName = 'LIVE-PRIVATE-01';
    value.accounts[0].accountName = accountName;
    value.accounts[0].displayName = accountName;
    value.strategies[0].accountName = accountName;
    value.orders[0].accountName = accountName;
    value.executions[0].accountName = accountName;
    const files = {
      snapshotPath: join(directory, 'snapshot.json'),
      contextPath: join(directory, 'context.json'),
      accountsPath: join(directory, 'accounts.csv'),
      strategiesPath: join(directory, 'strategies.csv'),
      ordersPath: join(directory, 'orders.csv'),
      executionsPath: join(directory, 'executions.csv'),
      outputPath: join(directory, 'comparison.json'),
    };
    await Promise.all([
      writeFile(files.snapshotPath, JSON.stringify(value)),
      writeFile(files.contextPath, JSON.stringify(context({
        registry: {
          [accountName]: {
            accountName, alias: 'Private alias', connection: 'Private connection',
            accountType: 'Cash', status: 'Active', payoutState: 'Not requested',
          },
        },
      }))),
      ...['accounts', 'strategies', 'orders', 'executions'].map((section) =>
        writeFile(files[`${section}Path`], csvForSection(section, value[section]))),
    ]);

    const report = await runShadowComparison(files);
    expect(report).toMatchObject({ ok: true, failures: [] });
    const output = await readFile(files.outputPath, 'utf8');
    expect(JSON.parse(output)).toMatchObject({ ok: true, sections: { accounts: { autoRows: 1, manualRows: 1 } } });
    expect(output).not.toMatch(/live-private|private alias|private connection|11111111|125\.5|140\.25/i);
    if (process.platform !== 'win32') expect((await stat(files.outputPath)).mode & 0o777).toBe(0o600);
  });
});
