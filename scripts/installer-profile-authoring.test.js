import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const installerRoot = new URL('../collector/src/Vincere.AutoExport.Installer/', import.meta.url);
const addon = await readFile(new URL('AddOn.Package.wxs', installerRoot), 'utf8');
const bundle = await readFile(new URL('Bundle.wxs', installerRoot), 'utf8');
const workflow = await readFile(new URL('../.github/workflows/collector-windows.yml', import.meta.url), 'utf8');

describe('guided NinjaTrader profile installer authoring', () => {
  it('captures and persists the interactive user Documents path before elevation', () => {
    expect(bundle).toMatch(/<Variable\s+Name="NinjaTraderDocuments"[^>]*Type="formatted"[^>]*Value="\[PersonalFolder\]"[^>]*Persisted="yes"/s);
    expect(bundle).toMatch(/<util:DirectorySearch[^>]*Path="\[NinjaTraderDocuments\]NinjaTrader 8"[^>]*Variable="NinjaTraderProfileFound"[^>]*Result="exists"/s);
    expect(bundle).toMatch(/<bal:Condition[^>]*Condition="WixBundleInstalled OR NinjaTraderProfileFound"[^>]*Message="[^"]*intended Windows user[^"]*"[^>]*\/>/s);
  });

  it('passes one explicit profile root to the AddOn MSI and never uses MSI PersonalFolder', () => {
    expect(bundle).toMatch(/<MsiPackage\s+Id="AddOnPackage"[\s\S]*?<MsiProperty\s+Name="NINJATRADERDOCUMENTS"\s+Value="\[NinjaTraderDocuments\]"\s*\/>[\s\S]*?<\/MsiPackage>/s);
    expect(addon).toMatch(/<Directory\s+Id="NINJATRADERDOCUMENTS"\s+Name="Documents">/);
    expect(addon).not.toContain('<StandardDirectory Id="PersonalFolder">');
  });

  it('registers AddOn ownership per-machine so repair and uninstall survive UAC identity changes', () => {
    expect(addon).toMatch(/<Package[^>]*Scope="perMachine"/s);
    expect(addon).toMatch(/<RegistryValue\s+Root="HKLM"/s);
    expect(addon).toMatch(/<Launch\s+Condition="NINJATRADERDOCUMENTS"[^>]*>/s);
  });

  it('compiles the AddOn MSI and full bundle authoring on every portable Windows run', () => {
    expect(workflow).toMatch(/name: Compile disposable AddOn MSI and bundle authoring/);
    expect(workflow).toMatch(/Vincere\.AutoExport\.AddOn\.Installer\.wixproj/);
    expect(workflow).toMatch(/Vincere\.AutoExport\.Bundle\.wixproj/);
    expect(workflow).toMatch(/Remove-Item[^\n]*Vincere-AutoExport-Setup\.exe/);
  });
});
