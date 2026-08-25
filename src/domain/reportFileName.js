/**
 * The name a client's report file has to be called, in one place.
 *
 * WHY THIS IS ITS OWN MODULE. The name is not cosmetic. The CAM sends these to
 * eleven clients every trading day and files them by hand afterwards, so
 * "<Client> - <date> daily report" is what the desk's folders and the
 * distribution step are keyed on. It is produced in three places that must
 * agree exactly:
 *
 *   1. printWithTitle (src/App.jsx) sets document.title before window.print(),
 *      because the OS dialog takes the saved file's name from the title. That
 *      is where this sanitiser was born, inline.
 *   2. the download path (src/domain/reportPdfDownload.js) names the blob it
 *      hands the browser.
 *   3. the server (server/report/reportPdf.js) stamps Content-Disposition so a
 *      direct GET of the endpoint saves under the same name.
 *
 * Three copies of one regex is how a client ends up with two differently-named
 * files for the same close, so there is one copy and the other two import it.
 *
 * The character class is Windows' illegal set (plus the two slashes), which is
 * the strictest of the platforms involved and therefore the only one worth
 * implementing: the desk is on macOS, the clients are mostly not.
 */

/** `\ / : * ? " < > |` — illegal in a Windows file name, and `/` in a POSIX one. */
const ILLEGAL_IN_A_FILE_NAME = /[\\/:*?"<>|]+/g;

/**
 * The file name without its extension.
 *
 * Byte-for-byte what printWithTitle did inline before this module existed, with
 * one addition: a title that sanitises away to nothing falls back to "report"
 * rather than naming the file "" (or ".pdf"). No caller can reach that today —
 * every one of the three interpolates a client name or the literal "Client" —
 * but a nameless download is not a failure anybody would diagnose quickly.
 */
export function reportFileStem(title) {
  const safe = String(title || 'report').replace(ILLEGAL_IN_A_FILE_NAME, '-').trim();
  return safe || 'report';
}

/** "<Client> - <date> daily report.pdf". */
export function reportPdfFileName(title) {
  return `${reportFileStem(title)}.pdf`;
}

/**
 * RFC 5987 / RFC 6266 value encoding for the `filename*` parameter.
 *
 * encodeURIComponent leaves `!'()*` alone and RFC 5987's attr-char set does
 * not include them, so they are escaped by hand.
 */
function encodeExtendedValue(value) {
  return encodeURIComponent(value).replace(/['()*!]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The Content-Disposition header for a report download.
 *
 * BOTH forms, and the second one is the one that matters. Client names on this
 * book are not ASCII — the redacted export alone carries "Muñoz", "Bałka" and
 * "Şahin" — and an HTTP header field value is latin-1 at best: Node throws
 * ERR_INVALID_CHAR on a header carrying U+015F, so a bare
 * `filename="Ayşe Şahin - 2026-08-24 daily report.pdf"` would not fail at the
 * client, it would fail at res.setHeader and the CAM would get an error instead
 * of a report. `filename*=UTF-8''…` carries the real name, `filename="…"` is
 * the ASCII fallback for anything that cannot read the extended form, and every
 * browser released this decade prefers the extended one.
 */
export function reportContentDisposition(title) {
  const name = reportPdfFileName(title);
  // Anything outside printable ASCII becomes "_", and `"` and `\` go too so the
  // quoted-string cannot be escaped out of.
  const ascii = name.replace(/["\\]/g, '_').replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeExtendedValue(name)}`;
}
