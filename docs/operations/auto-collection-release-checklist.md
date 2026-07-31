# Auto-collection release checklist

Release: `collector-v________________`  
Environment: `staging / production`  
Release owner: `________________`  
Operations owner: `________________`  
Rollback owner: `________________`

## Go/no-go evidence

- [ ] CRM tests, lint, build, and `git diff --check` pass on the release commit.
- [ ] Windows contracts, agent, setup UI, installer, and formatting checks pass.
- [ ] Same-minute NinjaTrader native/API parity evidence covers Accounts,
      Strategies, Orders, and Executions.
- [ ] Post-reset Realized/Gross behavior and two live strategy algorithms are
      explicitly reviewed.
- [ ] Production AddOn is compiled on the controlled `ninjatrader8` runner from
      the exact reviewed commit.
- [ ] Clean Windows VPS tests pass for install, pairing, capture, offline queue,
      retry, service restart, upgrade, rollback, and uninstall.
- [ ] EXE, both MSI packages, and AddOn DLL have valid Authenticode signatures
      from the expected thumbprint and trusted timestamp.
- [ ] `release-manifest.json.p7s` verifies against the exact manifest bytes.
- [ ] Manifest and all three artifacts are uploaded together to the immutable
      release path; no file at that path is replaced afterward.
- [ ] The raw manifest SHA-256 is recorded privately and pinned as
      `AUTO_COLLECTION_RELEASE_MANIFEST_SHA256`.
- [ ] `npm run collector:verify-env` reports `READY` without printing values.
- [ ] Staging Profile downloads the expected bundle; its SHA-256 and Windows
      signer match the manifest before execution.
- [ ] Pair, heartbeat, complete ingest, duplicate retry, immutable history,
      JSON download, four-CSV ZIP, revoke, and audit visibility pass in staging.
- [ ] Manager alerting and manual four-CSV rollback are available.

Any unchecked item is a no-go. Do not compensate for missing parity, unsigned
artifacts, routing uncertainty, or a failed clean-VPS test with manual approval.

## Promotion

1. Freeze the release manifest and artifacts for the rollout wave.
2. Set the exact HTTPS manifest URL and raw-byte SHA-256 in the server
   environment, then deploy the CRM.
3. Verify Profile and Manager display the same release version.
4. Begin with two or three shadow clients; preserve manual same-minute exports.
5. Expand in waves of 10–20 only after the documented acceptance window.

## Rollback

1. Remove the manifest URL and hash from the CRM environment and redeploy; this
   removes the download action without deleting evidence.
2. Pause the rollout and revoke only affected VPS bindings.
3. Restore the previously approved agent/AddOn package or uninstall Vincere
   components using the signed bundle.
4. Continue manual four-CSV uploads while retaining all automatic batches and
   audit history for investigation.
5. Record the incident, exact release version, affected device IDs, and final
   disposition in the private operational system—never secrets or raw P&L here.
