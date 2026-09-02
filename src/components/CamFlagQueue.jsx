import { CheckCircle2, Clock3 } from 'lucide-react';
import { OUTCOME_PROMPTS } from '../domain/accountOutcomeStamp';
import {
  buildCamFlagQueue,
  flagActivityEntry,
  flagGroupActivityEntry,
  flagResolutionPlan,
} from '../domain/camFlagQueue';
import { QUIET_SHAPES, buildQuietAccounts, quietEvidenceForFlag } from '../domain/quietAccounts';

/** The one flag type this file reads evidence back for. reconcile.js:582. */
const MISSING_ACCOUNT = 'Missing account';
const TARGET_REACHED = 'Evaluation target reached';

// WHICH FLAG ASKS WHICH QUESTION.
//
// These two are the only moments where the desk knows something the book does
// not: a balance crossed its target, or an account it was running stopped
// appearing. Both are the outcome of an account, and neither is recorded today.
// 48 accounts are marked Failed and 1 carries a date, because nobody was ever
// asked at the moment there was something to answer.
//
// Answering writes the outcome AND resolves the flag, because a CAM who has
// just said "it failed" has answered the flag too, and making them click twice
// is how a book ends up with resolved flags and unclassified accounts.
const OUTCOME_QUESTION = {
  [TARGET_REACHED]: OUTCOME_PROMPTS.TARGET_REACHED,
  [MISSING_ACCOUNT]: OUTCOME_PROMPTS.WENT_MISSING,
};

/**
 * How a shape renders on a flag row.
 *
 * `noop` is the important one and it is not cosmetic. 26 of the 106 open
 * Missing account problems on this book are flags with nothing behind them — 20
 * stand on a close the account did not yet exist on, and 6 are on accounts that
 * are back in their client's latest close. They read as work and they are not.
 */
const EVIDENCE_TONE = {
  [QUIET_SHAPES.PAST_DRAWDOWN]: 'past',
  [QUIET_SHAPES.NOT_YET_REGISTERED]: 'noop',
  [QUIET_SHAPES.REPORTING_AGAIN]: 'noop',
  [QUIET_SHAPES.NEVER_REPORTED]: 'noop',
};

/**
 * The record behind a `Missing account` flag, read back out of the closes.
 *
 * WHY THE EVIDENCE IS READ BACK HERE. The flag carries one sentence — "<alias>
 * existed before but did not appear in this close" — and nothing to act on,
 * which is how 106 of them stay open across 19 clients on this book, held in 309
 * flag rows. Everything needed to tell them apart is already in
 * account_snapshots. Rewriting reconcile's message instead would only reach
 * imports reconciled after the change: the 309 rows already in operational_flags
 * keep the sentence they were stored with, and buildCamFlagQueue groups by
 * message, so a reworded flag would split every live problem into an old row and
 * a new one and leave the historical half exactly as unreadable as it is now.
 *
 * A MODULE CACHE AND NOT useMemo, deliberately. This component is called as a
 * plain function by its own tests — no DOM, no renderer — precisely because the
 * defect it was written for is about which ids a click sends, and that cannot be
 * read off markup. A hook here would throw on every one of those calls. The
 * WeakMap is keyed on the `clients` array itself, so it holds for as long as the
 * caller's array identity does and never keeps a client alive.
 *
 * The sweep behind it is 51 ms for 96 clients and 485 closes on this book.
 */
const EVIDENCE_CACHE = new WeakMap();

function quietEvidenceModel(clients, asOfDate) {
  if (!Array.isArray(clients)) return null;
  const cached = EVIDENCE_CACHE.get(clients);
  if (cached && cached.asOfDate === asOfDate) return cached.model;
  const entry = { asOfDate, model: buildQuietAccounts(clients, { asOf: asOfDate }) };
  EVIDENCE_CACHE.set(clients, entry);
  return entry.model;
}

/**
 * The CAM's own flag queue: every open flag they hold, closable from here.
 *
 * Until now a CAM could see flags and not close them. CamOverview counts them
 * in a tile and prints the top one on each briefing card, and clicking the card
 * navigates away; the only Resolve buttons in the app are the manager's table
 * and the client Dashboard, and the Dashboard's handler reads the client and
 * the import from `selectedClient`/`dailyImport`, so it only ever closes flags
 * on the day the date picker happens to be showing. With the real book (last
 * close 2026-07-30, "today" 2026-08-11) that picker opens on a day with no
 * import at all, so the handler returns on its first line and the button does
 * nothing until the CAM finds the flag's own date by hand.
 *
 * Every button here sends (clientId, importId, flagId) taken from the row, so
 * what gets closed is the flag that was clicked and not whatever is on screen.
 *
 * No component state on purpose. Grouping uses <details>, so the whole
 * component is a pure function of its props and a test can call it, find a
 * button and fire its onClick without a DOM — which is how the ids a click
 * actually sends are asserted rather than assumed.
 */
/* ── Answering the outcome, not just clearing the flag ─────────────────────
 *
 * NOT A DEFAULT AND NOT A GUESS. The button states the outcome the CAM is
 * claiming and writes only that. The desk's own lifecycle module refuses to
 * decide this from evidence for good reason: 30 of the 48 accounts already
 * marked Failed still appear in their client's latest close and 25 of those
 * traded in it. A wrong "this is dead" on a live funded account costs far more
 * than an unanswered question, so nothing is preselected and Resolve stays.
 *
 * WRITTEN INLINE, not as a component. This file's suite calls CamFlagQueue as a
 * plain function and walks the returned tree, which is what lets it assert the
 * ids a click actually sends. A sub-component is an unrendered node in that
 * tree, so a button inside one is invisible to every test here.
 * ------------------------------------------------------------------------- */

export default function CamFlagQueue({
  clients = [],
  today = null,
  queue = null,
  onResolveFlag,
  onClassifyAccount = null,
  onLogClientActivity = null,
  onSelectClient = null,
  defaultOpenGroups = 3,
}) {
  // A date is always available, so age is always measurable: the fallback is
  // the real clock, never a silent 0.
  const asOfDate = today || new Date().toISOString().slice(0, 10);
  const model = queue || buildCamFlagQueue(clients, { today: asOfDate });
  const { totals, groups, buckets } = model;

  // Only built when there is a Missing account group to answer at all.
  const evidence = groups.some((group) => group.type === MISSING_ACCOUNT)
    ? quietEvidenceModel(clients, asOfDate)
    : null;

  /**
   * Fire an activity write without letting it become an unhandled rejection.
   *
   * App.jsx wires `onLogClientActivity` to `persistActivity`, whose catch block
   * alerts AND rethrows. Every existing caller ignores the returned promise, so
   * a failed Supabase insert already surfaces twice — once as the alert and once
   * as an unhandled rejection. One click here can fire a whole group's worth, so
   * the promise is swallowed at this boundary; the alert is still the user's
   * signal and the flag write itself has its own error path.
   */
  function logActivity(clientId, entry) {
    if (!onLogClientActivity || !entry) return;
    try {
      const result = onLogClientActivity(clientId, entry);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // Already reported by the handler itself.
    }
  }

  // Resolve is the only thing these buttons do. There used to be an Acknowledge
  // beside each one — "seen, hide for now" — and the desk manager took it out:
  // it wrote a second status that every count in the app already treated as
  // Resolved, so the two buttons closed the flag in the same way while looking
  // like a choice. Neither function takes a status any more, so there is nothing
  // for a future caller to pass.
  function applyRow(row) {
    if (!onResolveFlag) return;
    // One call per open occurrence. A problem still open on eleven closes has
    // eleven rows in operational_flags with eleven different uuids, and
    // updateSupabaseOperationalFlag patches one uuid per call. Closing only the
    // newest is what leaves 597 historical copies Open in Postgres and keeps
    // the all-history counter reading 1,952 for a book with 253 live problems.
    for (const call of flagResolutionPlan(row)) {
      onResolveFlag(call.clientId, call.importId, call.flagId);
    }
    logActivity(row.clientId, flagActivityEntry(row));
  }

  function applyGroup(group) {
    if (!onResolveFlag) return;
    for (const row of group.rows) {
      for (const call of flagResolutionPlan(row)) {
        onResolveFlag(call.clientId, call.importId, call.flagId);
      }
    }
    // One summary line per group, the same shape handleBulkResolveFlags writes
    // for a whole import. Nineteen separate "flag resolved" entries for one
    // click would bury the client's log under the tool that made them.
    logActivity(group.clientId, flagGroupActivityEntry(group));
  }

  if (!totals.rows) {
    return (
      <section className="panel">
        <div className="panel-heading">
          <h3>Open flags · my clients</h3>
          <span className="badge success">0 open</span>
        </div>
        <p className="muted" style={{ margin: '6px 0 0' }}>
          Nothing open across {clients.length} client{clients.length === 1 ? '' : 's'}
          {model.latestClose ? ` up to ${model.latestClose}` : ''}.
        </p>
      </section>
    );
  }

  return (
    <section className="panel" data-testid="cam-flag-queue">
      <div className="panel-heading">
        <h3>Open flags · my clients</h3>
        <span className={`badge ${totals.critical ? 'danger' : 'warning'}`}>
          {totals.rows} open{totals.critical ? ` · ${totals.critical} critical` : ''}
        </span>
      </div>

      <p className="muted" style={{ margin: '6px 0 0', fontSize: 12 }}>
        {totals.rows} problem{totals.rows === 1 ? '' : 's'} across {totals.clients} client
        {totals.clients === 1 ? '' : 's'}, held in {totals.occurrences} flag record
        {totals.occurrences === 1 ? '' : 's'} — the same problem is written again into every
        close it survives, so the record count is always the larger number.
        {' '}
        {totals.behindLatestClose > 0 ? (
          <strong>
            {totals.behindLatestClose} of them are no longer on their client&apos;s latest close,
            so nothing else in the app can reach them.
          </strong>
        ) : null}
      </p>

      <p className="muted" style={{ margin: '4px 0 0', fontSize: 12 }}>
        <Clock3 size={12} /> Age counted to {model.asOf || 'today'}
        {model.latestClose ? `, latest close in the book ${model.latestClose}` : ''} ·{' '}
        {buckets.map((bucket) => `${bucket.label} ${bucket.rows}`).join(' · ')}
        {totals.oldestDays === null ? ' · oldest not measured' : ` · oldest ${totals.oldestDays}d`}
      </p>

      {groups.map((group, index) => (
        <details
          key={group.key}
          className="flag-queue-group"
          open={index < defaultOpenGroups}
          style={{ marginTop: 10, borderTop: '1px solid var(--line)', paddingTop: 8 }}
        >
          <summary style={{ cursor: 'pointer' }}>
            <strong>{group.type}</strong>{' '}
            {onSelectClient ? (
              <button
                type="button"
                className="link-button"
                data-action="open-client"
                data-client-id={group.clientId}
                onClick={(event) => {
                  event.preventDefault();
                  onSelectClient(group.clientId);
                }}
              >
                {group.clientName}
              </button>
            ) : (
              <span>{group.clientName}</span>
            )}
            <span className="muted" style={{ fontSize: 12 }}>
              {' '}· {group.total} flag{group.total === 1 ? '' : 's'}
              {group.critical ? ` · ${group.critical} critical` : ''}
              {' '}· oldest {group.oldestDays === null ? 'not measured' : `${group.oldestDays}d`}
              {' '}· raised {group.firstSeen}
              {group.lastSeen !== group.firstSeen ? ` → ${group.lastSeen}` : ''}
              {group.behindLatestClose
                ? ` · ${group.behindLatestClose} behind the ${group.clientLatestClose} close`
                : ''}
            </span>
          </summary>

          {/* The button says how many rows AND how many records, because they
              differ by a factor of seven at the top of this book: Oakley Larch's
              "Missing account" group is 14 problems held in 98 flag rows, so one
              click fires 98 patches. A button labelled "Resolve all 14" that
              writes 98 times is understating what it does by 84 writes. */}
          <div style={{ display: 'flex', gap: 8, margin: '6px 0', alignItems: 'center' }}>
            <button
              type="button"
              className="resolve-button"
              data-action="resolve-group"
              data-group-key={group.key}
              data-write-calls={group.occurrences}
              style={{ fontSize: 11, whiteSpace: 'nowrap' }}
              onClick={() => applyGroup(group)}
            >
              <CheckCircle2 size={13} /> Resolve all {group.total}
            </button>
            <span className="muted" style={{ fontSize: 11 }}>
              {group.occurrences === group.total
                ? `${group.occurrences} flag record${group.occurrences === 1 ? '' : 's'}`
                : `writes ${group.occurrences} flag records — these ${group.total} problems are held on ${group.occurrences} rows across the closes they survived`}
            </span>
          </div>

          <div className="ops-table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Account</th>
                  <th>Flag</th>
                  <th>Age</th>
                  <th>From</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {group.rows.map((row) => (
                  <tr
                    key={row.key}
                    data-row-key={row.key}
                    style={
                      row.severity === 'Critical'
                        ? { background: 'var(--red-dim, rgba(239,68,68,.06))' }
                        : undefined
                    }
                  >
                    <td>
                      <span className={`badge ${row.severity === 'Critical' ? 'danger' : 'warning'}`}>
                        {row.severity}
                      </span>
                    </td>
                    <td className="muted">{row.accountName || '—'}</td>
                    <td>
                      {row.message || row.type}
                      <FlagEvidence group={group} row={row} model={evidence} />
                    </td>
                    <td className="muted">
                      {/* null is "could not be dated", not "raised today". */}
                      {row.ageDays === null ? 'not measured' : `${row.ageDays}d`}
                    </td>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                      {row.clientName} · {row.firstSeen}
                      {row.lastSeen !== row.firstSeen ? ` → ${row.lastSeen}` : ''}
                      {row.occurrences.length > 1 ? ` · ${row.occurrences.length} records` : ''}
                      {row.onLatestClose ? '' : ` · behind ${row.clientLatestClose}`}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button
                        type="button"
                        className="resolve-button"
                        data-action="resolve-row"
                        data-row-key={row.key}
                        data-client-id={row.clientId}
                        style={{ fontSize: 11, whiteSpace: 'nowrap' }}
                        onClick={() => applyRow(row)}
                      >
                        <CheckCircle2 size={13} /> Resolve
                      </button>
                      {(() => {
                        const prompt = OUTCOME_QUESTION[group.type] || OUTCOME_QUESTION[row.type];
                        // Only where there is an account to write to. A Missing
                        // account row with no accountName is a book problem, not
                        // an outcome.
                        if (!prompt || !onClassifyAccount || !row.accountName || !row.clientId) return null;
                        return (
                          <button
                            type="button"
                            className="ghost-button"
                            data-action="classify-account"
                            data-outcome-type={group.type || row.type}
                            data-account-name={row.accountName}
                            data-client-id={row.clientId}
                            title={prompt.question}
                            style={{ fontSize: 11, whiteSpace: 'nowrap', marginLeft: 6 }}
                            onClick={() => {
                              onClassifyAccount(row.clientId, row.accountName, { ...prompt.patch });
                              applyRow(row);
                            }}
                          >
                            {prompt.confirmLabel}
                          </button>
                        );
                      })()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ))}

      {/*
        The closing receipt, with the window it was measured over printed beside
        the count.

        It used to read "0 flags were closed in the last 7 days", which on this
        book is a true zero for a window that does not touch the data: "today" is
        2026-08-11, the last close is 2026-07-30, and 2,970 flags were closed in
        the seven days up to that close. A bare 0 there reads as "nobody works
        this queue" — the same "0 fields compared" mistake as a measurement that
        never ran. The window and the book's own last resolution are both named
        so the two readings cannot be confused.
      */}
      <p className="muted" style={{ marginTop: 10, fontSize: 12 }}>
        Nothing here is deleted. Resolving writes status and resolved_at onto the flag and an
        entry into the client&apos;s activity log, so a closed flag can still be read back —{' '}
        {totals.recentlyClosed} flag{totals.recentlyClosed === 1 ? '' : 's'} closed
        {model.closedWindow?.from
          ? ` between ${model.closedWindow.from} and ${model.closedWindow.to}`
          : ' on this book'}
        .{' '}
        {!totals.recentlyClosed && model.lastClosedOn ? (
          <>
            That window is empty, but the queue is not untouched: {model.closedTotal} flag
            {model.closedTotal === 1 ? ' is' : 's are'} already closed on this book and the most
            recent one is dated {model.lastClosedOn}, {' '}
            {model.latestClose === model.lastClosedOn
              ? 'the last close on file'
              : `against a last close of ${model.latestClose}`}. The window is measured from
            today; the data stops earlier.
          </>
        ) : null}
        {!totals.recentlyClosed && !model.lastClosedOn && model.closedTotal ? (
          <>
            {model.closedTotal} flag{model.closedTotal === 1 ? ' is' : 's are'} closed on this book
            but none carries a resolved_at date, so when they were closed is not measured — it is
            not that nothing was closed.
          </>
        ) : null}
      </p>
    </section>
  );
}

/**
 * The line the `Missing account` flag never carried.
 *
 * Rendered UNDER the stored message, never in place of it: the message is what
 * was written into operational_flags at the time and rewriting it on screen
 * would hide the fact that the flag itself says nothing. This is the read-back.
 *
 * Silent when there is nothing to read. 2 of the 106 open problems here name an
 * account with no registry row and no snapshot under that name, and a line
 * saying "nothing found" would be a claim about an account we cannot see.
 */
function FlagEvidence({ group, row, model }) {
  if (!model || group.type !== MISSING_ACCOUNT) return null;
  const evidence = quietEvidenceForFlag(model, row);
  if (!evidence) return null;
  const tone = EVIDENCE_TONE[evidence.shape] || 'healthy';
  return (
    <span className={`flag-evidence flag-evidence-${tone}`} data-shape={evidence.shape}>
      <strong>{evidence.label}.</strong> {evidence.evidenceLine}
      {/* The collection fact travels beside the account fact, never instead of
          it. On this book all 7 flags that sit on a zero-row close are also
          flags on accounts that did not exist that day, and printing only one of
          the two would leave a CAM chasing the other. */}
      {evidence.collection && evidence.shape !== QUIET_SHAPES.CLIENT_FILED_NOTHING ? (
        <> The {evidence.collection.date} close for this client carried no account rows at all.</>
      ) : null}
    </span>
  );
}
