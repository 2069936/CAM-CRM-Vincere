import { useMemo } from 'react';
import { buildDeskConfigOutliers, MIN_CONSENSUS_ACCOUNTS } from '../domain/deskConfigOutliers';
import { describeParameter, formatParameterValue } from '../domain/configDriftPresentation';
import PanelLoadState from './PanelLoadState';
import { panelIsLoaded } from '../domain/panelLoad';

/**
 * Is anybody running an algorithm configured differently from the rest of the
 * desk today?
 *
 * The panel above this one compares each client's own latest close, whenever
 * that fell, and ranks whole configurations. This one pins to ONE day and
 * compares field by field, because the desk's question is about the desk as it
 * stands: forty-four clients had URGO 4.5 open on MNQ on the book's last close,
 * and the only useful reference for any one of them is the other forty-three.
 *
 * WHAT IT REFUSES TO SAY. A group of fewer than three accounts has no consensus
 * to be off, and this panel lists those groups rather than ranking them: "no
 * finding" and "not measurable" are different answers and a reader must not have
 * to tell them apart by eye. A field the desk itself is divided on is stated
 * once at the group and nobody is listed for it. Nothing here calls a difference
 * wrong.
 *
 * ITS DATA IS NOT AT LOGIN. Same argument as ConfigDriftPanel and
 * SetFileMatchPanel: `parameters_raw` and `params_parsed` are 82% of a strategy
 * row and 30.9 MB of a production login, and `params_parsed` carries the machine
 * LicenseKey. They arrive when this panel is expanded, for the one day it is
 * showing, which is the smallest fetch of the three.
 */
export default function DeskConfigOutlierPanel({
  clients = [],
  date = '',
  load = null,
  onRetry = null,
}) {
  const result = useMemo(
    () => buildDeskConfigOutliers(clients, { date }),
    [clients, date],
  );

  if (!panelIsLoaded(load)) {
    return (
      <PanelLoadState
        load={load}
        onRetry={onRetry}
        waiting={`Reading the settings every account ran on ${date || 'the selected day'}. Nothing is compared until they arrive.`}
      />
    );
  }

  if (!date) {
    return (
      <p className="muted chart-empty">
        No trading day is selected, so there is nothing to compare across the desk.
      </p>
    );
  }

  const { basis, groups } = result;
  const measured = groups.filter((group) => group.measured);
  const small = groups.filter((group) => !group.measured);

  if (!groups.length) {
    return (
      <p className="muted chart-empty">
        No close on {date} carries a strategy row, so there is nothing to compare across the desk
        that day.
      </p>
    );
  }

  const differing = measured.filter((group) => group.outliers.length);

  return (
    <div className="drift-panel">
      <p className="drift-intro">
        On <strong>{date}</strong>, <strong>{basis.closes}</strong> close
        {basis.closes === 1 ? '' : 's'} put <strong>{basis.accountsCompared}</strong> account
        {basis.accountsCompared === 1 ? '' : 's'} into <strong>{basis.compared}</strong> group
        {basis.compared === 1 ? '' : 's'} large enough to have a consensus.{' '}
        <strong>{basis.accountsDiffering}</strong> of them run at least one setting the rest of
        their group does not.
      </p>
      <p className="drift-ask">
        A group is one algorithm, one version, one contract and one data series, across every
        client that closed that day. Different is not wrong. Customisation is legitimate, and this
        is a list to verify rather than a fault list.
      </p>

      {differing.length === 0 ? (
        <p className="muted chart-empty">
          Every group with a consensus is running it. Nothing on {date} sits off the desk.
        </p>
      ) : null}

      {measured.map((group, index) => (
        <GroupRow key={group.key} group={group} open={index === 0 && group.outliers.length > 0} />
      ))}

      {small.length ? (
        <div className="desk-config-small">
          <p className="muted">
            {small.length} group{small.length === 1 ? '' : 's'} had fewer than{' '}
            {MIN_CONSENSUS_ACCOUNTS} accounts on {date}. There is no desk consensus to be off in a
            group that size, so they are listed and not ranked.
          </p>
          <ul>
            {small.map((group) => (
              <li key={group.key}>
                <strong>{groupName(group)}</strong>
                <span className="muted">
                  {' '}
                  {group.accounts} account{group.accounts === 1 ? '' : 's'}
                  {group.clients ? `, ${group.clients} client${group.clients === 1 ? '' : 's'}` : ''}
                  {group.unreadable
                    ? `, ${group.unreadable} row${group.unreadable === 1 ? '' : 's'} nobody could read`
                    : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function groupName(group) {
  return [group.family, group.version, group.instrument, group.dataSeries]
    .filter(Boolean)
    .join(' · ');
}

/**
 * One group, closed unless it is the first with something to show.
 *
 * The summary carries the decision a reader is making: how big the group is, how
 * many accounts are off it, and whether the group is divided on anything. The
 * old drift panel had to be expanded to learn any of that.
 */
function GroupRow({ group, open = false }) {
  const consensusOn = group.consensus.filter((entry) => entry.alsoInUse.length);
  return (
    <details className="drift-row" open={open}>
      <summary>
        <span className="drift-head">
          <strong>{group.family}</strong>
          <span className="muted">
            {group.version} {group.instrument}
            {group.dataSeries ? ` ${group.dataSeries}` : ''}
          </span>
          <span className="drift-count">
            {group.outliers.length
              ? `${group.outliers.length} to verify`
              : 'all on the desk setting'}
          </span>
          <span className="drift-findings muted">
            {group.accounts} account{group.accounts === 1 ? '' : 's'}, {group.clients} client
            {group.clients === 1 ? '' : 's'}
          </span>
        </span>
        <span className="drift-majority">
          <span className="muted">
            {group.fields.compared} setting{group.fields.compared === 1 ? '' : 's'} compared
            {group.fields.split
              ? `, ${group.fields.split} the desk does not agree on`
              : ''}
            {group.fields.ignored.length
              ? `, ${group.fields.ignored.length} left out as per machine`
              : ''}
          </span>
        </span>
        {group.contractPeers.length ? (
          <span className="drift-worst">
            Also running on {group.contractPeers.map((peer) => `${peer.instrument} (${peer.accounts})`).join(', ')}.
          </span>
        ) : null}
      </summary>

      <div className="drift-detail">
        {group.unstatedSeries || group.unreadable || group.unnamed ? (
          <p className="muted desk-config-note">
            {group.unstatedSeries
              ? `${group.unstatedSeries} row${group.unstatedSeries === 1 ? ' stated' : 's stated'} no data series and ${group.unstatedSeries === 1 ? 'was' : 'were'} placed on this group's busiest data series. `
              : ''}
            {group.unreadable
              ? `${group.unreadable} row${group.unreadable === 1 ? ' exported' : 's exported'} settings nobody could read and ${group.unreadable === 1 ? 'was' : 'were'} left out. `
              : ''}
            {group.unnamed
              ? `${group.unnamed} row${group.unnamed === 1 ? '' : 's'} carry no trading account on the import and cannot be attributed.`
              : ''}
          </p>
        ) : null}

        {group.spellings.length > 1 ? (
          <p className="muted desk-config-note">
            The grid spelled this contract {group.spellings.length} ways (
            {group.spellings.join(', ')}). They are one contract and are compared together.
          </p>
        ) : null}

        {group.splitFields.length ? (
          <div className="desk-config-split">
            <h5>The desk does not agree on these</h5>
            <p className="muted">
              No value holds enough of the group to be called the desk&apos;s. Nobody is listed
              against these, because there is nothing to be off.
            </p>
            <ul>
              {group.splitFields.map((field) => (
                <li key={field.name}>
                  <FieldName name={field.name} />:{' '}
                  {field.readings.map((reading, index) => (
                    <span key={`${reading.value}`}>
                      {index ? ', ' : ''}
                      <code>{readingText(field.name, reading.value)}</code> on{' '}
                      {reading.accounts}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {consensusOn.length ? (
          <div className="desk-config-second">
            <h5>Two settings in use on purpose</h5>
            <p className="muted">
              A reading this much of the group runs is a decision somebody took, so its accounts
              are not listed below.
            </p>
            <ul>
              {consensusOn.map((entry) => (
                <li key={entry.name}>
                  <FieldName name={entry.name} />:{' '}
                  <code>{readingText(entry.name, entry.value)}</code> on {entry.accounts}
                  {entry.alsoInUse.map((other) => (
                    <span key={`${other.value}`}>
                      , <code>{readingText(entry.name, other.value)}</code> on {other.accounts}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {group.outliers.length ? (
          /* ONE table per group, not one per account. Bullet Bot's 19 accounts
             on the book's last close are mostly a single setting each, and a
             table apiece put the same four column headings on screen nineteen
             times above one row. The account is a row group inside one table. */
          <div className="drift-table-wrap">
            <table className="drift-table desk-config-table">
              <thead>
                <tr>
                  <th scope="col">Setting</th>
                  <th scope="col">
                    The desk
                    <em>on this day</em>
                  </th>
                  <th scope="col">
                    This account
                    <em>what it ran</em>
                  </th>
                  <th scope="col">
                    From the desk
                    <em>numeric settings only</em>
                  </th>
                </tr>
              </thead>
              {group.outliers.map((outlier) => (
                <tbody key={`${outlier.clientId}-${outlier.accountName}`}>
                  <tr className="desk-config-account">
                    <th colSpan={4} scope="colgroup">
                      <strong>{outlier.clientName}</strong>
                      <span className="drift-account-numbers">{outlier.accountName}</span>
                      <span className="muted">
                        {outlier.differences.length} setting
                        {outlier.differences.length === 1 ? '' : 's'} differ
                        {outlier.differences.length === 1 ? 's' : ''}
                        {outlier.rows > 1
                          ? `, over ${outlier.rows} rows on this close`
                          : ''}
                      </span>
                    </th>
                  </tr>
                  {outlier.differences.map((difference) => (
                    <DifferenceRow key={difference.name} difference={difference} />
                  ))}
                </tbody>
              ))}
            </table>
          </div>
        ) : (
          <p className="muted chart-empty">
            Every account in this group runs the same settings the rest of it runs.
          </p>
        )}

        {group.fields.ignored.length ? (
          <p className="muted desk-config-note">
            Left out of the comparison:{' '}
            {group.fields.ignored.map((field, index) => (
              <span key={field.name}>
                {index ? ', ' : ''}
                <code>{field.name}</code>{' '}
                {field.reason === 'per-machine'
                  ? '(names the machine or the export)'
                  : '(a different value on every account, so it cannot have a consensus)'}
              </span>
            ))}
            .
          </p>
        ) : null}
      </div>
    </details>
  );
}

/** The plain-language name where the desk has established one, the raw name otherwise. */
function FieldName({ name }) {
  const meta = describeParameter(name);
  return meta.mapped ? (
    <strong>{meta.label}</strong>
  ) : (
    <code>{meta.name}</code>
  );
}

/**
 * A whole percent, rounded away from zero on both sides.
 *
 * Math.round takes -92.5 to -92 and +92.5 to +93, so a target half as far below
 * the desk as another is above it printed as the smaller number. Two readings of
 * the same size have to print the same size.
 */
function percent(value) {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/** A reading in the dialect its parameter is written in. `null` is absence. */
function readingText(name, value) {
  if (value === null) return 'not in this build';
  const formatted = formatParameterValue(name, value);
  return formatted === null || formatted === '' ? 'empty' : formatted;
}

/**
 * One setting, both sides of it, and how far apart they are.
 *
 * Missing and extra are worded as builds rather than as values. Printing
 * `Break-even offset: (blank) against 5` invites a CAM to go and set a field
 * that does not exist on that account's strategy, and the reverse invites them
 * to clear one the desk never had.
 */
function DifferenceRow({ difference }) {
  const meta = describeParameter(difference.name);
  const unit = meta.unit ? ` ${meta.unit}` : '';
  return (
    <tr className="drift-change">
      <th scope="row">
        {meta.mapped ? meta.label : <code>{meta.name}</code>}
        {meta.unit ? <em>{meta.unit}</em> : null}
      </th>
      <td>
        {difference.consensus === null ? (
          <span className="drift-absent">not in this build</span>
        ) : (
          formatParameterValue(difference.name, difference.consensus)
        )}
        <em className="desk-config-count">
          {' '}
          {difference.consensusAccounts} of {difference.population}
        </em>
      </td>
      <td className="drift-here">
        {difference.state === 'missing' ? (
          <span className="drift-absent">not in this build</span>
        ) : difference.state === 'inconsistent' ? (
          <span className="drift-absent">two rows disagree: {difference.values.join(', ')}</span>
        ) : (
          formatParameterValue(difference.name, difference.value)
        )}
      </td>
      <td>
        {difference.distance === null ? (
          <span className="muted">
            {difference.state === 'missing'
              ? 'missing'
              : difference.state === 'extra'
                ? 'the desk carries none'
                : difference.state === 'inconsistent'
                  ? 'no single value'
                  : 'different'}
          </span>
        ) : (
          <span className="desk-config-distance">
            {difference.distance > 0 ? '+' : ''}
            {difference.distance}
            {unit}
            {difference.distancePct === null ? null : (
              <em>
                {' '}
                {difference.distancePct > 0 ? '+' : ''}
                {percent(difference.distancePct)}%
              </em>
            )}
          </span>
        )}
      </td>
    </tr>
  );
}
