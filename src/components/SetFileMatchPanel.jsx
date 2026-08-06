import { useMemo } from 'react';
import { buildSetFileMatch, MATCH, VERSION_IDENTITY } from '../domain/setFileMatch';
import { buildSynthesizedReference, REFERENCE } from '../domain/synthesizedReference';
import {
  buildNoteFor,
  countAccounts,
  describeChangeRow,
  describeParameter,
  formatParameterValue,
  headlineFor,
  rollUpAccounts,
} from '../domain/configDriftPresentation';

/**
 * Which catalogued version each account is running, and which accounts are on
 * none.
 *
 * The sibling of ConfigDriftPanel and deliberately built in its idiom — same
 * <details> rows, same tables, same class names — because it answers the other
 * half of the same question. The drift panel compares accounts to each other and
 * can only say who is unusual; this one compares them to the desk's 911 set
 * files and can say what they are on.
 *
 * Worded as a question throughout. On the real book 168 of 619 rows sit on a
 * catalogued version with a setting or two changed, and most of that is
 * deliberate: 43 of the 54 RBO rows share the same two changes, which is one
 * question about the library rather than 43 about clients. Anything here that
 * read as "wrong" would train a CAM to dismiss the panel, which is worse than
 * not having one.
 *
 * The two numbers that must never be conflated: EXACT is a count, and the field
 * intersection each match was decided on is printed beside it. A match on 11 of
 * 31 fields (Bullet Bot) and one on 48 of 50 (MotusTemplar) are not the same
 * claim, and 118 of this book's 329 exact matches are the 11-field kind.
 */
export default function SetFileMatchPanel({ clients = [], asOfDate = '', limit = 8 }) {
  const view = useMemo(() => {
    const result = buildSetFileMatch(clients, { asOfDate });
    return {
      ...buildMatchView(result, { limit }),
      // Same result object, so the catalogued section and the observed one are
      // gated on one set of classifications rather than on two computations that
      // could disagree about which rows the library can speak to.
      observed: buildObservedView(buildSynthesizedReference(clients, { asOfDate, match: result })),
    };
  }, [clients, asOfDate, limit]);

  const { totals, families, rest, notMeasured, provenance, observed } = view;

  if (!totals.rows) {
    return <p className="muted chart-empty">No strategy rows to compare against the set-file library.</p>;
  }

  return (
    <div className="drift-panel">
      <p className="drift-intro">
        <strong>{totals.onCatalogedVersion}</strong> of {totals.measuredRows} measured strategy row
        {totals.measuredRows === 1 ? '' : 's'} run a version that is in the desk's set-file library
        — <strong>{totals.exact}</strong> on it exactly, {totals.near} with settings changed.{' '}
        <strong>{totals.none}</strong> run no catalogued version.
        {totals.undetermined ? ` ${totals.undetermined} could not be compared.` : ''}
        {totals.notMeasured ? (
          <>
            {' '}
            <span
              className="muted"
              title="These families have no folder in the set-file library, so there is nothing to compare them against. Not measured is not the same as uncatalogued."
            >
              ({totals.notMeasured} more row{totals.notMeasured === 1 ? '' : 's'} not measured)
            </span>
          </>
        ) : null}
      </p>
      <p className="drift-ask">
        This is a list to verify, not a fault list. The desk customises clients on purpose, so a
        setting that differs from the file is a question — was it asked for? — and a configuration
        no file carries is the question worth the most time. Risk level is expected to vary: an
        account on a version at Medium sizing is on that version, and the sizing it runs is named.
      </p>

      {notMeasured.length ? (
        <p className="drift-recurring">
          <strong>Not measured:</strong>{' '}
          {notMeasured.map((family, index) => (
            <span key={family.family}>
              {index ? ', ' : ''}
              {family.family} ({family.rows} row{family.rows === 1 ? '' : 's'}, {family.accounts}{' '}
              account{family.accounts === 1 ? '' : 's'})
            </span>
          ))}
          . The library has no folder for {notMeasured.length === 1 ? 'it' : 'them'}, so nothing the
          desk wrote can say what these accounts should be running. They are not uncatalogued — they
          are unmeasured, and the two must not be read as the same finding.
          {observed.cohorts.length ? (
            <> Observed references for {observed.cohorts.length === 1 ? 'it' : 'them'} are at the
              bottom of this panel, derived from the accounts rather than from the library.
            </>
          ) : null}
        </p>
      ) : null}

      <RollUp
        title="By algorithm"
        rows={view.rollup.families}
        nameOf={(row) => row.family}
        noteOf={(row) => (row.measured ? null : 'no folder in the library')}
      />
      <RollUp
        title="By instrument"
        rows={view.rollup.instruments}
        nameOf={(row) => row.instrument}
        noteOf={(row) => (row.catalogued ? null : 'no template for this symbol')}
      />

      {families.map((family) => (
        <FamilyRow key={family.key} family={family} />
      ))}

      {rest.length ? (
        <details className="drift-rest">
          <summary>
            {rest.length} more famil{rest.length === 1 ? 'y' : 'ies'} with fewer rows to verify —
            the count is rows, not distance from the library, so a single account can be the
            furthest off the book.
          </summary>
          <div className="drift-rest-body">
            {rest.map((family) => (
              <FamilyRow key={family.key} family={family} />
            ))}
          </div>
        </details>
      ) : null}

      <ObservedSection observed={observed} />

      <p className="drift-ask">
        Matched against {provenance.files} set files holding {provenance.distinctConfigurations}{' '}
        distinct parameter sets. A match names a parameter set, never one file: Periods 0/1/2 are
        identical in all {provenance.ambiguity?.periodsIdentical} named variants measured, and all{' '}
        {provenance.ambiguity?.pfTwinsIdentical} prop-firm twins are identical to their twin, so the
        strategy name is the only thing that separates them.
      </p>
    </div>
  );
}

/**
 * The manager's two lines of sight: which algorithms are on the book's own
 * library, and which instruments are.
 *
 * Every row states its own denominator. "N of M on a catalogued version" where M
 * is the MEASURED rows, never the total: G4M's 47 rows have no folder in the
 * library, and rolling them in would report the book as 496 of 619 rather than
 * 496 of 572 — a worse number produced by counting rows nothing was measured on.
 */
function RollUp({ title, rows, nameOf, noteOf }) {
  if (!rows.length) return null;
  return (
    <div className="drift-table-wrap">
      <table className="drift-table">
        <thead>
          <tr>
            <th scope="col">{title}</th>
            <th scope="col">
              Accounts
              <em>rows</em>
            </th>
            <th scope="col">
              On a catalogued version
              <em>of rows measured</em>
            </th>
            <th scope="col">
              Exactly
              <em>every shared field</em>
            </th>
            {/* Everything that is not an exact match, which is what the family
                sections below count too. Two meanings of "to verify" on one
                screen — one counting only the uncatalogued rows and one
                counting the adjusted ones as well — would make the panel
                disagree with itself in the reader's head. */}
            <th scope="col">
              To verify
              <em>not an exact match</em>
            </th>
            <th scope="col">
              Fields compared
              <em>both sides carry</em>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const note = noteOf(row);
            return (
              <tr key={nameOf(row)}>
                <th scope="row">
                  {nameOf(row)}
                  {note ? <em>{note}</em> : null}
                </th>
                <td>
                  {row.accounts}
                  {row.rows === row.accounts ? '' : ` (${row.rows})`}
                </td>
                <td>
                  {row.measuredRows
                    ? `${row.onCatalogedVersion} of ${row.measuredRows}`
                    : <span className="drift-absent">not measured</span>}
                </td>
                <td>{row.measuredRows ? row.exact : <span className="drift-absent">—</span>}</td>
                <td className="drift-here">
                  {row.measuredRows
                    ? row.measuredRows - row.exact
                    : <span className="drift-absent">—</span>}
                </td>
                <td>
                  {row.fieldsCompared
                    ? (row.fieldsCompared.min === row.fieldsCompared.max
                      ? row.fieldsCompared.min
                      : `${row.fieldsCompared.min}–${row.fieldsCompared.max}`)
                    : <span className="drift-absent">—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FamilyRow({ family }) {
  return (
    <section className="drift-row">
      <div className="drift-head">
        <strong>{family.family}</strong>
        {family.catalogFamily && family.catalogFamily !== family.family ? (
          <span className="muted" title="The book and the library spell this family differently.">
            {family.catalogFamily} in the library
          </span>
        ) : null}
        <span className="drift-count">
          {family.verifyRows} to verify
        </span>
      </div>
      <p className="drift-majority">
        <span className="muted">
          {family.onCatalogedVersion} of {family.measuredRows} row
          {family.measuredRows === 1 ? '' : 's'} on a catalogued version
        </span>
        {family.fieldsCompared ? (
          <span
            className="badge muted"
            title="How many parameters the account's export and the set file both carry. Every match here was decided on this many fields and no more."
          >
            {family.fieldsCompared.min === family.fieldsCompared.max
              ? `${family.fieldsCompared.min} fields compared`
              : `${family.fieldsCompared.min}–${family.fieldsCompared.max} fields compared`}
          </span>
        ) : null}
      </p>

      {family.recurring ? (
        <p className="drift-recurring">
          <strong>
            One question covers {family.recurring.rows} of the {family.recurring.ofDiffering} rows
            that differ.
          </strong>{' '}
          They all differ from their closest set file in the same{' '}
          {family.recurring.changes.length === 1 ? 'setting' : `${family.recurring.changes.length} settings`}
          {family.recurring.changes.map((change, index) => (
            <span key={change.name}>
              {index ? ', ' : ' — '}
              {change.mapped ? change.label : <code>{change.name}</code>}{' '}
              {change.liveValues.length === 1 ? (
                <>
                  <code>{change.liveValues[0]}</code> here
                </>
              ) : (
                <>
                  {change.liveValues.length} different values here (
                  {change.liveValues.map((value, at) => (
                    <span key={value}>
                      {at ? ', ' : ''}
                      <code>{value}</code>
                    </span>
                  ))}
                  )
                </>
              )}{' '}
              against{' '}
              {change.catalogValues.map((value, at) => (
                <span key={value}>
                  {at ? ' / ' : ''}
                  <code>{value}</code>
                </span>
              ))}{' '}
              in the file
            </span>
          ))}
          .{' '}
          {family.recurring.sameValues
            ? `${family.recurring.rows} accounts changed `
              + `${family.recurring.changes.length === 1 ? 'the same setting to the same value' : 'the same settings to the same values'}`
              + ' is more likely one decision the library has not caught up with than '
              + `${family.recurring.rows} separate customisations — worth settling once.`
            : `The value is not the same on all ${family.recurring.rows}, so this is one setting to `
              + 'ask about rather than one answer — the rows below carry each account\'s own value.'}
        </p>
      ) : null}

      {family.exactByFile.length ? (
        <details className="drift-rest">
          <summary>
            {family.exact} row{family.exact === 1 ? '' : 's'} match a set file exactly, across{' '}
            {family.exactByFile.length} configuration
            {family.exactByFile.length === 1 ? '' : 's'} — nothing to do, listed so the version each
            account is on is on record.
          </summary>
          <ul className="drift-accounts">
            {family.exactByFile.map((entry) => (
              <li key={entry.key}>
                <strong>{entry.count}</strong>
                <span>{entry.label}</span>
                <span className="drift-account-numbers">
                  {entry.comparedFields} of {entry.liveFieldCount} exported fields compared
                  {entry.parameterCount ? `, file carries ${entry.parameterCount}` : ''}
                  {entry.periods.length > 1 ? ` · Periods ${entry.periods.join('/')} identical` : ''}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <ul className="drift-groups">
        {family.groups.map((group) => (
          <li key={group.key} className="drift-group">
            <details>
              <summary>
                <span className="drift-summary-body">
                  <span className="drift-group-head">
                    <span
                      className="drift-group-count"
                      title={group.tally.unnamedRows
                        ? `${group.tally.accounts} identified account${group.tally.accounts === 1 ? '' : 's'} and ${group.tally.unnamedRows} strategy row${group.tally.unnamedRows === 1 ? '' : 's'} with no trading account on the import.`
                        : undefined}
                    >
                      {group.count} account{group.count === 1 ? '' : 's'}
                    </span>
                    <span className={`badge ${group.tone}`}>{group.classLabel}</span>
                    {/* Only when a comparison actually happened. `comparedFields`
                        is null on a row whose export carried no readable
                        parameters, and rendering that as `0 fields compared`
                        states a measurement that was never made — the reader
                        cannot tell it apart from a genuine empty intersection.
                        98 of the snapshot's 3805 strategy rows carry no
                        parameters_raw; none is in a latest import today, so this
                        renders on 0 of 619 rows and on every one of those 98 the
                        day they are. */}
                    {group.comparedFields === null ? (
                      <span className="drift-more drift-absent">nothing to compare</span>
                    ) : (
                      <span className="drift-more">
                        {group.comparedFields} field{group.comparedFields === 1 ? '' : 's'} compared
                      </span>
                    )}
                  </span>
                  <span className="drift-headline">{group.headline}</span>
                  {group.note ? <span className="drift-build">{group.note}</span> : null}
                  <span className="drift-who muted">{group.whoLine}</span>
                </span>
              </summary>
              <div className="drift-detail">
                {group.changes.length ? (
                  <div className="drift-table-wrap">
                    <table className="drift-table">
                      <thead>
                        <tr>
                          <th scope="col">Setting</th>
                          <th scope="col">
                            Set file
                            <em>{group.matchLabel}</em>
                          </th>
                          <th scope="col">
                            These {group.count}
                            <em>account{group.count === 1 ? '' : 's'}</em>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.changes.map((change) => (
                          <tr key={change.name}>
                            <th scope="row">
                              {change.mapped ? (
                                change.label
                              ) : (
                                <code title="No safe plain-language name for this parameter — shown exactly as the strategy writes it.">
                                  {change.name}
                                </code>
                              )}
                              {change.unit ? <em>{change.unit}</em> : null}
                              {change.identity ? (
                                <em title="Profit targets and the stop are what identify a version on this desk. A difference here means this is not that version, not that a setting was tweaked.">
                                  version identity
                                </em>
                              ) : null}
                              {change.sizing ? (
                                <em title="Position sizing is the risk level, not the version. The same version at a different size is still that version.">
                                  sizing
                                </em>
                              ) : null}
                            </th>
                            <td>
                              {change.absentInCohort ? (
                                <span className="drift-absent">not in this file</span>
                              ) : (
                                change.cohort
                              )}
                            </td>
                            <td className="drift-here">
                              {change.absentHere ? (
                                <span className="drift-absent">not in this export</span>
                              ) : (
                                change.here
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}

                {group.separating.length ? (
                  <p className="drift-build">
                    Would separate them:{' '}
                    {group.separating.map((field, index) => (
                      <span key={field.name}>
                        {index ? ', ' : ''}
                        <code>{field.name}</code>
                        {field.inLiveExport ? '' : ' (not in this export)'}
                      </span>
                    ))}
                    .
                  </p>
                ) : null}

                <p className="drift-build">
                  {group.evidence}
                </p>

                <ul className="drift-accounts">
                  {group.clients.map((client) => (
                    <li key={client.clientId}>
                      <strong>{client.clientName}</strong>
                      {client.accounts.length ? (
                        <span className="drift-account-numbers">{client.accounts.join('  ')}</span>
                      ) : null}
                      {client.unnamedRows ? (
                        <span className="drift-absent">
                          {client.unnamedRows} row{client.unnamedRows === 1 ? '' : 's'} with no
                          account number on the import
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ── Observed references ──────────────────────────────────────────────────── */

/**
 * The families the library does not hold, checked against themselves.
 *
 * A separate section rather than more rows in the list above, and it is not a
 * styling preference. Every row above is an account measured against something
 * the desk WROTE. Every row here is an account measured against what its
 * neighbours HAPPEN to do. Mixed into one list, a CAM would carry the authority
 * of the first kind onto the second — and the second kind's failure mode is
 * silent: a cohort that all moved together produces a reference that moved with
 * it and a section that reports agreement.
 *
 * So: its own box, a dashed rule, the word "observed" on the section, on every
 * cohort head and on every group badge, and no set-file name, version number or
 * risk level anywhere inside it. Those are claims only the library can make.
 */
function ObservedSection({ observed }) {
  if (!observed.cohorts.length) return null;
  const { totals } = observed;

  return (
    <section className="drift-observed">
      <div className="drift-observed-head">
        <strong>Observed references</strong>
        <span
          className="badge observed"
          title="Derived from the accounts on this book, not from the desk's set-file library."
        >
          observed, not catalogued
        </span>
        {/* "0 to verify" beside a cohort nothing could be measured on is the
            same claim as "0 fields compared" on an unreadable export: a zero
            where there is no measurement. When no cohort in this section
            produced a reference, there is no count to state. */}
        {totals.withReference ? (
          <span
            className="drift-count"
            title={totals.withoutReference
              ? `${totals.withoutReference} of these cohorts produced no reference at all and are outside this count.`
              : undefined}
          >
            {/* Accounts, and it says the word. Every chip under this head counts
                accounts, and the domain's row count is a different number
                whenever one account exports twice — which happens on this book.
                A bare number here that disagreed with the chips below it would
                be unresolvable by the reader. */}
            {totals.toVerifyAccounts} account
            {totals.toVerifyAccounts === 1 ? '' : 's'} to verify
          </span>
        ) : (
          <span className="drift-count muted">no reference established</span>
        )}
      </div>
      <p className="drift-observed-warn">
        These {totals.cohorts === 1 ? 'accounts run a family' : 'accounts run families'} the library
        has no folder for, so there is nothing the desk wrote to check them against. What follows is
        not a set file: it is the configuration the accounts themselves converge on, read off this
        book. It states what the cohort does, never what the desk decided — and if a cohort was
        changed together, the reference changed with it and everything below will read as agreeing.
        Use it to find the account that stands apart, not to confirm a family is correct.
      </p>

      {observed.cohorts.map((cohort) => (
        <ObservedCohort key={cohort.key} cohort={cohort} />
      ))}
    </section>
  );
}

function ObservedCohort({ cohort }) {
  return (
    <section className="drift-row drift-observed-row">
      <div className="drift-head">
        <strong>{cohort.family}</strong>
        <span className="muted">{cohort.instrument}</span>
        <span className="badge observed">observed</span>
        {cohort.reference ? (
          <span className="drift-count">
            {cohort.verifyAccounts} account{cohort.verifyAccounts === 1 ? '' : 's'} to verify
          </span>
        ) : (
          <span className="drift-count muted">no reference</span>
        )}
      </div>

      {cohort.reference ? (
        <>
          <p className="drift-majority">
            <span className="muted">
              {cohort.reference.rows} of {cohort.rows} row{cohort.rows === 1 ? '' : 's'} (
              {cohort.reference.share}%) run the same configuration
            </span>
            <span
              className="badge muted"
              title="How many separate configurations the cohort splits into. A high share across 3 configurations is a different claim from the same share across 16."
            >
              {cohort.distinctConfigurations} configuration
              {cohort.distinctConfigurations === 1 ? '' : 's'} across {cohort.accounts} account
              {cohort.accounts === 1 ? '' : 's'}
            </span>
          </p>

          <p className="drift-observed-fact">
            {cohort.identityLine} {cohort.fieldsLine}
          </p>

          {cohort.historyLine ? (
            <p className="drift-observed-fact">{cohort.historyLine}</p>
          ) : null}

          <details className="drift-rest">
            <summary>
              {/* The table below has one row per COMPARED setting, so that is the
                  number stated here. The reference's own field count is the
                  smaller one whenever a minority build carries settings the
                  reference has no field for, and heading a 7-row table "4
                  settings" is the mismatch this panel exists not to make. */}
              The observed reference — {cohort.reference.comparedFieldCount} setting
              {cohort.reference.comparedFieldCount === 1 ? '' : 's'}
              {cohort.reference.fieldCount === cohort.reference.comparedFieldCount
                ? ''
                : `, ${cohort.reference.fieldCount} of them carried by the reference itself`}
              , and how many rows carry each. Not a set file: no version, no risk level, no
              filename, because the library has none to give.
            </summary>
            <div className="drift-table-wrap">
              <table className="drift-table">
                <thead>
                  <tr>
                    <th scope="col">Setting</th>
                    <th scope="col">
                      Observed reference
                      <em>the majority configuration</em>
                    </th>
                    <th scope="col">
                      Across the cohort
                      <em>rows carrying each value</em>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {cohort.referenceFields.map((field) => (
                    <tr key={field.name}>
                      <th scope="row">
                        {field.mapped ? (
                          field.label
                        ) : (
                          <code title="No safe plain-language name for this parameter — shown exactly as the strategy writes it.">
                            {field.name}
                          </code>
                        )}
                        {field.unit ? <em>{field.unit}</em> : null}
                        {field.identity ? (
                          <em title="Profit targets and the stop are what identify a version on this desk.">
                            version identity
                          </em>
                        ) : null}
                      </th>
                      <td>
                        {/* A setting the reference has no field for is stated,
                            never dashed. An em dash in a value column reads as
                            "blank" or as zero, and "the reference does not carry
                            this" is neither. Same wording as the diff table
                            below, which already had it right. */}
                        {field.absentFromReference ? (
                          <span className="drift-absent">not in the reference</span>
                        ) : (
                          field.value
                        )}
                      </td>
                      <td className={field.unanimous ? '' : 'drift-here'}>
                        {field.unanimous ? (
                          <span className="muted">every row</span>
                        ) : (
                          /* `value · rows`, not `value on N rows`. The prose form
                             renders a toggle as "on on 2 rows" and an absent
                             field as "not in that build on 14 rows"; every
                             toggle on this desk (Martingale, Break-even,
                             Re-entry, the seven weekday filters) hits it as soon
                             as it varies. */
                          field.spread.map((entry, index) => (
                            <span key={entry.value}>
                              {index ? ', ' : ''}
                              {entry.value} · {entry.rows} row{entry.rows === 1 ? '' : 's'}
                            </span>
                          ))
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      ) : (
        <p className="drift-recurring drift-observed-none">{cohort.noReferenceLine}</p>
      )}

      {cohort.groups.length ? (
        <ul className="drift-groups">
          {cohort.groups.map((group) => (
            <li key={group.key} className="drift-group">
              <details>
                <summary>
                  <span className="drift-summary-body">
                    <span className="drift-group-head">
                      <span
                        className="drift-group-count"
                        title={group.tally.unnamedRows
                          ? `${group.tally.accounts} identified account${group.tally.accounts === 1 ? '' : 's'} and ${group.tally.unnamedRows} strategy row${group.tally.unnamedRows === 1 ? '' : 's'} with no trading account on the import.`
                          : undefined}
                      >
                        {group.count} account{group.count === 1 ? '' : 's'}
                      </span>
                      <span className={`badge ${group.tone}`}>{group.classLabel}</span>
                      <span
                        className="drift-more"
                        title={`${group.rows} of the cohort's ${cohort.rows} strategy rows. The count beside it is accounts, which is the smaller number whenever one account exports twice.`}
                      >
                        {group.share}% of the cohort
                      </span>
                    </span>
                    <span className="drift-headline">{group.headline}</span>
                    <span className="drift-build">{group.reading}</span>
                    {group.note ? <span className="drift-build">{group.note}</span> : null}
                    <span className="drift-who muted">{group.whoLine}</span>
                  </span>
                </summary>
                <div className="drift-detail">
                  {group.changes.length ? (
                    <div className="drift-table-wrap">
                      <table className="drift-table">
                        <thead>
                          <tr>
                            <th scope="col">Setting</th>
                            <th scope="col">
                              Observed reference
                              <em>{cohort.reference.rows} rows of {cohort.rows}</em>
                            </th>
                            <th scope="col">
                              These {group.count}
                              <em>account{group.count === 1 ? '' : 's'}</em>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.changes.map((change) => (
                            <tr key={change.name}>
                              <th scope="row">
                                {change.mapped ? (
                                  change.label
                                ) : (
                                  <code title="No safe plain-language name for this parameter — shown exactly as the strategy writes it.">
                                    {change.name}
                                  </code>
                                )}
                                {change.unit ? <em>{change.unit}</em> : null}
                                {change.identity ? (
                                  <em title="Profit targets and the stop are what identify a version on this desk. A difference here is a different version, not a tweak.">
                                    version identity
                                  </em>
                                ) : null}
                              </th>
                              <td>
                                {change.absentInCohort ? (
                                  <span className="drift-absent">not in the reference</span>
                                ) : (
                                  change.cohort
                                )}
                              </td>
                              <td className="drift-here">
                                {change.absentHere ? (
                                  <span className="drift-absent">not in this export</span>
                                ) : (
                                  change.here
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}

                  <p className="drift-build">{group.evidence}</p>

                  <ul className="drift-accounts">
                    {group.clients.map((client) => (
                      <li key={client.clientId}>
                        <strong>{client.clientName}</strong>
                        {client.accounts.length ? (
                          <span className="drift-account-numbers">{client.accounts.join('  ')}</span>
                        ) : null}
                        {client.unnamedRows ? (
                          <span className="drift-absent">
                            {client.unnamedRows} row{client.unnamedRows === 1 ? '' : 's'} with no
                            account number on the import
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              </details>
            </li>
          ))}
        </ul>
      ) : null}

      {cohort.reference && !cohort.groups.length ? (
        <p className="drift-observed-fact">
          Every row in this cohort runs the reference configuration — which is what makes it the
          reference, not evidence that it is right. A cohort that agrees with itself is the one case
          this comparison can say nothing about.
        </p>
      ) : null}

      <p className="drift-observed-fact muted">{cohort.provenanceLine}</p>
    </section>
  );
}

/* ── View model ───────────────────────────────────────────────────────────── */

const CLASS_LABEL = {
  [MATCH.NONE]: 'no catalogued version',
  [MATCH.NEAR]: 'on a version, settings changed',
  [MATCH.AMBIGUOUS]: 'more than one version fits',
  [MATCH.UNDETERMINED]: 'not enough shared fields',
};

/**
 * Amber for everything, never red.
 *
 * Same rule the drift panel settled on: a configuration that differs from the
 * library is a question. `info` for the two classes that are statements about
 * the evidence rather than about the account — an ambiguous match and a thin
 * intersection are the panel's limits, not the account's.
 */
const CLASS_TONE = {
  [MATCH.NONE]: 'warning',
  [MATCH.NEAR]: 'muted',
  [MATCH.AMBIGUOUS]: 'info',
  [MATCH.UNDETERMINED]: 'info',
};

const VERIFY_ORDER = [MATCH.NONE, MATCH.AMBIGUOUS, MATCH.UNDETERMINED, MATCH.NEAR];

/**
 * The badge, which has to agree with the headline beside it.
 *
 * UNDETERMINED covers two different answers and the badge said only one of them.
 * A row whose export carried nothing readable was badged "not enough shared
 * fields" next to a headline reading "the export carries no readable
 * parameters" — the badge asserting a comparison that never ran. Both are
 * UNDETERMINED and neither is NONE, but they are not the same sentence.
 */
function classLabelOf(row) {
  if (row.classification === MATCH.UNDETERMINED && row.reason === 'no-readable-parameters') {
    return 'export not readable';
  }
  return CLASS_LABEL[row.classification];
}

/**
 * One difference, in the shape configDriftPresentation already knows how to
 * render.
 *
 * Its `cohort`/`here` naming comes from the drift panel, where the left column
 * is the cohort. Here the left column is the set file — same direction (the
 * reference on the left, this account on the right), different reference — and
 * every column header in this panel says which it is, because an arrow could
 * not: on the real book `CloseAllOpenTradeTime` runs 16:45 → 16:30 on URGO and
 * 15:45 → 16:30 on ARPD.
 */
function toChangeRow(difference) {
  return {
    ...describeChangeRow({
      name: difference.name,
      from: difference.catalogValue ?? null,
      to: difference.liveValue ?? null,
    }),
    identity: difference.identity,
    sizing: difference.sizing,
  };
}

function sortChanges(rows) {
  // Version identity first whatever its rank: a profit target that no file
  // carries is the finding, and the drift panel's rank puts the stop above it.
  return rows.slice().sort((a, b) => Number(b.identity) - Number(a.identity)
    || a.rank - b.rank
    || a.label.localeCompare(b.label));
}

/**
 * What makes two rows the same finding: the same class, against the same
 * catalogued configuration, differing in the same fields BY THE SAME VALUES.
 *
 * The values are not optional. Keyed on field names alone, the panel put 11
 * Bullet Bot accounts in one group headed `ProfitTargetTicks 155 -> 70` when
 * their live targets are 110, 70, 125, 60, 30, 90, 140 and 82 — one row's values
 * printed as though they were eleven accounts' settings. Nine of those eleven
 * would have read a number they do not run.
 *
 * Joined with a character that cannot occur in a parameter name or value. Never
 * '/': values here include `1/1/2020 4:45:00 PM` and a '/' split has silently
 * produced a wrong answer three times in this codebase.
 */
function signatureOf(row) {
  return [
    row.classification,
    row.match?.configHash ?? '',
    row.differences
      .map((difference) => `${difference.name}=${difference.catalogValue}>${difference.liveValue}`)
      .sort()
      .join(''),
  ].join('');
}

function headlineOf(row, changes, count) {
  const subject = count === 1 ? 'this account' : `these ${count} accounts`;
  const label = row.match?.label || 'the closest set file';

  if (row.classification === MATCH.UNDETERMINED) {
    if (row.reason === 'no-readable-parameters') {
      return `The export carries no readable parameters, so nothing can be said about what ${subject} runs.`;
    }
    // No `?? 0`: this branch is only reached with a measured intersection, and
    // writing a zero for a missing one would fabricate the very number the
    // sentence is about.
    return `Only ${row.comparedFields} fields are carried by both this export and the library's files — too few to name a version, which is not the same as running none.`;
  }

  if (row.classification === MATCH.AMBIGUOUS) {
    return `${row.matches.length} catalogued configurations fit ${subject} equally well on the `
      + `${row.comparedFields} fields compared: ${row.matches.map((match) => match.label).join('; ')}.`;
  }

  const identity = changes.filter((change) => change.identity);
  const others = changes.length - identity.length;

  if (row.classification === MATCH.NONE) {
    const lead = identity[0];
    const detail = lead
      ? `${lead.label} is ${lead.here} here and ${lead.cohort} in the closest file (${label})`
      : `the closest file is ${label}`;
    return `No catalogued version carries what ${count === 1 ? 'this account runs' : `these ${count} accounts run`} — ${detail}`
      + `${others ? `, and ${others} other setting${others === 1 ? '' : 's'} differ${others === 1 ? 's' : ''}` : ''}.`;
  }

  if (row.sizingOnly) {
    return `On ${label}, at a position size the library does not carry — the version is the file's, `
      + 'the sizing is this account\'s.';
  }
  const lead = changes[0];
  const detail = lead
    ? `${lead.label}: ${lead.here ?? '—'} here, ${lead.cohort ?? '—'} in the file`
    : 'no setting differs';
  return `On ${label} with ${changes.length} setting${changes.length === 1 ? '' : 's'} changed — ${detail}.`;
}

/**
 * The size of the claim, in words, under every group.
 *
 * Required rather than decorative: the library's files carry between 19 and 50
 * comparable parameters and an export carries between 11 and 48, so "matches"
 * without both numbers is a claim of unknown strength. On this book the same
 * verdict is reached on 11 fields for Bullet Bot and on 48 for MotusTemplar.
 */
function evidenceOf(row) {
  const parts = [];
  if (row.comparedFields !== null) {
    parts.push(`Compared on ${row.comparedFields} parameter${row.comparedFields === 1 ? '' : 's'} `
      + `carried by both sides — the export carries ${row.liveFieldCount}`
      + (row.match ? `, the set file ${row.match.parameterCount}` : '') + '.');
  }
  if (row.liveOnly.length) {
    // "This file does not carry them", not "no set file carries them". 14 export
    // fields exist in no set file at all, but this list is measured against ONE
    // entry, and stating the stronger claim from the weaker measurement is the
    // kind of overreach the whole panel is built to avoid.
    parts.push(`${row.liveOnly.length} exported field${row.liveOnly.length === 1 ? '' : 's'} `
      + `(${row.liveOnly.join(', ')}) ${row.liveOnly.length === 1 ? 'is' : 'are'} not in this set `
      + 'file, so it could not be compared on them.');
  }
  if (row.catalogOnly.length) {
    parts.push(`${row.catalogOnly.length} setting${row.catalogOnly.length === 1 ? '' : 's'} the file `
      + `carries ${row.catalogOnly.length === 1 ? 'is' : 'are'} not in this export.`);
  }
  if (row.match?.periods?.length > 1) {
    parts.push(`Periods ${row.match.periods.join('/')} of this variant are identical, so the match `
      + 'names the configuration rather than one file.');
  }
  if (row.match && !row.match.risk && row.classification !== MATCH.NONE) {
    parts.push('The files carrying this configuration do not agree on one risk level, so none is named.');
  }
  return parts.join(' ');
}

function whoLineOf(clients) {
  const named = clients.slice(0, 2).map((client) => client.clientName);
  const rest = clients.length - named.length;
  const who = rest > 0 ? `${named.join(', ')} +${rest} more` : named.join(', ');
  return clients.length === 1 ? `${who} — one client's book` : who;
}

/**
 * Everything the panel renders, derived once.
 *
 * `limit` decides what is open, never what exists — the drift panel learned that
 * the hard way, dropping the single row with the largest configuration distance
 * on the book below the fold because it sorted by account count.
 */
function buildMatchView(result, { limit = 8 } = {}) {
  const families = result.families
    .filter((family) => family.measured)
    .map((family) => {
      const groups = new Map();
      const exact = new Map();

      for (const row of family.strategyRows) {
        if (row.classification === MATCH.EXACT) {
          const key = `${row.match.configHash}${row.comparedFields}`;
          if (!exact.has(key)) {
            exact.set(key, {
              key,
              label: row.match.label,
              comparedFields: row.comparedFields,
              liveFieldCount: row.liveFieldCount,
              parameterCount: row.match.parameterCount,
              periods: row.match.periods,
              count: 0,
            });
          }
          exact.get(key).count += 1;
          continue;
        }
        if (row.classification === MATCH.NOT_MEASURED) continue;

        const key = signatureOf(row);
        if (!groups.has(key)) groups.set(key, { key, rows: [] });
        groups.get(key).rows.push(row);
      }

      const groupRows = [...groups.values()].map((group) => {
        const first = group.rows[0];
        const tally = countAccounts(group.rows);
        const changes = sortChanges(first.differences.map(toChangeRow));
        const clients = rollUpAccounts(group.rows);
        return {
          key: group.key,
          classification: first.classification,
          classLabel: classLabelOf(first),
          tone: CLASS_TONE[first.classification],
          count: tally.total,
          tally,
          // Null stays null. `?? 0` here turned "the export could not be read"
          // into "0 fields were compared" — a measurement the panel never made,
          // rendered identically to a genuine empty intersection.
          comparedFields: first.comparedFields,
          matchLabel: first.match?.label || '—',
          changes,
          separating: first.separating || [],
          headline: headlineOf(first, changes, tally.total),
          // The risk level the account actually runs, stated rather than left to
          // be inferred from the file name. Only when no sizing field differs:
          // an account whose PosSize is off the library's three levels is on
          // this version at ITS own sizing, and naming the file's risk there
          // would report a size the account does not run.
          note: first.match && first.classification === MATCH.NEAR && first.match.risk
            && !changes.some((change) => change.sizing)
            ? `Runs the ${first.match.risk} Risk sizing of this version.`
            : null,
          evidence: evidenceOf(first),
          clients,
          whoLine: whoLineOf(clients),
        };
      }).sort((a, b) => VERIFY_ORDER.indexOf(a.classification) - VERIFY_ORDER.indexOf(b.classification)
        || b.count - a.count);

      return {
        key: family.family,
        family: family.family,
        catalogFamily: family.catalogFamily,
        exact: family.exact,
        measuredRows: family.measuredRows,
        onCatalogedVersion: family.onCatalogedVersion,
        fieldsCompared: family.fieldsCompared,
        verifyRows: family.near + family.none + family.ambiguous + family.undetermined,
        // Every value each side actually takes, not one row's. The domain
        // reports the sets; the panel formats them and never collapses one.
        recurring: family.recurring
          ? {
            ...family.recurring,
            changes: family.recurring.changes
              .map((change) => ({
                ...describeParameter(change.name),
                catalogValues: change.catalogValues
                  .map((value) => formatParameterValue(change.name, value) ?? '—'),
                liveValues: change.liveValues
                  .map((value) => formatParameterValue(change.name, value) ?? '—'),
              }))
              .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label)),
          }
          : null,
        exactByFile: [...exact.values()].sort((a, b) => b.count - a.count),
        groups: groupRows,
      };
    })
    .filter((family) => family.verifyRows > 0 || family.exact > 0)
    .sort((a, b) => b.verifyRows - a.verifyRows || a.family.localeCompare(b.family));

  return {
    totals: result.totals,
    families: families.slice(0, Math.max(0, limit)),
    rest: families.slice(Math.max(0, limit)),
    // Every family and every instrument, including the ones with nothing to
    // verify and the ones nothing could be measured on. The findings below are
    // filtered; a roll-up that hides a row is a roll-up of something else.
    rollup: { families: result.families, instruments: result.instruments },
    notMeasured: result.notMeasuredFamilies,
    provenance: result.catalogProvenance,
  };
}

/* ── Observed reference view model ────────────────────────────────────────── */

const percent = (fraction) => Math.round(fraction * 100);
const plural = (count, one, many) => (count === 1 ? one : many);

/**
 * Why the library could not answer, in the words of the gap rather than of the
 * code. All 47 rows in scope today carry `family-not-in-library`; the other two
 * reasons are the same hole seen from the instrument side and are 0 rows only
 * because every Bullet Bot file is instrument-less and stays a candidate for any
 * contract.
 */
function uncoveredLine(cohort) {
  const reasons = new Set(cohort.whyUncovered);
  if (reasons.has('no-file-for-instrument')) {
    return `The library has a folder for ${cohort.family} but no file for ${cohort.instrument}.`;
  }
  if (reasons.has('instrument-not-in-library')) {
    return `The library holds no template for ${cohort.instrument}.`;
  }
  return `The library has no folder for ${cohort.family}.`;
}

/**
 * What the cohort agrees on where it matters most.
 *
 * The desk's own definition of a version — profit targets and the stop — so a
 * unanimous cohort can be described as one version with settings adjusted rather
 * than as a popularity contest. G4M is unanimous on all four across all 47 rows.
 *
 * Three outcomes, three sentences. `unanimous` is null when the export carries
 * none of those fields, and that case must not borrow either of the other two:
 * "the cohort disagrees" and "nothing was compared" are different answers.
 */
function identityLineOf(cohort) {
  const { identity } = cohort.reference;
  const count = identity.fields.length;
  if (identity.unanimous === null) {
    return 'This export carries none of the settings the desk uses to identify a version, so '
      + 'nothing here can say whether the cohort is on one version or several.';
  }
  if (!identity.unanimous) {
    return `The cohort does not agree on the ${count} ${plural(count, 'setting', 'settings')} the `
      + 'desk uses to identify a version, so it is running more than one — the reference below is '
      + 'the most common of them, not the family\'s.';
  }
  const values = identity.fields.map((name) => {
    const meta = describeParameter(name);
    const value = formatParameterValue(name, identity.values[name]);
    return `${meta.label} ${value}${meta.unit ? ` ${meta.unit}` : ''}`;
  });
  return `All ${cohort.rows} rows agree on the ${count} ${plural(count, 'setting', 'settings')} the `
    + `desk uses to identify a version — ${values.join(', ')} — so this cohort is one version with `
    + 'settings adjusted, not several versions in one place.';
}

/**
 * How much of the reference is the whole cohort speaking, and what is held out.
 *
 * The denominator is `comparedFieldCount` — every setting any build in the
 * cohort carries — because that is the set `unanimousFields` and `varyingFields`
 * are counted over and the two halves have to add up to it. Against the
 * reference's own `fieldCount` this printed "4 of the 4 compared settings are
 * identical on every row and 3 vary" on a cohort whose minority build carried
 * three Martingale settings the reference has no field for.
 */
function fieldsLineOf(cohort) {
  const { reference } = cohort;
  const unanimous = reference.unanimousFields.length;
  const varying = reference.varyingFields.length;
  const names = reference.varyingFields
    .map((field) => describeParameter(field.name).label)
    .join(', ');
  const sizing = reference.excluded.sizing;
  return `${unanimous} of the ${reference.comparedFieldCount} compared settings are identical on every row`
    + `${varying ? ` and ${varying} ${plural(varying, 'varies', 'vary')} (${names})` : ''}.`
    + (sizing.length
      ? ` Position sizing (${sizing.join(', ')}) and the licence key are held out — sizing is the `
        + 'risk level, which the desk sets per client on purpose.'
      : ' The licence key is held out.');
}

/**
 * Whether today's majority is new.
 *
 * The only check on the reference available anywhere in the book, and it is a
 * weak one: it can show that a configuration is not last week's change, never
 * that it is what the desk wanted. Said in the sentence, not left to be inferred.
 */
function historyLineOf(cohort) {
  const { history } = cohort;
  if (!history) return null;
  if (!history.referenceIsAllTimeMajority) {
    return `Over every import on record this configuration is ${history.referenceRows} of `
      + `${history.rows} strategy rows (${history.referenceShare}%) and is not the most common one, `
      + 'so today\'s majority is a recent move rather than a settled state.';
  }
  return `The same configuration has been the majority for as long as this book records — `
    + `${history.referenceRows} of ${history.rows} strategy rows across all imports `
    + `(${history.referenceShare}%). That is stability, not endorsement: it is the same book, `
    + 'counted by row, so a client who imports often weighs more than one who imported once.';
}

/**
 * The sentence for a cohort that gets NO reference.
 *
 * The whole reason this module reports non-findings at all. A fragmented cohort
 * and a clean one look identical when both are dropped, and the difference
 * between them is the difference between "nothing to do" and "we cannot tell".
 */
function noReferenceLineOf(cohort, guards) {
  if (cohort.status === REFERENCE.NO_MAJORITY) {
    const rest = cohort.rows - cohort.largest.rows;
    return `No reference could be established here. ${cohort.rows} rows split across `
      + `${cohort.distinctConfigurations} configurations and the largest holds ${cohort.largest.rows}`
      + ` of them (${cohort.largest.share}%), under the ${percent(guards.minDominantShare)}% a `
      + 'majority needs to count as a norm. This is "there is nothing to compare against", not '
      + `"everything is fine": a reference built from ${cohort.largest.rows} rows would list the `
      + `other ${rest} as departures from a configuration most of the cohort does not run.`;
  }
  if (cohort.status === REFERENCE.COHORT_TOO_SMALL) {
    return `No reference. ${cohort.rows} ${plural(cohort.rows, 'row is', 'rows are')} under the `
      + `${guards.minCohort}-row floor, and in a cohort this small the majority is one client's `
      + 'preference — reporting the rest against it would manufacture a standard rather than find '
      + 'one. Not the same as finding nothing wrong.';
  }
  return `No reference. None of this cohort's ${cohort.unreadableRows} `
    + `${plural(cohort.unreadableRows, 'row', 'rows')} exported parameters that could be read, so `
    + 'nothing was compared.';
}

/** How the cohort was assembled, under every cohort. */
function provenanceLineOf(cohort) {
  const parts = [
    `Derived from ${cohort.rows} strategy ${plural(cohort.rows, 'row', 'rows')} on `
    + `${cohort.accounts} ${plural(cohort.accounts, 'account', 'accounts')} across `
    + `${cohort.clients} ${plural(cohort.clients, 'client', 'clients')}, latest import each`
    + `${cohort.unnamedRows
      ? `, plus ${cohort.unnamedRows} ${plural(cohort.unnamedRows, 'row', 'rows')} with no trading `
        + 'account on the import'
      : ''}.`,
  ];
  if (cohort.unreadableRows) {
    parts.push(`${cohort.unreadableRows} ${plural(cohort.unreadableRows, 'row', 'rows')} exported `
      + 'nothing readable and sit outside every share above.');
  }
  parts.push(uncoveredLine(cohort));
  if (!cohort.instrumentCatalogued) {
    parts.push(`The library holds no template for ${cohort.instrument} for any family either, so `
      + 'this cohort has two gaps, not one.');
  }
  return parts.join(' ');
}

/**
 * One minority configuration, ready to render.
 *
 * `variant` and `outlier` are two different findings and the domain already
 * separates them: above the outlier share a group is a second configuration the
 * cohort runs, below it a group is worth a look. G4M's 11 accounts closing at
 * 16:30 are 23% — and `Close all open trades → 16:30` is the most recurring
 * change on the whole book, 14 of 29 drift groups. Listing them as departures
 * would put a desk decision on a review list eleven times.
 */
function toObservedGroup(config, kind, cohort, guards) {
  const changes = sortChanges(config.changes.map((change) => ({
    ...describeChangeRow(change),
    // The desk's own definition of a version, carried onto an observed diff so
    // a minority that differs on a profit target sorts above one that differs on
    // a trail frequency. No difference here can be `sizing`: the reference
    // excludes sizing by construction.
    identity: VERSION_IDENTITY.test(change.name),
    sizing: false,
  })));
  const count = config.tally.total;
  const clients = rollUpAccounts(config.accounts);
  return {
    key: config.key,
    kind,
    count,
    tally: config.tally,
    // The share's own numerator, so the tooltip can state the denominator the
    // percentage is actually over rather than leaving a reader to assume it is
    // the account count printed beside it.
    rows: config.rows,
    share: config.share,
    classLabel: kind === 'variant' ? 'second configuration' : 'to verify',
    tone: kind === 'variant' ? 'info' : 'warning',
    headline: headlineFor(config.changes, count),
    // The share is already a chip on the collapsed row, so the sentence says
    // what the share MEANS rather than repeating the number beside itself.
    reading: kind === 'variant'
      ? `Above the ${percent(guards.outlierShare)}% floor, so this reads as a second configuration `
        + 'the cohort runs rather than as accounts departing from one.'
      : 'A minority configuration is a question, not a fault — the desk customises clients on '
        + 'purpose, so what this asks is whether it was asked for.',
    note: buildNoteFor(config.changes),
    changes,
    // The comparison runs over every setting either side carries, so that is the
    // denominator. Against the reference's own field count it read "compared
    // against the reference's 4 settings; 3 differ" for a group whose three
    // differences were settings the reference has no field for — three of four,
    // none of them among the four.
    evidence: `Compared field by field across the ${cohort.reference.comparedFieldCount} settings `
      + `this cohort carries between its builds; ${changes.length} `
      + `${plural(changes.length, 'differs', 'differ')}. The reference is `
      + `${cohort.reference.rows} of this cohort's ${cohort.rows} rows and nothing the desk wrote.`,
    clients,
    whoLine: whoLineOf(clients),
  };
}

/**
 * Everything the observed section renders, derived once.
 *
 * Cohorts without a reference are kept, deliberately. They are the ones a panel
 * is tempted to drop, and dropping them is how "we could not establish a norm
 * here" becomes indistinguishable from "nothing found here".
 */
function buildObservedView(result) {
  const guards = result.guards;
  const cohorts = result.cohorts.map((cohort) => {
    const groups = cohort.reference
      ? [
        ...cohort.outliers.map((config) => toObservedGroup(config, 'outlier', cohort, guards)),
        ...cohort.variants.map((config) => toObservedGroup(config, 'variant', cohort, guards)),
      ]
      : [];
    return {
      ...cohort,
      // What the cohort head prints. Accounts, matching the chip on every group
      // below it; the row count is the same number today and stops being one the
      // moment an account exports twice in a cohort, which this book does
      // elsewhere. The row count is not derived here at all — an unrendered
      // second total beside a rendered one is how the two drift apart.
      verifyAccounts: cohort.outliers.reduce((sum, config) => sum + config.tally.total, 0),
      identityLine: cohort.reference ? identityLineOf(cohort) : null,
      fieldsLine: cohort.reference ? fieldsLineOf(cohort) : null,
      historyLine: cohort.reference ? historyLineOf(cohort) : null,
      noReferenceLine: cohort.reference ? null : noReferenceLineOf(cohort, guards),
      provenanceLine: provenanceLineOf(cohort),
      referenceFields: cohort.reference
        ? cohort.reference.fields.map((field) => ({
          ...describeParameter(field.name),
          // The reference's own value, not the field's most common one. They
          // agree on this book and they need not: the majority CONFIGURATION can
          // hold a value that is not the majority value of that field once the
          // minorities are counted together.
          // The `'—'` is unreachable now that `absentFromReference` carries the
          // only case that produced a null — every value in the parameter map is
          // a string. Left as the last resort rather than deleted: a bare null
          // reaching JSX renders as nothing at all, which is the blank cell this
          // panel has already shipped once.
          value: formatParameterValue(field.name, cohort.reference.parameters[field.name]) ?? '—',
          // "The reference has no field for this" is a different claim from "the
          // reference sets it to nothing", and only the parameter map can tell
          // them apart — formatParameterValue returns null for both.
          absentFromReference: !Object.prototype.hasOwnProperty.call(
            cohort.reference.parameters, field.name,
          ),
          identity: VERSION_IDENTITY.test(field.name),
          unanimous: field.unanimous,
          spread: field.unanimous ? null : field.values.map((entry) => ({
            value: formatParameterValue(field.name, entry.value) ?? 'not in that build',
            rows: entry.rows,
          })),
        })).sort((a, b) => Number(b.identity) - Number(a.identity)
          || a.rank - b.rank
          || a.label.localeCompare(b.label))
        : [],
      groups,
    };
  });

  return { ...result, cohorts, guards };
}
