# Vincere Auto Export collector

This folder contains the versioned contract, NinjaTrader AddOn, Windows Service,
guided WPF setup application, installer, and their tests. The production design
does not use pixels, mouse automation, OCR, filenames, IP addresses, or shared
CRM credentials to identify a client.

## Build boundaries

- `Vincere.AutoExport.Contracts` targets `netstandard2.0` so NinjaTrader and the
  service share one wire contract.
- `Vincere.AutoExport.NinjaTrader.Core` targets `netstandard2.0` and owns the
  testable four-section mapper, safe strategy-parameter reader, capture request
  concurrency/timeout rules, and bounded wire framing. It has no NinjaTrader UI
  or proprietary assembly dependency.
- Pure agent tests target `net8.0` and run on every developer/CI platform.
- The service and UI target self-contained `net8.0-windows` / `win-x64`.
- The AddOn targets `net48`. Set `NINJATRADER_HOME` to a legitimate local
  NinjaTrader 8 installation; proprietary assemblies are never committed.

The SDK and package versions are pinned. Restore once to generate/update the
reviewed `packages.lock.json` files, then CI uses locked mode.

```powershell
dotnet restore collector\Vincere.AutoExport.sln --locked-mode
dotnet test collector\tests\Vincere.AutoExport.Contracts.Tests -c Release --no-restore
dotnet test collector\tests\Vincere.AutoExport.NinjaTrader.Core.Tests -c Release --no-restore
dotnet test collector\tests\Vincere.AutoExport.Agent.Tests -c Release --no-restore
```

The supported-API parity gate and its manual VPS instructions live in
[`probe/README.md`](probe/README.md). Do not treat the production AddOn as ready
until that comparison has been reviewed.

## Machine configuration boundary

All machine-owned state derives from `%ProgramData%\Vincere\AutoExport`. The
nonsecret `config.json` is written with flush-and-rename semantics and retains
one validated last-known-good backup. The device credential is stored only in
`secret.bin`, protected with DPAPI `LocalMachine` scope and fixed application
entropy; it has no plaintext backup and is never accepted by diagnostic state
serializers. The root ACL is replaced with explicit Full Control entries for
SYSTEM and the local Administrators group before either file is accessed.

Cross-platform tests verify atomic recovery, secret-store sequencing, machine
ID normalization/hash behavior, and redaction. Real DPAPI, registry, owner/ACL,
and elevated/non-elevated access checks remain required on the Windows system
runner before release.

## Windows packaging boundary

The operator receives one setup executable, but it chains two ownership
domains: a per-machine MSI for the LocalSystem service and guided setup UI, and
a per-user MSI for the AddOn under the selected user's NinjaTrader Documents
tree. Runtime data under `%ProgramData%\Vincere\AutoExport` is retained by
default during uninstall so unsent captures are not destroyed.

Production packaging fails unless the AddOn DLL has a matching verification
receipt proving all four `SnapshotV1` sections passed the supported-API parity
gate. The probe and UI-automation experiments are never accepted as installer
inputs.

On a controlled Windows runner:

```powershell
collector\scripts\build-installer.ps1 `
  -Version 1.0.0 `
  -AddOnSource C:\verified\Vincere.AutoExport.NinjaTrader.dll `
  -AddOnVerificationPath C:\verified\addon-verification.json `
  -ProductionSign
```

The release workflow verifies every Authenticode signature, creates SHA-256
release metadata, and emits a detached CMS signature for the manifest. WiX and
the WPF application still require the Windows system gate before any release is
offered in the CRM.
