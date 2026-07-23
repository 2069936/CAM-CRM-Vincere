import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildParityEvidence } from './lib/parityEvidence.mjs';

const ARGUMENTS = {
  '--comparison': 'comparisonPath',
  '--review': 'reviewPath',
  '--out': 'outputPath',
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

export async function runEvidence(options) {
  const comparisonBytes = await readFile(options.comparisonPath);
  const report = JSON.parse(comparisonBytes.toString('utf8'));
  const review = JSON.parse(await readFile(options.reviewPath, 'utf8'));
  const comparisonSha256 = createHash('sha256').update(comparisonBytes).digest('hex');
  const evidence = buildParityEvidence(report, review, comparisonSha256);
  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return evidence;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await runEvidence(options);
  process.stdout.write(`Wrote sanitized parity evidence to ${options.outputPath}.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`Parity evidence failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
