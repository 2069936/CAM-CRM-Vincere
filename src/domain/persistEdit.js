/**
 * One edit, one write, one visible result.
 *
 * THE DEFECT THIS REPLACES
 *
 * Eighteen call sites in App.jsx were shaped like this:
 *
 *     mutate(...)
 *       .then(() => reloadSupabaseState(camId, clientId))
 *       .catch((error) => window.alert("Could not save: " + error.message))
 *
 * reloadSupabaseState re-downloads every table, so under load the sequence was:
 * the write SUCCEEDS, the refresh fires its request burst, part of the burst
 * fails, the refresh throws, and the `.catch` written for the WRITE tells the
 * user their save failed. It did not. Worse, setState was never reached, so the
 * screen still showed the old value and the user's correct conclusion — from
 * what they could see — was that the app had thrown their edit away.
 *
 * Three of the desk manager's symptoms were this one shape: a flag that came
 * back, a day that read as not closed, a dragged client that snapped home.
 *
 * THE RULE HERE
 *
 * An edit is visible from the edit itself. `apply` puts it on screen before the
 * request leaves; `reconcile` folds in whatever the write returned (server ids,
 * server defaults) when it comes back. A refetch is never the mechanism by
 * which a user sees their own action.
 *
 * A refresh, when one is still wanted — some writes fan out server-side into
 * rows the client cannot name, and a daily import is the clear case — runs
 * DETACHED, after the save has already been reported as done. It is handed no
 * way to write state on failure: `refresh` owns its own success path, and this
 * module guarantees that a rejected refresh touches neither `rollback` nor
 * `onSaveFailed`. State that cannot be replaced is never reverted.
 *
 * The two failures are reported separately because the user acts differently on
 * each: a failed save needs the edit made again, a failed refresh needs
 * nothing — their work is safe, they are just looking at a slightly old copy of
 * everyone else's.
 */

/**
 * What the user is told when the WRITE failed.
 *
 * There are three different things that can be true of the screen at that
 * moment, and they send the user three different places:
 *
 *   applied + rolled back  the edit was shown and has been taken back off.
 *                          Make it again.
 *   applied, no rollback   the edit is still visible and is NOT saved. Do not
 *                          walk away from it.
 *   never applied          nothing on screen ever changed — a create whose id
 *                          only the server can hand out. Nothing to undo and
 *                          nothing to distrust.
 *
 * Saying "undone here" about a change that is still sitting on screen sends
 * someone to re-enter what is already there; saying "still on screen" about a
 * change that was reverted sends them looking for it. Callers pass what
 * actually happened, and persistEdit hands them both facts.
 */
export function saveFailedMessage(what, error, { rolledBack = true, applied = true } = {}) {
  const detail = error?.message || String(error || 'unknown error');
  if (!applied) {
    return `Could not save ${what}: ${detail}\n\nNothing was written and nothing on screen has changed. Try again.`;
  }
  return rolledBack
    ? `Could not save ${what}: ${detail}\n\nNothing was written, and the change has been undone here. Try again.`
    : `Could not save ${what}: ${detail}\n\nThe change is still on screen but is NOT saved.`;
}

/**
 * What the user is told when the SAVE worked and only the background refresh
 * failed. Deliberately never the word "save" in the failing half.
 */
export function refreshFailedMessage(what, error) {
  const detail = error?.message || String(error || 'unknown error');
  return `${what} saved. The view could not be refreshed (${detail}) — your change is safe, but anything other people changed may be missing until the next refresh.`;
}

/**
 * Applies an edit locally, writes it, and reports the two outcomes apart.
 *
 * @param {object}   options
 * @param {Function} options.setState        React setState (updater form only).
 * @param {Function} [options.apply]         (current) => next. Runs NOW, before the write.
 * @param {Function} [options.rollback]      (current) => next. Runs only if the WRITE rejects.
 * @param {Function} options.write           () => Promise<result>.
 * @param {Function} [options.reconcile]     (current, result) => next. Runs on write success.
 * @param {Function} [options.onSaved]       (result) => void. Audit, toasts, follow-on writes.
 * @param {Function} [options.onSaveFailed]  (error, { rolledBack, applied }) => void.
 *        `applied` says whether anything was ever put on screen for this edit,
 *        so the caller can tell "undone" apart from "never shown".
 * @param {Function} [options.refresh]       () => Promise<any>. Detached; never blocks the edit.
 * @param {Function} [options.onRefreshFailed] (error) => void. Must not revert state.
 * @returns {Promise<{saved: boolean, result?: any, error?: Error}>} settles with the WRITE,
 *          never with the refresh, and never rejects.
 */
export function persistEdit({
  setState,
  apply = null,
  rollback = null,
  write,
  reconcile = null,
  onSaved = null,
  onSaveFailed = null,
  refresh = null,
  onRefreshFailed = null,
} = {}) {
  if (typeof write !== 'function') {
    throw new Error('persistEdit needs a write function.');
  }
  const patch = (updater) => {
    if (setState && updater) setState(updater);
  };

  // Before the request leaves, not after it lands. This is the whole point.
  if (apply) patch(apply);

  return Promise.resolve()
    .then(() => write())
    .then((result) => {
      if (reconcile) patch((current) => reconcile(current, result));
      if (onSaved) onSaved(result);

      if (refresh) {
        // Detached on purpose: the returned promise below resolves as saved
        // whether or not this ever comes back. Nothing in here may call
        // rollback or onSaveFailed — the save already happened.
        Promise.resolve()
          .then(() => refresh())
          .catch((error) => {
            if (onRefreshFailed) onRefreshFailed(error);
          });
      }
      return { saved: true, result };
    })
    .catch((error) => {
      // Only a failed WRITE reaches here. A failed refresh cannot: it is caught
      // inside the branch above and never rethrown into this chain.
      // A rollback only rolls something back if something was applied. A create
      // whose id the server hands out has no placeholder to revert, and calling
      // that "undone" would be the same class of untruth this module exists to
      // remove — just pointed the other way.
      const applied = Boolean(apply);
      const rolledBack = applied && Boolean(rollback);
      if (rolledBack) patch(rollback);
      if (onSaveFailed) onSaveFailed(error, { rolledBack, applied });
      return { saved: false, error };
    });
}
