import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { resolve } from 'node:path';
import { resolveInstallerRelease } from '../api/_lib/collectorRelease.js';
import { compareCollectorVersions, normalizeCollectorVersion } from '../api/_lib/collectorVersion.js';

const PLACEHOLDER = /^(?:change[-_ ]?me|replace[-_ ]?me|placeholder|todo|xxx+|your[-_ ].*)$/i;
const REQUIRED_TEXT = [
  'SUPABASE_URL',
  'SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_PUBLISHABLE_KEY',
  'INGEST_TOKEN_PEPPER',
  'AUTO_COLLECTION_MIN_AGENT_VERSION',
  'AUTO_COLLECTION_RELEASE_MANIFEST_URL',
  'AUTO_COLLECTION_RELEASE_MANIFEST_SHA256',
];
const INTEGER_RULES = Object.freeze({
  INGEST_PAIR_RATE_LIMIT_MAX_ATTEMPTS: [1, 1_000],
  INGEST_PAIR_RATE_LIMIT_WINDOW_SECONDS: [1, 86_400],
  INGEST_PAIR_RATE_LIMIT_BLOCK_SECONDS: [1, 604_800],
  AUTO_COLLECTION_HEARTBEAT_MIN_INTERVAL_SECONDS: [1, 3_600],
  AUTO_COLLECTION_MAX_COMPRESSED_BYTES: [1, 32 * 1024 * 1024],
  AUTO_COLLECTION_MAX_UNCOMPRESSED_BYTES: [1, 128 * 1024 * 1024],
  AUTO_COLLECTION_PROCESSING_LEASE_SECONDS: [30, 600],
});

function value(env, name) {
  return typeof env?.[name] === 'string' ? env[name].trim() : '';
}

function status(setting, passed, code = passed ? 'valid' : 'invalid') {
  return { setting, status: passed ? 'pass' : 'fail', code };
}

function safeHttps(valueToCheck) {
  try {
    const url = new URL(valueToCheck);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function validateEnvironmentShape(env) {
  const checks = [];
  for (const setting of REQUIRED_TEXT) {
    const current = value(env, setting);
    checks.push(status(setting, Boolean(current) && !PLACEHOLDER.test(current), current ? 'placeholder_or_invalid' : 'missing'));
  }
  for (const [setting, [minimum, maximum]] of Object.entries(INTEGER_RULES)) {
    const parsed = Number(value(env, setting));
    checks.push(status(setting, Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum, 'out_of_range'));
  }
  checks.push(status('SUPABASE_URL', safeHttps(value(env, 'SUPABASE_URL')), 'https_required'));
  checks.push(status('VITE_SUPABASE_URL', safeHttps(value(env, 'VITE_SUPABASE_URL')), 'https_required'));
  checks.push(status(
    'SUPABASE_URL',
    value(env, 'SUPABASE_URL') === value(env, 'VITE_SUPABASE_URL'),
    'browser_server_mismatch',
  ));
  checks.push(status(
    'SUPABASE_PUBLISHABLE_KEY',
    value(env, 'SUPABASE_PUBLISHABLE_KEY') === value(env, 'VITE_SUPABASE_PUBLISHABLE_KEY'),
    'browser_server_mismatch',
  ));
  checks.push(status('SUPABASE_SERVICE_ROLE_KEY', value(env, 'SUPABASE_SERVICE_ROLE_KEY').length >= 24, 'too_short'));
  checks.push(status('INGEST_TOKEN_PEPPER', value(env, 'INGEST_TOKEN_PEPPER').length >= 32, 'too_short'));
  checks.push(status(
    'AUTO_COLLECTION_RELEASE_MANIFEST_URL',
    safeHttps(value(env, 'AUTO_COLLECTION_RELEASE_MANIFEST_URL')),
    'https_required',
  ));
  checks.push(status(
    'AUTO_COLLECTION_RELEASE_MANIFEST_SHA256',
    /^[a-f0-9]{64}$/.test(value(env, 'AUTO_COLLECTION_RELEASE_MANIFEST_SHA256')),
    'invalid_sha256',
  ));
  try {
    normalizeCollectorVersion(value(env, 'AUTO_COLLECTION_MIN_AGENT_VERSION'));
    checks.push(status('AUTO_COLLECTION_MIN_AGENT_VERSION', true));
  } catch {
    checks.push(status('AUTO_COLLECTION_MIN_AGENT_VERSION', false, 'invalid_version'));
  }
  const compressed = Number(value(env, 'AUTO_COLLECTION_MAX_COMPRESSED_BYTES'));
  const uncompressed = Number(value(env, 'AUTO_COLLECTION_MAX_UNCOMPRESSED_BYTES'));
  checks.push(status('AUTO_COLLECTION_MAX_UNCOMPRESSED_BYTES', uncompressed >= compressed, 'smaller_than_compressed'));
  return checks;
}

async function inspectEnvironment(env, fetchImpl) {
  const checks = validateEnvironmentShape(env);
  let release = null;
  try {
    const resolvedRelease = await resolveInstallerRelease(env, { production: true, fetchImpl });
    if (!resolvedRelease) throw new Error('missing');
    const serverMinimum = normalizeCollectorVersion(value(env, 'AUTO_COLLECTION_MIN_AGENT_VERSION'));
    const versionsMatch = serverMinimum === resolvedRelease.minimumAgentVersion
      && compareCollectorVersions(resolvedRelease.version, serverMinimum) >= 0;
    const supportedSchema = resolvedRelease.minimumSchemaVersion === 1;
    checks.push(status('AUTO_COLLECTION_RELEASE_MANIFEST', versionsMatch && supportedSchema, versionsMatch ? 'unsupported_schema' : 'minimum_version_mismatch'));
    release = { version: resolvedRelease.version, minimumSchemaVersion: resolvedRelease.minimumSchemaVersion };
  } catch {
    checks.push(status('AUTO_COLLECTION_RELEASE_MANIFEST', false, 'unavailable_or_invalid'));
  }
  return { ok: checks.every((check) => check.status === 'pass'), checks, release };
}

export function parseEnvironmentText(text) {
  const parsed = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const matched = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!matched) throw new Error('Invalid environment metadata line.');
    let parsedValue = matched[2].trim();
    if ((parsedValue.startsWith('"') && parsedValue.endsWith('"'))
      || (parsedValue.startsWith("'") && parsedValue.endsWith("'"))) {
      parsedValue = parsedValue.slice(1, -1);
    }
    parsed[matched[1]] = parsedValue;
  }
  return parsed;
}

export function formatReadinessReport(report) {
  const lines = [`Auto-collection readiness: ${report.ok ? 'READY' : 'NOT READY'}`];
  for (const name of ['staging', 'production', 'crossEnvironment']) {
    const section = report[name] || { ok: false, checks: [] };
    lines.push(`${name}: ${section.ok ? 'PASS' : 'FAIL'}`);
    for (const check of section.checks || []) {
      lines.push(`  ${check.status.toUpperCase()} ${check.setting} (${check.code})`);
    }
  }
  return lines.join('\n');
}

export async function verifyAutoCollectionEnvironments({ staging, production, fetchImpl = globalThis.fetch }) {
  const [stagingReport, productionReport] = await Promise.all([
    inspectEnvironment(staging, fetchImpl),
    inspectEnvironment(production, fetchImpl),
  ]);
  const crossChecks = [
    status('SUPABASE_URL', Boolean(value(staging, 'SUPABASE_URL')) && value(staging, 'SUPABASE_URL') !== value(production, 'SUPABASE_URL'), 'must_differ'),
    status('INGEST_TOKEN_PEPPER', Boolean(value(staging, 'INGEST_TOKEN_PEPPER')) && value(staging, 'INGEST_TOKEN_PEPPER') !== value(production, 'INGEST_TOKEN_PEPPER'), 'must_differ'),
  ];
  const crossEnvironment = { ok: crossChecks.every((check) => check.status === 'pass'), checks: crossChecks };
  return {
    ok: stagingReport.ok && productionReport.ok && crossEnvironment.ok,
    staging: stagingReport,
    production: productionReport,
    crossEnvironment,
  };
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const path = argv[index + 1];
    if (!['--staging-env', '--production-env'].includes(name) || !path) throw new Error('Usage: --staging-env <path> --production-env <path>');
    result[name] = path;
  }
  if (!result['--staging-env'] || !result['--production-env']) throw new Error('Usage: --staging-env <path> --production-env <path>');
  return result;
}

async function main() {
  try {
    const args = parseArguments(process.argv.slice(2));
    const [stagingText, productionText] = await Promise.all([
      readFile(resolve(args['--staging-env']), 'utf8'),
      readFile(resolve(args['--production-env']), 'utf8'),
    ]);
    const report = await verifyAutoCollectionEnvironments({
      staging: parseEnvironmentText(stagingText),
      production: parseEnvironmentText(productionText),
    });
    process.stdout.write(`${formatReadinessReport(report)}\n`);
    if (!report.ok) process.exitCode = 1;
  } catch {
    process.stderr.write('Auto-collection readiness check could not run. No values were printed.\n');
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
