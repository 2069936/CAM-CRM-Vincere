import { ACCOUNT_NATURES, NATURE_LABELS, classifyAccountNature } from '../domain/simulationAccounts';

/**
 * Marks an account as simulated, or as one whose nature nobody has determined.
 *
 * Wherever accounts are listed, a simulated one must be distinguishable at a
 * glance. A currency-formatted balance next to a real one is indistinguishable
 * from real money — that is the whole failure this feature exists to prevent —
 * so the badge carries the word, not just a colour.
 *
 * The tooltip carries the REASON. "Treated as simulation because the account is
 * named Sim101" is something a CAM can check and correct; a silent
 * reclassification is not, and the silent version of this rule deleted a
 * client's entire trading day.
 *
 * Same idiom as ClientKindBadge: a `client-kind`-shaped pill with its own
 * modifier class, so it sits correctly inside every list that already renders
 * one.
 */
export default function SimulationBadge({ meta = null, accountName = '', nature = null, compact = false }) {
  const resolved = nature
    ? { nature, reason: '', heuristic: false, source: '' }
    : classifyAccountNature(meta || {}, { accountName });

  if (resolved.nature === ACCOUNT_NATURES.LIVE) return null;

  const simulated = resolved.nature === ACCOUNT_NATURES.SIMULATION;
  const label = simulated
    ? (compact ? 'SIM' : NATURE_LABELS[ACCOUNT_NATURES.SIMULATION])
    : (compact ? 'UNDET.' : NATURE_LABELS[ACCOUNT_NATURES.UNDETERMINED]);

  const title = simulated
    ? `Not real money. ${capitalize(resolved.reason)}${resolved.heuristic ? ' — this was detected automatically; confirm it on the account record.' : ''}`
    : `Counted as neither real nor simulated. ${capitalize(resolved.reason)}`;

  return (
    <span
      className={`client-kind sim-badge sim-badge-${simulated ? 'simulation' : 'undetermined'}`}
      title={title}
    >
      {label}
    </span>
  );
}

function capitalize(text) {
  const value = String(text || '');
  return value ? `${value[0].toUpperCase()}${value.slice(1)}.` : '';
}
