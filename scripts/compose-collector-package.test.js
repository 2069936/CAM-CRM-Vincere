import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = new URL('./compose-collector-package.sh', import.meta.url).pathname;
const requiredDlls = [
  'Vincere.AutoExport.NinjaTrader.dll',
  'Vincere.AutoExport.NinjaTrader.Core.dll',
  'Vincere.AutoExport.Contracts.dll',
  'Newtonsoft.Json.dll',
];
const temporaryRoots = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'vincere-package-test-'));
  temporaryRoots.push(root);
  const stage = join(root, 'base');
  const addon = join(root, 'addon');
  const baseZip = join(root, 'base.zip');
  const outputZip = join(root, 'Vincere-AutoExport-Agent.zip');
  mkdirSync(join(stage, 'Agent'), { recursive: true });
  mkdirSync(join(stage, 'Setup'), { recursive: true });
  mkdirSync(join(stage, 'AddOn'), { recursive: true });
  mkdirSync(addon, { recursive: true });
  writeFileSync(join(stage, 'Agent', 'Vincere.AutoExport.Agent.exe'), 'agent');
  writeFileSync(join(stage, 'Setup', 'Vincere.AutoExport.Agent.UI.exe'), 'setup');
  writeFileSync(join(stage, 'install-agent.ps1'), 'installer');
  writeFileSync(join(stage, 'AddOn', 'stale.dll'), 'must-not-ship');
  execFileSync('zip', ['-q', '-r', baseZip, '.'], { cwd: stage });
  return { root, addon, baseZip, outputZip };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('complete collector package composition', () => {
  it('preserves the base package and adds the four AddOn runtime DLLs', () => {
    const { addon, baseZip, outputZip } = fixture();
    for (const [index, name] of requiredDlls.entries()) {
      writeFileSync(join(addon, name), `addon-${index}`);
    }

    execFileSync('bash', [script, baseZip, addon, 'Vincere-AutoExport-Agent.zip'], { cwd: dirname(outputZip) });

    const entries = execFileSync('unzip', ['-Z1', outputZip], { encoding: 'utf8' }).trim().split('\n');
    expect(entries).toContain('Agent/Vincere.AutoExport.Agent.exe');
    expect(entries).toContain('Setup/Vincere.AutoExport.Agent.UI.exe');
    expect(entries).toContain('install-agent.ps1');
    expect(entries).not.toContain('AddOn/stale.dll');
    for (const [index, name] of requiredDlls.entries()) {
      expect(entries).toContain(`AddOn/${name}`);
      expect(execFileSync('unzip', ['-p', outputZip, `AddOn/${name}`], { encoding: 'utf8' }))
        .toBe(`addon-${index}`);
    }
  });

  it.each([
    ['missing', false],
    ['empty', true],
  ])('refuses an %s required AddOn DLL without writing a release', (_case, createEmptyFile) => {
    const { addon, baseZip, outputZip } = fixture();
    for (const name of requiredDlls.slice(0, -1)) writeFileSync(join(addon, name), name);
    if (createEmptyFile) writeFileSync(join(addon, requiredDlls.at(-1)), '');

    const result = spawnSync('bash', [script, baseZip, addon, outputZip], { encoding: 'utf8' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(requiredDlls.at(-1));
    expect(existsSync(outputZip)).toBe(false);
  });
});
