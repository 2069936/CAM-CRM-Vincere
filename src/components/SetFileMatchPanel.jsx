import { useMemo } from 'react';
import { buildSetFileMatch, MATCH } from '../domain/setFileMatch';
import {
  countAccounts,
  describeChangeRow,
  describeParameter,
  formatParameterValue,
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
  const view = useMemo(
    () => buildMatchView(buildSetFileMatch(clients, { asOfDate }), { limit }),
    [clients, asOfDate, limit],
  );

  const { totals, families, rest, notMeasured, provenance } = view;

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
          . The library has no folder for {notMeasured.length === 1 ? 'it' : 'them'}, so nothing here
          can say what these accounts should be running. They are not uncatalogued — they are
          unmeasured, and the two must not be read as the same finding.
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
