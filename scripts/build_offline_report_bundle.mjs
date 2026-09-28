// Builds the offline report bundle with the CRM's own vite.
//
//   node scripts/build_offline_report_bundle.mjs
//
// Output: collector/src/Vincere.AutoExport.Agent.UI/OfflineReport/report-bundle.js
//
// WHY THE CRM'S VITE AND NOT A SECOND TOOLCHAIN. The point of shipping the
// desk's own report code to the machine is that the numbers cannot drift. A
// bundler with different defaults - a different target, a different way of
// treating a getter - is a second toolchain that can disagree with the first.
// This is the same vite, the same config resolution, the same repo.
//
// The agent copies the output beside its executable and inlines it into every
// report it writes, so this runs in CI, not on the machine.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = path.join(root, 'collector/src/Vincere.AutoExport.Agent.UI/OfflineReport');

const result = await build({
  root,
  configFile: false,
  logLevel: 'warn',
  build: {
    outDir,
    emptyOutDir: true,
    // WITHOUT THIS, vite copies public/ into the output. That folder holds
    // local-snapshot.json, which is the desk's whole book - 63 MB of real
    // client closes - and it would have been written into the agent's source
    // tree and from there into the package installed on client machines.
    copyPublicDir: false,
    // A browser opening a file:// URL, not a module graph. One IIFE, no
    // imports, nothing to resolve at run time.
    lib: {
      entry: path.join(root, 'src/offline/entry.js'),
      formats: ['iife'],
      name: 'VincereOfflineReport',
      fileName: () => 'report-bundle.js',
    },
    minify: true,
    // Windows Server ships whatever Edge it ships. Nothing here needs anything
    // newer, and a narrower target is one less way for the file to open blank.
    target: 'es2019',
  },
});

const file = path.join(outDir, 'report-bundle.js');
if (!fs.existsSync(file)) {
  console.error('vite did not write', file);
  process.exit(1);
}
const bytes = fs.statSync(file).size;
const text = fs.readFileSync(file, 'utf8');

// The file is opened on a machine with no network. Anything remote in it would
// be a blank section on a client's report, or worse, a request from a client's
// VPS to somewhere nobody chose.
const remote = text.match(/https?:\/\/[^\s'"`)]+/g);
if (remote) {
  console.error('the bundle references something remote:', [...new Set(remote)].slice(0, 5));
  process.exit(1);
}

console.log(`report-bundle.js  ${(bytes / 1024).toFixed(1)} kB`);
if (Array.isArray(result?.output)) {
  for (const chunk of result.output) if (chunk.fileName) console.log('  ', chunk.fileName);
}
