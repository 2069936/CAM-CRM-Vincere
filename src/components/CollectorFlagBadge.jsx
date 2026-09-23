import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { autoCollectionApi } from '../domain/autoCollectionApi';
import { collectorFlagBadge, collectorFlags } from '../domain/collectorFlags';

/* ------------------------------------------------------------------------- *
 * THE FLAG, WHERE IT CANNOT BE MISSED, POINTING AT WHERE IT IS FIXED.
 *
 * A collection problem lives on Credentials and Notes, which is a tab nobody
 * opens unless they already suspect something. So it is also said in the
 * client's header, next to their name, on every tab: one line, and clicking it
 * switches to the tab that can fix it.
 *
 * It reads the same collectorFlags the card reads, so the header can never
 * claim a flag the card does not show. Nothing here is dismissible, because
 * nothing here is stored: the badge is a function of the device, the release
 * and the last batch, and it disappears when they stop saying it.
 *
 * Its own failure is silence. A status endpoint that is slow or down is not a
 * reason to put an error next to a client's name, and the card on the tab
 * reports its own failures in its own words.
 * ------------------------------------------------------------------------- */
export default function CollectorFlagBadge({
  clientUuid,
  onOpen,
  api = autoCollectionApi,
  initialStatus = null,
  now = () => new Date(),
}) {
  const [status, setStatus] = useState(initialStatus);
  const request = useRef(null);

  useEffect(() => {
    // No fetch and no clearing: the caller keys this component by client uuid,
    // so a different client is a different component with its own empty state.
    if (!clientUuid) return undefined;
    let live = true;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    api.loadStatus(clientUuid, { signal: controller.signal })
      .then((result) => { if (live) setStatus(result); })
      .catch(() => { if (live) setStatus(null); });
    return () => {
      live = false;
      controller.abort();
    };
  }, [api, clientUuid]);

  const badge = useMemo(() => {
    if (!status) return null;
    return collectorFlagBadge(collectorFlags(status, now()));
    // `now` is a clock, not data: re-running on every tick would rebuild the
    // badge once a second for a value that changes at most twice a day.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  if (!badge) return null;

  return (
    <button
      type="button"
      className={`collector-flag-badge ${badge.severity}`}
      title={`${badge.title}. Open ${badge.tab}.`}
      onClick={() => onOpen?.(badge.tab)}
    >
      <AlertTriangle size={13} aria-hidden="true" />
      <span>{badge.label}</span>
    </button>
  );
}
