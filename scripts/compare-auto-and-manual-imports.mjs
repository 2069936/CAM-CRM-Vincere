import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { compareAutoAndManual } from './lib/autoManualComparison.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ARGUMENTS = Object.freeze({
  '--snapshot': 'snapshotPath',
  '--context': 'contextPath',
  '--accounts': 'accountsPath',
  '--strategies': 'strategiesPath',
  '--orders': 'ordersPath',
  '--executions': 'executionsPath',
  '--out': 'outputPath',
});
const CONTEXT_KEYS = new Set([
  'schemaVersion', 'purpose', 'expectedClientUuid', 'autoClientUuid', 'manualCapturedAt', 'registry',
]);

export function parseArguments(argv = []) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const option = ARGUMENTS[flag];
    const value = argv[index + 1];
    if (!option) throw new Error(`Unknown argument: ${flag || '(empty)'}`);
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a path.`);
    options[option] = value;
  }
  for (const [flag, option] of Object.entries(ARGUMENTS)) {
    if (!options[option]) throw new Error(`Missing required argument ${flag}.`);
  }
  return options;
}

export function validateComparisonContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !CONTEXT_KEYS.has(key))) {
    throw new Error('comparison_context_unknown_field');
  }
  if (value.schemaVersion !== 1 || value.purpose !== 'vincere-auto-manual-shadow-comparison') {
    throw new Error('comparison_context_invalid');
  }
  if (!UUID.test(String(value.expectedClientUuid || '')) || !UUID.test(String(value.autoClientUuid || ''))) {
    throw new Error('comparison_client_uuid_invalid');
  }
  if (typeof value.manualCapturedAt !== 'string' || Number.isNaN(Date.parse(value.manualCapturedAt))) {
    throw new Error('comparison_manual_capture_invalid');
  }
  if (!value.registry || typeof value.registry !== 'object' || Array.isArray(value.registry)) {
    throw new Error('comparison_registry_invalid');
  }
  return {
    expectedClientUuid: value.expectedClientUuid.toLowerCase(),
    autoClientUuid: value.autoClientUuid.toLowerCase(),
    manualCapturedAt: value.manualCapturedAt,
    registry: value.registry,
  };
}

async function readJson(path, code) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error(code);
  }
}

async function writePrivateJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function runShadowComparison(options = {}) {
  const [snapshot, context, accounts, strategies, orders, executions] = await Promise.all([
    readJson(options.snapshotPath, 'comparison_snapshot_invalid'),
    readJson(options.contextPath, 'comparison_context_invalid_json'),
    readFile(options.accountsPath, 'utf8'),
    readFile(options.strategiesPath, 'utf8'),
    readFile(options.ordersPath, 'utf8'),
    readFile(options.executionsPath, 'utf8'),
  ]);
  const validated = validateComparisonContext(context);
  const report = compareAutoAndManual({
    ...validated,
    snapshot,
    manualFiles: { accounts, strategies, orders, executions },
  });
  await writePrivateJson(options.outputPath, report);
  return report;
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const report = await runShadowComparison(options);
    process.stdout.write(`Auto/manual shadow comparison: ${report.ok ? 'PASS' : 'FAIL'}; failures=${report.failures.length}\n`);
    if (!report.ok) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`Auto/manual shadow comparison failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
