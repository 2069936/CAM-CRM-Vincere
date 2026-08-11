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
import { buildClientExportPlan, formatBytes } from "../domain/clientExportPlan";

/**
 * Picks the scope and range for a CAM-scoped export, and shows what the
 * download will contain before it is asked for.
 *
 * The preview is the point. "All my clients, last month" is one click away from
 * ten thousand rows, and a CAM who only learns that from their downloads folder
 * will not use this twice. Everything shown here is computed from state the app
 * already holds — no request is made until Download is pressed.
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
  // A Manager's client list is the whole book, not an assignment set, so "all"
  // has to be sent as ids. A CAM's list IS their assignment set, and sending no
  // ids lets the server read it from client_assignments — a stale browser list
  // then cannot widen or narrow what comes back.
  namedScopeForAll = false,
  maxRangeDays = 92,
  maxClients = 60,
  busy = false,
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
  const scope = scopeChoice ?? (focusClientId ? "client" : "all");
  const setScope = setScopeChoice;

  const focusClient = clients.find((client) => client.id === focusClientId) || null;
  const selected = useMemo(
    () => (scope === "client" && focusClient ? [focusClient] : clients),
    [scope, focusClient, clients],
  );

  const plan = useMemo(
    () => buildClientExportPlan(selected, { from, to, includeTradeHistory }),
    [selected, from, to, includeTradeHistory],
  );

  const rangeDays = from && to && from <= to
    ? Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000) + 1
    : 0;
  const rangeInvalid = !from || !to || from > to;
  const rangeTooLong = rangeDays > maxRangeDays;
  const tooManyClients = selected.length > maxClients;
  const blocked = rangeInvalid || rangeTooLong || tooManyClients || !selected.length;

  const rowLines = Object.entries(plan.rows)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);

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
              <label className={scope === "all" ? "is-active" : ""}>
                <input
                  type="radio"
                  name="client-export-scope"
                  checked={scope === "all"}
                  onChange={() => setScope("all")}
                />
                All my clients ({clients.length})
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
          {/* Estimated, so it warns rather than blocks — the server measures the
              real payload and is the one that refuses. Shown because the refusal
              costs a full round trip through every table otherwise. */}
          {plan.exceedsResponseLimit && !blocked ? (
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
          {result ? (
            <div className="export-dialog-preview">
              <strong>
                Downloaded {result.totalRows.toLocaleString()} rows for{" "}
                {result.scope.includedClientCount} client
                {result.scope.includedClientCount === 1 ? "" : "s"}
              </strong>
              <div className="export-dialog-rows">
                <span>
                  Range <b>{result.range.from} to {result.range.to}</b>
                </span>
                <span>
                  Sessions <b>{(result.rowCounts.daily_imports || 0).toLocaleString()}</b>
                </span>
                {result.scope.requestedClientCount !== result.scope.includedClientCount ? (
                  <span>
                    Not found <b>{result.scope.requestedClientCount - result.scope.includedClientCount}</b>
                  </span>
                ) : null}
              </div>
              {result.truncated ? (
                <p className="export-dialog-warning">
                  <TriangleAlert size={14} /> Truncated:{" "}
                  {result.truncation.map((entry) => entry.table).join(", ")} hit the row
                  ceiling. Export a shorter range before reading these as complete.
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
            onClick={() => onExport({
              clientIds: scope === "client" && focusClient
                ? [focusClient.uuid || focusClient.id]
                : (namedScopeForAll ? selected.map((entry) => entry.uuid || entry.id) : null),
              from,
              to,
              includeTradeHistory,
            })}
          >
            {busy ? <LoaderCircle className="spin" size={14} /> : <Download size={15} />}
            {busy ? "Exporting..." : "Download JSON"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
