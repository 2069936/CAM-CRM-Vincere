#!/usr/bin/env node
// Builds the auto-collection release manifest and prints the two environment
// values the application release pin needs. Run it after uploading the agent package, or before —
// the URLs just have to be the ones the files will finally live at.
//
//   node scripts/make-release-manifest.mjs \
//     --package ./Vincere-AutoExport-Agent.zip \
//     --base-url https://<project>.supabase.co/storage/v1/object/public/collector \
//     --version 1.0.0 \
//     --out ./release-manifest.json
//
// Then upload BOTH the package and the generated manifest to that base URL, and
// commit the printed URL and digest in server/apiLib/collectorRelease.js.
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import process from 'node:process';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index === process.argv.length - 1) return fallback;
  return process.argv[index + 1];
}

const packagePath = arg('package');
const baseUrl = arg('base-url');
const version = arg('version', '1.0.0');
const outPath = arg('out', './release-manifest.json');
const thumbprint = arg('thumbprint');   // optional: only for a signed release

if (!packagePath || !baseUrl) {
  console.error('Usage: --package <zip> --base-url <https url the files are served from> [--version 1.0.0] [--out release-manifest.json] [--thumbprint <cert thumbprint>]');
  process.exit(1);
}

const bytes = readFileSync(packagePath);
const name = basename(packagePath);
if (!/^Vincere-AutoExport-(Agent\.zip|Setup\.exe)$/.test(name)) {
  console.error(`The package must be named Vincere-AutoExport-Agent.zip (or Vincere-AutoExport-Setup.exe for a signed release). Got: ${name}`);
  process.exit(1);
}

const manifest = {
  schemaVersion: 1,
  version,
  minimumAgentVersion: version,
  minimumSchemaVersion: 1,
  publishedAt: new Date().toISOString(),
  artifacts: [
    {
      name,
      // Artifacts must sit on the same origin as the manifest.
      url: `${baseUrl.replace(/\/+$/, '')}/${name}`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: statSync(packagePath).size,
    },
  ],
};
// Only carried when the artifact really is signed; the CRM treats its absence
// as an unsigned release rather than a malformed manifest.
if (thumbprint) manifest.signingThumbprint = thumbprint.toUpperCase();

const text = JSON.stringify(manifest, null, 2);
writeFileSync(outPath, text);

console.log(`Wrote ${outPath}\n`);
console.log('Upload these two files to that base URL:');
console.log(`  1. ${name}`);
console.log(`  2. ${basename(outPath)}\n`);
console.log('Pin these values in server/apiLib/collectorRelease.js:');
console.log(`  DEFAULT_RELEASE_MANIFEST_URL=${baseUrl.replace(/\/+$/, '')}/${basename(outPath)}`);
// The manifest is pinned by hash, so any later edit to it is rejected until
// this value is updated too.
console.log(`  DEFAULT_RELEASE_MANIFEST_SHA256=${createHash('sha256').update(text).digest('hex')}`);
