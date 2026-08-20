import { useState } from 'react';
import { buildAlgoAccountHistory } from '../domain/algoContribution';

const money = (n) => `${n < 0 ? '-' : ''}$${Math.abs(Math.round(n)).toLocaleString()}`;
const cls = (n) => (n > 0 ? 'positive' : n < 0 ? 'negative' : 'muted');

// What the account did under each roster, and what each algo was worth.
//
// The two halves are deliberately not symmetric. Combination periods are exact:
// the roster and the account's realized PnL both come straight from the close,
// and nothing is attributed to anyone.
//
// The per-algo split has two possible sources and this panel never lets them
// blur together:
//
//   DERIVED  — worked out from the account's own fills, by pairing them FIFO and
//              crediting each closed pair to the strategy named on both of its
//              legs. Shown only for a day whose derived total reconciles with the
//              account's gross and leaves nothing unattributed.
//   REPORTED — read off NinjaTrader's Strategies grid, which populates it on a
//              minority of rows.
//
// Every figure carries its source, because the two are not equally checkable and
// a reader who cannot tell which is which cannot judge either. Money the fills
// paired but could not credit to any single algo is printed as its own residual
// line rather than being folded into a row — the whole point of the feature is
// that a number on screen which looks like an answer must be one.
//
// Two lines below the table, never one. The RESIDUAL is money the fills paired
// but could name no strategy for. OFF-ROSTER money is the opposite shape: the
// fills did name a strategy and this account's Strategies grid has no row for
// it. They are separate lines because they are separate facts, and the
// off-roster line says explicitly that its dollars are already inside the
// coverage total above — this panel once printed a $0 row for an account whose
// whole day had gone off-roster, and stating the same money twice would be the
// mirror of that mistake.
export default function AlgoContributionPanel({ client, accountName }) {
  const [open, setOpen] = useState(false);
  const history = buildAlgoAccountHistory(client, accountName);
  const { periods, algos, attribution } = history;
  if (!periods.length) return null;

  const { derivedDays, reportedDays, totalDays, attributedDays } = attribution;
  const sourceNote =
    derivedDays && reportedDays
      ? `${derivedDays} derived from fills, ${reportedDays} reported by NinjaTrader`
      : derivedDays
        ? `${derivedDays} derived from fills`
        : reportedDays
          ? `${reportedDays} reported by NinjaTrader`
          : '';

  const coverage =
    attribution.status === 'unavailable'
      ? `no day carries a per-algo split — ${money(attribution.accountTotal)} unattributed`
      : attribution.status === 'complete'
        ? `all ${totalDays} days carry a per-algo split (${sourceNote})`
        : `${attributedDays} of ${totalDays} days carry a per-algo split (${sourceNote}); ${money(attribution.unattributedPnl)} across the other days is unattributed`;

  return (
    <div className="algo-contrib">
      <button type="button" className="algo-contrib-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} Algo contribution · {periods.length} combination{periods.length === 1 ? '' : 's'} over {totalDays} days
      </button>

      {open ? (
        <div className="algo-contrib-body">
          <table className="algo-contrib-table">
            <thead>
              <tr><th>Combination</th><th>Dates</th><th>Days</th><th>Total</th><th>Avg/day</th><th>Green</th></tr>
            </thead>
            <tbody>
              {periods.map((p, i) => (
                <tr key={`${p.from}-${i}`}>
                  <td>{p.combo === 'None' ? <em className="muted">no enabled algo</em> : p.combo}</td>
                  <td className="nums">{p.from === p.to ? p.from : `${p.from} → ${p.to}`}</td>
                  <td className="nums">{p.days}</td>
                  <td className={`nums ${cls(p.totalPnl)}`}>{money(p.totalPnl)}</td>
                  <td className={`nums ${cls(p.avgPnl)}`}>{money(p.avgPnl)}</td>
                  <td className="nums">{p.greenDays}/{p.days}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <table className="algo-contrib-table">
            <thead>
              <tr><th>Algo</th><th>Days on</th><th>Direction</th><th>Instrument</th><th>Contribution</th><th>Source</th></tr>
            </thead>
            <tbody>
              {algos.map((a) => {
                const covered = a.derivedDays + a.reportedDays;
                return (
                  <tr key={a.key}>
                    <td>{a.key}</td>
                    <td className="nums">{a.daysEnabled}/{a.daysPresent}</td>
                    <td>{a.directions.join(', ') || '—'}</td>
                    <td className="muted">{a.instruments.slice(0, 2).join(', ') || '—'}</td>
                    <td className={`nums ${covered ? cls(a.contributionPnl) : 'muted'}`}>
                      {covered ? `${money(a.contributionPnl)} over ${covered}d` : 'not attributable'}
                    </td>
                    <td className="muted algo-contrib-source">
                      {/* Never one word for two different things. A row summed from
                          both sources says so and shows each side, so a reader can
                          see the derived and reported halves disagree if they ever do. */}
                      {!covered ? (
                        <span title="Neither the export nor the fills could attribute this algo on any day">
                          —
                        </span>
                      ) : a.derivedDays && a.reportedDays ? (
                        <span title={`Derived from fills on ${a.derivedDays}d (${money(a.derivedPnl)}); reported by NinjaTrader on ${a.reportedDays}d (${money(a.reportedPnl)})`}>
                          derived {a.derivedDays}d · reported {a.reportedDays}d
                        </span>
                      ) : a.derivedDays ? (
                        <span title="Worked out from this account's own fills: FIFO-paired, credited only where both legs of a pair name the same strategy">
                          derived from fills
                        </span>
                      ) : (
                        <span title="Read off NinjaTrader's Strategies grid, not derived">
                          reported by export
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <small className="muted algo-contrib-note">{coverage}.</small>
          {attribution.offRosterPnl ? (
            <small className="muted algo-contrib-note">
              {' '}
              {money(attribution.offRosterPnl)} of that was credited by the fills to{' '}
              {attribution.offRosterNames.join(', ') || 'a strategy'}, which this account&apos;s Strategies
              grid never listed — so it belongs to the account but to no row above. It is part of the
              total already stated, not an extra amount.
            </small>
          ) : null}
          {attribution.residualPnl ? (
            <small className="muted algo-contrib-note">
              {' '}
              A further {money(attribution.residualPnl)} was paired from the fills but belongs to no single
              algo — a hand-placed leg, an exit NinjaTrader detached from its strategy, or a position carried
              in from an earlier session. It is left out of every row above rather than assigned to one.
            </small>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
