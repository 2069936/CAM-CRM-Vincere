/* ------------------------------------------------------------------------- *
 * WHEN A CAPTURE IS NOT WORTH REWRITING THE DAY FOR.
 *
 * On 2026-09-22 one VPS sent 62 captures of the same trading day, 13 to 45
 * seconds apart between 16:30 and 17:00 New York. Three other machines sent 22,
 * 21 and 21. The other 75 sent one each. It is not a broken machine: the agent
 * queues the snapshot and THEN throws positions_open when an account still
 * carries unrealized PnL (CaptureAndQueueWorkflow.cs:147-160), deliberately,
 * so the day stays unmarked and the 15-second scheduler tries again before its
 * cutoff. The retry has no cap, so a client who leaves positions open past
 * 16:30 produces a capture every 15 seconds for half an hour.
 *
 * THE COST IS NOT THE REQUEST. Each capture deletes and reinserts every
 * strategy, order, execution and flag row of that client-day, under an
 * exclusive lock on the client row, with a per-row account lookup. Nothing in
 * that path is incremental, so the sixty-second capture costs exactly what the
 * first one cost. Stopping the HTTP request would save two storage round trips
 * and cost far more than it saves, because a refused upload is not dropped: the
 * agent returns it to `pending` and re-offers it every ten seconds forever, and
 * the queue is claimed in filename order, so one permanently refused day sits
 * at the head and the machine never uploads again. The upload must SUCCEED.
 * What we skip is the expensive half.
 *
 * WHICH ONE DO WE SKIP. The agent sums unrealized PnL across accounts and
 * throws when the SUM is non-zero; the CRM flags when ANY account is non-zero
 * (openPositions.js:41-58). They are not the same test, and the implication
 * runs one way only: a non-zero sum requires a non-zero account, so every
 * capture the agent considered provisional the CRM also sees as provisional.
 * The reverse can fail, when two accounts cancel. So "provisional" is never on
 * its own a reason to skip anything:
 *
 *   1. A SETTLED capture is never skipped. That is the close, whatever else is
 *      true, and it is the one the whole storm exists to reach.
 *   2. A day with nothing persisted yet is never skipped. Something has to be
 *      the day.
 *   3. A day that has not been rewritten for QUIET_MS is never skipped, even by
 *      a provisional capture, so a day whose captures are ALL provisional still
 *      refreshes and never freezes on the 16:30 reading.
 *
 * What is left is the middle of a storm: a provisional capture arriving on a
 * day that was rewritten seconds ago. Skipping that writes no day and loses
 * nothing, because the capture behind it is already on its way.
 * ------------------------------------------------------------------------- */

// Five minutes. A 30-minute window then rewrites the day at most 7 times
// instead of 62, which is inside the p90 of an ordinary day (measured across
// 2026-09-17, 18, 21 and 22: median 1 capture per device per day, p90 between
// 2 and 12). Short enough that the desk watching a live day sees it move.
export const QUIET_MS = 5 * 60 * 1000;

export const THROTTLE_REASON = 'provisional_capture_superseded';

function parseTime(value) {
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value || ''));
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * @param {object} args
 * @param {{open?: boolean}|null} args.openPositions normalized.metadata.openPositions
 * @param {{id: string, status: string|null, updatedAt: string|null}|null} args.dailyImport
 * @param {Date|string|number} args.now
 * @param {number} [args.quietMs]
 * @returns {{skip: boolean, reason: string, dailyImportId: string|null, quietForMs: number|null}}
 */
export function decideCaptureThrottle({ openPositions, dailyImport, now, quietMs = QUIET_MS }) {
  const keep = (reason) => ({ skip: false, reason, dailyImportId: dailyImport?.id || null, quietForMs: null });

  // Rule 1. The settled close, and the only capture the storm was trying to
  // produce. It is written even if it arrives one second after the last one.
  if (openPositions?.open !== true) return keep('settled_capture');
  // Rule 2. Nothing is the day yet.
  if (!dailyImport?.id) return keep('no_daily_import_yet');
  // A closed day is not ours to skip OR to write: the persist path refuses it
  // with its own error and the desk gets a named refusal rather than a silent
  // no-op. Left to the existing branch on purpose.
  if (dailyImport.status === 'Closed') return keep('closed_day');

  const writtenAt = parseTime(dailyImport.updatedAt);
  const reference = parseTime(now);
  // An unreadable timestamp is not evidence that the day is fresh. Write it.
  if (writtenAt === null || reference === null) return keep('unknown_daily_import_age');

  const quietFor = reference - writtenAt;
  // Rule 3. Also covers a clock that went backwards: a negative age is not a
  // fresh day, it is an unusable measurement, so the capture is written.
  if (quietFor < 0 || quietFor >= quietMs) return keep('day_is_stale');

  return { skip: true, reason: THROTTLE_REASON, dailyImportId: dailyImport.id, quietForMs: quietFor };
}

/* What the batch records about itself when it is skipped. `completeness` is
 * free-form jsonb with no shape constraint (step_28_auto_collection.sql:188)
 * and every admin endpoint passes it through, so the desk can count shed
 * captures per device without a column that does not exist in production. */
export function throttledCompleteness(metadata, decision) {
  return {
    isComplete: metadata?.isComplete ?? null,
    emptySections: metadata?.emptySections ?? [],
    openPositions: metadata?.openPositions ?? null,
    throttled: {
      skipped: true,
      reason: decision.reason,
      quietForMs: decision.quietForMs,
    },
  };
}

/* The same three keys the processed and superseded branches have always
 * written, plus the one the CRM was already computing and discarding. Adding a
 * key is additive: the consumers read named fields, none compares shapes. */
export function completenessWithOpenPositions(metadata) {
  return {
    isComplete: metadata?.isComplete ?? null,
    emptySections: metadata?.emptySections ?? [],
    openPositions: metadata?.openPositions ?? null,
  };
}
