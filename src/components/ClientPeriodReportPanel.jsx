import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import {
  MAX_CUSTOM_DAYS,
  WINDOW_KINDS,
  WINDOW_LABELS,
  buildClientPeriodReport,
  closesNeedingDetail,
  dayLabel,
  defaultAnchor,
  resolveClientPeriodWindow,
  shiftAnchor,
} from '../domain/clientPeriodReport';
import { todayIsoDate } from '../domain/crmStateStore';
import PanelLoadState from './PanelLoadState';
import ReportSheetActions from './ReportSheetActions';
import ClientPeriodReportSheet from './ClientPeriodReportSheet';

/**
 * The client period report, as an overlay over the client workspace.
 *
 * One piece of state, the window, and everything else derived. The sheet below
 * is the `.report-sheet` the PDF is made from, exactly like the daily report:
 * ReportSheetActions posts its outerHTML to /api/report/pdf, and the controls
 * sit in `.report-actions.no-print`, so none of them reaches the paper.
 *
 * THE REPORT FETCHES ITS OWN ROWS, the way DeskPeriodReportView does. A login
 * holds each client's latest close account by account and every older close
 * with `snapshots: []`, and no close's fills. Built over those, the report
 * would print a week of zeros. So the panel asks for every close in the window
 * and the close before it (`closesNeedingDetail`) through `onNeedCloseRows`,
 * keys the load state per window so a newly chosen window never inherits the
 * previous one's `loaded`, and prints no figure and offers no download until
 * the rows are here. A failed load says why and offers Try again. Whatever is
 * still missing afterwards is named on the sheet as missing, never as zero.
 */
export default function ClientPeriodReportPanel({
  client,
  selectedDate = '',
  // A date the window must contain, as given. The client overview's month
  // strip passes the first of the month it is showing; without it the window
  // is built around `selectedDate`, or the latest close (`defaultAnchor`).
  anchorDate = '',
  initialKind = 'week',
  accountManager = '',
  // App.jsx `ensureCloseDetailFor`: fetches named closes' account rows,
  // strategy rows and fills into state, deduplicated against what this session
  // already holds or has asked for. Null in a local snapshot or a test, where
  // every close already holds its rows.
  onNeedCloseRows = null,
  // App.jsx `panelLoadFor`: the state of a fetch, by the key it was asked under.
  closeRowsLoadFor = null,
  onClose = null,
  // Injected by tests; the app passes neither.
  asOf = '',
  now = null,
}) {
  const sheetRef = useRef(null);
  const [kind, setKind] = useState(WINDOW_KINDS.includes(initialKind) ? initialKind : 'week');
  const [anchor, setAnchor] = useState(() => anchorDate || defaultAnchor(client, selectedDate));
  const [custom, setCustom] = useState({ from: '', to: '' });

  const period = useMemo(
    () => resolveClientPeriodWindow(client, { kind, anchor, from: custom.from, to: custom.to }),
    [client, kind, anchor, custom.from, custom.to],
  );

  const neededIds = useMemo(() => closesNeedingDetail(client, period), [client, period]);
  const neededKey = neededIds.join(',');
  // One load state per client and window. A single key would hand a newly
  // chosen window the previous one's `loaded` for the render before its own
  // fetch starts, and the sheet would print that render's zeros.
  const rowsKey = `client-period-report:${client?.id || ''}:${period.from}:${period.to}`;
  const closeRowsLoad = closeRowsLoadFor ? closeRowsLoadFor(rowsKey) : null;
  const requestRows = useCallback(() => (
    onNeedCloseRows && neededIds.length
      ? onNeedCloseRows(rowsKey, neededIds, { withAccountRows: true, withFills: true })
      : undefined
    // neededKey stands for neededIds: a new array with the same ids must not
    // fetch again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [onNeedCloseRows, neededKey, rowsKey]);
  useEffect(() => {
    const pending = requestRows();
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  }, [requestRows]);

  const rowsLoad = onNeedCloseRows && neededIds.length
    ? {
      status: closeRowsLoad?.status || 'loading',
      error: closeRowsLoad?.error || '',
      waiting: `Loading the account figures and fills of ${neededIds.length} close${neededIds.length === 1 ? '' : 's'} `
        + 'for this report. Nothing is shown until they arrive.',
      onRetry: requestRows,
    }
    : null;
  /* NOTHING IS PRINTED OR DOWNLOADED OVER ROWS THAT HAVE NOT ARRIVED. While
   * they are on their way, or failed to come, the window control stays and the
   * report does not render, so no PDF can be taken from partial data. */
  const blocked = Boolean(rowsLoad) && rowsLoad.status !== 'loaded';

  const today = asOf || todayIsoDate();
  const report = useMemo(
    () => (blocked ? null : buildClientPeriodReport(client, {
      window: period,
      asOf: today,
      builtAt: (now || new Date()).toISOString(),
      accountManager,
    })),
    [blocked, client, period, today, now, accountManager],
  );

  const pdfTitle = `${client?.name || 'Client'} - ${period.from} to ${period.to} period report`;

  const chooseKind = (next) => {
    if (next === 'custom' && kind !== 'custom') setCustom({ from: period.from, to: period.to });
    setKind(next);
  };

  return (
    <div
      className="report-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      <div className="report-sheet client-period-report" ref={sheetRef}>
        <div className="report-actions no-print cpr-actions">
          <div className="cpr-controls">
            <div className="cpr-segmented" role="group" aria-label="Report window">
              {WINDOW_KINDS.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={kind === value}
                  onClick={() => chooseKind(value)}
                >
                  {WINDOW_LABELS[value]}
                </button>
              ))}
            </div>
            {kind === 'custom' ? (
              <>
                <label className="cpr-field">
                  <span>From</span>
                  <input
                    type="date"
                    value={custom.from}
                    onChange={(event) => setCustom((current) => ({ ...current, from: event.target.value }))}
                  />
                </label>
                <label className="cpr-field">
                  <span>To</span>
                  <input
                    type="date"
                    value={custom.to}
                    onChange={(event) => setCustom((current) => ({ ...current, to: event.target.value }))}
                  />
                </label>
                <span className="cpr-control-note">{`Up to ${MAX_CUSTOM_DAYS} days.`}</span>
              </>
            ) : (
              <span className="cpr-stepper">
                <button
                  type="button"
                  className="ghost-button icon-only"
                  title="Earlier period"
                  aria-label="Earlier period"
                  onClick={() => setAnchor(shiftAnchor(period, -1))}
                >
                  <ChevronLeft size={15} />
                </button>
                <span className="cpr-window-label">{`${dayLabel(period.from)} to ${dayLabel(period.to, { year: true })}`}</span>
                <button
                  type="button"
                  className="ghost-button icon-only"
                  title="Later period"
                  aria-label="Later period"
                  onClick={() => setAnchor(shiftAnchor(period, 1))}
                >
                  <ChevronRight size={15} />
                </button>
              </span>
            )}
          </div>
          {report ? <ReportSheetActions title={pdfTitle} sheetRef={sheetRef} /> : null}
          <button
            className="report-close-button"
            type="button"
            onClick={() => onClose?.()}
            aria-label="Close report"
            title="Close report"
          >
            <X size={18} />
          </button>
        </div>

        {blocked ? (
          <div className="cpr-loading">
            <PanelLoadState
              load={{ status: rowsLoad.status, error: rowsLoad.error }}
              waiting={rowsLoad.waiting}
              onRetry={rowsLoad.onRetry}
            />
          </div>
        ) : (
          <ClientPeriodReportSheet report={report} />
        )}
      </div>
    </div>
  );
}
