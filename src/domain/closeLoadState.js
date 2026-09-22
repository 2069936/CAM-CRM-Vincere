// Whether a close's fills are in hand, asked in one place.
//
// NOT LOADED IS NOT EMPTY, and per close an empty array cannot tell you which.
// A day on which nothing traded and a day whose orders nobody has fetched are
// the same `[]`, which is why accountLifecycle.js and StackPlaybook.jsx each
// grew their own book-wide probe: "does ANY close anywhere carry a fill". That
// worked while loading was all or nothing — the whole trade history arrived in
// one pass after the dashboard shell, so one fill anywhere meant every fill
// everywhere.
//
// It stopped being true when the login became per close. A login now carries
// the executions of each client's LATEST close and of no other, so the old
// probe answers "loaded" over a book where 2,379 of 2,585 closes hold nothing —
// and both panels would drop the sentence that says their figures are reading
// the strategy grid alone, at exactly the moment it became most true.
//
// So the answer is on the close. `detailLoaded` is set by the per-close fetch
// and by a whole-table load (a local snapshot, a test fixture built from whole
// tables), and it is the only thing here that is trusted when it is present.
// A close that does not carry the field at all is a fixture written before it
// existed, and falls back to the old evidence — it carries fills, so they were
// loaded — so nothing that used to answer "loaded" now answers "not".

/** One close: are its orders and executions in hand? */
export function fillsLoadedFor(dailyImport) {
  if (typeof dailyImport?.detailLoaded === 'boolean') return dailyImport.detailLoaded;
  return Boolean(
    (dailyImport?.orders || []).length
    || (dailyImport?.executions || []).length
    || (dailyImport?.simulation?.orders || []).length
    || (dailyImport?.simulation?.executions || []).length,
  );
}

/**
 * A whole book: can a figure drawn from fills be stated without a caveat?
 *
 * Deliberately unanimous. One close short is a figure with a hole in it, and a
 * panel that says "reading the strategy grid alone" while 205 of 206 closes
 * have their fills is saying something almost untrue — but a panel that says
 * nothing while 2,379 closes are missing theirs is saying something entirely
 * untrue, and that is the one that costs money.
 */
export function fillsLoadedAcross(clients = []) {
  let anyLoaded = false;
  for (const client of clients || []) {
    for (const dailyImport of client?.dailyImports || []) {
      if (!fillsLoadedFor(dailyImport)) return false;
      anyLoaded = true;
    }
  }
  return anyLoaded;
}

/** The closes of `clients` whose fills are not in hand, newest last. */
export function closesAwaitingFills(clients = [], { from = '', to = '' } = {}) {
  const ids = [];
  for (const client of clients || []) {
    for (const dailyImport of client?.dailyImports || []) {
      const date = String(dailyImport?.date || '').slice(0, 10);
      if (!date) continue;
      if (from && date < from) continue;
      if (to && date > to) continue;
      if (fillsLoadedFor(dailyImport)) continue;
      ids.push(dailyImport.uuid || dailyImport.id);
    }
  }
  return ids;
}
