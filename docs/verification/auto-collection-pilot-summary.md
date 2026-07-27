# Auto-collection shadow pilot comparison

Status: **comparison tooling implemented; multi-day live pilot evidence pending**.

The shadow comparator runs the automatic snapshot and the four same-minute
manual NinjaTrader CSVs through the CRM's existing normalization and
reconciliation paths. It compares contract validity, Accounts, Strategies,
Orders, Executions, selected daily P&L, and operational flags without writing
to the CRM or closing a day.

The committed report contains counts and stable mismatch categories only. It
does not contain client UUIDs, account/order/execution identifiers, names,
timestamps, P&L values, registry values, product keys, credentials, or raw rows.

## Private context

Create a temporary context file outside the repository with mode `0600`:

```json
{
  "schemaVersion": 1,
  "purpose": "vincere-auto-manual-shadow-comparison",
  "expectedClientUuid": "00000000-0000-4000-8000-000000000001",
  "autoClientUuid": "00000000-0000-4000-8000-000000000001",
  "manualCapturedAt": "2026-07-23T16:45:30-04:00",
  "registry": {}
}
```

`expectedClientUuid` is the client selected for the manual export.
`autoClientUuid` must come from the Manager batch-history record, not from the
snapshot payload. Populate `registry` from the same private CRM account
registry used by both import paths. Never commit this context.

## Run

```bash
npm run collector:compare-shadow -- \
  --snapshot /secure/pilot/automatic.json \
  --context /secure/pilot/context.json \
  --accounts /secure/pilot/Accounts.csv \
  --strategies /secure/pilot/Strategies.csv \
  --orders /secure/pilot/Orders.csv \
  --executions /secure/pilot/Executions.csv \
  --out /secure/evidence/shadow-comparison.json
```

Exit code `0` means equivalent required data. Exit code `2` means the sanitized
comparison completed with mismatches. Exit code `1` means an input or execution
error. Missing optional values are counted but do not fail the gate; missing
rows, required-field mismatches, cross-client routing, different capture
minutes, selected-P&L mismatches, and reconciled-flag mismatches do fail it.

## Acceptance record

For each pilot VPS, run the comparison for at least three consecutive trading
days. Record only the output JSON plus version/date and operational incident
counts. Delete the private context and working downloads after the approved
retention period.

| Gate | Day 1 | Day 2 | Day 3 |
|---|---:|---:|---:|
| Same client and capture minute | pending | pending | pending |
| Accounts required parity | pending | pending | pending |
| Strategies required parity | pending | pending | pending |
| Orders required parity | pending | pending | pending |
| Executions required parity | pending | pending | pending |
| Selected P&L parity | pending | pending | pending |
| Reconciled flags parity | pending | pending | pending |
| Result | pending | pending | pending |
