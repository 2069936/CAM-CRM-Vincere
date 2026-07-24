import { clientAccountMix } from '../domain/clientSegments';

/**
 * Marks whether a client runs cash accounts, prop (funded/evaluation) accounts,
 * or both. The two are managed differently, so every surface that lists a client
 * shows the same badge.
 */
export default function ClientKindBadge({ client, mix = null }) {
  const resolved = mix || clientAccountMix(client);
  if (!resolved.label) return null;
  return (
    <span
      className={`client-kind client-kind-${resolved.kind}`}
      title={`${resolved.cash} cash · ${resolved.prop} prop account${resolved.prop === 1 ? '' : 's'}`}
    >
      {resolved.label}
    </span>
  );
}
