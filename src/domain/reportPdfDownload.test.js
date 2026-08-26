// @vitest-environment jsdom
//
// The browser half of "click and it downloads".

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReportPdfError, createReportPdfDownloader, saveBlobAs } from './reportPdfDownload';

const TITLE = 'Wren Larch - 2026-08-24 daily report';

/** A live report sheet, complete with everything the print contract strips. */
function sheet() {
  const node = document.createElement('div');
  node.className = 'report-sheet';
  node.innerHTML = '<div class="report-actions no-print"><button>Design</button></div>'
    + '<section class="report-note-section has-note">'
    + '<div class="report-note-editor no-print"><textarea></textarea></div>'
    + '<p class="report-note-print">A quiet close.</p></section>';
  return node;
}

function pdfResponse(bytes = '%PDF-1.4 paper') {
  return { ok: true, status: 200, blob: async () => new Blob([bytes], { type: 'application/pdf' }) };
}

function downloader({ fetchImpl, saveBlob = vi.fn(), token = 'tok' } = {}) {
  const download = createReportPdfDownloader({
    fetchImpl: fetchImpl || vi.fn(async () => pdfResponse()),
    getAccessToken: typeof token === 'function' ? token : async () => token,
    saveBlob,
  });
  return { download, saveBlob };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('what goes up', () => {
  it('sends the live sheet exactly as it stands, chrome and all', async () => {
    // THE CONTRACT LIVES AT THE FAR END. `.report-actions`, the note editor and
    // the design drawer travel up inside this markup and are removed by the same
    // `@media print` rules that remove them from a printed page. Filtering here
    // would be a second copy of the print contract, and a second copy is how the
    // CAM's textarea reached a client's PDF when the rasteriser was measured.
    const fetchImpl = vi.fn(async () => pdfResponse());
    const { download } = downloader({ fetchImpl });
    await download({ sheet: sheet(), title: TITLE });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.html).toContain('class="report-actions no-print"');
    expect(body.html).toContain('class="report-note-editor no-print"');
    expect(body.html).toContain('<p class="report-note-print">A quiet close.</p>');
    expect(body.html).toContain('report-note-section has-note');
    expect(body.title).toBe(TITLE);
  });

  it('posts to the report endpoint with the caller\'s bearer token', async () => {
    const fetchImpl = vi.fn(async () => pdfResponse());
    const { download } = downloader({ fetchImpl });
    await download({ sheet: sheet(), title: TITLE });
    expect(fetchImpl).toHaveBeenCalledWith('/api/report/pdf', expect.objectContaining({
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
    }));
  });

  it('carries a note the CAM has typed but not saved, and not the textarea it was typed in', async () => {
    // A REAL SUBTLETY OF SENDING outerHTML. A <textarea>'s current value is a
    // PROPERTY; it is not reflected into the serialized markup, so the box the
    // CAM typed in arrives at the server empty. That is harmless only because
    // `.report-note-editor` is `.no-print` and never reaches the paper anyway —
    // what prints is the sibling `<p class="report-note-print">`, which React
    // renders as a text node and outerHTML therefore carries.
    //
    // The failure this pins is the one ReportNoteSection exists to prevent: a
    // CAM types a paragraph, presses Download before Save, and the client
    // receives a report without it.
    const node = sheet();
    const box = node.querySelector('textarea');
    box.value = 'Typed but not saved.';
    node.querySelector('.report-note-print').textContent = 'Typed but not saved.';
    const fetchImpl = vi.fn(async () => pdfResponse());
    const { download } = downloader({ fetchImpl });
    await download({ sheet: node, title: TITLE });
    const { html } = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(html).toContain('<p class="report-note-print">Typed but not saved.</p>');
    expect(html).toContain('<textarea></textarea>');
  });

  it('refuses when the report is not on screen rather than posting nothing', async () => {
    const fetchImpl = vi.fn();
    const { download } = downloader({ fetchImpl });
    await expect(download({ sheet: null, title: TITLE })).rejects.toThrow(ReportPdfError);
    await expect(download({ title: TITLE })).rejects.toThrow(/not on screen/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('what comes back', () => {
  it('saves it under the name the desk files by', async () => {
    const { download, saveBlob } = downloader();
    const result = await download({ sheet: sheet(), title: TITLE });
    expect(saveBlob).toHaveBeenCalledWith(`${TITLE}.pdf`, expect.any(Blob));
    expect(result.fileName).toBe(`${TITLE}.pdf`);
  });

  it('refuses a 200 that is not a PDF', async () => {
    // A proxy or a login wall answering 200 with HTML would otherwise be saved
    // as "<Client> - <date> daily report.pdf" into the folder the CAM
    // distributes from — a file that looks right in a listing and is not a
    // report.
    const fetchImpl = vi.fn(async () => ({
      ok: true, status: 200, blob: async () => new Blob(['<html>sign in</html>'], { type: 'text/html' }),
    }));
    const { download, saveBlob } = downloader({ fetchImpl });
    await expect(download({ sheet: sheet(), title: TITLE })).rejects.toThrow(ReportPdfError);
    expect(saveBlob).not.toHaveBeenCalled();
  });
});

describe('what the CAM is told when it fails', () => {
  const failing = (status, error) => vi.fn(async () => ({
    ok: false, status, json: async () => ({ error }), blob: async () => new Blob([]),
  }));

  it('names Print as the way out, every time', async () => {
    // This is the one path that needs the network and the deployment; print
    // needs only the open tab. Eleven reports go out at every close, so the
    // fallback is said out loud rather than left for the CAM to think of.
    for (const [status, error] of [[403, 'nope'], [413, 'report_pdf_too_large'], [500, 'boom'], [502, 'report_font_missing: Inter']]) {
      const { download } = downloader({ fetchImpl: failing(status, error) });
      await expect(download({ sheet: sheet(), title: TITLE })).rejects.toThrow(/Print/);
    }
  });

  it('tells a missing-font failure apart from a plain outage', async () => {
    // Worth distinguishing because it is the failure that would otherwise ship:
    // the render succeeded mechanically, against fonts that were not there, and
    // a real client report goes from one sheet to two when that happens.
    const { download } = downloader({ fetchImpl: failing(502, 'report_font_missing: Inter Variable, Outfit Variable') });
    await expect(download({ sheet: sheet(), title: TITLE })).rejects.toMatchObject({
      code: 'assets_unavailable',
      status: 502,
    });
    const { download: plain } = downloader({ fetchImpl: failing(500, 'boom') });
    await expect(plain({ sheet: sheet(), title: TITLE })).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('reports an expired session as one', async () => {
    for (const status of [401, 403]) {
      const { download } = downloader({ fetchImpl: failing(status, 'denied') });
      await expect(download({ sheet: sheet(), title: TITLE })).rejects.toMatchObject({ code: 'permission_denied' });
    }
  });

  it('does not save anything when the request fails outright', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const { download, saveBlob } = downloader({ fetchImpl });
    await expect(download({ sheet: sheet(), title: TITLE })).rejects.toMatchObject({ code: 'unavailable' });
    expect(saveBlob).not.toHaveBeenCalled();
  });

  it('lets an abort through untouched, so a closed report does not raise an error', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async () => { throw new DOMException('Aborted', 'AbortError'); });
    const { download } = downloader({ fetchImpl });
    await expect(download({ sheet: sheet(), title: TITLE, signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('handing the file to the browser', () => {
  it('names the anchor and clicks it, then lets go of the object url', async () => {
    const created = [];
    const revoked = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => { created.push('blob:x'); return 'blob:x'; });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => revoked.push(url));
    const clicks = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() {
      clicks.push({ download: this.download, href: this.href, attached: this.isConnected });
    });

    saveBlobAs('Wren Larch - 2026-08-24 daily report.pdf', new Blob(['%PDF-'], { type: 'application/pdf' }));

    expect(clicks).toEqual([{ download: 'Wren Larch - 2026-08-24 daily report.pdf', href: 'blob:x', attached: true }]);
    // The anchor is taken back out of the document; a downloads folder's worth
    // of orphan nodes under <body> is not a thing to leave behind.
    expect(document.querySelectorAll('a[download]')).toHaveLength(0);
    // Revoked on the NEXT tick. The click only schedules the download, and
    // revoking in the same task has been observed to cancel it.
    expect(revoked).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(revoked).toEqual(['blob:x']);
    expect(created).toHaveLength(1);
  });
});
