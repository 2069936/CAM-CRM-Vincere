import { reportPdfFileName } from './reportFileName';

/* ------------------------------------------------------------------------- *
 * Every client's report for one close, as one file.
 *
 * The close is a per client action eleven times over: open the client, build
 * the report, download, go back, next client. That is the shape of the work,
 * not of the decision, and the decision was made once when the day closed.
 *
 * ONE FAILURE MUST NOT COST THE OTHER TEN. The PDF is built by a serverless
 * function that cold starts, launches Chromium and can time out, so on a book
 * of eleven the interesting case is not "it worked" but "nine worked". This
 * collects what it got and names what it did not, and a caller that receives
 * nine PDFs and two named failures can send nine messages tonight.
 *
 * SEQUENTIAL, NOT PARALLEL. Eleven concurrent renders is eleven Chromium
 * launches on one deployment, which is how a working endpoint starts timing out
 * on a desk that just wanted its afternoon back. They are also not urgent: this
 * runs once a day and the wait is unattended.
 *
 * SKIPPED IS NOT FAILED. A client with no close for the date has nothing to
 * report and is not a problem to fix, so it is counted apart from the ones that
 * were tried and refused.
 * ------------------------------------------------------------------------- */

/** A client is in the package when it has a close on that date. */
export function clientsWithCloseOn(clients, date) {
  const day = String(date || '').trim();
  if (!day) return [];
  return (clients || [])
    .map((client) => ({
      client,
      dailyImport: (client?.dailyImports || []).find((entry) => entry?.date === day) || null,
    }))
    .filter((entry) => entry.dailyImport);
}

/**
 * Build one PDF per client and hand back what to write.
 *
 * Every collaborator is injected because the useful assertions here are about
 * what happens when one of them fails, and a test that needs a browser to make
 * a Chromium render time out is a test nobody writes.
 *
 * @param clients      the CAM's book.
 * @param date         'YYYY-MM-DD'.
 * @param renderSheet  ({client, dailyImport}) -> HTML string for that client's
 *                     report sheet, or null if it cannot be built.
 * @param renderPdf    ({html, title}) -> bytes. Rejects on failure.
 * @param onProgress   optional, called with {done, total, clientName}.
 * @param signal       optional AbortSignal; an abort stops the run and is
 *                     rethrown, because a cancelled batch is not a result.
 */
export async function buildDailyReportPackage({
  clients,
  date,
  renderSheet,
  renderPdf,
  onProgress = null,
  signal = null,
} = {}) {
  const entries = clientsWithCloseOn(clients, date);
  const files = [];
  const failed = [];
  let done = 0;

  for (const { client, dailyImport } of entries) {
    if (signal?.aborted) throw signal.reason || new Error('aborted');
    const name = client?.name || 'Unknown client';
    try {
      const html = await renderSheet({ client, dailyImport });
      if (!html) throw new Error('no_report');
      // The SAME title the single download builds, so a file pulled out of this
      // zip is byte-for-byte the one a CAM would have downloaded by hand and
      // nothing downstream has to learn a second naming scheme.
      const title = `${name} - ${date} daily report`;
      const bytes = await renderPdf({ html, title, signal });
      if (!bytes) throw new Error('empty_pdf');
      files.push({ name: reportPdfFileName(title), bytes, clientName: name });
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted) throw error;
      // The reason is for a human deciding what to do about this one client, so
      // it keeps the code the downloader already maps rather than a stack.
      failed.push({ clientName: name, reason: error?.code || error?.message || 'failed' });
    }
    done += 1;
    onProgress?.({ done, total: entries.length, clientName: name });
  }

  return {
    files,
    failed,
    // Counted, not listed: a book has clients who did not trade today and that
    // is not a list anybody needs to read every afternoon.
    skipped: (clients || []).length - entries.length,
    total: entries.length,
  };
}

/** What the zip is called. Dated, because these land in a Downloads folder. */
export function packageFileName(date) {
  return `Vincere daily reports ${String(date || '').trim()}.zip`;
}

/**
 * One sentence for the CAM, because the interesting outcome is the partial one.
 * Deliberately names the clients that failed: "9 of 11" sends someone hunting
 * for the two.
 */
export function describePackage({ files = [], failed = [], skipped = 0 } = {}) {
  const built = `${files.length} report${files.length === 1 ? '' : 's'}`;
  if (!failed.length) {
    return skipped
      ? `${built}. ${skipped} client${skipped === 1 ? '' : 's'} had no close today.`
      : `${built}.`;
  }
  const names = failed.map((entry) => entry.clientName).join(', ');
  return `${built}. Could not build: ${names}.`;
}
