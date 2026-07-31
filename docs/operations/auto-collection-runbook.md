# Auto-collection operations runbook

## Daily control

Run the audit after 17:00 ET on trading days, then reconcile its aggregate
counts with **Manager → Auto Collection**. Use a short-lived Manager session
token and a private HMAC key dedicated to operational references; neither may
be passed as a command argument or committed.

```bash
export AUTO_COLLECTION_AUDIT_MANAGER_TOKEN='<short-lived Manager token>'
export AUTO_COLLECTION_AUDIT_REDACTION_KEY='<private random value, at least 32 bytes>'
export AUTO_COLLECTION_AUDIT_ALLOW_ORIGIN='https://crm.example.com'
npm run collector:audit-day -- \
  --base-url https://crm.example.com \
  --confirm-origin https://crm.example.com \
  --out /secure/operations/collector-audit-YYYY-MM-DD.json
unset AUTO_COLLECTION_AUDIT_MANAGER_TOKEN AUTO_COLLECTION_AUDIT_REDACTION_KEY
```

The script performs only paginated `GET /api/admin/ingest-fleet` requests. Its
private `0600` report contains status counts and HMAC client/device references;
it never requests snapshots, CSV/ZIP downloads, client names, account values,
versions, credentials, or P&L. Keep the same HMAC key only for the approved
retention window if stable cross-day references are needed.

The daily owner records: expected total, every status count, unexplained late
or incomplete references, ticket owner, and disposition. Weekend
`not_expected`, pre-schedule `pending`, and grace-window `expected` are not
failures. A weekday audit is not complete until every attention item is owned.

## Triage by condition

1. **Pending/expected:** wait until the 15-minute grace has expired. Do not ask
   staff to force duplicate captures during the normal window.
2. **AddOn unavailable:** confirm NinjaTrader was restarted after installation,
   that the supported Vincere AddOn is present, and that the agent UI test
   capture is green. Do not install the UIAutomation/pixel prototype.
3. **NinjaTrader closed:** start NinjaTrader and connect the intended account
   before 17:00 ET when possible. The agent should retry; confirm one batch in
   Manager history rather than starting repeated exports.
4. **Offline queue/upload failure:** restore network/service connectivity and
   leave `%ProgramData%\Vincere\AutoExport\queue` untouched. Confirm the
   existing item uploads once and produces no duplicate normalized rows.
5. **Incomplete/invalid schema:** keep the CRM day open. In immutable history,
   review section counts and safe error code. Export redacted diagnostics and
   escalate; do not edit the stored snapshot.
6. **Revoked credential:** decide whether revocation was intended. For a moved
   or rebuilt VPS, use the Profile rebind flow and a new one-time code. Never
   restore the old token or copy `secret.bin` between machines.
7. **Late closed-day batch:** it must remain `late_closed_day` until a Manager
   explicitly approves replacement. Never reopen or overwrite it by direct SQL.
8. **Update required:** download the pinned signed bundle from the client
   Profile, verify the displayed client, and upgrade. Downgrades and artifacts
   from chat/email are prohibited.
9. **Storage/processing failure:** preserve the batch and audit history, stop
   the rollout if data loss or immutable-object conflict is possible, and
   escalate to engineering before replay.

## Safe recovery procedures

### Replay an open day

Open **Manager → Auto Collection → client history**. Verify client, trading
date, row counts, state, and error code. For `failed` or `incomplete`, choose
**Reprocess batch**, enter a specific reason of at least 10 characters, and
type `REPROCESS <client> <YYYY-MM-DD>`. This creates a processing attempt from
the immutable object; it does not modify that object. If the API is busy, obey
`Retry-After` and do not launch a parallel replay.

### Replace a closed day

Independently confirm the reviewed report is allowed to change. Choose
**Replace closed day**, record the reason, and type
`REPLACE <client> <YYYY-MM-DD>`. Verify the replacement lineage, new report,
critical operational flag, and audit event before resolving the flag.

### Revoke or rebind

Use Profile controls, select the real operational reason, and revoke only the
resolved client/device. Rebind generates a fresh single-use enrollment code and
invalidates the previous credential. Confirm the client name returned by the
installer before accepting the new binding.

### Diagnostics and repair

In the agent UI select **Create support diagnostics**. Share only the generated
redacted ZIP through the approved private support channel; do not manually zip
ProgramData, raw queue objects, `secret.bin`, CSVs, or screenshots containing
accounts/P&L. Check the Windows service named `Vincere Auto Export`, then rerun
the exact pinned, Authenticode-verified setup bundle and choose repair. Confirm
the service, AddOn, pairing, queue retention, and one test capture afterward.

### Rollback and manual fallback

Pause new enrollments; revoke only affected devices; retain queue, immutable
batches, and audit evidence; restore the previously approved signed version or
uninstall Vincere-owned components. Do not delete unsent data. Until automatic
collection is verified again, export Accounts, Strategies, Orders, and
Executions manually before the session reset and upload them through the
existing CRM four-file flow. The CRM remains responsible for validation, flags,
day closure, and report generation.

## Escalation

- **Critical, immediate stop:** routing/security/secret/signature/data-loss or
  duplicate-normalization issue. Owner: engineering incident lead plus CRM
  owner; pause the wave immediately.
- **High, 15 minutes:** late after grace, incomplete, update required,
  unexpected revoke, storage/processing failure. Owner: operations with
  engineering or data support.
- **Medium, 30 minutes:** one VPS offline or not installed. Owner: VPS support;
  escalate to High if the capture window is at risk.
- **Info:** pending, expected, planned paused/revoked, received, weekend. Owner:
  daily operations reviewer.

Live pilot execution and Manager reconciliation are evidence tasks: record only
sanitized counts and ticket references. Do not mark them passed from unit tests.
