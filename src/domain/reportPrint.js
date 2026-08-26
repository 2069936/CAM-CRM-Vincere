import { reportFileStem } from './reportFileName';

/**
 * Printing the report the way the desk has always printed it.
 *
 * Print-to-PDF takes the saved file's name from document.title, so the title is
 * set to the client and the close before the dialog opens and restored after —
 * which is the only reason the desk's files were ever named correctly. It moved
 * out of App.jsx when the download path was added, so that the one sanitiser
 * both paths depend on lives in one module (src/domain/reportFileName.js) rather
 * than being reimplemented beside each caller.
 *
 * IT IS STILL HERE ON PURPOSE, and demoted rather than deleted. Two reasons,
 * neither of them sentiment:
 *
 *   1. The download route IS the print route — the server renders the same DOM
 *      through the same `@media print` blocks in src/index.css. Removing the
 *      button would leave the stylesheet that shapes every client's PDF with no
 *      human ever exercising it, and the first person to notice it had drifted
 *      would be a client.
 *   2. It is the only path that survives the function being down, on a desk that
 *      ships eleven reports at the close of every trading day. Download needs the
 *      network and the deployment; this needs the tab that is already open.
 */
export function printWithTitle(title) {
  const safe = reportFileStem(title);
  const previous = document.title;
  document.title = safe;
  const restore = () => {
    document.title = previous;
    window.removeEventListener('afterprint', restore);
  };
  window.addEventListener('afterprint', restore);
  window.print();
}
