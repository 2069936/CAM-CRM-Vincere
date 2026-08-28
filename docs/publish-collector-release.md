# Publishing the complete auto-collector release

The public package has three parts that must travel together:

- the Windows service (`Agent/`);
- the pairing application (`Setup/`);
- the four compiled NinjaTrader runtime DLLs (`AddOn/`).

GitHub-hosted CI builds and tests the first two. The AddOn must be compiled once
on a Windows machine with NinjaTrader 8 because its project references
NinjaTrader's installed assemblies. Client machines never compile source.

No CRM-console access, self-hosted Actions runner, or Authenticode certificate is
required for this unsigned release path. Integrity remains enforced by the
committed SHA-256 pin for the manifest and the package hash inside the manifest.

## Prerequisites

- A green `Collector Windows` workflow run for the commit being released.
- A VPS with NinjaTrader 8 and PowerShell. NinjaTrader must be closed during the
  AddOn build.
- On the release workstation: `gh`, Node.js, `zip`, and `unzip`.

## 1. Build and test the base package

Run **Actions → Collector Windows → Run workflow** on the release commit. The
workflow tests the service and Setup on Windows and uploads
`collector-agent-base-package-<run-number>`.

That artifact intentionally has no `AddOn/` directory and is not publishable by
itself. The release composer below refuses a missing or empty AddOn DLL.

## 2. Compile the AddOn on the NinjaTrader VPS

Close NinjaTrader, open PowerShell, and run:

```powershell
irm https://raw.githubusercontent.com/2069936/CAM-CRM-Vincere/main/collector/scripts/bootstrap-local-test.ps1 | iex
```

The script downloads the canonical `main` source, installs the .NET 8 SDK for
the current user if necessary, compiles against the local NinjaTrader install,
installs the AddOn into `Documents\NinjaTrader 8\bin\Custom`, and prints the
build-output directory.

Copy these four non-empty files from that directory to one folder on the release
workstation:

```text
Vincere.AutoExport.NinjaTrader.dll
Vincere.AutoExport.NinjaTrader.Core.dll
Vincere.AutoExport.Contracts.dll
Newtonsoft.Json.dll
```

The Control Center menu **New → Vincere: Export Snapshot to File (local test)**
is the host-level check that this build loads and reads NinjaTrader.

## 3. Compose the public ZIP and manifest

Choose the final GitHub Release tag before generating the manifest because its
asset URL is embedded in the manifest. For version `1.0.1`:

```bash
./scripts/prepare-release.sh \
  https://github.com/2069936/CAM-CRM-Vincere/releases/download/agent-v1.0.1 \
  /absolute/path/to/addon-dlls \
  1.0.1 \
  <successful-workflow-run-id>
```

The run ID is optional; omitting it selects the newest successful
`Collector Windows` run. The command downloads the CI base package, validates
all four DLLs, creates `AddOn/`, and writes:

```text
release-upload/Vincere-AutoExport-Agent.zip
release-upload/release-manifest.json
```

Before publishing, inspect the exact AddOn entries:

```bash
unzip -l release-upload/Vincere-AutoExport-Agent.zip | grep 'AddOn/'
shasum -a 256 release-upload/Vincere-AutoExport-Agent.zip release-upload/release-manifest.json
```

## 4. Publish the GitHub Release

```bash
gh release create agent-v1.0.1 \
  release-upload/Vincere-AutoExport-Agent.zip \
  release-upload/release-manifest.json \
  --repo 2069936/CAM-CRM-Vincere \
  --title 'Auto-Export Agent 1.0.1' \
  --notes 'Complete collector release with Agent, Setup, and NinjaTrader AddOn.'
```

Do not replace assets under an already pinned tag. Publish a new tag so the old
release remains reproducible.

## 5. Pin the new release in application code

`scripts/make-release-manifest.mjs` prints the manifest SHA-256. Update both
constants in `server/apiLib/collectorRelease.js`:

```js
const DEFAULT_RELEASE_MANIFEST_URL =
  'https://github.com/2069936/CAM-CRM-Vincere/releases/download/agent-v1.0.1/release-manifest.json';
const DEFAULT_RELEASE_MANIFEST_SHA256 = '<printed manifest sha256>';
```

Run the release resolver tests and merge through the normal `main` deployment.
The application already deploys from the repository, so this step does not
require entering CRM or Vercel settings. Environment overrides, if deliberately
configured, still take precedence over the committed default.

## 6. Acceptance test on one VPS

With NinjaTrader closed, install from the command shown by Auto Collection. Then
verify in this order:

1. Setup passes **Checking this VPS** without `unexpected_loop_failure`.
2. Pairing accepts a fresh enrollment code.
3. NinjaTrader starts and shows the Vincere local-export menu.
4. A manual test capture reaches the queue and the CRM acknowledges it.
5. The next heartbeat is accepted after that acknowledgement.
6. The four captured sections match the local JSON for the same trading day.

Only after all six checks should the package be used on other VPS machines.

## Rollback

The previous GitHub Release remains immutable. Reverting the two committed
manifest constants restores the previous download after the normal deployment.
`C:\ProgramData\Vincere\AutoExport` remains preserved by default, so reinstalling
does not discard pairing unless `uninstall-agent.ps1 -RemoveData` is explicitly
used.
