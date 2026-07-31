# Auto-collection shadow pilot

Status: **template ready; no pilot is approved or running from this document**.

The pilot proves that the signed collector can operate beside the existing
four-CSV process without changing a reviewed day automatically. It uses two or
three representative CAM-controlled client VPSs and retains manual export as
the fallback until all acceptance thresholds pass.

## Selection rules

Select the smallest set that covers all of these conditions:

- two or three VPSs with explicit maintenance authorization;
- at least two NinjaTrader connection providers or prop firms;
- populated Accounts, Strategies, Orders, and current-session Executions;
- at least two active strategy algorithms across the group;
- an operator who can perform the same-minute manual export and rollback; and
- no VPS whose loss during the test would exceed the same-day rollback capacity.

Client names, account IDs, VPS addresses, employees, credentials, and contact
details belong only in the approved private operational system. The public
checklist records opaque private ticket references and aggregate results.

## Shadow-mode boundary

Automatic captures are stored, normalized, reconciled, and displayed in
Manager history. During the pilot they must not silently close a day, replace a
reviewed manual import, or resolve flags. A Manager must perform any closed-day
replacement through the explicit confirmation workflow.

Every comparison uses the same New York trading date and capture minute. At the
configured automatic capture, the operator immediately exports Accounts,
Strategies, Orders, and Executions manually. The sanitized comparator in
`scripts/compare-auto-and-manual-imports.mjs` evaluates section rows, selected
P&L, and reconciled flags without writing to the CRM.

## Four-step employee flow

1. In the client's CRM Profile, generate a fresh one-time setup code and
   download the pinned signed installer.
2. Run the installer, select the one intended NinjaTrader profile if asked, and
   enter only the setup code. No product key or database credential is needed.
3. Confirm that the returned CRM client name is correct, restart NinjaTrader,
   and wait for the AddOn status to become available.
4. Run **Test capture**, confirm all four sections and a green heartbeat in
   Manager, then leave the default 4:45 p.m. `America/New_York` schedule active.

The operator must also know where **Create support diagnostics** is, how to use
the manual four-CSV fallback, and which private support contact owns rollback.

## Pilot sequence

1. Complete the blank pilot checklist and obtain engineering, CRM-owner, and
   operations approval.
2. Record the Windows/NinjaTrader versions privately, back up only prior
   Vincere-owned configuration, and create a recoverable VM snapshot.
3. Install one VPS at a time. Verify pairing, client identity, AddOn test,
   heartbeat, enrollment audit event, signed version, and schedule before the
   next VPS.
4. Run at least three consecutive trading days of same-minute shadow
   comparison for every pilot VPS.
5. During the approved window, exercise one network outage and one
   service/NinjaTrader restart. Confirm the queued capture arrives once and
   produces no duplicate normalized rows.
6. On a noncritical test account, capture after the daily reset. Confirm the CRM
   selects Gross only when Realized is zero and Gross is non-zero and records
   `pnlSource=gross_fallback` in batch metadata/audit.
7. Run the read-only daily audit after 17:00 ET and reconcile its counts with
   Manager. Resolve every unexplained late or incomplete item the same day.

## Acceptance and stop rules

Pilot acceptance requires 100% routing accuracy, 100% required-field
availability, no lost or duplicate acknowledged capture, equivalent reconciled
P&L and flags, full recovery of deliberately queued items, no high-severity
security finding, and at least 95% of scheduled captures received within 15
minutes with every miss explained.

Stop immediately on cross-client routing, token/secret exposure, unsigned or
tampered artifacts, missing required data, duplicate normalized rows,
systematic P&L mismatch, or possible data loss. Pause new enrollment, revoke
only affected devices, preserve queue/raw/audit evidence, restore the previous
approved package or uninstall Vincere components, and use the manual four-CSV
workflow. Failed required/security criteria cannot be waived.
