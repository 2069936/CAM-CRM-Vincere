import { conversionFromFree, revenueLeakage, revenueMovement, revenueSnapshot } from '../domain/revenueHealth';
import { SUBSCRIPTION_PRICES } from '../domain/subscriptionPrice';

/* ------------------------------------------------------------------------- *
 * Revenue health, with its own limits printed on it.
 *
 * Two things on this page are not like the others and both are said out loud
 * rather than left for someone to discover in a meeting:
 *
 * THE UNPRICED COUNT SITS NEXT TO THE MRR. Most of this book is on
 * 'Undetermined'. The MRR is therefore a floor and the page says so, because a
 * dashboard that treats "nobody asked" as $0 reports a business half its size
 * and gets believed.
 *
 * MOVEMENT SAYS HOW FAR BACK IT CAN SEE. New and lost MRR come from the price
 * log, which starts the day it shipped. Before that the audit trail recorded
 * which field changed and never the values, so the honest answer for earlier
 * periods is "not recorded", not zero.
 * ------------------------------------------------------------------------- */

const money = (value) => `$${Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

function Tile({ label, value, note, tone }) {
  return (
    <div className={`revenue-tile${tone ? ` ${tone}` : ''}`}>
      <div className="revenue-tile-label">{label}</div>
      <div className="revenue-tile-value">{value}</div>
      {note ? <div className="revenue-tile-note">{note}</div> : null}
    </div>
  );
}

export default function RevenueHealthPanel({
  clients = [],
  priceChanges = [],
  priceLogStartedAt = null,
  asOf,
  monthStart,
}) {
  const snapshot = revenueSnapshot(clients);
  const leakage = revenueLeakage(clients, { asOf });
  const movement = revenueMovement(priceChanges, {
    from: monthStart,
    to: asOf,
    logStartedAt: priceLogStartedAt,
  });
  const conversion = conversionFromFree(priceChanges, { logStartedAt: priceLogStartedAt });

  return (
    <section className="panel revenue-health">
      <div className="panel-heading">
        <h3>Revenue health</h3>
        <span className="muted">{snapshot.activeClients} active clients</span>
      </div>

      <div className="revenue-tiles">
        <Tile
          label="Total MRR"
          value={money(snapshot.mrr)}
          note={snapshot.unpriced
            ? `Floor, not total. ${snapshot.unpriced} of ${snapshot.activeClients} clients have no tier set.`
            : 'Every active client is priced.'}
          tone={snapshot.unpriced ? 'warn' : undefined}
        />
        <Tile
          label="Avg revenue per priced client"
          value={money(snapshot.arpc)}
          note={`${snapshot.priced} priced · ${snapshot.paying} paying`}
        />
        <Tile
          label="Avg per paying client"
          value={money(snapshot.arpuPaying)}
          note="What the pipeline below is valued at"
        />
      </div>

      <div className="revenue-tiers">
        <h4>Where the base sits</h4>
        <table className="revenue-table">
          <thead>
            <tr><th>Tier</th><th>Clients</th><th>Share</th><th>MRR</th></tr>
          </thead>
          <tbody>
            {SUBSCRIPTION_PRICES.map((tier) => (
              <tr key={tier} className={tier === 'Undetermined' && snapshot.byTier[tier] ? 'warn-row' : undefined}>
                <td>{tier}</td>
                <td>{snapshot.byTier[tier]}</td>
                <td>{snapshot.tierShare[tier]}%</td>
                <td>{tier === 'Undetermined' ? '—' : money(snapshot.byTier[tier] * (tier === '$500' ? 500 : tier === '$250' ? 250 : 0))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {snapshot.byTier.Undetermined ? (
          <p className="revenue-caveat">
            {snapshot.byTier.Undetermined} clients have never had a tier set. Until they do,
            every number on this page understates the desk.
          </p>
        ) : null}
      </div>

      <div className="revenue-leakage">
        <h4>Not being collected</h4>
        <div className="revenue-tiles">
          <Tile label="Free clients" value={leakage.freeClients} note={`${leakage.refundSaves} of them are refund saves`} />
          <Tile
            label="Convertible"
            value={leakage.convertible}
            note="Refund saves excluded: the firm already paid to keep them"
          />
          <Tile label="Pipeline if converted" value={money(leakage.potentialMrr)} note="At what paying clients pay today" />
        </div>
        {leakage.aging.length ? (
          <table className="revenue-table">
            <thead><tr><th>Free client</th><th>Free for</th></tr></thead>
            <tbody>
              {leakage.aging.map((entry) => (
                <tr key={entry.id}>
                  <td>{entry.name}</td>
                  <td>{entry.days === null ? 'Not recorded' : `${entry.days} days`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted">No convertible free clients.</p>}
      </div>

      <div className="revenue-movement">
        <h4>What moved this month</h4>
        {movement.partialPeriod ? (
          <p className="revenue-caveat">
            The price log starts {movement.coversFrom ? movement.coversFrom.slice(0, 10) : 'later than this period'}.
            Before it, the audit trail recorded which field changed and never the values, so movement
            earlier than that is not recorded rather than zero.
          </p>
        ) : null}
        <div className="revenue-tiles">
          <Tile label="New MRR" value={money(movement.newMrr)} />
          <Tile label="Lost MRR" value={money(movement.lostMrr)} />
          <Tile
            label="Net change"
            value={`${movement.netMrr >= 0 ? '+' : ''}${money(movement.netMrr)}`}
            tone={movement.netMrr < 0 ? 'warn' : undefined}
            note={`${movement.changes} price changes recorded`}
          />
        </div>
      </div>

      <div className="revenue-conversion">
        <h4>Free to paying</h4>
        {conversion.startedFree ? (
          <div className="revenue-tiles">
            <Tile label="Converted" value={`${conversion.converted} of ${conversion.startedFree}`} note={`${conversion.rate}%`} />
            <Tile
              label="Typical time"
              value={conversion.medianDaysToConvert === null ? '—' : `${conversion.medianDaysToConvert} days`}
              note="Median, so one long outlier cannot tell the story"
            />
          </div>
        ) : (
          <p className="revenue-caveat">
            Nothing to measure yet. A conversion is only countable when both the move to Free and the
            move to paying are inside the price log, so this fills in from {priceLogStartedAt
              ? priceLogStartedAt.slice(0, 10)
              : 'the day the log ships'} onward.
          </p>
        )}
      </div>
    </section>
  );
}
