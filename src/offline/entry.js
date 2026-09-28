/* The offline report's browser entry.
 *
 * Bundled into one IIFE by scripts/build_offline_report_bundle.mjs and inlined
 * into the HTML the agent writes. It reads the data the agent put in
 * `window.__VINCERE__` and replaces the document with the rendered sheet.
 *
 * There is a script in that file only because there is nowhere else to run
 * this. The machine has no Node and the agent has no WebView2, so the browser
 * that opens the file is the only interpreter available. Nothing is fetched:
 * the bundle and the data are both already in the file.
 */
import { buildOfflineDailyReport } from './offlineReport.js';
import { renderOfflineReport } from './renderOfflineReport.js';

export function mount(input, document_ = document) {
  const built = buildOfflineDailyReport(input);
  const html = renderOfflineReport(built);
  // Replace the whole document: the shell that carried the bundle has served
  // its purpose, and what is printed should be the sheet and only the sheet.
  document_.open();
  document_.write(html);
  document_.close();
  return built;
}

/* THE DATA COMES OUT OF A JSON SCRIPT TAG, NOT A JAVASCRIPT LITERAL.
 *
 * The agent writes account names and a client's name into this file, and an
 * account named with a closing script tag would end the block early and put
 * the rest of the payload on the page as markup. Reading it as JSON from a
 * tag the browser does not execute removes the class of problem, and the
 * writer escapes `<` as \u003c so the tag cannot be closed from inside the
 * string either.
 */
export const DATA_ELEMENT_ID = 'vincere-offline-data';

if (typeof document !== 'undefined') {
  const holder = document.getElementById(DATA_ELEMENT_ID);
  if (holder) {
    try {
      mount(JSON.parse(holder.textContent));
    } catch (error) {
      document.body.textContent = `This report could not be built: ${error.message}`;
    }
  }
}
