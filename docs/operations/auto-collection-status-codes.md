# Auto-collection operational status codes

The Manager fleet endpoint is the source of truth for the daily status. It uses
the server clock in `America/New_York`; workstation time and browser locale do
not affect the classification. The normal capture is 16:30 ET with a 30-minute
grace window.

| Status | Meaning | Severity | Owner and response target |
|---|---|---|---|
| `pending` | Weekday, before the configured capture time | Info | Operations checks again after schedule |
| `expected` | Scheduled time passed, still inside grace | Info | Operations waits until grace expires |
| `received` | Current trading-date batch reached a received/terminal state | Healthy | No action |
| `late` | No current batch after grace | High | VPS support starts triage within 15 minutes |
| `incomplete` | Batch lacks a required section/row or processing failed validation | High | Data operations reviews before closing the day |
| `offline` | No heartbeat within 10 minutes | Medium before schedule; High after | VPS support starts within 30 minutes; before 17:00 ET when possible |
| `failed` | Collector or ingest reported a stable operational failure | High; Critical for routing/security/data loss | Engineering within 15 minutes; stop rollout immediately if Critical |
| `revoked` | Device credential was intentionally invalidated | Info if planned; High if unexpected | CAM/Manager confirms replacement or manual fallback same day |
| `paused` | A non-active, non-revoked device is intentionally excluded | Info | Rollout owner records reason and resumption decision |
| `update_required` | Agent is older than the pinned release or reports update required | High | VPS support updates before the next capture; no downgrade |
| `not_installed` | Client has no paired VPS | Medium | CAM/Manager confirms whether the client is in scope within one business day |
| `not_expected` | Saturday or Sunday in New York | Info | No regular capture expected |

The fleet can also expose these safe diagnostic codes:

| Code family | Examples | Required action |
|---|---|---|
| NinjaTrader/AddOn | `ninjatrader_not_running`, `addon_unavailable`, `capture_timeout`, `capture_failed`, `contract_mismatch` | Restore NinjaTrader/AddOn, run a test capture, then allow the queued retry |
| Local queue/upload | `queue_capacity_warning`, `upload_failed`, `configuration_error` | Preserve queue, restore connectivity/configuration, never delete pending items |
| Contract | `unsupported_schema_version`, `invalid_auto_import_snapshot`, `normalization_failed`, `registry_load_failed`, `reconciliation_failed` | Keep the day open, retain the immutable batch, escalate to data/engineering |
| Persistence/storage | `storage_failed`, `persistence_failed`, `immutable_object_conflict`, `ingest_failed` | Engineering incident; do not replay until storage and lineage are understood |

Immediate rollout-stop conditions are any cross-client routing, credential or
secret exposure, unsigned/tampered binaries, missing acknowledged data, or
duplicate normalized records. Optional-field differences alone are not a stop
when the approved probe contract records them as optional.

## The seven-day strip in the setup window

The agent keeps a per-day record in `C:\ProgramData\Vincere\AutoExport\history.json`
and the setup window renders the last seven calendar days from it. A cell is only
called `Missed` when three things hold: the weekday is one of the configured
trading days, the day's cutoff has passed, and the agent has history reaching
back at least that far.

That last condition matters on a fresh install. A VPS paired on Friday has no
record of Monday through Thursday, and reporting those as missed would open the
window on a wall of red for days when nothing was installed to collect them. They
show as `NotTracked` instead.

**Known gap: market holidays.** Enabled trading days are weekdays, so a market
holiday that falls Monday to Friday — Thanksgiving, Independence Day — has no
capture and will be reported as `Missed`. The strip has no holiday calendar. Until
one exists, treat a single red cell on a known market holiday as expected. Adding
a holiday list to `AgentOptions` is the fix; it was left out rather than guessed
at, because a wrong calendar would suppress real misses.
