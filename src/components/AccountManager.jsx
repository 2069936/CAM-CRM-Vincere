import { useState } from 'react';
import { ACCOUNT_STATUSES, ACCOUNT_TYPES, PAYOUT_STATES } from '../domain/reconcile';

const ACCOUNT_TYPE_OPTIONS = [
  ACCOUNT_TYPES.UNASSIGNED,
  ACCOUNT_TYPES.EVALUATION_BULLET,
  ACCOUNT_TYPES.EVALUATION_STANDARD,
  ACCOUNT_TYPES.FUNDED,
  ACCOUNT_TYPES.CASH,
  ACCOUNT_TYPES.IGNORE,
];

const STATUS_OPTIONS = Object.values(ACCOUNT_STATUSES);
const PAYOUT_OPTIONS = Object.values(PAYOUT_STATES);
const PASS_TYPES = ['', '1-day pass', '2-day pass', '3-day pass'];
const DIRECTIONS = ['', 'Long', 'Short'];

export default function AccountManager({ accounts, snapshots, onUpdateAccount, onAddAccount, onRemoveAccount, mode }) {
  const isCash = mode === 'cash';
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState(ACCOUNT_TYPES.FUNDED);
  const [newAlias, setNewAlias] = useState('');
  const [newConnection, setNewConnection] = useState('');

  const rows = Object.values(accounts || {}).map((account) => ({
    ...account,
    snapshot: (snapshots || []).find((item) => item.accountName === account.accountName),
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
        <button type="submit" className="primary-button">+ Add account</button>
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
            {!isCash ? <th>Pass</th> : null}
            {!isCash ? <th>Direction</th> : null}
            {!isCash ? <th>Payout</th> : null}
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
                  {ACCOUNT_TYPE_OPTIONS.map((option) => <option key={option}>{option}</option>)}
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
              {!isCash ? (
                <td>
                  {account.accountType === ACCOUNT_TYPES.CASH ? <span className="field-na">N/A</span> : (
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
                  {account.accountType === ACCOUNT_TYPES.CASH ? <span className="field-na">N/A</span> : (
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
                  {account.accountType === ACCOUNT_TYPES.CASH ? <span className="field-na">N/A</span> : (
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
                  {account.accountType === ACCOUNT_TYPES.CASH ? <span className="field-na">N/A</span> : (
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
                  {account.accountType === ACCOUNT_TYPES.CASH ? <span className="field-na">N/A</span> : (
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
                      : <span className="muted" style={{fontSize:11}}>—</span>;
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
              </td>
              {onRemoveAccount ? (
                <td><button className="ghost-button" style={{color:'var(--negative)',fontSize:11,padding:'2px 6px'}} title="Remove from registry" onClick={() => onRemoveAccount(account.accountName)}>✕</button></td>
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
