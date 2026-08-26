import { useCallback, useState } from 'react';
import { Download, Printer } from 'lucide-react';
import { printWithTitle } from '../domain/reportPrint';
import { downloadReportPdf as defaultDownload } from '../domain/reportPdfDownload';

/**
 * The two buttons at the top of every report sheet.
 *
 * WHAT CHANGED AND WHY. There used to be one button, "Print / Save PDF", and it
 * opened the operating system's print dialog. The CAM closes eleven clients
 * every trading day; on 2026-08-24 every one of those eleven reports needed that
 * dialog, one at a time, and all eleven files landed in whichever folder the
 * dialog last pointed at and had to be redistributed by hand. The dialog is also
 * the one step in the close that nothing can automate — it is an OS window, so
 * no script and no agent can drive it. Download is now the action; the file
 * arrives named "<Client> - <date> daily report.pdf" in the browser's own
 * downloads folder, and whoever wants paper prints the downloaded file.
 *
 * PRINT IS DEMOTED, NOT REMOVED — see src/domain/reportPrint.js for the two
 * reasons. In short: download IS the print path (the server renders this same
 * DOM through the same `@media print` blocks), so the stylesheet needs a human
 * exercising it; and print is the only path that still works when the function
 * is down, which on this desk is eleven reports at the close.
 *
 * ORDER IS THE AFFORDANCE. Download is a `secondary-button` in first position
 * and Print is a `ghost-button` after it, which is the same weighting the rest of
 * this app uses for "the thing you meant" against "the thing you might need".
 *
 * The whole group sits inside `.report-actions.no-print`, so none of it reaches
 * the paper — printed or downloaded.
 */
export default function ReportSheetActions({
  title,
  sheetRef,
  download = defaultDownload,
  print = printWithTitle,
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const onDownload = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      await download({ sheet: sheetRef?.current, title });
    } catch (failure) {
      // Every message here names Print as the way out, because it is: this is
      // the one path that needs the network and the deployment.
      console.error('[CRM] Failed to download the report PDF:', failure);
      setError(failure?.message || 'Could not build the PDF. Use Print to save this one.');
    } finally {
      setBusy(false);
    }
  }, [download, sheetRef, title]);

  return (
    <>
      <button
        className="secondary-button"
        type="button"
        disabled={busy}
        onClick={onDownload}
        title="Download this report as a PDF, named for the client and the close"
      >
        <Download size={14} /> {busy ? 'Building PDF…' : 'Download PDF'}
      </button>
      <button
        className="ghost-button"
        type="button"
        onClick={() => print(title)}
        title="Open the print dialog instead. Same pages, and it works with no network."
      >
        <Printer size={14} /> Print
      </button>
      {/*
        Last, and on a row of its own — see .report-download-error in
        src/index.css. Rendered before the buttons it pushed Print and the close
        button onto a second row, which is a poor way to deliver a message whose
        text is "use Print".
      */}
      {error ? (
        <span className="remote-pill error report-download-error" role="status">{error}</span>
      ) : null}
    </>
  );
}
