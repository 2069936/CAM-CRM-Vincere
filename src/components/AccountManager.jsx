import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { ACCOUNT_STATUSES, ACCOUNT_TYPES, PAYOUT_STATES, RISK_LEVELS, isCashType } from '../domain/reconcile';
import { normalizePropFirm, plansFor, resolveAccountLimits } from '../domain/propFirmRules';

const ACCOUNT_TYPE_OPTIONS = [
  ACCOUNT_TYPES.UNASSIGNED,
  ACCOUNT_TYPES.EVALUATION_BULLET,
  ACCOUNT_TYPES.EVALUATION_STANDARD,
  ACCOUNT_TYPES.FUNDED,
  ACCOUNT_TYPES.CASH_IRA,
  ACCOUNT_TYPES.CASH_STRAIGHT,
  ACCOUNT_TYPES.IGNORE,
];

// Accounts classified before the IRA/Straight split still hold the legacy 'Cash'
// value. Offer it only on those rows, so the dropdown shows their real value
// instead of silently snapping to another type, and the CAM can reclassify.
function typeOptionsFor(accountType) {
  return accountType === ACCOUNT_TYPES.CASH
    ? [...ACCOUNT_TYPE_OPTIONS, ACCOUNT_TYPES.CASH]
    : ACCOUNT_TYPE_OPTIONS;
}

const STATUS_OPTIONS = Object.values(ACCOUNT_STATUSES);
const PAYOUT_OPTIONS = Object.values(PAYOUT_STATES);
const PASS_TYPES = ['', '1-day pass', '2-day pass', '3-day pass'];
const DIRECTIONS = ['', 'Long', 'Short'];
const RISK_OPTIONS = ['', ...RISK_LEVELS];

/**
 * Names the account's plan, which nothing the platform reports can reveal.
 *
 * Firm and size are derivable — the connection names the firm, the earliest
 * balance on record gives the size — but the plan is a purchase decision, and it
 * is the plan that sets the limits. Legends sells 50k at 2,000 on Apprentice and
 * 2,200 on Elite; Lucid 100k is 3,000 on Pro and 3,500 on Direct.
 *
 * Until a CAM names it, the account runs on the tightest drawdown that firm
 * sells at that size. That is deliberately the pessimistic guess: warning 200
 * dollars early is survivable, warning 200 dollars after the account is dead is
 * not. The cell says so rather than presenting the fallback as settled.
 *
 * Picking a plan writes the limits onto the account. They stay editable —
 * published rules change, and a stored value the desk typed always wins.
 */
function PlanPicker({ account, dailyImports, onUpdateAccount }) {
  const firm = normalizePropFirm(account.connection);
  const plans = firm ? plansFor(firm) : [];

  if (isCashType(account.accountType)) return <span className="field-na">N/A</span>;
  if (!firm) return <span className="field-na" title="No prop firm recognised in this account's connection">—</span>;
  if (!plans.length) {
    // A firm nobody has researched yet. This must not block the row: the CAM can
    // still type the drawdown into Max DD $ and the account behaves normally.
    // What it should not do is look identical to a firm whose rules are loaded,
    // because then nobody ever goes and gets them.
    const known = Boolean(account.maxDrawdownLimit);
    return (
      <span
        className={known ? 'muted' : 'plan-fallback'}
        title={`No published rules on record for ${firm}. Enter Max DD $ by hand, or ask for the firm to be researched.`}
      >
        {firm}
        {known ? null : ' · needs review'}
      </span>
    );
  }

  const limits = resolveAccountLimits(account, { dailyImports });

  const apply = (plan) => {
    if (!plan) {
      onUpdateAccount(account.accountName, { propFirmPlan: '' });
      return;
    }
    const next = resolveAccountLimits({ ...account, propFirmPlan: plan }, { dailyImports });
    onUpdateAccount(account.accountName, {
      propFirmPlan: plan,
      // Only filled from the rule when the desk has not typed its own number.
      ...(account.maxDrawdownLimit ? {} : { maxDrawdownLimit: next.maxDrawdownLimit ?? '' }),
      ...(account.targetProfit ? {} : { targetProfit: next.targetProfit ?? '' }),
    });
  };

  const hint = limits.accountSize
    ? `${firm} ${(limits.accountSize / 1000)}k`
    : `${firm}, size unknown — set Start Bal $ to resolve the limits`;

  return (
    <div className="plan-picker">
      <select
        value={account.propFirmPlan || ''}
        onChange={(event) => apply(event.target.value)}
        aria-label={`Plan for ${account.accountName}`}
      >
        <option value="">Which plan?</option>
        {plans.map((plan) => <option key={plan} value={plan}>{plan}</option>)}
      </select>
      <small className={limits.planKnown ? 'muted' : 'plan-fallback'} title={hint}>
        {limits.planKnown
          ? hint
          : `${hint} · using tightest`}
      </small>
    </div>
  );
}

export default function AccountManager({ accounts, snapshots, dailyImports = [], onUpdateAccount, onAddAccount, onRemoveAccount, mode }) {
  const isCash = mode === 'cash';
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState(ACCOUNT_TYPES.FUNDED);
  const [newAlias, setNewAlias] = useState('');
  const [newConnection, setNewConnection] = useState('');

  const rows = Object.values(accounts || {}).map((account) => ({
    ...account,
    snapshot: (snapshots || []).find((item) => item.accountName?.toLowerCase() === account.accountName?.toLowerCase()),
  }));

  function submitAdd(e) {
    e.preventDefault();
    if (!newName.trim()) return;
    onAddAccount?.(newName.trim(), {
      accountName: newName.trim(),
      alias: newAlias.trim() || newName.trim(),
      accountType: newType,
      connection: newConnection.trim(),
      status: ACCOUNT_STATUSES.ACTIVE,
      dateAdded: new Date().toISOString().slice(0, 10),
    });
    setNewName(''); setNewAlias(''); setNewConnection('');
  }

  return (
    <div>
    {onAddAccount && (
      <form className="add-account-form" onSubmit={submitAdd}>
        <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Account ID (e.g. ROME7045)" />
        <input value={newAlias} onChange={e => setNewAlias(e.target.value)} placeholder="Alias (e.g. BlueSky - 7045)" />
        <input value={newConnection} onChange={e => setNewConnection(e.target.value)} placeholder="Connection" />
        <select value={newType} onChange={e => setNewType(e.target.value)}>
          {ACCOUNT_TYPE_OPTIONS.map(o => <option key={o}>{o}</option>)}
        </select>
        <button type="submit" className="primary-button">
          <Plus size={14} /> Add account
        </button>
      </form>
    )}
    {!rows.length ? (
      <div className="empty-state">No accounts loaded for this date yet. Use the form above to pre-register an account, or upload an NT CSV file.</div>
    ) : (
    <div className="table-wrap">
      <table className="ops-table registry-table">
        <thead>
          <tr>
            <th>Account</th>
            <th>Type</th>
            <th>Status</th>
            <th>Risk</th>
            {!isCash ? <th>Pass</th> : null}
            {!isCash ? <th>Direction</th> : null}
            {!isCash ? <th>Payout</th> : null}
            {!isCash ? <th>Plan</th> : null}
            {!isCash ? <th>Start Bal $</th> : null}
            {!isCash ? <th>Target $</th> : null}
            {!isCash ? <th>Max DD $</th> : null}
            {!isCash ? <th>Date Added</th> : null}
            {!isCash ? <th>Date Funded</th> : null}
            {!isCash ? <th>Date Failed</th> : null}
            {!isCash ? <th>Last Payout</th> : null}
            {!isCash ? <th>Last Payout $</th> : null}
            {!isCash ? <th># Payouts</th> : null}
            <th>Notes</th>
            {onRemoveAccount ? <th></th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((account) => (
            <tr key={account.accountName}>
              <td>
                <strong>{account.alias || account.accountName}</strong>
                <small>{account.connection || 'No connection'} · {account.accountName}</small>
              </td>
              <td>
                <select
                  value={account.accountType || ACCOUNT_TYPES.UNASSIGNED}
                  onChange={(event) => onUpdateAccount(account.accountName, { accountType: event.target.value })}
                >
                  {typeOptionsFor(account.accountType).map((option) => <option key={option}>{option}</option>)}
                </select>
              </td>
              <td>
                <select
                  value={account.status || ACCOUNT_STATUSES.ACTIVE}
                  onChange={(event) => onUpdateAccount(account.accountName, { status: event.target.value })}
                >
                  {STATUS_OPTIONS.map((option) => <option key={option}>{option}</option>)}
                </select>
              </td>
              <td>
                <select
                  value={account.riskLevel || ''}
                  onChange={(event) => onUpdateAccount(account.accountName, { riskLevel: event.target.value })}
                >
                  {RISK_OPTIONS.map((option) => <option key={option} value={option}>{option || 'Unassigned'}</option>)}
                </select>
              </td>
              {!isCash ? (
                <td>
                  {isCashType(account.accountType) ? <span className="field-na">N/A</span> : (
                    <select
                      value={account.bulletBotPassType || ''}
                      disabled={account.accountType !== ACCOUNT_TYPES.EVALUATION_BULLET}
                      onChange={(event) => onUpdateAccount(account.accountName, { bulletBotPassType: event.target.value })}
                    >
                      {PASS_TYPES.map((option) => <option key={option} value={option}>{option || 'N/A'}</option>)}
                    </select>
                  )}
                </td>
              ) : null}
              {!isCash ? (
                <td>
                  {isCashType(account.accountType) ? <span className="field-na">N/A</span> : (
                    <select
                      value={account.bulletBotDirection || ''}
                      disabled={account.accountType !== ACCOUNT_TYPES.EVALUATION_BULLET}
                      onChange={(event) => onUpdateAccount(account.accountName, { bulletBotDirection: event.target.value })}
                    >
                      {DIRECTIONS.map((option) => <option key={option} value={option}>{option || 'N/A'}</option>)}
                    </select>
                  )}
                </td>
              ) : null}
              {!isCash ? (
                <td>
                  {isCashType(account.accountType) ? <span className="field-na">N/A</span> : (
                    <select
                      value={account.payoutState || PAYOUT_STATES.NOT_REQUESTED}
                      onChange={(event) => onUpdateAccount(account.accountName, { payoutState: event.target.value })}
                    >
                      {PAYOUT_OPTIONS.map((option) => <option key={option}>{option}</option>)}
                    </select>
                  )}
                </td>
              ) : null}
              {!isCash ? (
                <td>
                  {isCashType(account.accountType) ? <span className="field-na">N/A</span> : (
                    <input
                      type="number"
                      value={account.startBalance ?? ''}
                      placeholder="e.g. 50000"
                      onChange={(event) => onUpdateAccount(account.accountName, { startBalance: event.target.value })}
                    />
                  )}
                </td>
              ) : null}
              {!isCash ? (
                <td>
                  <PlanPicker
                    account={account}
                    dailyImports={dailyImports}
                    onUpdateAccount={onUpdateAccount}
                  />
                </td>
              ) : null}
              {!isCash ? (
                <td>
                  {isCashType(account.accountType) ? <span className="field-na">N/A</span> : (
                    <input
                      type="number"
                      value={account.targetProfit ?? ''}
                      placeholder="e.g. 52000"
                      onChange={(event) => onUpdateAccount(account.accountName, { targetProfit: event.target.value })}
                    />
                  )}
                </td>
              ) : null}
              {!isCash ? (
                <td>
                  {isCashType(account.accountType) ? <span className="field-na">N/A</span> : (
                    <input
                      type="number"
                      value={account.maxDrawdownLimit ?? ''}
                      placeholder="e.g. 2500"
                      onChange={(event) => onUpdateAccount(account.accountName, { maxDrawdownLimit: event.target.value })}
                    />
                  )}
                </td>
              ) : null}
              {!isCash ? (
                <td>
                  <input
                    type="date"
                    value={account.dateAdded || ''}
                    onChange={(event) => onUpdateAccount(account.accountName, { dateAdded: event.target.value })}
                  />
                </td>
              ) : null}
              {!isCash ? (
                <td>
                  <input
                    type="date"
                    value={account.dateFunded || ''}
                    onChange={(event) => onUpdateAccount(account.accountName, { dateFunded: event.target.value })}
                  />
                </td>
              ) : null}
              {!isCash ? (
                <td>
                  <input
                    type="date"
                    value={account.dateFailed || ''}
                    onChange={(event) => onUpdateAccount(account.accountName, { dateFailed: event.target.value })}
                  />
                </td>
              ) : null}
              {!isCash ? (
                <td>
                  <input
                    type="date"
                    value={account.dateLastPayout || ''}
                    onChange={(event) => onUpdateAccount(account.accountName, { dateLastPayout: event.target.value })}
                  />
                </td>
              ) : null}
              {!isCash ? (
                <td>
                  {(() => {
                    const last = (account.payoutHistory || []).at(-1);
                    return last
                      ? <span style={{fontSize:12}}>${Number(last.amount || 0).toLocaleString()}</span>
                      : <span className="muted" style={{fontSize:11}}>-</span>;
                  })()}
                </td>
              ) : null}
              {!isCash ? (
                <td style={{ textAlign: 'center' }}>
                  <strong>{account.payoutCount || 0}</strong>
                </td>
              ) : null}
              <td>
                <input
                  value={account.notes || ''}
                  placeholder="Internal note"
                  onChange={(event) => onUpdateAccount(account.accountName, { notes: event.target.value })}
                />
                <input
                  value={account.tradovateAccountId || ''}
                  placeholder="Tradovate ID"
                  title="Tradovate / NinjaTrader-web numeric account id, to match its CSV export"
                  style={{ marginTop: 4, fontSize: 11 }}
                  onChange={(event) => onUpdateAccount(account.accountName, { tradovateAccountId: event.target.value.trim() })}
                />
              </td>
              {onRemoveAccount ? (
                <td>
                  <button className="ghost-button icon-only registry-remove-btn" title="Remove from registry" onClick={() => onRemoveAccount(account.accountName)}>
                    <Trash2 size={13} />
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    )}
    </div>
  );
}
