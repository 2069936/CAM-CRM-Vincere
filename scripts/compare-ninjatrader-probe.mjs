import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  compareProbeSnapshot,
  normalizeManualGridFile,
  renderComparisonMarkdown,
} from './lib/manualGridNormalization.mjs';

const GRID_INPUTS = [
  ['accounts', 'accountsPath'],
  ['strategies', 'strategiesPath'],
  ['orders', 'ordersPath'],
  ['executions', 'executionsPath'],
];

const ARGUMENTS = {
  '--snapshot': 'snapshotPath',
  '--accounts': 'accountsPath',
  '--strategies': 'strategiesPath',
  '--orders': 'ordersPath',
  '--executions': 'executionsPath',
  '--out': 'outDir',
};

export function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const optionName = ARGUMENTS[flag];
    const value = argv[index + 1];
    if (!optionName) throw new Error(`Unknown argument: ${flag || '(empty)'}`);
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a path.`);
    options[optionName] = value;
  }
  for (const [flag, optionName] of Object.entries(ARGUMENTS)) {
    if (!options[optionName]) throw new Error(`Missing required argument ${flag}.`);
  }
  return options;
}

export async function runComparison(options) {
  const snapshot = JSON.parse(await readFile(options.snapshotPath, 'utf8'));
  const files = [];

  for (const [expectedType, optionName] of GRID_INPUTS) {
    const path = options[optionName];
    const normalized = normalizeManualGridFile(await readFile(path, 'utf8'), path);
    if (normalized.type !== expectedType) {
      throw new Error(`${optionName} was detected as ${normalized.type}; expected ${expectedType}.`);
    }
    if (normalized.errors.length > 0) {
      throw new Error(`${optionName} contains CSV errors: ${JSON.stringify(normalized.errors)}`);
    }
    files.push(normalized);
  }

  const report = {
    inputTypes: files.map((file) => file.type),
    ...compareProbeSnapshot(snapshot, files),
  };
  await mkdir(options.outDir, { recursive: true });
  await writeFile(join(options.outDir, 'comparison.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(join(options.outDir, 'comparison.md'), renderComparisonMarkdown(report), 'utf8');
  return report;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = await runComparison(options);
  process.stdout.write(`Wrote comparison.json and comparison.md to ${options.outDir}.\n`);
  if ((report.summary['value-mismatch'] || 0) > 0) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`Probe comparison failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
