import { ATTENTION_VERDICTS } from './trackerCloseComparison';
import { addFlagToImport, removeFlagFromImport } from './crmStateStore';
import { insertSupabaseOperationalFlag } from './supabaseStore';
import { formatCurrency } from './report';

/* ────────────────────────────────────────────────────────────────────────────
 * "ADD FLAG" ON A ROW THE TRACKER AND THE CLOSE DISAGREE ABOUT.
 *
 * The comparison is read only; a CAM who wants the desk to act on a row puts
 * it into the flag queue, where every other problem of the book already lives
 * and where it is closed the way every other flag is closed. This is the
 * queue's own path in the other direction: createCamFlagResolver patches the
 * state, writes one uuid and audits it; this patches the state, inserts one
 * row and audits it, and undoes the patch when the write fails, so a flag that
 * was never written never stays on screen as if it had been.
 *
 * THE TITLE IS THE MESSAGE. "Tracker and close differ on ACC 01 by $140" is
 * what the queue prints, groups by and resolves; the figures behind it stay on
 * the panel. Whole dollars, no dashes, no verdict stronger than "differ".
 *
 * Pure except for the injected writers: no React.
 * ──────────────────────────────────────────────────────────────────────────── */

export const TRACKER_CLOSE_FLAG_TYPE = 'Tracker differs from the close';

function whole(value) {
  return formatCurrency(Math.abs(Number(value) || 0));
}

/** The one sentence the flag carries, or null when the row asks for nothing. */
export function trackerCloseFlagTitle(row) {
  if (!row) return null;
  const account = row.accountName;
  switch (row.verdict) {
    case 'differs':
      return `Tracker and close differ on ${account} by ${whole(row.delta)}`;
    case 'tracker_reset':
      return `Tracker reset seen on ${account}: tracker ${whole(row.tracker?.realized)} against close ${whole(row.close?.realized)}`;
    case 'tracker_only':
      return `Tracker saw ${account} at the close but the close does not list it`;
    case 'close_only':
      return `Close lists ${account} but the tracker had no reading before the capture`;
    case 'stale_reading':
      return `Tracker reading for ${account} was stale at the close`;
    default:
      break;
  }
  const flags = Array.isArray(row.flags) ? row.flags : [];
  if (flags.includes('algo_moved')) return `An algorithm on ${account} moved between the tracker and the close`;
  if (flags.includes('strategies_differ')) return `Strategies on ${account} differ between the tracker and the close`;
  if (flags.includes('connection_differs')) return `Connection on ${account} differs between the tracker and the close`;
  return null;
}

function newFlagId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

/**
 * The flag for one attention row, in the shape operational_flags and the
 * queue read: a uuid Postgres accepts (reconcile.js's lesson), Warning, Open.
 */
export function buildTrackerCloseFlag(row, { id = null } = {}) {
  if (!row || !(row.attention || ATTENTION_VERDICTS.has(row.verdict))) return null;
  const message = trackerCloseFlagTitle(row);
  if (!message) return null;
  return {
    id: id || newFlagId(),
    type: TRACKER_CLOSE_FLAG_TYPE,
    severity: 'Warning',
    accountName: row.accountName || '',
    message,
    status: 'Open',
  };
}

/**
 * The onAddFlag the panels are wired with: (clientId, importId, flag).
 *
 * Everything is injected so this can be tested without a database, and so
 * App.jsx keeps passing its own setState and audit helper.
 */
export function createTrackerCloseFlagAdder({
  setState = null,
  patchState = addFlagToImport,
  unpatchState = removeFlagFromImport,
  insertFlag = insertSupabaseOperationalFlag,
  audit = null,
  onError = null,
  source = 'tracker-close',
} = {}) {
  return function addFlag(clientId, importId, flag) {
    if (!clientId || !importId || !flag?.message) {
      const error = new Error(
        `Adding a flag needs a client, an import and a message (got ${clientId || 'null'}, ${importId || 'null'}, ${flag?.message ? 'a message' : 'no message'}).`,
      );
      if (onError) onError(error);
      else throw error;
      return null;
    }
    if (setState && patchState) setState((current) => patchState(current, clientId, importId, flag));
    return Promise.resolve()
      .then(() => insertFlag(clientId, importId, flag))
      .then((result) => {
        if (audit) {
          audit({
            entityType: 'operational_flag',
            entityId: flag.id,
            action: 'flag.create',
            afterData: {
              clientId, importId, flagId: flag.id, type: flag.type, accountName: flag.accountName, message: flag.message, source,
            },
          });
        }
        return result;
      })
      .catch((error) => {
        // Put the row back: the patch above is optimistic, and a flag that was
        // never written must not stay in the queue as if it had been.
        if (setState && unpatchState) setState((current) => unpatchState(current, clientId, importId, flag.id));
        if (onError) onError(error);
        else throw error;
        return null;
      });
  };
}
