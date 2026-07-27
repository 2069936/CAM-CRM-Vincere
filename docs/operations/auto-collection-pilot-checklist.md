# Auto-collection shadow pilot checklist

This is a blank, redacted template. Store operational identities and approvals
in the private system referenced below; never add client data or credentials to
this repository.

| Field | Private value/reference |
|---|---|
| Pilot record | `________________` |
| Collector version | `________________` |
| Release-manifest SHA-256 | `________________` |
| Pilot start/end dates | `________________` |
| Expected device count | `2 / 3` |

## Authorization and selection

- [ ] Engineering owner, CRM owner, operations owner, and rollback owner are
      named in the private record.
- [ ] Every VPS has explicit maintenance authorization and a recoverable VM
      snapshot or equivalent rollback point.
- [ ] The set covers at least two providers/prop firms, all four populated
      sections, active strategies, and at least two algorithms.
- [ ] Each operator has practiced manual four-CSV export and knows the private
      escalation contact.
- [ ] Shadow mode is documented: no automatic close or silent replacement of a
      reviewed day.
- [ ] The exact signed version/hash passed the release-readiness checklist.

## Per-VPS installation record

Repeat this section in the private record for each opaque VPS reference.

Opaque VPS reference: `________________`

- [ ] Correct CRM Profile selected and fresh one-time code generated.
- [ ] Installer downloaded from Profile; manifest hash and signer verified.
- [ ] Correct NinjaTrader profile selected; foreign files remain untouched.
- [ ] Returned CRM client name independently confirmed before acceptance.
- [ ] NinjaTrader restarted and AddOn status available.
- [ ] Test capture reports Accounts, Strategies, Orders, and Executions.
- [ ] Manager shows heartbeat, expected signed version, 4:45 p.m. New York
      schedule, and one enrollment audit event.
- [ ] Manual fallback remains available.

## Three-day evidence

Record only sanitized report/ticket references here.

| Gate | Day 1 | Day 2 | Day 3 |
|---|---|---|---|
| Same client and capture minute | `_____` | `_____` | `_____` |
| Accounts required parity | `_____` | `_____` | `_____` |
| Strategies required parity | `_____` | `_____` | `_____` |
| Orders required parity | `_____` | `_____` | `_____` |
| Executions required parity | `_____` | `_____` | `_____` |
| Selected P&L and flags equivalent | `_____` | `_____` | `_____` |
| Scheduled capture within 15 minutes | `_____` | `_____` | `_____` |
| Daily audit reconciled with Manager | `_____` | `_____` | `_____` |

## Recovery and P&L exercises

- [ ] Controlled offline capture persisted locally and uploaded once after
      recovery.
- [ ] Service/NinjaTrader restart recovered without a duplicate batch or
      normalized row.
- [ ] Post-reset test preserved separate Realized and Gross values.
- [ ] When Realized was zero and Gross non-zero, metadata/audit recorded
      `gross_fallback`; no other case selected Gross incorrectly.
- [ ] Diagnostics ZIP contained no snapshot payload, token, enrollment code,
      product key, account ID, or raw P&L.

## Go/no-go

- [ ] Routing accuracy: 100%.
- [ ] Required-field availability: 100%.
- [ ] Lost/duplicate acknowledged captures: zero.
- [ ] Deliberately queued captures recovered: 100%.
- [ ] Reconciled P&L/totals/flags equivalent under documented normalization.
- [ ] Captures received within 15 minutes: at least 95%, all misses explained.
- [ ] High-severity security, signature, or data-loss findings: zero.
- [ ] Every incident has an owner, disposition, and sanitized reference.

| Decision/approval | Private reference |
|---|---|
| Decision | `GO / NO-GO` |
| Engineering | `________________` |
| CRM owner | `________________` |
| Operations | `________________` |

Any unchecked required/security item makes the decision **NO-GO**. Continue
manual export and return the finding to its owning implementation plan.
