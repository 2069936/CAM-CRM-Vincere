import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Ban,
  Check,
  CheckCircle2,
  Clock3,
  Copy,
  Download,
  KeyRound,
  LoaderCircle,
  Radio,
  RefreshCw,
  RotateCcw,
  Server,
  ShieldCheck,
  X,
} from 'lucide-react';
import { autoCollectionApi } from '../domain/autoCollectionApi';
import {
  buildAutoCollectionViewModel,
  confirmationPhrase,
  copyEnrollmentCode,
  isEnrollmentUsable,
  remainingEnrollmentSeconds,
} from '../domain/autoCollectionViewModel';
const REBIND_REASON_OPTIONS = [
  ['vps_rebuilt', 'The VPS was rebuilt'],
  ['device_replaced', 'This is a replacement VPS'],
  ['support_reset', 'Support reset'],
];
const REVOKE_REASON_OPTIONS = [
  ['client_offboarded', 'Client offboarded'],
  ['security_revoke', 'Security concern'],
  ['support_reset', 'Support reset'],
];


function formatCountdown(seconds) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')} remaining`;
}

function formatTime(value) {
  if (!value) return 'Not yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not yet';
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function formatSchedule(schedule) {
  const time = String(schedule?.time || '16:45:00').slice(0, 5);
  const timezone = schedule?.timezone || 'America/New_York';
  if (time === '16:45' && timezone === 'America/New_York') return 'Daily at 4:45 PM ET';
  return `Daily at ${time} · ${timezone}`;
}

function StepMarker({ status = 'future' }) {
  if (status === 'done') return <Check size={14} aria-hidden="true" />;
  return <span aria-hidden="true" />;
}

function ConnectionStep({ number, title, description, state = 'future', children }) {
  return (
    <li className={`auto-collection-step ${state}`}>
      <div className="auto-collection-step-marker">
        <StepMarker status={state} />
        <span className="sr-only">Step {number}: {state}</span>
      </div>
      <div className="auto-collection-step-copy">
        <span className="auto-collection-step-number">{String(number).padStart(2, '0')}</span>
        <strong>{title}</strong>
        <p>{description}</p>
        {children}
      </div>
    </li>
  );
}

function SetupConfirmation({ action, clientName, busy, onCancel, onConfirm }) {
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState(action?.kind === 'rebind' ? 'vps_rebuilt' : 'security_revoke');
  const dialogRef = useRef(null);
  const returnFocus = useRef(null);
  useEffect(() => {
    returnFocus.current = document.activeElement;
    return () => returnFocus.current?.focus?.();
  }, []);
  if (!action) return null;
  const phrase = confirmationPhrase(action.kind, clientName);
  const reasonOptions = action.kind === 'rebind' ? REBIND_REASON_OPTIONS : REVOKE_REASON_OPTIONS;
  return (
    <div className="auto-collection-confirm-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onCancel();
    }}>
      <section
        ref={dialogRef}
        className="auto-collection-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="collector-confirm-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) {
            event.preventDefault();
            onCancel();
            return;
          }
          if (event.key !== 'Tab') return;
          const focusable = [...dialogRef.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')];
          const first = focusable[0];
          const last = focusable.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <div className="auto-collection-confirm-head">
          <div>
            <span className="auto-collection-eyebrow">Confirm client binding</span>
            <h4 id="collector-confirm-title">{action.title}</h4>
          </div>
          <button type="button" className="ghost-button icon-only" aria-label="Close confirmation" disabled={busy} onClick={onCancel}><X size={15} /></button>
        </div>
        <p>{action.description}</p>
        {action.kind !== 'generate' ? (
          <label>
            Reason
            <select value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)}>
              {reasonOptions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
            </select>
          </label>
        ) : null}
        <label>
          Type <code>{phrase}</code> to continue
          <input value={typed} disabled={busy} autoFocus onChange={(event) => setTyped(event.target.value)} autoComplete="off" />
        </label>
        <div className="auto-collection-confirm-actions">
          <button type="button" className="ghost-button" disabled={busy} onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className={action.kind === 'revoke' ? 'danger-button' : 'primary-button'}
            disabled={busy || typed !== phrase}
            onClick={() => onConfirm(reason)}
          >
            {busy ? <LoaderCircle className="spin" size={14} /> : null}
            {busy ? 'Working…' : action.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

function StatusDetail({ label, value, dateTime }) {
  return (
    <div className="auto-collection-detail">
      <span>{label}</span>
      {dateTime && value !== 'Not yet' ? <time dateTime={dateTime}>{value}</time> : <strong>{value}</strong>}
    </div>
  );
}

export default function AutoCollectionCard({
  clientUuid,
  clientName,
  api = autoCollectionApi,
  initialStatus = null,
  initialError = null,
  disableAutoLoad = false,
}) {
  const [status, setStatus] = useState(initialStatus);
  const [error, setError] = useState(initialError);
  const [loading, setLoading] = useState(!initialStatus && !initialError && !disableAutoLoad);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState(null);
  const [copyState, setCopyState] = useState('idle');
  const [installerStarted, setInstallerStarted] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.parse(initialStatus?.serverTime || '') || Date.now());
  const requestSequence = useRef(0);
  const activeRequest = useRef(null);
  const clockAnchor = useRef(null);
  const copyTimer = useRef(null);

  const calibrateClock = useCallback((serverTime) => {
    const server = Date.parse(serverTime || '');
    if (!Number.isFinite(server)) return;
    clockAnchor.current = { server, local: Date.now() };
    setNowMs(server);
  }, []);

  const loadStatus = useCallback(async () => {
    const sequence = ++requestSequence.current;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setLoading(true);
    setError(null);
    try {
      const result = await api.loadStatus(clientUuid, { signal: controller.signal });
      if (sequence !== requestSequence.current) return;
      setStatus(result);
      calibrateClock(result.serverTime);
    } catch (caught) {
      if (caught?.name !== 'AbortError' && sequence === requestSequence.current) setError(caught);
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [api, calibrateClock, clientUuid]);

  useEffect(() => {
    const startTimer = disableAutoLoad ? null : window.setTimeout(loadStatus, 0);
    return () => {
      if (startTimer !== null) window.clearTimeout(startTimer);
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      requestSequence.current += 1;
      activeRequest.current?.abort();
    };
  }, [disableAutoLoad, loadStatus]);

  const enrollmentSeconds = remainingEnrollmentSeconds(status?.enrollment?.expiresAt, nowMs);
  useEffect(() => {
    if (!status?.enrollment?.code) return undefined;
    const expiresAt = Date.parse(status.enrollment.expiresAt || '');
    const startingAt = clockAnchor.current?.server ?? Date.parse(status.serverTime || '');
    if (!Number.isFinite(expiresAt) || !Number.isFinite(startingAt) || expiresAt <= startingAt) return undefined;
    if (!clockAnchor.current) clockAnchor.current = { server: startingAt, local: Date.now() };
    const timer = window.setInterval(() => {
      const anchor = clockAnchor.current;
      if (!anchor) return;
      const current = anchor.server + (Date.now() - anchor.local);
      setNowMs(Number.isFinite(expiresAt) ? Math.min(current, expiresAt) : current);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [status?.enrollment?.code, status?.enrollment?.expiresAt, status?.serverTime]);

  async function runConfirmedAction(reason) {
    const action = confirmation;
    if (!action || busy) return;
    const sequence = ++requestSequence.current;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setBusy(true);
    setError(null);
    try {
      let result;
      if (action.kind === 'generate') result = await api.generateEnrollment(clientUuid, { signal: controller.signal });
      if (action.kind === 'rebind') result = await api.rebind(clientUuid, reason, { signal: controller.signal });
      if (action.kind === 'revoke') {
        const activeDeviceId = status?.device?.status === 'active' && !status?.device?.revokedAt
          ? status.device.id
          : null;
        result = await api.revoke(clientUuid, {
          ...(activeDeviceId ? { deviceId: activeDeviceId } : { enrollmentId: status?.enrollment?.id }),
          reason,
          signal: controller.signal,
        });
      }
      if (sequence !== requestSequence.current) return;
      if (action.kind === 'revoke') {
        const revokedAt = new Date().toISOString();
        setStatus((current) => ({
          ...current,
          device: result?.revoked?.kind === 'device'
            ? { ...current?.device, status: 'revoked', revokedAt }
            : current?.device,
          enrollment: result?.revoked?.kind === 'enrollment'
            ? { ...current?.enrollment, revokedAt }
            : current?.enrollment,
        }));
      } else {
        setStatus((current) => ({ ...current, serverTime: result.serverTime, enrollment: result.enrollment }));
        calibrateClock(result.serverTime);
      }
      setConfirmation(null);
    } catch (caught) {
      if (caught?.name !== 'AbortError' && sequence === requestSequence.current) setError(caught);
    } finally {
      if (sequence === requestSequence.current) setBusy(false);
    }
  }

  async function handleCopy() {
    try {
      await copyEnrollmentCode(status?.enrollment?.code);
      setCopyState('copied');
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => {
        copyTimer.current = null;
        setCopyState('idle');
      }, 1800);
    } catch {
      setCopyState('failed');
    }
  }

  if (error?.status === 403 || error?.status === 401) {
    return (
      <section className="panel auto-collection-panel permission-denied" aria-labelledby="auto-collection-title">
        <div className="auto-collection-state-icon"><ShieldCheck size={20} /></div>
        <div><h3 id="auto-collection-title">Permission required</h3><p>{error.message}</p></div>
      </section>
    );
  }

  const view = buildAutoCollectionViewModel(status, nowMs);
  const usableCode = isEnrollmentUsable(status?.enrollment, nowMs);
  const device = status?.device;
  const activeDevice = device?.status === 'active' && !device?.revokedAt ? device : null;
  const activeEnrollment = status?.enrollment
    && !status.enrollment.consumedAt
    && !status.enrollment.revokedAt
    ? status.enrollment
    : null;
  const hasRelease = Boolean(status?.release);
  const displayClientName = status?.client?.name || clientName;
  const stepOneDone = Boolean(activeDevice || installerStarted);
  const stepTwoDone = Boolean(activeDevice);
  const stepThreeDone = Boolean(activeDevice);
  const stepFourDone = view.state === 'online';

  return (
    <section className={`panel auto-collection-panel state-${view.state}`} aria-labelledby="auto-collection-title" aria-busy={loading || busy}>
      <header className="auto-collection-header">
        <div>
          <span className="auto-collection-eyebrow"><Radio size={12} /> VPS data connection</span>
          <h3 id="auto-collection-title">Automatic NinjaTrader collection</h3>
          <p>Connect this client&apos;s VPS once. Accounts, strategies, orders, and executions will upload automatically.</p>
        </div>
        <div className={`auto-collection-state ${view.tone}`} role="status">
          <span className="auto-collection-state-dot" aria-hidden="true" />
          <div><strong>{loading ? 'Checking…' : view.label}</strong><span>{loading ? 'Loading the latest VPS status.' : view.detail}</span></div>
        </div>
      </header>

      {error ? <div className="auto-collection-notice danger" role="alert"><AlertTriangle size={15} /><span>{error.message}</span><button type="button" className="ghost-button" onClick={loadStatus}>Try again</button></div> : null}

      <div className="auto-collection-binding">
        <Server size={17} aria-hidden="true" />
        <span>Bound to</span>
        <strong>{displayClientName}</strong>
        <span className="auto-collection-schedule"><Clock3 size={13} /> {formatSchedule(device?.schedule)}</span>
      </div>

      <ol className="auto-collection-trace" aria-label="Collector setup progress">
        <ConnectionStep
          number={1}
          title="Download installer"
          description={hasRelease ? `Windows agent ${status.release.version}` : 'Waiting for an approved Windows release.'}
          state={stepOneDone ? 'done' : hasRelease ? 'active' : 'future'}
        >
          {hasRelease ? <a className="primary-button auto-collection-step-action" href={status.release.url} target="_blank" rel="noopener noreferrer" onClick={() => setInstallerStarted(true)}><Download size={14} /> Download agent</a> : null}
        </ConnectionStep>
        <ConnectionStep
          number={2}
          title="Run as administrator"
          description="Open the downloaded installer on the client VPS and approve the Windows prompt."
          state={stepTwoDone ? 'done' : installerStarted ? 'active' : 'future'}
        />
        <ConnectionStep
          number={3}
          title="Enter one-time code"
          description="The installer asks for this code to bind the correct client."
          state={stepThreeDone ? 'done' : usableCode ? 'active' : 'future'}
        >
          {usableCode ? (
            <div className="auto-collection-code-wrap">
              <code className="auto-collection-code">{status.enrollment.code}</code>
              <button type="button" className="ghost-button icon-only" aria-label="Copy one-time code" onClick={handleCopy}><Copy size={14} /></button>
              <span>{copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy unavailable' : formatCountdown(enrollmentSeconds)}</span>
            </div>
          ) : !device && status?.permissions?.generate ? (
            <button type="button" className="secondary-button auto-collection-step-action" onClick={() => setConfirmation({
              kind: 'generate',
              title: 'Generate a one-time code?',
              description: 'Any older unused code for this client will stop working.',
              confirmLabel: 'Generate one-time code',
            })}><KeyRound size={14} /> Generate one-time code</button>
          ) : null}
        </ConnectionStep>
        <ConnectionStep
          number={4}
          title="Confirm connection"
          description="Leave NinjaTrader open and confirm this step turns green."
          state={stepFourDone ? 'done' : activeDevice ? 'active' : 'future'}
        >
          {activeDevice && !stepFourDone ? <button type="button" className="secondary-button auto-collection-step-action" disabled={loading} onClick={loadStatus}><RefreshCw size={14} className={loading ? 'spin' : ''} /> Check connection</button> : null}
          {stepFourDone ? <span className="auto-collection-connected"><CheckCircle2 size={14} /> Connection test passed</span> : null}
        </ConnectionStep>
      </ol>

      {device ? (
        <div className="auto-collection-details" aria-label="Collector details">
          <StatusDetail label="Last heartbeat" value={formatTime(device.lastSeenAt)} dateTime={device.lastSeenAt} />
          <StatusDetail label="Last capture" value={formatTime(device.lastCaptureAt)} dateTime={device.lastCaptureAt} />
          <StatusDetail label="Last successful upload" value={formatTime(device.lastSuccessAt)} dateTime={device.lastSuccessAt} />
          <StatusDetail label="Installed versions" value={`Agent ${device.agentVersion || '—'} · Add-on ${device.addonVersion || '—'} · NinjaTrader ${device.ninjaTraderVersion || '—'}`} />
        </div>
      ) : null}

      {device || status?.enrollment ? (
        <footer className="auto-collection-footer">
          <span>Only rebind or revoke when the VPS assignment intentionally changes.</span>
          <div>
            {status?.permissions?.rebind ? <button type="button" className="ghost-button" onClick={() => setConfirmation({ kind: 'rebind', title: 'Rebind this client to another VPS?', description: 'The current VPS and all unused codes will immediately lose access.', confirmLabel: 'Rebind VPS' })}><RotateCcw size={14} /> Rebind VPS</button> : null}
            {status?.permissions?.revoke && (activeDevice || activeEnrollment) ? <button type="button" className="ghost-button danger-text" onClick={() => setConfirmation({ kind: 'revoke', title: 'Revoke automatic collection access?', description: 'Uploads from the current VPS will stop immediately.', confirmLabel: 'Revoke access' })}><Ban size={14} /> Revoke access</button> : null}
          </div>
        </footer>
      ) : null}

      <SetupConfirmation
        key={confirmation?.kind || 'none'}
        action={confirmation}
        clientName={displayClientName}
        busy={busy}
        onCancel={() => { if (!busy) setConfirmation(null); }}
        onConfirm={runConfirmedAction}
      />
    </section>
  );
}
