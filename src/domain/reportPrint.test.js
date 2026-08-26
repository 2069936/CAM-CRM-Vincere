// @vitest-environment jsdom
//
// Printing still names the file correctly.
//
// This behaviour is older than the download path and it did not change when the
// download path arrived — but it MOVED, out of App.jsx and into a module that
// shares one sanitiser with the download and the server. A move is exactly when
// a behaviour nobody is watching quietly stops working, and the behaviour here
// is the whole reason the desk's printed files were ever named right.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { printWithTitle } from './reportPrint';

const TITLE = 'Wren Larch - 2026-08-24 daily report';

afterEach(() => {
  document.title = '';
  vi.restoreAllMocks();
});

describe('printWithTitle', () => {
  it('names the print dialog\'s file after the client and the close', () => {
    // Print-to-PDF takes the saved file's name from document.title and there is
    // no other hook for it, which is why this exists at all.
    vi.spyOn(window, 'print').mockImplementation(() => {});
    document.title = 'CAM Portal — Client Account Manager';
    printWithTitle(TITLE);
    expect(document.title).toBe(TITLE);
    expect(window.print).toHaveBeenCalledTimes(1);
  });

  it('puts the app\'s own title back once the dialog closes', () => {
    // Otherwise every tab the CAM has open reads as a client's name for the rest
    // of the session, and the NEXT print inherits it.
    vi.spyOn(window, 'print').mockImplementation(() => {});
    document.title = 'CAM Portal — Client Account Manager';
    printWithTitle(TITLE);
    window.dispatchEvent(new Event('afterprint'));
    expect(document.title).toBe('CAM Portal — Client Account Manager');
  });

  it('stops listening once it has restored, so a spent listener cannot reach back', () => {
    // The restore listener unregisters ITSELF. Without that, every report the
    // CAM opens leaves another live `afterprint` handler on the window holding a
    // title from earlier in the session — and the next print event, from
    // anywhere, gets to overwrite the title with a stale one.
    //
    // Note the shape of this test. Asserting on a SECOND printWithTitle would
    // prove nothing: both the leaked listener and the fresh one would be
    // restoring the same string. The leak is only observable on a print event
    // that has no printWithTitle behind it at all.
    vi.spyOn(window, 'print').mockImplementation(() => {});
    document.title = 'CAM Portal';
    printWithTitle('First - 2026-08-24 daily report');
    window.dispatchEvent(new Event('afterprint'));
    expect(document.title).toBe('CAM Portal');

    document.title = 'Something else entirely';
    window.dispatchEvent(new Event('afterprint'));
    expect(document.title).toBe('Something else entirely');
  });

  it('sanitises the title with the same rule the download and the server use', () => {
    // One sanitiser, three callers — see src/domain/reportFileName.js. The
    // failure this prevents is a client receiving a printed file and a
    // downloaded file with different names for the same close.
    vi.spyOn(window, 'print').mockImplementation(() => {});
    printWithTitle('Client: A/B - 2026-08-24 daily report');
    expect(document.title).toBe('Client- A-B - 2026-08-24 daily report');
  });

  it('does not append .pdf, because the dialog adds the extension itself', () => {
    // The stem, not the file name. printWithTitle takes the extension-less form
    // and the download path takes the one with `.pdf`; getting this backwards
    // would produce "…daily report.pdf.pdf" on every printed file.
    vi.spyOn(window, 'print').mockImplementation(() => {});
    printWithTitle(TITLE);
    expect(document.title).not.toMatch(/\.pdf$/);
  });
});
