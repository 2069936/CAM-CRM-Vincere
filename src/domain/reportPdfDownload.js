import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';
import { reportPdfFileName } from './reportFileName';

/**
 * The download half of "click and it downloads".
 *
 * It sends the report sheet that is ON SCREEN — `outerHTML` of the live
 * `.report-sheet` — to /api/report/pdf, which renders it in a headless Chrome
 * against this build's own stylesheet and sends back the same paper
 * window.print() would have produced. Nothing about what the client is allowed
 * to see is decided here: `.report-actions`, the note editor and the design
 * drawer all travel up inside that markup and are removed at the far end by the
 * same `@media print` rules that remove them from a printed page. Filtering them
 * out here would be a second copy of the print contract, and a second copy is
 * how the CAM's textarea ends up in a client's PDF.
 *
 * EVERY FAILURE POINTS AT THE PRINT BUTTON. This route needs the network and the
 * deployment; print needs only the open tab. That is the one real thing the desk
 * gives up by downloading instead of printing, so when it goes wrong the message
 * says the fallback out loud rather than making the CAM think of it.
 */

const SAFE_MESSAGES = Object.freeze({
  no_report: 'The report is not on screen yet. Reopen it and try again.',
  permission_denied: 'Your session has expired. Sign in again, or use Print to save the PDF.',
  too_large: 'This report is too large to download. Use Print to save it.',
  assets_unavailable: 'The server could not load the report fonts, so the pages would break in the wrong places. Use Print to save this one.',
  unavailable: 'Could not build the PDF. Use Print to save this one.',
});

export class ReportPdfError extends Error {
  constructor(code, { status = 0, cause } = {}) {
    super(SAFE_MESSAGES[code] || SAFE_MESSAGES.unavailable, cause ? { cause } : undefined);
    this.name = 'ReportPdfError';
    this.code = code;
    this.status = status;
  }
}

async function defaultAccessToken() {
  if (!isSupabaseConfigured || !supabase) throw new ReportPdfError('permission_denied', { status: 401 });
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token) throw new ReportPdfError('permission_denied', { status: 401 });
  return data.session.access_token;
}

/**
 * Hands the browser a file.
 *
 * The object URL is revoked on the next tick rather than immediately after
 * `click()`: the click only SCHEDULES the download, and revoking in the same
 * task has been observed to cancel it.
 */
export function saveBlobAs(fileName, blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Maps a server status onto something the CAM can act on.
 *
 * The 502 family is split out from "unavailable" because it is the one the desk
 * most needs to distinguish: it means the render SUCCEEDED mechanically but
 * against missing fonts or a missing stylesheet, which is the failure that would
 * otherwise have shipped a client a report paginated differently from every
 * other report they have ever received.
 */
function errorCode(status, message) {
  if (status === 401 || status === 403) return 'permission_denied';
  if (status === 413) return 'too_large';
  if (/report_(font|stylesheet|assets)_/.test(String(message || ''))) return 'assets_unavailable';
  return 'unavailable';
}

export function createReportPdfDownloader({
  fetchImpl = globalThis.fetch,
  getAccessToken = defaultAccessToken,
  saveBlob = saveBlobAs,
  endpoint = '/api/report/pdf',
} = {}) {
  return async function downloadReportPdf({ sheet, title, signal } = {}) {
    const html = sheet?.outerHTML;
    if (!html) throw new ReportPdfError('no_report', { status: 0 });

    const token = await getAccessToken();
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ html, title }),
      });
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted) throw error;
      throw new ReportPdfError('unavailable', { cause: error });
    }

    if (!response.ok) {
      let message;
      try { message = (await response.json())?.error || ''; } catch { message = ''; }
      throw new ReportPdfError(errorCode(response.status, message), { status: response.status });
    }

    const blob = await response.blob();
    // A 200 that is not a PDF means something between here and the function
    // answered instead of it — a proxy, a login wall — and saving it would put a
    // file named "<Client> - <date> daily report.pdf" full of HTML in the folder
    // the CAM distributes from.
    if (blob.type && !blob.type.startsWith('application/pdf')) {
      throw new ReportPdfError('unavailable', { status: response.status });
    }

    // The name comes from the same module the server stamps Content-Disposition
    // with, so the two cannot disagree — see src/domain/reportFileName.js.
    const fileName = reportPdfFileName(title);
    saveBlob(fileName, blob);
    return { fileName, bytes: blob.size };
  };
}

export const downloadReportPdf = createReportPdfDownloader();

/* ------------------------------------------------------------------------- *
 * The same request, handing back the bytes instead of saving them.
 *
 * For the day package, which needs eleven PDFs in one zip rather than eleven
 * files in a Downloads folder. It takes HTML rather than a live sheet because
 * the package renders each client off screen and reads the markup back, so
 * there is no element to hand over.
 *
 * Everything else is deliberately shared: the same endpoint, the same token,
 * the same refusal to save a 200 that is not a PDF. That last one matters more
 * here than anywhere: a login page saved eleven times into a zip named for the
 * close is a folder a CAM distributes from.
 * ------------------------------------------------------------------------- */
export function createReportPdfBytesFetcher({
  fetchImpl = globalThis.fetch,
  getAccessToken = defaultAccessToken,
  endpoint = '/api/report/pdf',
} = {}) {
  return async function downloadReportPdfBytes({ html, title, signal } = {}) {
    if (!html) throw new ReportPdfError('no_report', { status: 0 });
    const token = await getAccessToken();
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ html, title }),
      });
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted) throw error;
      throw new ReportPdfError('unavailable', { cause: error });
    }
    if (!response.ok) {
      let message;
      try { message = (await response.json())?.error || ''; } catch { message = ''; }
      throw new ReportPdfError(errorCode(response.status, message), { status: response.status });
    }
    const blob = await response.blob();
    if (blob.type && !blob.type.startsWith('application/pdf')) {
      throw new ReportPdfError('unavailable', { status: response.status });
    }
    return new Uint8Array(await blob.arrayBuffer());
  };
}

export const downloadReportPdfBytes = createReportPdfBytesFetcher();
