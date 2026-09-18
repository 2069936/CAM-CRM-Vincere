import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/* THE IMPORT VITE FORGIVES AND VERCEL DOES NOT.
 *
 * `import x from './openPositions'` works in the browser build and in every
 * test here, because Vite's resolver adds the extension. Vercel runs the files
 * under api/ with plain Node, which does not: the function crashed at import
 * with ERR_MODULE_NOT_FOUND, every ingest and admin endpoint answered 500
 * FUNCTION_INVOCATION_FAILED, and the desk saw "Collector setup is temporarily
 * unavailable" on every client the morning PR #24 was deployed.
 *
 * So every API entry point is imported here by a real Node process, outside
 * Vite, exactly as production loads it. */
const ROOT = join(import.meta.dirname, '..', '..', '..');

function apiFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return apiFiles(full);
    return name.endsWith('.js') ? [full] : [];
  });
}

describe('API entry points', () => {
  for (const file of apiFiles(join(ROOT, 'api'))) {
    it(`${relative(ROOT, file)} loads under plain Node the way Vercel loads it`, () => {
      const script = `import(${JSON.stringify(file)}).then(() => process.stdout.write('ok')).catch((error) => { process.stdout.write('FAIL ' + (error.code || '') + ' ' + error.message.split('\\n')[0]); process.exit(1); });`;
      let output;
      try {
        output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
          cwd: ROOT,
          env: { ...process.env, NODE_ENV: 'production' },
          encoding: 'utf8',
          timeout: 30_000,
        });
      } catch (error) {
        output = `${error.stdout || ''}${error.stderr || ''}`;
      }
      expect(output).toBe('ok');
    });
  }
});
