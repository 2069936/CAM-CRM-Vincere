# Auto-collection staging load verification

Status: **harness implemented; live staging evidence pending**.

This gate exercises the real HTTP path for a dedicated set of synthetic staging
clients. For each client it generates a one-time enrollment, pairs one synthetic
device, sends a heartbeat, uploads one four-section snapshot, repeats the same
capture to verify idempotency, verifies Manager history routing, downloads the
stored JSON and reconstructed CSV ZIP, and revokes the exact device it created.
The first device deliberately places a different synthetic machine ID inside
the snapshot source metadata; history must still route it through the device
credential rather than trusting payload metadata.

The committed harness never provisions or deletes clients and never performs a
broad database or Storage cleanup. Use only synthetic clients created for this
test in a disposable staging project. Every client in the private manifest must
have no active production-like device or operational data.

## Safety prerequisites

1. Apply the current migrations to a disposable Supabase staging project and
   deploy the matching Vercel staging commit.
2. Prepare at least 200 dedicated synthetic client UUIDs. Keep the private
   mapping outside the repository.
3. Confirm that the staging pairing rate limit can accommodate the planned
   enrollment phase. Any temporary increase belongs only in disposable staging
   and must be restored immediately after the run.
4. Obtain a short-lived Manager session token. Do not put it in the manifest,
   command line, shell history, CI artifact, or report.
5. Create a private manifest with mode `0600`:

```json
{
  "schemaVersion": 1,
  "purpose": "vincere-auto-collection-load-test",
  "environment": "staging",
  "stagingProjectRef": "cam-staging-01",
  "baseUrl": "https://cam-staging.example.test",
  "clients": [
    { "clientUuid": "00000000-0000-4000-8000-000000000001" }
  ]
}
```

The manifest accepts only the fields shown above. Product keys, device tokens,
enrollment codes, Supabase keys, client names, and account identifiers are
rejected or unnecessary.

## Run the gates

Set secrets only for the current shell and clear them afterwards:

```bash
export AUTO_COLLECTION_LOAD_MANAGER_TOKEN='<short-lived staging Manager token>'
export AUTO_COLLECTION_LOAD_ALLOW_ORIGIN='https://cam-staging.example.test'

npm run collector:load-test -- \
  --manifest /secure/staging-load-clients-20.json \
  --confirm-staging cam-staging-01 \
  --concurrency 20 \
  --out /secure/evidence/auto-collection-load-20.json

npm run collector:load-test -- \
  --manifest /secure/staging-load-clients-200.json \
  --confirm-staging cam-staging-01 \
  --concurrency 20 \
  --out /secure/evidence/auto-collection-load-200.json

unset AUTO_COLLECTION_LOAD_MANAGER_TOKEN AUTO_COLLECTION_LOAD_ALLOW_ORIGIN
```

Alternatively, run the opt-in Vitest E2E cases with
`AUTO_COLLECTION_E2E=1`, `AUTO_COLLECTION_LOAD_MANIFEST`,
`AUTO_COLLECTION_E2E_CONFIRM_STAGING`, and the same two protected variables.
Normal local and PR suites skip these live network tests.

## Acceptance evidence

Record only the aggregate JSON produced by the harness:

- requested, paired, processed, duplicate, routed, downloaded, and revoked
  counts;
- unique batch count;
- request count, failure count, and error rate;
- p50, p95, p99, and maximum latency by stage; and
- stable failure categories and counts.

Pass requires all requested devices to pair, process, return the original batch
on duplicate upload, route to the expected client/device, download both formats,
and revoke successfully. `uniqueBatchCount` must equal the device count and the
failure list must be empty. The report intentionally contains no client UUIDs,
device IDs, capture IDs, names, codes, tokens, row values, or project reference.

Before accepting the live result, use exact private client and batch IDs to
confirm that each successful unique batch has one private Storage object, one
automatic `daily_import`, traceable normalized rows, and only the flags produced
by the shared reconciliation path. Record counts only. Do not commit the private
manifest, SQL output with IDs, raw snapshots, or downloaded ZIPs.

## Pending live results

| Field | 20 concurrent | 200 daily |
|---|---:|---:|
| Commit/version | pending | pending |
| Staging environment | pending | pending |
| Requested devices | 20 | 200 |
| Unique batches | pending | pending |
| Routing mismatches | pending | pending |
| Duplicate normalized rows | pending | pending |
| Storage objects | pending | pending |
| Error rate | pending | pending |
| p95 ingest latency | pending | pending |
| Result | pending | pending |
