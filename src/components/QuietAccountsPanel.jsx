import { useMemo } from 'react';
import {
  QUIET_SHAPES,
  QUIET_SHAPE_LABELS,
  QUIET_SHAPE_TEXT,
  buildQuietAccounts,
} from '../domain/quietAccounts';

/**
 * The accounts a CAM has to see separately from the working book.
 *
 * Two kinds live here and neither had anywhere to live before. One is not real
 * money — simulation accounts, which today appear only inside
 * SimulationReportSection, a client-facing report block behind an opt-in toggle,
 * and in no account view at all. The other is not reporting: 122 accounts on
 * this book stopped filing and stayed gone for two or more of their client's own
 * closes, and the only trace of them in the product is a `Missing account` flag
 * reading "<alias> existed before but did not appear in this close" — 106 open
 * problems held in 309 flag rows, with nothing on them to act on.
 *
 * WHAT THIS PANEL REFUSES TO SAY. It never says failed. Of the 195 accounts on
 * this book that went quiet for two closes or more, 141 were healthy on the last
 * close they filed and 52 were past their trailing drawdown, so "missing means
 * failed" is wrong about 143 of them — and even the 52 are evidence rather than
 * a verdict, because 143 accounts here are past their limit with nobody having
 * marked them Failed and 30 accounts the desk HAS marked Failed still turn up in
 * closes. The two shapes are rendered differently so the difference is readable
 * at a glance; neither is rendered as a conclusion.
 *
 * COLLECTION COMES FIRST, ON PURPOSE. 24 of the 96 clients here have stopped
 * filing imports altogether, 136 registered accounts between them, and not one
 * of those accounts can raise a Missing account flag — a flag needs a close and
 * there is no close. That is one question for one person per client, and putting
 * it under the account list would be the same mistake the flag makes.
 */

const SHAPE_GROUPS = [
  {
    shape: QUIET_SHAPES.PAST_DRAWDOWN,
    tone: 'past',
    title: 'Past its drawdown on the close it went quiet',
  },
  {
    shape: QUIET_SHAPES.HEALTHY,
    tone: 'healthy',
    title: 'Healthy on the close it went quiet',
  },
  {
    shape: QUIET_SHAPES.NEVER_MEASURED,
    tone: 'unmeasured',
    title: 'Buffer never measured',
  },
  {
    shape: QUIET_SHAPES.NO_DRAWDOWN_RULE,
    tone: 'unmeasured',
    title: 'Cash accounts — no drawdown rule to read',
  },
];

function money(value) {
  // null is "not on file", and it must never render as $0. The whole reason the
  // drawdown column is read with `=== 0 -> null` upstream is that 585 of the
  // 3,100 snapshot rows here carry a zero that means "no column", not "no
  // buffer".
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const rounded = Math.round(Number(value));
  return `${rounded < 0 ? '-' : ''}$${Math.abs(rounded).toLocaleString('en-US')}`;
}

export default function QuietAccountsPanel({
  clients = [],
  asOfDate = '',
  absentCloses = 2,
  limit = 10,
}) {
  const model = useMemo(
    () => buildQuietAccounts(clients, { asOf: asOfDate, absentCloses }),
    [clients, asOfDate, absentCloses],
  );

  const { counts, collection, setAsideQuiet } = model;
  if (!counts.accountsOnRecord) {
    return <p className="muted chart-empty">No accounts on file for this book yet.</p>;
  }

  const groups = SHAPE_GROUPS
    .map((group) => ({ ...group, rows: model.accounts.filter((row) => row.shape === group.shape) }))
    .filter((group) => group.rows.length);

  const cohorts = model.cohorts.filter((cohort) => cohort.accounts >= 3);

  return (
    <div className="drift-panel">
      <p className="drift-intro">
        {/*
          TWO NUMBERS, NOT ONE. 195 of the 718 accounts on this book have filed
          nothing for two or more of their client's closes; 122 of them are
          listed. The other 73 are 61 shelved as Inactive / Ignore and 12 with no
          registry row, and they are counted apart at the bottom of this panel.
          This line used to read "122 of 718 accounts have filed nothing for 2 or
          more closes", which states the listed number as if it were the measured
          one — a reader checking it against the shelved count below would find
          the panel contradicting itself.
        */}
        <strong>{counts.quiet}</strong> of the {counts.quietOnRecord} accounts that have filed
        nothing for {absentCloses} or more of their client&apos;s own closes are listed here
        {counts.quietSetAside ? (
          <span className="muted">
            {' '}(the other {counts.quietSetAside} are set aside below: {setAsideQuiet.ignore}{' '}
            shelved, {setAsideQuiet.unregistered} with no registry row
            {setAsideQuiet.simulation ? `, ${setAsideQuiet.simulation} simulated` : ''})
          </span>
        ) : null}
        , out of {counts.accountsOnRecord} accounts on record, across {counts.clientsWithQuiet} of
        the {counts.clientsWithCloses} clients that have any close at all
        {/* The date the evidence reaches, never the date on the picker. The ops
            screen seeds its picker from the wall clock and this book ends
            2026-07-30, so the two differ by twelve days on every load. */}
        {model.asOf ? <> · closes to {model.asOf}</> : null}
        {model.bound && model.asOf && model.bound !== model.asOf ? (
          <span className="muted"> (nothing closed between {model.asOf} and {model.bound})</span>
        ) : null}.{' '}
        <span className="muted">
          {counts.quietShapes[QUIET_SHAPES.PAST_DRAWDOWN]} were past their drawdown when they went
          quiet · {counts.quietShapes[QUIET_SHAPES.HEALTHY]} were healthy ·{' '}
          {counts.quietShapes[QUIET_SHAPES.NEVER_MEASURED]} never measured ·{' '}
          {counts.quietShapes[QUIET_SHAPES.NO_DRAWDOWN_RULE]} cash
        </span>
      </p>

      <p className="drift-ask">
        Not one row here says failed, and none of them may be read that way. A negative buffer on the
        last close is the strongest evidence this book carries and it is still evidence: the desk
        holds accounts past their limit that nobody has marked Failed, and accounts marked Failed
        that are still trading. What each row states is what the last close said and when it said it.
      </p>

      <CollectionBlock collection={collection} counts={counts} absentCloses={absentCloses} />

      {cohorts.length ? <CohortBlock cohorts={cohorts} total={counts.quiet} /> : null}

      {groups.map((group) => (
        <ShapeGroup key={group.shape} group={group} limit={limit} />
      ))}

      <SimulationBlock model={model} />

      <CountedApartBlock model={model} />
    </div>
  );
}

/**
 * The collection half, above the accounts.
 *
 * "The account went quiet" and "the client stopped filing" are different claims
 * and the second one is not N account problems. On this book it is 24 clients
 * and 136 accounts, and every one of those absences is invisible to the flag
 * that is supposed to catch them.
 */
function CollectionBlock({ collection, counts, absentCloses }) {
  const { stoppedFiling, filedNothing } = collection;
  if (!stoppedFiling.length && !filedNothing.length) return null;

  return (
    <section className="drift-row quiet-collection">
      <div className="drift-head">
        <strong>Chase the collection, not the accounts</strong>
        <span className="drift-count">
          {stoppedFiling.length} client{stoppedFiling.length === 1 ? '' : 's'} ·{' '}
          {counts.stoppedFilingAccounts} account{counts.stoppedFilingAccounts === 1 ? '' : 's'}
        </span>
      </div>
      <p className="drift-majority">
        <span className="muted">
          These are one question per client, not one per account. A client with no import on a desk
          date has no close for an account to be absent from, so nothing in the account views —
          including the Missing account flag — can reach any of them.
        </span>
      </p>

      {stoppedFiling.length ? (
        <ul className="drift-accounts">
          {stoppedFiling
            .slice()
            .sort((a, b) => b.deskDatesMissed - a.deskDatesMissed || b.registered - a.registered)
            .map((entry) => (
              <li key={entry.key}>
                <strong>{entry.clientName}</strong>
                <span className="drift-account-numbers">
                  {entry.neverFiledAnyRow
                    ? `has imports but has never filed a single account row`
                    : `last filed ${entry.lastFiled}`}
                  {' · '}
                  {/*
                    "no ACCOUNT ROWS", not "no import", and the difference is not
                    pedantic: deskDatesMissed counts dates with nothing on file
                    for this client, and 5 of the 24 clients here DID lodge an
                    import on one of those dates that carried zero account rows.
                    The line used to read "Reese North has imports but has never
                    filed a single account row · no import on 14 of the 14 dates
                    the desk filed" — one sentence contradicting itself, about a
                    client whose import on 2026-07-13 is sitting in the table
                    right below.
                  */}
                  no account rows on {entry.deskDatesMissed} of the {entry.deskDates} dates the desk
                  filed
                  {' · '}
                  {entry.registered} account{entry.registered === 1 ? '' : 's'} on its record
                </span>
              </li>
            ))}
        </ul>
      ) : null}

      {filedNothing.length ? (
        <details className="drift-rest">
          <summary>
            {filedNothing.length} close{filedNothing.length === 1 ? '' : 's'} carried an import and
            zero account rows — covering {counts.filedNothingAccounts} account
            {counts.filedNothingAccounts === 1 ? '' : 's'} that existed on the day
          </summary>
          <div className="drift-rest-body">
            <ul className="drift-accounts">
              {filedNothing.map((entry) => (
                <li key={entry.key}>
                  <strong>
                    {entry.clientName} {entry.date}
                  </strong>
                  <span className="drift-account-numbers">
                    {/*
                      Measured, and it changes the reading completely: all 8 of
                      these closes cover ZERO accounts. Reese North's only close
                      is 2026-07-13 and all 7 of its registry rows carry
                      date_added 2026-07-16, so the day is not a lost day — the
                      client had no accounts yet. reconcile.js raises a Missing
                      account flag per row anyway, because its registry sweep
                      applies no existence rule.
                    */}
                    {entry.accountsCovered
                      ? `${entry.accountsCovered} of ${entry.registered} accounts on the record existed that day`
                      : entry.registered
                        ? `none of its ${entry.registered} account${entry.registered === 1 ? '' : 's'} existed yet on that date`
                        : 'it has no accounts on its record at all'}
                    {entry.notYetRegistered
                      ? ` · ${entry.notYetRegistered} registered later`
                      : ''}
                    {entry.shelved ? ` · ${entry.shelved} shelved` : ''}
                    {entry.isLastClose ? ' · the last close this client filed' : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </details>
      ) : null}
      {/* The overlap, stated rather than papered over. A client can be in this
          block AND own accounts in the list below: the account went quiet inside
          the closes the client did file, and the client then stopped filing
          altogether. Both are true, and 2 of the 122 accounts below are in it. */}
      <p className="drift-build">
        Absence below is counted in {absentCloses} or more of a client&apos;s own closes, so a client
        with no closes to be absent from appears only here.{' '}
        {counts.quietOnClientsThatStoppedFiling
          ? `${counts.quietOnClientsThatStoppedFiling} of the ${counts.quiet} accounts below belong to a client on this list as well — they went quiet while it was still filing, and it has since stopped. Their rows say so.`
          : 'No account below belongs to a client on this list.'}
      </p>
    </section>
  );
}

/**
 * Accounts of one client that stopped on the SAME close.
 *
 * Rendered before the per-account list because it is the thing the flag cannot
 * say. Oakley Larch has 13 accounts whose last close is 2026-07-22, out of the
 * 20 that filed it — thirteen flags for what is far more likely to be one event.
 * The strongest form of it is stated separately: when EVERY account that filed a
 * close never filed again, that is a machine, a connection or a rename, and
 * Jordan Cedar 2026-07-15 is exactly that (8 of 8 gone, a different set of 5
 * filing every close since).
 */
function CohortBlock({ cohorts, total }) {
  const inCohorts = cohorts.reduce((sum, cohort) => sum + cohort.accounts, 0);
  return (
    <section className="drift-row quiet-cohorts">
      <div className="drift-head">
        <strong>Stopped together, on the same close</strong>
        <span className="drift-count">
          {inCohorts} of {total} accounts
        </span>
      </div>
      <p className="drift-majority">
        <span className="muted">
          Three or more accounts of one client whose last close is the same day. Worth one look
          before {inCohorts} separate ones.
        </span>
      </p>
      <ul className="drift-accounts">
        {cohorts.map((cohort) => (
          <li key={cohort.key}>
            <strong>{cohort.clientName}</strong>
            <span className="drift-account-numbers">
              {cohort.accounts} account{cohort.accounts === 1 ? '' : 's'} last filed{' '}
              {cohort.lastSeenDate} · {cohort.neverReturnedThatClose} of the{' '}
              {cohort.reportedThatClose} that filed that close never filed again · absent{' '}
              {cohort.closesSinceSeen} close{cohort.closesSinceSeen === 1 ? '' : 's'}
            </span>
            {cohort.wholeClose ? (
              <span className="badge danger">every account that filed it stopped</span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ShapeGroup({ group, limit }) {
  const head = group.rows.slice(0, limit);
  const rest = group.rows.slice(limit);
  return (
    <section className={`drift-row quiet-shape quiet-shape-${group.tone}`}>
      <div className="drift-head">
        <strong>{group.title}</strong>
        <span className="drift-count">{group.rows.length} to read</span>
      </div>
      <p className="drift-majority">
        <span className="muted">{QUIET_SHAPE_TEXT[group.shape]}</span>
      </p>
      <ul className="drift-groups">
        {head.map((row) => (
          <QuietRow key={row.key} row={row} tone={group.tone} />
        ))}
      </ul>
      {rest.length ? (
        <details className="drift-rest">
          <summary>
            {rest.length} more in this group, largest balance first — the order is money at rest, not
            how sure the evidence is, so the bottom of the list is not the safe end of it.
          </summary>
          <div className="drift-rest-body">
            <ul className="drift-groups">
              {rest.map((row) => (
                <QuietRow key={row.key} row={row} tone={group.tone} />
              ))}
            </ul>
          </div>
        </details>
      ) : null}
    </section>
  );
}

/**
 * One account, with the four facts the flag never carried: the last close it
 * appeared in, what its trailing drawdown read then, its balance then, and how
 * many closes have passed.
 */
function QuietRow({ row, tone }) {
  return (
    <li className="drift-group">
      <details>
        <summary>
          <span className="drift-summary-body">
            <span className="drift-group-head">
              <span className="drift-group-count">{row.clientName}</span>
              <code>{row.accountName}</code>
              <span className="drift-more">{row.accountType || 'no type set'}</span>
              {row.declaredFailed ? (
                <span className="badge danger">status Failed</span>
              ) : (
                <span className="badge muted">status {row.status || 'Active'}</span>
              )}
              <span className={`quiet-chip quiet-chip-${tone}`}>{QUIET_SHAPE_LABELS[row.shape]}</span>
              {/*
                THE CHIP SAYS "when it went quiet" AND THE READING IS OLDER THAN
                THAT. 2 of the 122 rows here — Harper Juniper CCF23009250154227
                (quiet after 2026-07-20) and EKG54594881787638 (2026-07-27) —
                carried trailing_max_drawdown 0 on the very close they went quiet
                on, so the buffer quoted is their last real one, from 2026-07-13:
                7 and 14 days earlier. The evidence line says so and the detail
                table says so, but the chip beside the account name is what gets
                read at a glance and on its own it claims more than the book
                holds. A $2,000 buffer can be gone in fourteen days, and "it was
                fine" about an account that is already past its limit is the one
                mistake on this panel that costs money.
              */}
              {row.buffer.value !== null && !row.buffer.fromLastSeenClose ? (
                <span className="badge warning">reading predates that close</span>
              ) : null}
              {/* Both stories at once, and the client-level one is the bigger:
                  this account went quiet while its client was still filing, and
                  its client has since stopped filing altogether. */}
              {row.clientStoppedFiling ? (
                <span className="badge muted">client has since stopped filing</span>
              ) : null}
            </span>
            <span className="drift-headline">{row.evidenceLine}</span>
          </span>
        </summary>
        <div className="drift-detail">
          <div className="drift-table-wrap">
            <table className="drift-table">
              <thead>
                <tr>
                  <th scope="col">Evidence</th>
                  <th scope="col">
                    What the book holds
                    <em>{row.closes} close{row.closes === 1 ? '' : 's'} for this client</em>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">last close it appeared in</th>
                  <td>
                    {row.lastSeenDate} · {row.seenCloses} of {row.closes} closes
                    {row.skippedCloses
                      ? ` · it missed ${row.skippedCloses} inside its own span and came back`
                      : ''}
                  </td>
                </tr>
                <tr>
                  <th scope="row">
                    {row.buffer.model === 'limit' ? 'drawdown vs limit' : 'trailing buffer'} then
                    {row.buffer.date && !row.buffer.fromLastSeenClose ? (
                      <em>read on {row.buffer.date}, an earlier close</em>
                    ) : null}
                  </th>
                  <td className={row.buffer.breached === true ? 'drift-here' : undefined}>
                    {/* "never reported" is not a zero and must not read like one. */}
                    {row.buffer.value === null ? (
                      <span className="drift-absent">
                        {row.cash
                          ? 'a cash account has no trailing drawdown rule'
                          : 'never measured — the column read 0 on every close it filed'}
                      </span>
                    ) : row.buffer.model === 'limit' ? (
                      `${money(row.buffer.value)} of ${money(row.buffer.limit)}`
                    ) : (
                      money(row.buffer.value)
                    )}
                  </td>
                </tr>
                <tr>
                  <th scope="row">balance then</th>
                  <td>
                    {money(row.balanceThen)}
                    {row.realizedThen === null || row.realizedThen === undefined
                      ? ''
                      : ` · realized ${money(row.realizedThen)} that close`}
                  </td>
                </tr>
                <tr>
                  <th scope="row">closes since</th>
                  <td>
                    {row.closesSinceSeen === null
                      ? <span className="drift-absent">not measured</span>
                      : `${row.closesSinceSeen} of this client's ${row.closes}`}
                    {/* An absence is only the account's own where the client
                        was actually being collected. 0 here would mean every
                        close it has missed was an empty import — a collection
                        gap wearing an account's name. */}
                    {row.absentClosesWithRows === null
                      ? ''
                      : ` · ${row.absentClosesWithRows} of them carried account rows`}
                  </td>
                </tr>
                <tr>
                  <th scope="row">last traded</th>
                  <td>
                    {row.lastTradeDate
                      ? row.lastTradeDate
                      : (
                        <span className="drift-absent">
                          {row.tradeEvidence === 'unknown'
                            ? 'not known — the order tables are not loaded'
                            : 'never, in the closes we hold'}
                        </span>
                      )}
                  </td>
                </tr>
                <tr>
                  <th scope="row">on the record since</th>
                  <td>
                    {row.existsFrom || <span className="drift-absent">not known</span>}
                    {row.existsFromBasis ? ` (${row.existsFromBasis})` : ''}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {row.clientFiledNothingOnLastSeen ? (
            <p className="drift-build">
              Its last close carried no account rows at all, so this absence starts with the
              collection and not with the account.
            </p>
          ) : null}
        </div>
      </details>
    </li>
  );
}

/**
 * Simulation accounts, the other thing that has to be read apart from the book.
 *
 * Rendered with its counts even when empty, because "no simulation accounts" and
 * "we did not look" are different claims and the second one is what an absent
 * block says. On public/local-snapshot.json this is a real zero: the redaction
 * renames every account, and the only signal that recognises a simulator today
 * is NinjaTrader's own Sim<number> naming (11 of 11 on the unredacted exports,
 * 0 of 685 registry rows here).
 */
function SimulationBlock({ model }) {
  const { counts, simulation } = model;
  return (
    <section className="drift-row quiet-simulation">
      <div className="drift-head">
        <strong>Simulation accounts</strong>
        <span className="drift-count">
          {counts.simulation} of {counts.accountsOnRecord}
        </span>
      </div>
      <p className="drift-majority">
        <span className="muted">
          Not real money, and not in any total on this screen. They are absent from most closes by
          design — a simulator only appears in the grid while somebody has it loaded — so they can
          never be a missing account and are never counted as one.
        </span>
      </p>
      {simulation.length ? (
        <ul className="drift-accounts">
          {simulation.map((row) => (
            <li key={row.key}>
              <strong>{row.clientName}</strong>
              <code>{row.accountName}</code>
              <span className="badge muted">{row.natureLabel}</span>
              <span className="drift-account-numbers">
                {row.closesSeen
                  ? `last loaded ${row.lastSeenDate} · ${row.closesSeen} of ${row.closes} closes · ${money(row.balance)} simulated · ${row.orders} order${row.orders === 1 ? '' : 's'}, ${row.executions} execution${row.executions === 1 ? '' : 's'}`
                  : `never loaded in any of this client's ${row.closes} closes · no balance on file`}
                {row.heuristic ? ` · recognised by name only: ${row.natureReason}` : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="drift-build">
          {/*
            This sentence was false until the `Boolean(meta) &&` guard came off
            the classifier in quietAccounts.js: 685 of the 718 were tested and
            the 33 with no registry row were skipped, which are precisely the
            ones with no account_type and nothing but a name to go on. All 718
            are tested now, so the count and the claim are the same number.
          */}
          Every one of the {counts.accountsOnRecord} accounts on this book was classified and none
          came back simulated
          {counts.simulationUndetermined
            ? `, with ${counts.simulationUndetermined} that could not be decided either way`
            : ', and none was left undecided'}
          . That is a measured zero, not an unchecked one.
        </p>
      )}
    </section>
  );
}

/**
 * What was deliberately left off the list, counted.
 *
 * The honest half. 84 shelved accounts, 33 with no registry row and 10 that have
 * never appeared in a close are all absent from every close, and every one of
 * them would read as a collection failure in the headline above. They are not,
 * and the reasons have to be readable for the headline to be trustworthy.
 */
function CountedApartBlock({ model }) {
  const { countedApart, setAsideQuiet, counts, neverReported, cameBack } = model;
  // Each entry carries how many of it WENT QUIET, not just how many exist. 84
  // accounts are shelved; 61 of those are ones the headline above is leaving
  // out, and the difference between those two numbers is the whole reason this
  // block exists.
  const entries = [
    ['Shelved as Inactive / Ignore', countedApart.ignore, setAsideQuiet.ignore, 'Marked by the desk as not in use. Absent from every close by intent — they are a shelf, not a collection failure.'],
    ['No registry row', countedApart.unregistered, setAsideQuiet.unregistered, 'Trades under a name the registry does not hold, so there is no record for it to be missing from. Hard-deleting an account is what creates these.'],
    ['Registered after the last close', countedApart.notYetRegistered, 0, 'The earliest date they can be shown to have existed is after the last close on file, so they could not have reported. Counting them absent would invent the absence.'],
    ['No provable start date', countedApart.existenceUnknown, 0, 'Neither a date_added nor a close they appear in, so there is no date to measure an absence from. Not counted absent and not counted as registered late either — the two are different claims.'],
    ['Simulation', countedApart.simulation, setAsideQuiet.simulation, 'Not real money and absent by design.'],
  ].filter((entry) => entry[1] > 0);

  if (!entries.length && !neverReported.length && !cameBack.length) return null;

  return (
    <details className="drift-rest">
      <summary>
        {counts.neverReported} account{counts.neverReported === 1 ? '' : 's'} have never appeared in
        any close, {counts.cameBack} went quiet and came back, and{' '}
        {entries.reduce((sum, entry) => sum + entry[1], 0)} were deliberately left off the list — the
        reasons, counted
      </summary>
      <div className="drift-rest-body">
        {neverReported.length ? (
          <div>
            <p className="drift-build">
              <strong>Never seen in any close.</strong> These have not stopped — they have not
              started, and the flag that says &ldquo;existed before&rdquo; is wrong about every one
              of them.
            </p>
            <ul className="drift-accounts">
              {neverReported.map((row) => (
                <li key={row.key}>
                  <strong>{row.clientName}</strong>
                  <code>{row.accountName}</code>
                  <span className="drift-account-numbers">
                    {row.accountType || 'no type set'} · on the record since {row.existsFrom} (
                    {row.existsFromBasis}) · {row.closes} close
                    {row.closes === 1 ? '' : 's'} on file for this client
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {cameBack.length ? (
          <div>
            <p className="drift-build">
              <strong>Went quiet and came back.</strong> Absence is reversible and this is the proof:
              every one of these is in its client&apos;s latest close, having missed at least one
              before it.
            </p>
            <ul className="drift-accounts">
              {cameBack.map((row) => (
                <li key={row.key}>
                  <strong>{row.clientName}</strong>
                  <code>{row.accountName}</code>
                  <span className="drift-account-numbers">
                    missed {row.skippedCloses} close{row.skippedCloses === 1 ? '' : 's'} inside its
                    own span · reporting again on {row.lastSeenDate}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {entries.length ? (
          <ul className="drift-accounts">
            {entries.map(([label, count, quietOfThem, text]) => (
              <li key={label}>
                <strong>
                  {count} · {label}
                </strong>
                <span className="drift-account-numbers">
                  {quietOfThem
                    ? `${quietOfThem} of them went quiet for two or more closes and are not in the list above. `
                    : ''}
                  {text}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </details>
  );
}
