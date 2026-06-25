import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, TrendingUp, Zap } from 'lucide-react';
import { ACCOUNT_TYPES, ACCOUNT_STATUSES } from '../domain/reconcile';

const ALGO_STACKS = ['', 'URGO', 'IFSP', 'URGO + IFSP', 'URGO x2', 'IFSP x2', 'Custom'];
const DLL_OPTIONS = ['', 'None', '$300', '$400', '$500', '$600', '$700', '$800', '$1,000'];

function getRecommendation(activeFunded, freshEvals) {
  if (activeFunded === 0) {
    return {
      stack: 'No funded accounts',
      dll: 'N/A',
      bulletBot: freshEvals > 0 ? 'Run Bullet Bot on fresh evals' : 'No accounts ready',
      riskLevel: 'none',
      notes: 'Focus on passing evaluation accounts first.',
    };
  }
  if (activeFunded === 1) {
    return {
      stack: 'URGO',
      dll: 'None (single account)',
      bulletBot: freshEvals >= 1 ? `${freshEvals} eval(s) ready for Bullet Bot` : 'No fresh evals',
      riskLevel: 'low',
      notes: 'Single funded account. Run URGO only. No DLL needed.',
    };
  }
  if (activeFunded === 2) {
    return {
      stack: 'URGO on Acct 1 · IFSP on Acct 2',
      dll: 'Optional — set if P&L variance is high',
      bulletBot: freshEvals >= 1 ? `${freshEvals} eval(s) ready for Bullet Bot` : 'No fresh evals',
      riskLevel: 'medium',
      notes: 'Diversify stacks. URGO primary, IFSP secondary for decorrelation.',
    };
  }
  if (activeFunded === 3) {
    return {
      stack: 'URGO + IFSP spread across accounts',
      dll: 'Recommended — $500–$600 per account',
      bulletBot: freshEvals >= 1 ? `${freshEvals} eval(s) ready for Bullet Bot` : 'No fresh evals',
      riskLevel: 'medium',
      notes: '3 accounts: spread stacks. Set DLL to protect daily gains. Monitor correlation.',
    };
  }
  return {
    stack: 'URGO + IFSP mixed — rotate per account',
    dll: 'Required — $500–$700 per account',
    bulletBot: freshEvals >= 1 ? `${freshEvals} eval(s) ready for Bullet Bot` : 'No fresh evals',
    riskLevel: 'high',
    notes: `${activeFunded} funded accounts: full stack diversification. DLL is mandatory at this scale to protect daily variance.`,
  };
}

function riskColor(level) {
  if (level === 'none') return 'muted';
  if (level === 'low') return 'positive';
  if (level === 'medium') return 'warning';
  if (level === 'high') return 'negative';
  return '';
}

function getRiskScore(account, snapshots) {
  const stackCount = (account.algoStack || '').split('+').filter(Boolean).length;
  const hasDll = account.dailyLossLimit && Number(account.dailyLossLimit) > 0;
  const snap = snapshots.find((s) => s.accountName === account.accountName);
  const buffer = snap ? Number(snap.trailingMaxDrawdown || 0) : 0;

  let score = 0;
  if (stackCount >= 3) score += 3;
  else if (stackCount === 2) score += 2;
  else if (stackCount === 1) score += 1;

  if (!hasDll) score += 2;

  if (buffer > 0 && buffer < 500) score += 3;
  else if (buffer > 0 && buffer < 1200) score += 1;

  if (score <= 1) return { label: 'Low', tone: 'positive' };
  if (score <= 3) return { label: 'Medium', tone: 'warning' };
  return { label: 'High', tone: 'negative' };
}

export default function StackPlaybook({ client, dailyImport, onUpdateAccount }) {
  const registry = {
    ...(dailyImport?.accounts || {}),
    ...(client?.accountRegistry || {}),
  };
  const snapshots = dailyImport?.snapshots || [];

  const funded = Object.values(registry).filter(
    (a) => a.accountType === ACCOUNT_TYPES.FUNDED && a.status !== ACCOUNT_STATUSES.FAILED && a.status !== ACCOUNT_STATUSES.INACTIVE,
  );

  const freshEvals = Object.values(registry).filter((a) => {
    if (!a.accountType?.startsWith('Evaluation')) return false;
    const snap = snapshots.find((s) => s.accountName === a.accountName);
    const buffer = snap ? Number(snap.trailingMaxDrawdown || 0) : 0;
    return buffer >= 2000;
  });

  const rec = getRecommendation(funded.length, freshEvals.length);

  const [localStack, setLocalStack] = useState({});
  const [localDll, setLocalDll] = useState({});

  function updateStack(accountName, value) {
    setLocalStack((prev) => ({ ...prev, [accountName]: value }));
    onUpdateAccount?.(accountName, { algoStack: value });
  }

  function updateDll(accountName, value) {
    setLocalDll((prev) => ({ ...prev, [accountName]: value }));
    onUpdateAccount?.(accountName, { dailyLossLimit: value });
  }

  return (
    <div className="stack-playbook">
      <section className="panel">
        <div className="panel-heading">
          <h3>Stack Recommendation</h3>
          <span className="badge muted">{funded.length} active funded · {freshEvals.length} fresh evals</span>
        </div>

        <div className="playbook-rec-grid">
          <div className="playbook-rec-card">
            <div className="playbook-rec-label"><TrendingUp size={14} /> Recommended Stack</div>
            <div className="playbook-rec-value">{rec.stack}</div>
          </div>
          <div className="playbook-rec-card">
            <div className="playbook-rec-label"><Zap size={14} /> Daily Loss Limit</div>
            <div className="playbook-rec-value">{rec.dll}</div>
          </div>
          <div className="playbook-rec-card">
            <div className="playbook-rec-label"><CheckCircle2 size={14} /> Bullet Bot</div>
            <div className="playbook-rec-value">{rec.bulletBot}</div>
          </div>
          <div className="playbook-rec-card">
            <div className="playbook-rec-label"><AlertTriangle size={14} /> Risk Level</div>
            <div className={`playbook-rec-value ${riskColor(rec.riskLevel)}`}>{rec.riskLevel.charAt(0).toUpperCase() + rec.riskLevel.slice(1)}</div>
          </div>
        </div>

        {rec.notes ? (
          <div className="playbook-notes">
            <Info size={14} />
            <span>{rec.notes}</span>
          </div>
        ) : null}
      </section>

      {funded.length > 0 ? (
        <section className="panel">
          <div className="panel-heading">
            <h3>Funded Account Configuration</h3>
            <span className="badge muted">Algo stack + DLL per account</span>
          </div>
          <div className="table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Status</th>
                  <th>Drawdown Buffer</th>
                  <th>Algo Stack</th>
                  <th>Daily Loss Limit</th>
                  <th>Risk Level</th>
                </tr>
              </thead>
              <tbody>
                {funded.map((account) => {
                  const snap = snapshots.find((s) => s.accountName === account.accountName);
                  const buffer = snap ? Number(snap.trailingMaxDrawdown || 0) : null;
                  const risk = getRiskScore(account, snapshots);
                  const stackVal = localStack[account.accountName] ?? (account.algoStack || '');
                  const dllVal = localDll[account.accountName] ?? (account.dailyLossLimit || '');
                  return (
                    <tr key={account.accountName}>
                      <td>
                        <strong>{account.alias || account.accountName}</strong>
                        <small>{account.accountName}</small>
                      </td>
                      <td>{account.status || 'Active'}</td>
                      <td>
                        {buffer !== null
                          ? (buffer <= 0
                            ? <span className="negative">BREACHED</span>
                            : <span className={buffer <= 1200 ? 'warning' : ''}>${buffer.toLocaleString()}</span>)
                          : <span className="muted">—</span>}
                      </td>
                      <td>
                        <select
                          value={stackVal}
                          onChange={(e) => updateStack(account.accountName, e.target.value)}
                        >
                          {ALGO_STACKS.map((opt) => <option key={opt} value={opt}>{opt || 'Not set'}</option>)}
                        </select>
                      </td>
                      <td>
                        <select
                          value={dllVal}
                          onChange={(e) => updateDll(account.accountName, e.target.value)}
                        >
                          {DLL_OPTIONS.map((opt) => <option key={opt} value={opt}>{opt || 'None'}</option>)}
                        </select>
                      </td>
                      <td className={risk.tone}>{risk.label}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {freshEvals.length > 0 ? (
        <section className="panel">
          <div className="panel-heading">
            <h3>Bullet Bot Ready</h3>
            <span className="badge muted">Evals with ≥$2,000 drawdown buffer</span>
          </div>
          <div className="table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Type</th>
                  <th>Drawdown Buffer</th>
                  <th>Pass Type</th>
                  <th>Direction</th>
                </tr>
              </thead>
              <tbody>
                {freshEvals.map((account) => {
                  const snap = snapshots.find((s) => s.accountName === account.accountName);
                  const buffer = snap ? Number(snap.trailingMaxDrawdown || 0) : 0;
                  return (
                    <tr key={account.accountName}>
                      <td>
                        <strong>{account.alias || account.accountName}</strong>
                        <small>{account.accountName}</small>
                      </td>
                      <td>{account.accountType}</td>
                      <td className="positive">${buffer.toLocaleString()}</td>
                      <td>{account.bulletBotPassType || <span className="muted">Not set</span>}</td>
                      <td>{account.bulletBotDirection || <span className="muted">Not set</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-heading">
          <h3>Stack Rules Reference</h3>
          <span className="badge muted">Decision guide</span>
        </div>
        <div className="table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th># Funded Active</th>
                <th>Recommended Stack</th>
                <th>Daily Loss Limit</th>
                <th>Risk Level</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>0</td>
                <td className="muted">Run Bullet Bot on fresh evals</td>
                <td className="muted">N/A</td>
                <td className="muted">None</td>
              </tr>
              <tr>
                <td>1</td>
                <td>URGO</td>
                <td>None</td>
                <td className="positive">Low</td>
              </tr>
              <tr>
                <td>2</td>
                <td>URGO + IFSP (split)</td>
                <td>Optional</td>
                <td className="warning">Medium</td>
              </tr>
              <tr>
                <td>3</td>
                <td>URGO + IFSP spread</td>
                <td>Recommended ($500–$600)</td>
                <td className="warning">Medium</td>
              </tr>
              <tr>
                <td>4+</td>
                <td>Mixed — rotate per account</td>
                <td>Required ($500–$700)</td>
                <td className="negative">High</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
