# Windows collector verification

Status: **portable Windows gate passed; controlled VPS gate pending**. The
hosted Windows Server 2025 workflow compiled and tested the portable service,
setup UI, DPAPI and named-pipe logic, built the unsigned machine MSI, ran the
installer authoring tests, and uploaded the MSI artifact. This does not claim
that the collector has passed NinjaTrader parity, an installed LocalSystem
service, live ACL checks, the signed bundle, or Authenticode validation.

## Hosted Windows evidence

| Field | Result |
|---|---|
| Workflow | [Collector Windows run 30049258782](https://github.com/pedro-cmyks/CAM-CRM-Vincere/actions/runs/30049258782) |
| Commit | `5e2bf1b4d76b1d394cb2ad3546eba50f6fe78895` |
| Runner | GitHub-hosted `windows-2025` |
| .NET tests | 135 passed, including 18 pure AddOn mapping/protocol tests |
| Installer tests | 14 passed |
| Artifact | `collector-machine-msi-11/Vincere.AutoExport.Machine.msi` |
| Artifact SHA-256 | `2e80b9c3e2eb0f6b22b810bc26895a0b8c3c3342bed6cc8df21cd1d514108b02` |

The artifact is unsigned and retained for seven days. It is portable-gate
evidence only and must not be distributed as the production installer.

## Controlled environment

Record these values without credentials or client trading data:

| Field | Result |
|---|---|
| VM restore point ID | pending |
| Windows edition/build | pending |
| NinjaTrader version | pending |
| Agent/AddOn/setup version | pending |
| Signing thumbprint | pending |
| Test CRM environment | pending |
| Test date/operator | pending |

The VM must be disposable, use a synthetic NinjaTrader account, and expose
`NINJATRADER_HOME` outside the checkout. The parity evidence file must state
`captureMethod: supported-api` and `allFourSectionsPassed: true`; screenshots,
OCR, mouse automation, or the probe cannot satisfy the release gate.

## Required run

1. Restore the clean VM snapshot and compile the production AddOn against its
   legitimate NinjaTrader assemblies.
2. Compare Accounts, Strategies, Orders, and Executions against the frozen CSV
   baseline. Create the AddOn verification receipt only after all four pass.
3. Build the signed bundle with `build-installer.ps1 -ProductionSign`. Confirm
   the three package signatures and detached release-manifest CMS signature.
4. Install from the CRM Profile download link. Confirm one UAC prompt, the
   correct client name after pairing, NinjaTrader restart guidance, and a green
   test capture.
5. Run the system suite as administrator:

```powershell
$env:VINCERE_SYSTEM_TEST = '1'
$env:VINCERE_SIGNED_SETUP_PATH = 'C:\test\Vincere-AutoExport-Setup.exe'
$env:VINCERE_TEST_ENROLLMENT_CODE = '<disposable one-time code>'
Invoke-Pester collector\tests\installer,collector\tests\system -CI
```

Never paste the enrollment code into CI logs or commit it as evidence. Remove
the environment variable immediately after the run.

## Fault and lifecycle matrix

Record batch IDs, stable error codes, counts, and timestamps only.

| Scenario | Expected | Result |
|---|---|---|
| Clean install and pair | Correct CRM client; token only in DPAPI file | pending |
| NinjaTrader restart + test capture | Four non-synthesized sections queued | pending |
| Scheduled 16:45 ET capture | Fires correctly in EST and EDT | pending |
| Network outage | Local pending item retained; later upload succeeds once | pending |
| Service kill during upload | Receipt recovery; no duplicate normalized day | pending |
| NinjaTrader closed at schedule | Stable unavailable code; retries before cutoff | pending |
| Delayed NinjaTrader start | Capture succeeds before 17:00 ET cutoff | pending |
| Exact duplicate upload | Same CRM batch, no duplicate rows | pending |
| Credential revoke | Agent becomes unpaired; queued payload retained | pending |
| Upgrade | New version replaces old; queue/config preserved | pending |
| Downgrade | Blocked | pending |
| Forced rollback | Prior service and AddOn restored | pending |
| Repair | Owned files restored; foreign files untouched | pending |
| Uninstall | Owned binaries removed; unsent data retained by default | pending |

For forced rollback, run the machine MSI in the disposable VM with
`WIXFAILWHENDEFERRED=1`, then compare service/AddOn hashes before and after.
The Windows runner must also attempt the control pipe as a standard and a
separate unauthorized local user; both mutation attempts must be denied.

## Evidence and completion rule

Attach sanitized workflow URLs, Pester summary, signature table, installer log,
ACL SDDL, parity receipt hash, and CRM batch IDs. Do not attach raw snapshots,
CSV rows, account IDs, client names, product keys, enrollment codes, device
tokens, certificates, or Supabase credentials.

This gate is complete only when every row above passes on a freshly restored VM
using the same signed bundle offered by the CRM. Until then, the installer must
not be promoted as production-ready.
