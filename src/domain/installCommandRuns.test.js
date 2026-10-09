/* THE INSTALL LINE, RUN BY A REAL POWERSHELL.
 *
 * The string assertions in AutoCollectionCard.test.jsx pin what the line says.
 * This pins what it DOES: a package whose bytes match the release installs, and
 * one whose bytes do not throws before Expand-Archive and before
 * install-agent.ps1, leaving nothing behind to run.
 *
 * It needs pwsh on PATH. The ubuntu runner CI uses ships with it; a developer
 * machine without it skips this file rather than failing. The line is written
 * for Windows PowerShell 5.1, and PowerShell 7 on Linux reads the same
 * statements and accepts the backslash in "$env:TEMP\vincere-agent" as a path
 * separator, so the run here is the same command the CAM pastes, byte for byte.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildInstallCommand } from './autoCollectionViewModel';

const hasPwsh = (() => {
  try {
    return spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { timeout: 30_000 }).status === 0;
  } catch {
    return false;
  }
})();

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

function flatten(text) {
  return String(text).replace(ANSI, '').replace(/[\s|]/g, '');
}

function runPwsh(command, env) {
  return new Promise((resolve) => {
    const child = spawn('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      env: { ...process.env, NO_COLOR: '1', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe.skipIf(!hasPwsh)('the install line under a real PowerShell', () => {
  let root;
  let server;
  let baseUrl;
  let zipBytes;
  let sha256;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'install-line-'));
    const packageDir = path.join(root, 'package');
    await mkdir(packageDir);
    // Stands in for the real installer: it only records that it was run and
    // with which -PackagePath, which is what the hash check must prevent.
    await writeFile(
      path.join(packageDir, 'install-agent.ps1'),
      "param([string]$PackagePath)\nSet-Content -LiteralPath (Join-Path $env:TEMP 'installer-ran.txt') -Value $PackagePath\n",
    );
    const zipPath = path.join(root, 'package.zip');
    const built = await runPwsh(
      `Compress-Archive -Path '${path.join(packageDir, '*')}' -DestinationPath '${zipPath}' -Force`,
      {},
    );
    expect(built.code, built.stderr).toBe(0);
    zipBytes = await readFile(zipPath);
    sha256 = createHash('sha256').update(zipBytes).digest('hex');

    server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': zipBytes.length });
      res.end(zipBytes);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  }, 60_000);

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function freshTemp(name) {
    const temp = path.join(root, name);
    await mkdir(temp);
    return temp;
  }

  it('installs a package whose SHA-256 matches the release', async () => {
    const temp = await freshTemp('match');
    const command = buildInstallCommand({ url: `${baseUrl}/Vincere-AutoExport-Agent.zip`, kind: 'zip', sha256 });
    expect(command).not.toBe('');

    const result = await runPwsh(command, { TEMP: temp });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('SHA256 mismatch');
    const ran = await readFile(path.join(temp, 'installer-ran.txt'), 'utf8');
    expect(ran.trim()).toMatch(/vincere-agent$/);
    expect(existsSync(path.join(temp, 'vincere-agent', 'install-agent.ps1'))).toBe(true);
  }, 60_000);

  it('accepts the digest whatever its case, since Get-FileHash answers in upper case', async () => {
    const temp = await freshTemp('upper');
    const command = buildInstallCommand({ url: `${baseUrl}/Vincere-AutoExport-Agent.zip`, kind: 'zip', sha256: sha256.toUpperCase() });

    const result = await runPwsh(command, { TEMP: temp });

    expect(result.code, result.stderr).toBe(0);
    expect(existsSync(path.join(temp, 'installer-ran.txt'))).toBe(true);
  }, 60_000);

  it('throws on a different SHA-256, expands nothing, runs nothing and removes the zip', async () => {
    const temp = await freshTemp('mismatch');
    const wrong = sha256.replace(/^./, (first) => (first === '0' ? '1' : '0'));
    const command = buildInstallCommand({ url: `${baseUrl}/Vincere-AutoExport-Agent.zip`, kind: 'zip', sha256: wrong });

    const result = await runPwsh(command, { TEMP: temp });

    expect(result.code).not.toBe(0);
    // PowerShell's error view may colour, wrap and indent the message with
    // "|" gutters, so it is compared with all of that taken out.
    expect(flatten(`${result.stdout}\n${result.stderr}`)).toContain(flatten(`SHA256 mismatch, nothing was installed: ${sha256.toUpperCase()}`));
    expect(existsSync(path.join(temp, 'installer-ran.txt'))).toBe(false);
    expect(existsSync(path.join(temp, 'vincere-agent'))).toBe(false);
    expect(existsSync(path.join(temp, 'vincere-agent.zip'))).toBe(false);
  }, 60_000);
});
