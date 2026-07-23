# Vincere Auto Export collector

This folder contains the versioned contract, NinjaTrader AddOn, Windows Service,
guided WPF setup application, installer, and their tests. The production design
does not use pixels, mouse automation, OCR, filenames, IP addresses, or shared
CRM credentials to identify a client.

## Build boundaries

- `Vincere.AutoExport.Contracts` targets `netstandard2.0` so NinjaTrader and the
  service share one wire contract.
- Pure agent tests target `net8.0` and run on every developer/CI platform.
- The service and UI target self-contained `net8.0-windows` / `win-x64`.
- The AddOn targets `net48`. Set `NINJATRADER_HOME` to a legitimate local
  NinjaTrader 8 installation; proprietary assemblies are never committed.

The SDK and package versions are pinned. Restore once to generate/update the
reviewed `packages.lock.json` files, then CI uses locked mode.

```powershell
dotnet restore collector\Vincere.AutoExport.sln --locked-mode
dotnet test collector\tests\Vincere.AutoExport.Contracts.Tests -c Release --no-restore
dotnet test collector\tests\Vincere.AutoExport.Agent.Tests -c Release --no-restore
```

The supported-API parity gate and its manual VPS instructions live in
[`probe/README.md`](probe/README.md). Do not treat the production AddOn as ready
until that comparison has been reviewed.
