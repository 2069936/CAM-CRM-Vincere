import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  formatFleetLoadReport,
  runAutoCollectionFleet,
  validateLoadConfiguration,
} from './lib/autoCollectionLoadHarness.mjs';

const ARGUMENTS = Object.freeze({
  '--manifest': 'manifestPath',
  '--confirm-staging': 'confirmStaging',
  '--out': 'outputPath',
  '--concurrency': 'concurrency',
});
const REQUIRED = Object.freeze(['--manifest', '--confirm-staging', '--out']);
const MANIFEST_KEYS = new Set(['schemaVersion', 'purpose', 'environment', 'stagingProjectRef', 'baseUrl', 'clients']);
const PROJECT_REF = /^[a-z0-9][a-z0-9-]{2,63}$/;

export function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const key = ARGUMENTS[flag];
    const value = argv[index + 1];
    if (!key) throw new Error(`Unknown argument: ${flag || '(empty)'}`);
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
    options[key] = key === 'concurrency' ? Number(value) : value;
  }
  for (const flag of REQUIRED) {
    if (!options[ARGUMENTS[flag]]) throw new Error(`Missing required argument ${flag}.`);
  }
  if (options.concurrency == null) options.concurrency = 20;
  return options;
}

export function validateLoadManifest(value, confirmation) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !MANIFEST_KEYS.has(key))) {
    throw new Error('load_manifest_unknown_field');
  }
  if (value.schemaVersion !== 1 || value.purpose !== 'vincere-auto-collection-load-test') {
    throw new Error('load_manifest_invalid');
  }
  if (value.environment !== 'staging') throw new Error('load_environment_must_be_staging');
  if (!PROJECT_REF.test(String(value.stagingProjectRef || ''))) throw new Error('staging_project_ref_invalid');
  if (String(confirmation || '') !== value.stagingProjectRef) throw new Error('staging_confirmation_mismatch');
  if (!Array.isArray(value.clients)
    || value.clients.some((client) => !client
      || typeof client !== 'object'
      || Array.isArray(client)
      || Object.keys(client).length !== 1
      || typeof client.clientUuid !== 'string')) {
    throw new Error('load_manifest_client_shape_invalid');
  }
  const clientUuids = value.clients.map(({ clientUuid }) => clientUuid);
  validateLoadConfiguration({
    baseUrl: value.baseUrl,
    managerToken: 'manifest-shape-validation',
    clientUuids,
    concurrency: 1,
  });
  return {
    baseUrl: value.baseUrl,
    clientUuids,
  };
}

export async function runLoadTest({
  manifestPath,
  outputPath,
  confirmStaging,
  concurrency = 20,
  env = process.env,
  runFleet = runAutoCollectionFleet,
} = {}) {
  const raw = await readFile(manifestPath, 'utf8');
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw new Error('load_manifest_invalid_json');
  }
  const validated = validateLoadManifest(manifest, confirmStaging);
  const managerToken = env.AUTO_COLLECTION_LOAD_MANAGER_TOKEN;
  if (typeof managerToken !== 'string' || managerToken.length < 1) throw new Error('manager_token_required');
  const allowedOrigin = String(env.AUTO_COLLECTION_LOAD_ALLOW_ORIGIN || '').trim();
  if (!allowedOrigin || allowedOrigin !== validated.baseUrl) throw new Error('load_origin_confirmation_required');
  validateLoadConfiguration({ ...validated, managerToken, concurrency });

  const report = await runFleet({
    ...validated,
    managerToken,
    concurrency,
  });
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, outputPath);
  if (!report.ok) throw new Error('auto_collection_load_gate_failed');
  return report;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  try {
    const report = await runLoadTest(options);
    process.stdout.write(formatFleetLoadReport(report));
  } catch (error) {
    process.stderr.write(`Auto-collection load test failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
