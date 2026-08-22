import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { formatCurrency } from '../domain/report';

/**
 * The rows of a deviation-alert panel, rendered the same way wherever they are
 * shown.
 *
 * The alerts themselves come from ONE function — buildCamOverview in
 * src/domain/camOverview.js — which produces both the peer-performance flags
 * ("below peer performance for RBO 1.8") and the execution-drift flags ("moved
 * opposite to peer executions for MNQ"). The CAM overview has rendered them for
 * a long time; the manager's consolidated view now renders them too, and this
 * component exists so the second screen could not be given a second opinion
 * about what an alert says. There is one computation and one row.
 *
 * `camNameByClientId` is the only thing the two screens differ on. A CAM reading
 * his own book already knows whose client it is; a manager reading 74 alerts
 * across eight books needs to know which desk each one lands on before he can do
 * anything with it. Omitted, the attribution simply is not printed — it is never
 * guessed.
 */
export default function DeviationAlertList({ flags = [], camNameByClientId = null }) {
  if (!flags.length) {
    return (
      <div className="notice success">
        <CheckCircle2 size={16} /> No cross-account deviation alerts.
      </div>
    );
  }
  return (
    <div className="flag-list">
      {flags.map((flag) => {
        // A client with no CAM on record renders no attribution rather than
        // "Unassigned": this list is not the place that discovery belongs, and
        // the client roster on the same page already reports it in red.
        const camName = camNameByClientId ? camNameByClientId[flag.clientId] || '' : '';
        return (
          <div className="flag warning" key={flag.id}>
            <AlertTriangle size={16} />
            <div>
              <strong>{flag.algorithm}</strong>
              <span>
                {flag.message} Daily realized: {formatCurrency(flag.realized)}.
                {flag.executionMove !== undefined
                  ? ` Execution move: ${flag.executionMove > 0 ? '+' : ''}${flag.executionMove.toFixed(2)} vs peer direction ${flag.peerDirection}.`
                  : ''}
                {camName ? ` CAM: ${camName}.` : ''}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
