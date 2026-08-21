/**
 * One background refresh at a time, however many edits ask for one.
 *
 * THE DEFECT THIS EXISTS FOR
 *
 * "Import all N closes" called onAppendDailyImport in a forEach, and each of
 * those closes asked for its own detached full reload. Five closes meant five
 * dashboard loads — 205 requests against a project that started answering 429s
 * at a fraction of that — all in flight together, each carrying a snapshot read
 * at a different moment, and each ending in `setState(nextState)`. They landed
 * in whatever order the network gave them, the last one to land won, and it was
 * not the last one to have been written: with five closes, four vanished off
 * the screen.
 *
 * Ordering the landings would not fix it. The refresh that lands last is not
 * the refresh that read last, and even if it were, a whole-state replacement
 * still discards edits made after its read (see refreshMerge.js, which is the
 * other half of this fix).
 *
 * WHAT THIS DOES
 *
 * Coalesces. At most one run is ever in flight. Requests that arrive while one
 * is running are batched into a single trailing run that starts when it
 * finishes, so N closes cost at most two loads instead of N, and the trailing
 * run reads AFTER every write that queued against it. Each caller's promise
 * settles with the run that actually served it, so a failed refresh is still
 * reported per edit — persistEdit needs that to tell one failed refresh from a
 * failed save.
 *
 * A trailing run is one run, not one per waiter: the second, third and fifth
 * close all wanted the same thing, and asking for it five times is the burst
 * again with extra steps.
 */

/**
 * @param {object} options
 * @param {(targets: Array) => Promise<any>} options.run Does the load and applies
 *        it. Called with every target batched into this run, oldest first.
 * @returns {{request: (target: any) => Promise<any>, isIdle: () => boolean}}
 *        `request` resolves when a run that INCLUDED this target has finished,
 *        and rejects with that run's error. It never rejects with an earlier
 *        run's error, because an earlier run did not carry this target.
 */
export function createCoalescingRefresh({ run } = {}) {
  if (typeof run !== 'function') {
    throw new Error('createCoalescingRefresh needs a run function.');
  }

  let inFlight = null;
  let queuedTargets = null;
  let queuedWaiters = null;

  function settle(waiters, settleOne) {
    // Copied before settling: a waiter's own .then may request another refresh,
    // and iterating the live array while it grows is how a queue turns into a
    // loop.
    for (const waiter of [...waiters]) settleOne(waiter);
  }

  function start(targets, waiters) {
    const current = Promise.resolve()
      .then(() => run(targets))
      .then(
        (value) => {
          inFlight = null;
          drain();
          settle(waiters, (waiter) => waiter.resolve(value));
          return value;
        },
        (error) => {
          inFlight = null;
          drain();
          settle(waiters, (waiter) => waiter.reject(error));
        },
      );
    inFlight = current;
    return current;
  }

  function drain() {
    if (inFlight || !queuedWaiters?.length) return;
    const targets = queuedTargets;
    const waiters = queuedWaiters;
    queuedTargets = null;
    queuedWaiters = null;
    start(targets, waiters);
  }

  function request(target) {
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      if (!inFlight) {
        start([target], [waiter]);
        return;
      }
      // A run is out. It read before this target existed, so joining it would
      // report a refresh that cannot have seen this write. Queue instead.
      if (!queuedWaiters) {
        queuedTargets = [];
        queuedWaiters = [];
      }
      queuedTargets.push(target);
      queuedWaiters.push(waiter);
    });
  }

  return {
    request,
    isIdle: () => !inFlight && !queuedWaiters?.length,
  };
}
