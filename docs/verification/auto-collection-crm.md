# CRM auto-collection verification and operations

## Evidence status

Local contract and regression evidence is complete for the CRM implementation.
Live staging evidence is **pending** because this workspace has no staging
Supabase/Vercel credentials. No row below is presented as a live result until an
operator records a sanitized request ID and resulting database state.

Local evidence recorded on 2026-07-23:

- 61 Vitest files passed; 837 tests passed and 3 were skipped, including the
  canonical four-CSV round-trip regression test.
- The canonical Accounts, Strategies, Orders, and Executions CSVs reconstructed
  from snapshot v1 are recognized by the normal manual importer and produce the
  same snapshots, strategies, orders, executions, and stable flags as direct
  automatic normalization.
- `npm run lint` exits zero. The deliberate Fast Refresh exclusions are limited
  to legacy modules that export tested helpers or initialize local view state;
  hook dependency and purity rules remain enabled.
- `npm run build` succeeds. The existing large-chunk advisory remains a
  performance warning, not a build failure.
- Desktop and narrow-viewport browser checks passed for enrollment, fleet
  history, authenticated downloads, replay, and closed-day confirmation.

Run the current local gate before recording or deploying evidence:

```bash
npm test
npm run lint
npm run build
git diff --check
```

## Staging environment

Use separate staging and production Supabase projects and different
`INGEST_TOKEN_PEPPER` values. Store server settings only in the Vercel server
environment; never prefix secrets with `VITE_`.

| Variable | Scope | Rule |
| --- | --- | --- |
| `SUPABASE_URL` | server | HTTPS project URL |
| `SUPABASE_PUBLISHABLE_KEY` | server | browser-token verification client |
| `SUPABASE_SERVICE_ROLE_KEY` | server secret | never browser-visible or logged |
| `VITE_SUPABASE_URL` | browser | matching public project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | browser | public/publishable key only |
| `INGEST_TOKEN_PEPPER` | server secret | unique per environment; rotate by controlled re-pair |
| `INGEST_PAIR_RATE_LIMIT_MAX_ATTEMPTS` | server | default `10` |
| `INGEST_PAIR_RATE_LIMIT_WINDOW_SECONDS` | server | default `60` |
| `INGEST_PAIR_RATE_LIMIT_BLOCK_SECONDS` | server | default `300` |
| `AUTO_COLLECTION_MIN_AGENT_VERSION` | server | reviewed dotted version |
| `AUTO_COLLECTION_HEARTBEAT_MIN_INTERVAL_SECONDS` | server | default `30` for unchanged heartbeats |
| `AUTO_COLLECTION_MAX_COMPRESSED_BYTES` | server | default 2 MiB; hard cap 32 MiB |
| `AUTO_COLLECTION_MAX_UNCOMPRESSED_BYTES` | server | default 16 MiB; hard cap 128 MiB |
| `AUTO_COLLECTION_PROCESSING_LEASE_SECONDS` | server | default `120`; bounded 30–600 |
| `AUTO_COLLECTION_INSTALLER_URL` | server | HTTPS release URL |
| `AUTO_COLLECTION_INSTALLER_VERSION` | server | exact dotted release version |
| `AUTO_COLLECTION_INSTALLER_SHA256` | server | lowercase 64-character SHA-256 |
| `AUTO_COLLECTION_INSTALLER_PUBLISHED_AT` | server | ISO-8601 timestamp |

The private Storage bucket name is fixed in code as `ninjatrader-imports` so a
misconfigured environment cannot route raw data to a public bucket.

## Migration order and rollback

Apply in this order after the baseline CRM migrations:

1. `supabase/step_22_ingest_devices.sql`
2. `supabase/step_28_auto_collection.sql`
3. `supabase/step_29_auto_collection_reprocess.sql`

Apply steps 28 and 29 twice on disposable/staging first; both must be rerunnable.
Then run their static tests and the catalog checks in
`auto-collection-schema.md`.

Application rollback does not delete ingest rows or Storage objects. Remove the
installer manifest from the server environment to stop new installation,
revoke affected devices in CRM, deploy the previously approved application, and
return staff to the manual four-CSV workflow. Database rollback is forward-only:
revoke execute on the new RPCs if necessary, but retain tables, lineage, audit,
and raw objects. Never drop the bucket or broad-delete batches during an
incident.

## Retention decision

Initial policy, pending compliance approval:

- server raw gzip snapshots: 730 days;
- batch, daily-import, lineage, and audit metadata: retained indefinitely;
- agent `Sent`: 30 days after acknowledged upload;
- agent diagnostic logs: 14 days;
- agent `Quarantine`: 90 days after resolution, never while it is the only copy.

No destructive server-retention job is enabled yet. Production rollout must add
a reviewed job that resolves exact object IDs, proves the corresponding batch
is terminal, writes an audit summary, and never uses broad bucket deletion.

## Staging scenario record

Use one test-run identifier and synthetic/redacted clients. Do not record bearer
tokens, enrollment codes, raw MachineGuid, device credentials, hashes, raw
payloads, or account identifiers. Capture only sanitized platform request IDs.

| Scenario | Expected HTTP/state | Request ID | Row counts | Audit event | Result |
| --- | --- | --- | --- | --- | --- |
| Generate and pair | 201; one active device | pending | n/a | enrollment generated, device paired | pending |
| Heartbeat | 200; online | pending | n/a | first online only | pending |
| First complete ingest | 201; processed | pending | A/S/O/E | batch processed | pending |
| Exact duplicate retry | 200; same batch/import | pending | unchanged | no duplicate mutation | pending |
| Newer open-day ingest | 201; prior batch replaced | pending | A/S/O/E | superseded lineage | pending |
| Incomplete ingest | 201; incomplete | pending | captured counts | batch processed | pending |
| Closed-day late ingest | 202; late_closed_day | pending | captured counts | late alert | pending |
| Failed/incomplete replay | 200; new attempt | pending | unchanged raw | reprocess started | pending |
| Confirmed closed replacement | 200; Closed retained | pending | normalized counts | critical flag + replacement audit | pending |
| JSON download | 200; canonical bytes | pending | manifest counts | download audit | pending |
| Four-CSV ZIP | 200; 4 CSV + manifest | pending | matching CSV rows | download audit | pending |
| Manual round trip | equivalent reconciliation | pending | matching results | normal manual import audit | pending |

For each ingest, verify `ingest_batches`, the private object path, the linked
`daily_imports.source_batch_id`, normalized child-row counts, and related
`audit_logs`. For downloads, verify content hashes and re-upload the four files
through the existing manual upload screen for the same synthetic registry.

## On-call replay procedure

1. In Manager → Auto Collection, find the client and open immutable batch
   history. Confirm client, trading date, status, counts, and error code.
2. Download JSON or ZIP for inspection. Do not edit or re-upload the stored raw
   object.
3. For `failed` or `incomplete`, choose **Reprocess batch**, enter an operational
   reason, and type `REPROCESS <client> <YYYY-MM-DD>` exactly.
4. For `late_closed_day` or a failed attempt marked `closed_day`, independently
   confirm the reviewed day should change. Choose **Replace closed day**, enter
   the reason, and type `REPLACE <client> <YYYY-MM-DD>` exactly.
5. Confirm a new processing attempt, terminal batch state, linked daily import,
   audit event, and—when closed—a critical operational flag. Resolve that flag
   only after checking the regenerated report.
6. If the API reports busy, honor `Retry-After`; do not create parallel retries.
   If finalization is unavailable, leave the immutable object untouched and
   retry the same confirmed action after the bounded lease.
7. If recovery is uncertain, revoke the device, use manual exports for that day,
   and preserve all evidence for engineering review.
