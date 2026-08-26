/**
 * What the sidebar actually says about the connection.
 *
 * THE DEFECT THIS EXISTS FOR
 *
 * The pass that separated a failed save from a failed refresh wrote the honest
 * sentence for the second case — "<the close> saved. The view could not be
 * refreshed (429 Too Many Requests) — your change is safe, but anything other
 * people changed may be missing until the next refresh." — stored it on
 * remoteStatus.message, and then never rendered it. `remoteStatus.message`
 * appeared nowhere in src/. The sidebar read the STATUS alone, through a
 * three-way ternary:
 *
 *     connected ? "Supabase" : loading ? "Connecting..." : "Supabase required"
 *
 * so the new "stale" state fell through to the same four words as a hard
 * error. A user whose refresh was rate-limited — whose edit is saved, whose
 * screen is correct, and who needs to do nothing — was told exactly what a user
 * with no database connection is told. That is the confusion the whole pass
 * exists to remove, surviving in the one place the user actually looks.
 *
 * Splitting the mapping out of the JSX is what makes it testable: the defect
 * was a ternary with no home of its own, and a fourth state added to a ternary
 * is a defect that cannot be caught by anything but reading it.
 */

/** The four states remoteStatus can hold, and what each one means to a user. */
const STATES = {
  connected: { tone: 'positive', showsMessage: false },
  loading: { tone: '', showsMessage: false },
  // Saved, on screen, and possibly behind on other people's work. Not an error,
  // and above all not the same words as one.
  stale: { tone: 'warning', showsMessage: true },
  error: { tone: 'negative', showsMessage: true },
};

/**
 * @param {{source?: string, status?: string, message?: string}} remoteStatus
 * @returns {{label: string, tone: string, detail: string}}
 *          `label` names the data source in two or three words; `detail` is the
 *          sentence the user acts on, empty when there is nothing to act on.
 */
export function describeRemoteStatus(remoteStatus = {}) {
  const status = remoteStatus.status || 'loading';
  const state = STATES[status] || STATES.error;
  const message = remoteStatus.message || '';
  const local = remoteStatus.source === 'local-snapshot';

  let label;
  if (status === 'connected') label = local ? 'Local snapshot' : 'Supabase';
  else if (status === 'loading') label = 'Connecting...';
  else if (status === 'stale') label = 'Showing older data';
  else label = local ? 'Snapshot unavailable' : 'Supabase required';

  return {
    label,
    tone: state.tone,
    detail: state.showsMessage ? message : '',
  };
}
