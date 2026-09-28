// Builds the daily report email bundle with the CRM's own vite.
//
//   node scripts/build_daily_email_bundle.mjs
//
// Output: supabase/functions/daily-report-email/_bundle.js
//
// WHY BUNDLED AND NOT IMPORTED. The Edge Function runs under Deno, which wants
// explicit file extensions on every import; this repo's src/ does not use them,
// because vite resolves them. Rewriting several hundred imports to satisfy one
// runtime would be a change to the whole app for the benefit of one function.
// So the function imports one file, and that file is built by the same vite,
// with the same config resolution, as everything else the desk runs.
//
// WHY THE SAME VITE, AND NOT DENO'S BUNDLER. The point of sending the desk's
// own report code is that the numbers cannot drift. A second bundler is a
// second set of defaults that can disagree with the first, and the day it does
// the difference shows up as a client's figure, not as a build error.
//
// This runs in CI, not on the machine that deploys.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = path.join(root, 'supabase/functions/daily-report-email');

await build({
  root,
  configFile: false,
  logLevel: 'warn',
  resolve: {
    alias: [
      /* See scripts/bundle-stubs/supabaseClient.js. The bundle needs
       * buildCrmStateFromTables, which is pure, out of a file that also holds
       * every call the browser makes as the signed-in user. Without this the
       * whole supabase-js client comes along - the build refuses it below -
       * into a process that already has a service role. */
      {
        find: /^.*\/lib\/supabaseClient(\.js)?$/,
        replacement: path.join(root, 'scripts/bundle-stubs/supabaseClient.js'),
      },
    ],
  },
  build: {
    outDir,
    // NOT emptied: index.ts lives in this folder and is hand written.
    emptyOutDir: false,
    // Without this, vite copies public/ into the output. That folder holds
    // local-snapshot.json, the desk's whole book, 63 MB of real client closes.
    copyPublicDir: false,
    lib: {
      entry: path.join(root, 'src/domain/dailyEmailEntry.js'),
      formats: ['es'],
      fileName: () => '_bundle.js',
    },
    // Readable on purpose. This file is deployed to Supabase and read there by
    // whoever is debugging a run at the close, with no source map and no repo.
    minify: false,
    // Deno's baseline is far newer than a browser's. Nothing here needs a
    // transform, and an untransformed bundle is one that still reads like the
    // source it came from.
    target: 'es2022',
  },
});

const file = path.join(outDir, '_bundle.js');
if (!fs.existsSync(file)) {
  console.error('vite did not write', file);
  process.exit(1);
}
const text = fs.readFileSync(file, 'utf8');

/* THE ONLY HOST THIS FILE MAY NAME IS THE MAIL PROVIDER.
 *
 * It runs inside the database with a service role. A request from here to
 * somewhere nobody chose is not a broken feature, it is client data leaving.
 * The provider's own endpoint is in emailDelivery.js and is expected; anything
 * else fails the build rather than being noticed later. */
const ALLOWED = [
  ['https://api.brevo.com', 'the mail provider, called from emailDelivery.js'],
  ['https://github.com/mholt/PapaParse', "PapaParse's attribution banner, not a request"],
];
const remote = [...new Set(text.match(/https?:\/\/[^\s'"`)]+/g) || [])]
  .filter((url) => !ALLOWED.some(([host]) => url.startsWith(host)));
if (remote.length) {
  console.error('the bundle references a host nobody chose:', remote.slice(0, 5));
  console.error('If it belongs there, add it to ALLOWED with the reason it does.');
  process.exit(1);
}

/* PapaParse is here because reconcile.js reaches csvImport.js, and the email
 * path never parses a CSV. It is dead weight in a service-role process rather
 * than a hazard, and it is written down so the next person to read the bundle
 * size knows why it is what it is instead of assuming it is load bearing. */

/* The supabase-js client is the browser store's dependency, not this one's: the
 * function reads its rows through the REST endpoint it is already inside. If it
 * ever gets bundled in, the file grows by an order of magnitude and starts
 * carrying auth code that has no business running as a service role. */
if (/@supabase\/supabase-js/.test(text)) {
  console.error('the bundle pulled in the supabase browser client');
  process.exit(1);
}

console.log(`_bundle.js  ${(fs.statSync(file).size / 1024).toFixed(1)} kB`);
