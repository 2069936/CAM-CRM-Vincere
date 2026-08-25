// The name on the file the client receives.
//
// This is not a formatting test. The CAM sends eleven of these every trading
// day and files them by hand afterwards, so "<Client> - <date> daily report" is
// the key the desk's folders and the distribution step are built on. Three
// callers produce it — printWithTitle via document.title, the download path via
// the anchor's `download`, and the server via Content-Disposition — and they all
// read this module so that they cannot disagree.

import { describe, expect, it } from 'vitest';
import { reportContentDisposition, reportFileStem, reportPdfFileName } from './reportFileName';

const DAILY = 'Wren Larch - 2026-08-24 daily report';

describe('the report file name', () => {
  it('keeps the name the desk actually files by, untouched', () => {
    // Nothing in the ordinary name is legal to change: no case folding, no
    // collapsing the spaces around the hyphen, no reordering. This is the whole
    // point of the module.
    expect(reportFileStem(DAILY)).toBe(DAILY);
    expect(reportPdfFileName(DAILY)).toBe(`${DAILY}.pdf`);
  });

  it('replaces every character a file system would refuse', () => {
    // Windows' illegal set plus the POSIX slash. The desk is on macOS and the
    // clients are mostly not, so the strictest platform is the one implemented.
    expect(reportFileStem('a\\b/c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j');
    // A CONTIGUOUS run collapses to one hyphen rather than one per character,
    // which is why the regex is `+`: "Client:*/? report" would otherwise be
    // "Client---- report". Characters separated by anything legal stay separate.
    expect(reportFileStem('Client:*/? report')).toBe('Client- report');
    expect(reportFileStem('Client: */? report')).toBe('Client- - report');
  });

  it('never produces a nameless file', () => {
    // No caller can reach this today — all three interpolate a client name or
    // the literal "Client" — but a download called ".pdf" is not a failure
    // anybody would diagnose quickly.
    expect(reportPdfFileName('   ')).toBe('report.pdf');
    expect(reportPdfFileName('///')).toBe('-.pdf');
    expect(reportPdfFileName('')).toBe('report.pdf');
    expect(reportPdfFileName(null)).toBe('report.pdf');
  });
});

describe('the Content-Disposition the server stamps', () => {
  it('asks the browser to save rather than display', () => {
    expect(reportContentDisposition(DAILY)).toMatch(/^attachment; /);
  });

  it('carries the exact name in the extended form and an ASCII one beside it', () => {
    const header = reportContentDisposition(DAILY);
    expect(header).toContain(`filename="${DAILY}.pdf"`);
    expect(header).toContain("filename*=UTF-8''Wren%20Larch%20-%202026-08-24%20daily%20report.pdf");
  });

  it('carries a non-ASCII client name through the extended form intact', () => {
    // THE FAILURE THIS PREVENTS IS AT THE SERVER, NOT THE CLIENT. An HTTP header
    // field value is latin-1 at best and Node throws ERR_INVALID_CHAR on
    // U+015F, so a bare `filename="Ayşe Şahin …"` would not produce a
    // mis-named download, it would produce a 500 and no report at all. Real
    // names on this book include Muñoz, Bałka and Şahin.
    const header = reportContentDisposition('Ayşe Şahin - 2026-08-24 daily report');
    expect(header).toContain("filename*=UTF-8''Ay%C5%9Fe%20%C5%9Eahin%20-%202026-08-24%20daily%20report.pdf");
    // decodeURIComponent of the extended form is the real name, byte for byte.
    const extended = /filename\*=UTF-8''(\S+)$/.exec(header)[1];
    expect(decodeURIComponent(extended)).toBe('Ayşe Şahin - 2026-08-24 daily report.pdf');
  });

  it('leaves nothing in the plain form that a header cannot carry', () => {
    // The whole quoted-string must be latin-1-safe and un-escapable: a `"` in
    // the name would close the quoted string early and let the rest of the name
    // be read as further header parameters.
    const header = reportContentDisposition('Wojciech Bałka "x" \\ - 2026-08-24 daily report');
    const plain = /filename="([^"]*)"/.exec(header)[1];
    expect(plain).toMatch(/^[\x20-\x7e]*$/);
    expect(plain).not.toContain('"');
    expect(plain).not.toContain('\\');
    expect(plain).toContain('_'); // ł became the placeholder rather than vanishing
  });

  it('escapes the characters RFC 5987 does not allow but encodeURIComponent leaves alone', () => {
    // encodeURIComponent passes `!'()*` through and attr-char does not include
    // them, so an unescaped apostrophe in a client name would terminate the
    // charset''value form early.
    const header = reportContentDisposition("O'Neill (Trading)! - 2026-08-24 daily report");
    const extended = /filename\*=UTF-8''(\S+)$/.exec(header)[1];
    expect(extended).not.toMatch(/['()*!]/);
    expect(decodeURIComponent(extended)).toBe("O'Neill (Trading)! - 2026-08-24 daily report.pdf");
  });
});
