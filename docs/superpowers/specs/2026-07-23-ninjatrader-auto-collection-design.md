# NinjaTrader Auto-Collection Design

**Date:** 2026-07-23  
**Status:** Approved design  
**Target:** CAM CRM plus a Windows collector installed on each client VPS

## 1. Objective

Automate the daily collection of the NinjaTrader data currently exported by hand
from the Accounts, Strategies, Orders, and Executions grids. Each client runs
NinjaTrader on a dedicated Windows VPS. The collector must capture the same
operational data without interacting with NinjaTrader menus or Save dialogs and
upload it to the CRM before the session values reset at 5:00 p.m. New York time.

The collector is responsible only for acquiring and delivering data. The CRM
remains responsible for normalization, reconciliation, flags, CAM review, daily
close, and report generation.

## 2. Scope

### In scope

- A NinjaScript/C# AddOn that reads the four live NinjaTrader datasets.
- A separate Windows background agent with a small configuration interface.
- Configurable scheduling in the `America/New_York` time zone, defaulting to
  4:45 p.m. on enabled trading days.
- Local durable queuing and automatic upload retries.
- Client identification through the existing per-client product key and VPS
  device binding.
- A server ingest endpoint that stores the immutable source snapshot and routes
  it through the CRM's existing daily-import processing.
- Import history, operational status, audit events, and download tools in the
  Manager experience.
- JSON and reconstructed four-CSV downloads for historical investigation.
- A staged rollout that first proves access to every required NinjaTrader field
  on a real VPS.

### Out of scope

- Evaluating whether balances, P&L, strategies, orders, or executions are
  operationally correct inside the collector.
- Resolving flags, closing days, or generating reports on the VPS.
- Authenticating the collector as a CAM or exposing CRM user credentials to it.
- Pixel hunting, screen-coordinate automation, or Save-dialog automation as the
  primary collection mechanism.
- Historical executions that NinjaTrader no longer exposes to the current
  session. Existing log backfill remains a separate historical-data path.

## 3. Existing Foundation and Gap

The CRM already contains `resolveClientForIngest`, which resolves a product key
to a client and binds the first successful upload to a Windows machine ID. The
`step_22_ingest_devices.sql` migration defines the corresponding device table.

The reviewed `ItsJuanBlanco/Auto-Export` repository contains a draft
`api/import/daily.js` receiver, but it does not contain the promised NinjaTrader
AddOn, Python watcher, or Windows executable. The draft endpoint also duplicates
normalization and persistence logic rather than using the current CRM pipeline.
It is reference material, not a production-ready implementation.

## 4. Selected Architecture

The selected approach is a **NinjaScript AddOn plus a separate Windows agent**.

### 4.1 NinjaTrader AddOn

The C# AddOn runs inside NinjaTrader and has one responsibility: return a
point-in-time snapshot of Accounts, Strategies, Orders, and Executions using
NinjaTrader's supported in-process objects. It has no CRM credentials, no CAM
login, no scheduling policy, and no remote network responsibility.

The AddOn exposes a local-only request channel to the Windows agent. A named
pipe is preferred because it is restricted to the local machine and does not
require an open TCP port or firewall rule. The AddOn returns the snapshot as a
versioned JSON document.

### 4.2 Windows Agent

The agent is installed on each client VPS and consists of:

- a Windows Service that schedules captures, communicates with the AddOn,
  persists the queue, and uploads snapshots; and
- a small configuration/status application for setup and troubleshooting.

The service continues running when no employee has an interactive desktop
session. The interface allows an authorized operator to configure the product
key, schedule, enabled days, and to run a manual capture.

### 4.3 CRM Ingest Service

The CRM endpoint authenticates the product key and machine ID, validates the
payload structure, records an immutable ingest batch, stores the compressed raw
snapshot, and passes normalized data into the same reconciliation and
persistence path used by manual CSV uploads.

The endpoint must not reproduce a second, divergent implementation of daily
import business rules.

## 5. Identity and Security

### 5.1 Client matching

The product key is the authoritative ingest identity. IP addresses, client
names, filenames, and NinjaTrader account names are not used to select the CRM
client.

On first pairing:

1. The operator enters the client's product key in the agent.
2. The agent obtains the Windows `MachineGuid` and sends both values over HTTPS.
3. The CRM resolves the product key to exactly one active client.
4. The CRM binds that key to the machine and returns the client display name.
5. The agent shows the resolved client so the operator can confirm the pairing.

Every account contained in a valid snapshot is routed under the client resolved
from the product key. Account names continue to identify accounts within that
client.

### 5.2 Invalid or moved devices

- An unknown product key is rejected. The raw trading payload is not placed in
  an unassigned pool; only a security-safe failed-attempt audit record is kept.
- The agent retains the snapshot locally and can retry after configuration is
  corrected.
- A known key presented by a different machine is rejected until a Manager
  explicitly authorizes device replacement or resets the binding.
- Device `last_seen_at`, agent version, and last successful capture are updated
  after authenticated requests.

### 5.3 Secret handling

- All remote communication uses HTTPS.
- The product key is protected at rest with Windows DPAPI or Windows Credential
  Manager and is never stored in a plain-text configuration file.
- The agent never receives the Supabase service-role key, database credentials,
  or a CAM session.
- Server logs and error messages must redact product keys.

## 6. Schedule and Capture

Scheduling is controlled by the Windows agent, not the AddOn.

- Time zone: `America/New_York`, including daylight-saving transitions.
- Default time: 4:45 p.m.
- The operator can change the time and enabled trading days.
- `Run now` triggers the same collection path as the scheduler.
- If NinjaTrader or the AddOn is unavailable, the agent retries every two
  minutes until 5:00 p.m. and reports the missed collection if no attempt works.
- Upload retries can continue after 5:00 p.m. because the captured snapshot is
  already durable on disk.

The AddOn captures the four datasets in one request and records one common
`capturedAt` value. This prevents the four sections from representing unrelated
moments.

## 7. Snapshot Contract

The transport format is one JSON document containing four independent arrays,
not one flattened table.

```json
{
  "schemaVersion": 1,
  "captureId": "uuid-generated-on-the-vps",
  "capturedAt": "2026-07-23T16:45:00-04:00",
  "tradingDate": "2026-07-23",
  "timeZone": "America/New_York",
  "source": {
    "machineId": "windows-machine-guid",
    "agentVersion": "1.0.0",
    "addonVersion": "1.0.0",
    "ninjaTraderVersion": "8.x"
  },
  "accounts": [],
  "strategies": [],
  "orders": [],
  "executions": []
}
```

### 7.1 Accounts fields

The collector attempts to provide at least:

- connection status and connection name;
- account name and display name;
- cash value;
- Realized PnL after commissions;
- Gross Realized PnL before commissions;
- Unrealized PnL;
- Weekly PnL; and
- trailing max drawdown.

Realized and Gross Realized PnL remain separate source fields. The CRM applies
its approved rule: use non-zero Realized PnL, otherwise fall back to Gross
Realized PnL.

### 7.2 Strategies fields

The collector attempts to provide account, strategy name, instrument, data
series, complete parameters, state/enabled status, connection, Realized PnL,
and Unrealized PnL.

### 7.3 Orders fields

The collector attempts to provide the fields consumed by the current importer,
including account, external order ID, instrument, action, type, quantity, limit,
stop, state, filled, average price, remaining, name, strategy, OCO, TIF, and
timestamp.

### 7.4 Executions fields

The collector attempts to provide account, execution ID, order ID, instrument,
action, quantity, price, timestamp, entry/exit classification, position, name,
commission, rate, and connection.

### 7.5 Structural validation

The collector and server validate only transport integrity:

- supported schema version;
- unique and valid capture ID;
- valid capture timestamp and New York trading date;
- presence of all four arrays;
- at least one account row; and
- presence of required identity fields on retained rows.

They do not decide whether a value, strategy, trade, or account is correct.

## 8. Local Queue

The agent writes the completed snapshot atomically before attempting upload. A
representative layout is:

```text
C:\ProgramData\Vincere\AutoExport\
  Queue\
  Sent\
  Quarantine\
  Logs\
```

A local filename may contain the timestamp and a shortened capture ID, for
example `2026-07-23_16-45-00_a8f3c21b.json`. The filename is for local operator
convenience only and is not trusted for routing.

- Network and server failures remain in `Queue` and retry with bounded
  exponential backoff.
- A successful, acknowledged upload moves the snapshot to `Sent`.
- Unsupported or malformed snapshots move to `Quarantine` with an actionable
  error.
- The service never deletes the only local copy before server acknowledgement.
- Local retention is configurable; the initial policy retains recent sent
  snapshots long enough for operational recovery while the server remains the
  long-term system of record.

## 9. Server Storage and Processing

### 9.1 Ingest metadata

A new `ingest_batches` table records:

- capture ID with a unique constraint;
- client and ingest device IDs;
- trading date and captured timestamp;
- received and processed timestamps;
- schema, agent, AddOn, and NinjaTrader versions;
- row counts for all four sections;
- status (`received`, `processed`, `incomplete`, `failed`, or `late`);
- source object path;
- error summary; and
- the daily import/version it produced.

The unique capture ID makes retries idempotent. Repeating a confirmed capture
returns the original success result instead of inserting duplicate data.

### 9.2 Raw source storage

The immutable JSON is compressed and stored in a private Supabase Storage
bucket. A representative object key is:

```text
auto-imports/{client_id}/{trading_date}/{capture_id}/snapshot.json.gz
```

Large raw payloads are not stored in `audit_logs` and are not exposed through a
public bucket.

### 9.3 Daily import behavior

- A valid snapshot is automatically processed into the CRM as an open or
  pending-review daily close.
- Normalization and reconciliation use the shared CRM domain pipeline.
- The CRM, not the collector, creates operational flags.
- A later snapshot for the same open day creates a new source version and may
  become the active version without destroying earlier raw evidence.
- If the CAM has already closed the day, a late snapshot is stored and logged
  but does not silently replace the closed result. A Manager must authorize a
  reopen or replacement.

## 10. Manager Experience

### 10.1 Auto-collection health

Manager receives a compact operational view with:

- expected and received captures for the current trading day;
- pending, incomplete, late, and failed imports;
- VPS devices that have not checked in;
- last capture and upload per client;
- installed agent/AddOn versions; and
- access to retry, rebind, and manual recovery information.

### 10.2 Audit Logs integration

Audit Logs records lightweight events such as pairing, upload received,
processing completed, retry exhausted, device rejected, version replaced, and
late arrival. An event links to its `ingest_batch` detail rather than embedding
the full payload.

### 10.3 Historical download

From ingest history, a Manager can download:

- the original versioned JSON snapshot; or
- a generated ZIP containing `accounts.csv`, `strategies.csv`, `orders.csv`,
  `executions.csv`, and a `manifest.json`.

Generated names include the client and trading date for human use, but routing
continues to rely only on server IDs. The four CSVs reproduce the source fields
and are intended for inspection, not as pixel-identical copies of NinjaTrader's
grid layout.

## 11. Scalability

At 200 clients and one daily snapshot per client, the system receives about
1,000 snapshots per five-day week. This is modest for an HTTP ingest service,
Supabase Storage, and indexed metadata tables.

Scalability protections include:

- one compressed source object per capture;
- metadata indexes on client, trading date, status, and received timestamp;
- idempotent capture IDs;
- asynchronous or bounded processing so concurrent 4:45 p.m. uploads do not
  require long-running request handlers;
- pagination in Manager history and Audit Logs; and
- retention rules for verbose server and local diagnostic logs.

Filenames are not required to be globally unique because object paths contain
the client ID and capture UUID.

## 12. Error Handling

- **NinjaTrader unavailable:** retry collection until the configured cutoff and
  show a missed-capture state.
- **AddOn unavailable:** report the failed local channel and keep retrying.
- **Internet unavailable:** retain the snapshot and retry upload later.
- **Invalid product key:** reject, redact the key in logs, and retain the local
  snapshot for corrected configuration.
- **Machine mismatch:** reject and require Manager rebind approval.
- **Duplicate request:** return the existing batch result.
- **Partial payload:** preserve and label it incomplete; the CRM decides how it
  affects review.
- **Unsupported schema:** quarantine without processing.
- **Persistence failure:** do not acknowledge success; preserve raw evidence and
  allow idempotent retry.
- **Late arrival after close:** store and audit, but do not overwrite the closed
  day automatically.

## 13. Verification Strategy

### 13.1 Collector probe

The first implementation milestone is a diagnostic AddOn installed on one real
VPS. It must enumerate and serialize the required fields, with special attention
to strategy parameters, trailing max drawdown, both Realized PnL values, and
current-session executions. Any field not available through supported AddOn APIs
must be documented before choosing a fallback.

### 13.2 Automated tests

- Snapshot contract and field serialization tests.
- New York scheduling and daylight-saving tests.
- Atomic queue-write and crash-recovery tests.
- Retry, duplicate, invalid-key, and machine-mismatch tests.
- Server structural validation and idempotency tests.
- Normalization parity tests comparing AddOn JSON with existing CSV fixtures.
- Open-day replacement and closed-day late-arrival tests.
- Raw JSON and reconstructed CSV download tests.

### 13.3 Operational comparison

During the pilot, employees continue the manual export for the same clients.
Automatic and manual results are compared field by field for several trading
days before the manual process is retired.

## 14. Rollout

1. Build and validate the collector probe on one VPS.
2. Complete the agent, server endpoint, storage, and Manager status surfaces.
3. Pilot end to end on two or three clients.
4. Run automatic and manual collection in parallel for several days.
5. Resolve field or timing differences found during comparison.
6. Deploy in groups of 10–20 VPSs.
7. Monitor missing captures, device health, version adoption, and late uploads.
8. Retire manual daily export after the automatic path meets the agreed success
   criteria across the fleet.

## 15. Success Criteria

- A configured VPS captures at the scheduled New York time without an active
  remote desktop session.
- The four required datasets arrive under the correct CRM client without using
  filenames, IP addresses, or CAM credentials for routing.
- Network interruption does not lose a captured close.
- Repeated uploads do not create duplicate daily data.
- The CRM automatically opens the imported day and retains its existing review,
  flags, close, and reporting workflow.
- Managers can audit every capture and download either its raw JSON or a
  reconstructed four-CSV package.
- Automatic snapshots match the corresponding manual exports during the pilot
  for every required field exposed by NinjaTrader.

