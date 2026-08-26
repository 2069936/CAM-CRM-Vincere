import { useMemo, useState } from "react";
import { Download, LoaderCircle, TriangleAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { buildClientExportPlan, formatBytes, planExportBatches } from "../domain/clientExportPlan";

/**
 * Picks the scope and range for a CAM-scoped export, and shows what the
 * download will contain before it is asked for.
 *
 * The preview is the point. "All my clients, last month" is one click away from
 * ten thousand rows, and a CAM who only learns that from their downloads folder
 * will not use this twice. Everything shown here is computed from state the app
 * already holds — no request is made until Download is pressed.
 *
 * It is also where a pull too big for one response is split into parts. The
 * split is by measured bytes and it is shown BEFORE the download, because "this
 * arrives as three files" is a thing to agree to, not to discover.
 */

const DEFAULT_RANGE_DAYS = 30;

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function shiftDays(day, delta) {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + delta);
  return at.toISOString().slice(0, 10);
}

const TABLE_LABELS = {
  clients: "Clients",
  trading_accounts: "Accounts",
  daily_imports: "Sessions",
  account_snapshots: "Account closes",
  strategy_snapshots: "Strategy rows",
  operational_flags: "Flags",
  activity_logs: "Activity notes",
  orders: "Orders",
  executions: "Fills",
};

export default function ClientExportDialog({
  open,
  onOpenChange,
  clients = [],
  focusClientId = "",
  // The middle scope, and it only exists on the Manager's screen: the clients
  // of the CAM whose workspace is open. A CAM's own page passes neither, and
  // gets the two choices it always had — "all my clients" already IS this list
  // there, and offering it twice under two names would teach a reader that the
  // two are somehow different books.
  camClients = null,
  camName = "",
  // A Manager's client list is the whole book, not an assignment set, so "all"
  // has to be sent as ids. A CAM's list IS their assignment set, and sending no
  // ids lets the server read it from client_assignments — a stale browser list
  // then cannot widen or narrow what comes back.
  namedScopeForAll = false,
  maxRangeDays = 92,
  maxClients = 60,
  busy = false,
  progress = null,
  error = "",
  result = null,
  onExport,
}) {
  const today = isoToday();
  const [scopeChoice, setScopeChoice] = useState(null);
  const [from, setFrom] = useState(shiftDays(today, -(DEFAULT_RANGE_DAYS - 1)));
  const [to, setTo] = useState(today);
  const [includeTradeHistory, setIncludeTradeHistory] = useState(false);

  // The scope defaults to whichever button opened the dialog: the client
  // toolbar means "this client", the sidebar means "all my clients". Adjusted
  // during render rather than in an effect, so reopening for a different client
  // does not paint the previous choice first.
  const openedFor = `${open ? 1 : 0}|${focusClientId}`;
  const [lastOpenedFor, setLastOpenedFor] = useState(openedFor);
  if (lastOpenedFor !== openedFor) {
    setLastOpenedFor(openedFor);
    setScopeChoice(null);
  }

  const focusClient = clients.find((client) => client.id === focusClientId) || null;
  // Offered only when it is a different set from "everything". A Manager whose
  // desk has one CAM would otherwise see the same list twice.
  const camScopeClients = useMemo(() => camClients || [], [camClients]);
  const showCamScope = Boolean(camName) && camScopeClients.length > 0
    && camScopeClients.length !== clients.length;
  const scope = scopeChoice ?? (focusClientId ? "client" : "all");
  const setScope = setScopeChoice;

  const selected = useMemo(() => {
    if (scope === "client" && focusClient) return [focusClient];
    if (scope === "cam" && showCamScope) return camScopeClients;
    return clients;
  }, [scope, focusClient, showCamScope, camScopeClients, clients]);

  const plan = useMemo(
    () => buildClientExportPlan(selected, { from, to, includeTradeHistory }),
    [selected, from, to, includeTradeHistory],
  );

  const rangeDays = from && to && from <= to
    ? Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000) + 1
    : 0;
  const rangeInvalid = !from || !to || from > to;
  const rangeTooLong = rangeDays > maxRangeDays;

  // Planned whenever the estimate is over the ceiling, and only then: a pull
  // that fits stays one request and one file.
  const batchPlan = useMemo(
    () => (plan.exceedsResponseLimit && !rangeInvalid && !rangeTooLong
      ? planExportBatches(selected, { from, to, includeTradeHistory, maxClients })
      : null),
    [plan.exceedsResponseLimit, rangeInvalid, rangeTooLong, selected, from, to, includeTradeHistory, maxClients],
  );

  // A single request can carry no more clients than the server allows; a batched
  // one never plans a part over that number, so the cap can only bite here.
  const tooManyClients = !batchPlan && selected.length > maxClients;
  // The one thing that must never be downloadable: a set this dialog knows it
  // cannot deliver whole. Splitting does not help a client that is too big on
  // its own, and four good files plus one refusal is the silent truncation this
  // export exists to refuse.
  const undeliverable = Boolean(batchPlan && !batchPlan.deliverable);
  const blocked = rangeInvalid || rangeTooLong || tooManyClients || undeliverable || !selected.length;

  const rowLines = Object.entries(plan.rows)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);

  // One request when it fits, one per part when it does not. `batch` is a label
  // the server echoes into the file and the audit row so the parts can be told
  // apart; it selects nothing.
  //
  // A batched "all my clients" has to name its clients even for a CAM, because
  // a part is defined by which clients are in it and there is no other way to
  // say so. The server still authorises every named id against the assignment
  // table, so this widens nothing.
  function requestsForDownload() {
    if (!batchPlan) {
      return [{
        clientIds: scope === "client" && focusClient
          ? [focusClient.uuid || focusClient.id]
          : ((namedScopeForAll || scope === "cam") ? selected.map((entry) => entry.uuid || entry.id) : null),
        from,
        to,
        includeTradeHistory,
        batch: null,
      }];
    }
    return batchPlan.batches.map((part) => ({
      clientIds: part.clientIds,
      from,
      to,
      includeTradeHistory,
      batch: { index: part.index, of: part.of },
    }));
  }

  const downloaded = result?.payloads || [];

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent className="confirm-dialog export-dialog" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Export data for analysis</DialogTitle>
          <DialogDescription>
            Downloads the sessions, accounts, flags and per-day P&amp;L as JSON.
            Credentials and prop-firm logins are never included.
          </DialogDescription>
        </DialogHeader>

        <div className="export-dialog-body">
          <div className="export-dialog-field">
            <span className="export-dialog-label">Scope</span>
            <div className="export-dialog-choices">
              <label className={scope === "client" ? "is-active" : ""}>
                <input
                  type="radio"
                  name="client-export-scope"
                  checked={scope === "client"}
                  disabled={!focusClient}
                  onChange={() => setScope("client")}
                />
                {focusClient ? focusClient.name : "This client"}
              </label>
              {showCamScope ? (
                <label className={scope === "cam" ? "is-active" : ""}>
                  <input
                    type="radio"
                    name="client-export-scope"
                    checked={scope === "cam"}
                    onChange={() => setScope("cam")}
                  />
                  {camName}&apos;s clients ({camScopeClients.length})
                </label>
              ) : null}
              <label className={scope === "all" ? "is-active" : ""}>
                <input
                  type="radio"
                  name="client-export-scope"
                  checked={scope === "all"}
                  onChange={() => setScope("all")}
                />
                {showCamScope ? `Every client (${clients.length})` : `All my clients (${clients.length})`}
              </label>
            </div>
          </div>

          <div className="export-dialog-field">
            <span className="export-dialog-label">Range</span>
            <div className="export-dialog-dates">
              <input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} />
              <span className="muted">to</span>
              <input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} />
              <button
                type="button"
                className="link-button"
                onClick={() => { setTo(today); setFrom(shiftDays(today, -(DEFAULT_RANGE_DAYS - 1))); }}
              >
                Last {DEFAULT_RANGE_DAYS} days
              </button>
              <button
                type="button"
                className="link-button"
                onClick={() => { setTo(today); setFrom(shiftDays(today, -6)); }}
              >
                Last 7 days
              </button>
            </div>
          </div>

          <label className="export-dialog-toggle">
            <input
              type="checkbox"
              checked={includeTradeHistory}
              onChange={(event) => setIncludeTradeHistory(event.target.checked)}
            />
            <span>
              Include every order and fill
              <small className="muted">
                {plan.excludedTradeRows === null
                  ? "Roughly doubles the download."
                  : `Adds about ${plan.excludedTradeRows.toLocaleString()} rows. Per-day counts are included either way.`}
              </small>
            </span>
          </label>

          <div className="export-dialog-preview">
            <strong>
              {plan.sessions.toLocaleString()} session{plan.sessions === 1 ? "" : "s"} ·{" "}
              {plan.clientsWithSessions} of {plan.clients} client{plan.clients === 1 ? "" : "s"} traded ·{" "}
              ~{plan.totalRows.toLocaleString()} rows · ~{formatBytes(plan.estimatedDownloadBytes)} download
            </strong>
            <div className="export-dialog-rows">
              {rowLines.map(([table, count]) => (
                <span key={table}>
                  {TABLE_LABELS[table] || table} <b>{count.toLocaleString()}</b>
                </span>
              ))}
            </div>
            {plan.sessions === 0 ? (
              <p className="muted">
                No closes in this range. The export will still carry the client and
                account records, and will say so.
              </p>
            ) : null}
          </div>

          {rangeInvalid ? (
            <p className="export-dialog-warning"><TriangleAlert size={14} /> Pick a start date on or before the end date.</p>
          ) : null}
          {rangeTooLong ? (
            <p className="export-dialog-warning">
              <TriangleAlert size={14} /> {rangeDays} days is over the {maxRangeDays}-day limit. Export in parts.
            </p>
          ) : null}
          {tooManyClients ? (
            <p className="export-dialog-warning">
              <TriangleAlert size={14} /> {selected.length} clients is over the {maxClients}-client limit.
            </p>
          ) : null}

          {/* The split, stated before it happens. Sizes are estimates and the
              server measures the real payload, so the parts are planned to 80%
              of what one response can carry rather than to the brim. */}
          {batchPlan && batchPlan.deliverable ? (
            <div className="export-dialog-preview">
              <strong>
                Too big for one file. Arrives as {batchPlan.batchCount} parts of up to{" "}
                {formatBytes(batchPlan.budgetBytes + batchPlan.fixedBytes)} each.
              </strong>
              <div className="export-dialog-rows">
                {batchPlan.batches.map((part) => (
                  <span key={part.index}>
                    Part {part.index} <b>{part.clients.length} client{part.clients.length === 1 ? "" : "s"}</b>{" "}
                    ~{formatBytes(part.estimatedBytes)}
                  </span>
                ))}
              </div>
              <p className="muted">
                Each file says which part it is and which clients are in it. An
                analysis needs all {batchPlan.batchCount}.
              </p>
            </div>
          ) : null}

          {batchPlan && batchPlan.oversized.length ? (
            <p className="export-dialog-warning">
              <TriangleAlert size={14} />{" "}
              {batchPlan.oversized.length === 1
                ? `${batchPlan.oversized[0].name || "One client"} alone is about ${formatBytes(batchPlan.oversized[0].bytes)} over this range`
                : `${batchPlan.oversized.length} clients are each too big for one file over this range`}
              , so splitting the list cannot deliver it. Shorten the range
              {includeTradeHistory ? " or turn trade history off" : ""}.
            </p>
          ) : null}
          {batchPlan && batchPlan.tooManyBatches ? (
            <p className="export-dialog-warning">
              <TriangleAlert size={14} /> This would take {batchPlan.batchCount} parts, over the{" "}
              limit of {batchPlan.maxBatches ?? 200}. Shorten the range or export fewer clients at a time.
            </p>
          ) : null}
          {/* Estimated, so it warns rather than blocks — the server measures the
              real payload and is the one that refuses. Shown because the refusal
              costs a full round trip through every table otherwise. */}
          {plan.exceedsResponseLimit && !batchPlan && !blocked ? (
            <p className="export-dialog-warning">
              <TriangleAlert size={14} /> About {formatBytes(plan.estimatedBytes)} of data, over the{" "}
              {formatBytes(plan.maxResponseBytes)} one response can carry. Shorten the range
              {includeTradeHistory ? ", turn trade history off," : ""} or export fewer clients at a time.
            </p>
          ) : null}
          {error ? <p className="export-dialog-warning"><TriangleAlert size={14} /> {error}</p> : null}

          {/* What the server actually applied, not what was asked for. The
              range can differ from the form (a blank range takes the server
              default) and a truncated payload has to say so here, because
              nothing downstream will notice rows that never arrived. */}
          {downloaded.length ? (
            <div className="export-dialog-preview">
              <strong>
                Downloaded{" "}
                {downloaded.reduce((sum, payload) => sum + payload.totalRows, 0).toLocaleString()} rows for{" "}
                {downloaded.reduce((sum, payload) => sum + payload.scope.includedClientCount, 0)} client
                {downloaded.reduce((sum, payload) => sum + payload.scope.includedClientCount, 0) === 1 ? "" : "s"}
                {downloaded.length > 1 ? ` in ${downloaded.length} files` : ""}
              </strong>
              <div className="export-dialog-rows">
                <span>
                  Range <b>{downloaded[0].range.from} to {downloaded[0].range.to}</b>
                </span>
                <span>
                  Sessions{" "}
                  <b>
                    {downloaded
                      .reduce((sum, payload) => sum + (payload.rowCounts.daily_imports || 0), 0)
                      .toLocaleString()}
                  </b>
                </span>
                {downloaded.some((payload) => (
                  payload.scope.requestedClientCount !== payload.scope.includedClientCount
                )) ? (
                  <span>
                    Not found{" "}
                    <b>
                      {downloaded.reduce((sum, payload) => (
                        sum + payload.scope.requestedClientCount - payload.scope.includedClientCount
                      ), 0)}
                    </b>
                  </span>
                ) : null}
              </div>
              {/* A part that never arrived is the one thing a folder of files
                  cannot show on its own, so it is said here. */}
              {result?.expectedParts && downloaded.length < result.expectedParts ? (
                <p className="export-dialog-warning">
                  <TriangleAlert size={14} /> Only {downloaded.length} of {result.expectedParts} parts
                  downloaded. What you have is incomplete — do not read it as the whole range.
                </p>
              ) : null}
              {downloaded.some((payload) => payload.truncated) ? (
                <p className="export-dialog-warning">
                  <TriangleAlert size={14} /> Truncated:{" "}
                  {[...new Set(downloaded.flatMap((payload) => (
                    payload.truncation.map((entry) => entry.table)
                  )))].join(", ")}{" "}
                  hit the row ceiling. Export a shorter range before reading these as complete.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter className="confirm-dialog-footer">
          <button className="ghost-button" type="button" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={busy || blocked}
            onClick={() => onExport(requestsForDownload())}
          >
            {busy ? <LoaderCircle className="spin" size={14} /> : <Download size={15} />}
            {busy
              ? (progress && progress.total > 1
                ? `Exporting part ${progress.done + 1} of ${progress.total}...`
                : "Exporting...")
              : (batchPlan && batchPlan.deliverable
                ? `Download ${batchPlan.batchCount} files`
                : "Download JSON")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
