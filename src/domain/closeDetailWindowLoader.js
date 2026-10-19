/**
 * Fetching a window of closes in full, with a load state of its own.
 *
 * WHO USES IT. The client period report (ClientPeriodReportPanel.jsx), which
 * reads every close of its window and the close before it: the account rows
 * (balances, realized), the strategy rows (which algorithm ran, and what each
 * reported) and the fills (the counts, and the fills half of the ran rule).
 *
 * WHY THE CLOSE DETAIL AND NOT THE RANKING FETCH. `loadSupabaseCloseDetail`
 * brings all three in one pass: account_snapshots, strategy_snapshots without
 * the two parameter columns, orders and executions. Four requests per 60
 * closes, about 36 rows and 0.018 MB a close on the book, so a four week window
 * of one client (about 21 closes) is roughly 0.4 MB. The ranking fetch
 * (App.jsx `ensureStrategyParameters` with `withAccountRows`) brings no fills,
 * so it would need this fetch beside it anyway, and its strategy rows carry
 * `parameters_raw` and `params_parsed`: 2,231 B of a 2,731 B row, and the
 * machine LicenseKey with them, which a client report has no use for.
 *
 * THE SAME CARE AS `ensureStrategyParameters`, on the close-detail cache that
 * opening a close already uses (App.jsx `ensureCloseDetail`):
 *
 *   * the load state is per panel key, and the report keys it per window, so
 *     a newly chosen window never inherits the previous one's `loaded`;
 *   * ids another caller already has in flight are waited on, never declared
 *     loaded early;
 *   * a failure backs the ids out of the cache, so Try again fetches again,
 *     and leaves state alone;
 *   * and one thing that loader does not need: the panel asks only for closes
 *     that lack their rows or fills in state, so an id the cache calls loaded
 *     is one a refresh has since rebuilt from a login, and it is fetched again
 *     rather than reported as loaded over rows that are not there.
 *
 * Pure apart from what it is handed, so it is tested without React or a
 * database: `cache` is `{ current: Map }` (App's ref), `load(ids)` resolves to
 * the fetched detail, `onLoaded(detail)` merges it into state, and
 * `setPanelLoad(key, { status, error })` records the panel's state.
 */
export function createWindowDetailLoader({
  cache,
  load,
  onLoaded,
  setPanelLoad,
  log = (...args) => console.error(...args),
}) {
  return function ensureWindowDetail(panelKey, importIds) {
    const ids = [...new Set((importIds || []).filter(Boolean))];
    for (const id of ids) {
      if (cache.current.get(id)?.status === 'loaded') cache.current.delete(id);
    }
    const wanted = ids.filter((id) => !cache.current.has(id));
    const waiting = ids
      .filter((id) => !wanted.includes(id))
      .map((id) => cache.current.get(id))
      .filter((entry) => entry?.status === 'loading' && entry.promise)
      .map((entry) => entry.promise);
    // Every id has to have landed. A request somebody else had out resolves to
    // null on failure rather than rejecting, so the cache is the answer.
    const settle = () => {
      const failed = ids.some((id) => cache.current.get(id)?.status !== 'loaded');
      setPanelLoad(panelKey, failed
        ? { status: 'error', error: 'Could not load the closes for this report: the request failed.' }
        : { status: 'loaded', error: '' });
    };

    if (!wanted.length) {
      if (!waiting.length) {
        setPanelLoad(panelKey, { status: 'loaded', error: '' });
        return Promise.resolve(null);
      }
      setPanelLoad(panelKey, { status: 'loading', error: '' });
      return Promise.allSettled(waiting).then(() => {
        settle();
        return null;
      });
    }

    setPanelLoad(panelKey, { status: 'loading', error: '' });
    // Asked now, not on a later tick, so a second caller in the same render
    // finds the ids in flight; a loader that throws is a rejection like any.
    let started;
    try {
      started = Promise.resolve(load(wanted));
    } catch (error) {
      started = Promise.reject(error);
    }
    const request = started
      .then((detail) => {
        for (const id of wanted) cache.current.set(id, { status: 'loaded' });
        onLoaded(detail);
        return detail;
      })
      .catch((error) => {
        for (const id of wanted) cache.current.delete(id);
        log('[CRM] Loading the closes of a period report failed:', error);
        throw error;
      });
    // What a second caller waits on never rejects, the promise shape
    // `ensureCloseDetail` stores in the same cache.
    const shared = request.then(() => true, () => false);
    for (const id of wanted) cache.current.set(id, { status: 'loading', promise: shared });
    return Promise.all([request, ...waiting])
      .then(() => {
        settle();
        return null;
      })
      .catch((error) => {
        setPanelLoad(panelKey, {
          status: 'error',
          error: `Could not load the closes for this report: ${error?.message || 'the database did not answer.'}`,
        });
        return null;
      });
  };
}
