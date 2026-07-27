# Auto-collection production rollout evidence

Status: **evidence template only; production rollout has not been proven**.

This file receives sanitized aggregate evidence after each controlled wave. It
must never contain client names, VPS addresses, account IDs, P&L values,
product keys, enrollment codes, device tokens, credentials, raw snapshots, or
private contact details. Operational identities and individual dispositions
remain in the referenced private wave record.

## Evidence contract

Every recorded wave binds to one immutable collector version, public source
commit, private build snapshot, release-manifest hash, signer thumbprint
reference, and workflow/system-test evidence. A version cannot span changed
bits. A wave is not accepted merely because every installer completed.

Required aggregate evidence includes:

- expected, enrolled, heartbeat-visible, received, incomplete, late, offline,
  failed, revoked, and update-required device counts;
- unique accepted batch/raw-object/normalized-day counts and duplicate retries;
- routing mismatch, required-field mismatch, P&L mismatch, and data-loss counts;
- gross-fallback selection count without account identifiers or values;
- daily-audit/Manager reconciliation result;
- support event count by severity and final disposition; and
- explicit go/no-go references from engineering, CRM owner, and operations.

## Frozen releases

| Wave | Version | Source commit | Manifest hash reference | Signed/system gate | Result |
|---|---|---|---|---|---|
| 0 | `pending` | `pending` | `pending` | `pending` | `pending` |
| 1 | `pending` | `pending` | `pending` | `pending` | `pending` |

## Wave records

Copy this section for each completed wave.

### Wave `_____`

| Field | Sanitized value/reference |
|---|---|
| Private wave record | `________________` |
| Version and release dates | `________________` |
| Planned / enrolled devices | `_____ / _____` |
| Successful trading-day hold | `_____ days` |

| Gate | Aggregate result |
|---|---:|
| Client/device routing mismatches | `_____` |
| Missing required fields | `_____` |
| Lost acknowledged captures | `_____` |
| Duplicate normalized rows/days | `_____` |
| Immutable raw object mismatches | `_____` |
| Unexplained late/incomplete devices | `_____` |
| Scheduled captures within 15 minutes | `_____%` |
| Deliberately queued captures recovered | `_____%` |
| P&L/flag comparison mismatches | `_____` |
| High/critical security findings | `_____` |
| Daily audit matched Manager | `yes / no` |

| Decision evidence | Sanitized value/reference |
|---|---|
| Incidents by severity/disposition | `________________` |
| Decision | `EXPAND / HOLD / ROLLBACK` |
| Approvals | `________________` |

## Final fleet acceptance

Do not complete this section until every rollout completion gate has direct
evidence.

- [ ] Staging E2E and 200-device load checks passed without routing or
      duplication errors.
- [ ] Three-day shadow pilot passed required fields, P&L, reliability, and
      security thresholds.
- [ ] Every wave used an immutable signed version/hash and held for at least two
      successful trading days.
- [ ] Expected-versus-received monitoring and the daily owner routine are live.
- [ ] Replay, closed-day replacement, revoke/rebind, rollback, repair,
      uninstall, and manual fallback were rehearsed.
- [ ] Support staff can use redacted diagnostics without developer/database
      credentials.
- [ ] Full CRM and Windows gates passed on the exact production artifact.
- [ ] The observation period retaining manual upload is approved and recorded.

| Final decision | Private approval record |
|---|---|
| `NOT EVALUATED / ACCEPTED / REJECTED` | `________________` |
