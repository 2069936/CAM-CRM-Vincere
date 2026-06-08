import React from 'react';

export default function AccountManager({ accounts, meta, onUpdateMeta }) {
  if (!accounts || accounts.length === 0) {
    return (
      <div className="text-center py-20">
        <h2 className="text-h2 mb-4 text-muted">No accounts loaded</h2>
        <p>Please upload your CSV data first.</p>
      </div>
    );
  }

  const unassigned = accounts.filter(a => !meta[a.name] || meta[a.name].bucket === 'unassigned');
  const evaluations = accounts.filter(a => meta[a.name]?.bucket === 'evaluation');
  const funded = accounts.filter(a => meta[a.name]?.bucket === 'funded');

  const AccountRow = ({ account }) => {
    const accMeta = meta[account.name] || { bucket: 'unassigned', baseBalance: 50000, target: 3000, risk: '', status: 'Active' };

    return (
      <tr key={account.name} className="border-b border-[var(--border)] hover:bg-[var(--bg-surface-hover)]">
        <td className="p-3">
          <div className="font-medium text-sm">{account.name}</div>
          <div className="text-xs text-muted">{account.connection}</div>
        </td>
        <td className="p-3">
          <select 
            className="input-field py-1 px-2 text-xs w-full bg-[var(--bg-base)]"
            value={accMeta.bucket}
            onChange={(e) => onUpdateMeta(account.name, 'bucket', e.target.value)}
          >
            <option value="unassigned">Unassigned</option>
            <option value="evaluation">Evaluation</option>
            <option value="funded">Funded</option>
            <option value="ignore">Ignore</option>
          </select>
        </td>
        <td className="p-3">
          <select 
            className="input-field py-1 px-2 text-xs w-full bg-[var(--bg-base)]"
            value={accMeta.status}
            onChange={(e) => onUpdateMeta(account.name, 'status', e.target.value)}
          >
            <option value="Active">Active</option>
            <option value="Inactive">Inactive</option>
            <option value="Parked">Parked</option>
          </select>
        </td>
        <td className="p-3">
          <input 
            type="number" 
            className="input-field py-1 px-2 text-xs w-24 bg-[var(--bg-base)]"
            value={accMeta.baseBalance}
            onChange={(e) => onUpdateMeta(account.name, 'baseBalance', parseFloat(e.target.value) || 0)}
          />
        </td>
        <td className="p-3">
          <input 
            type="number" 
            className="input-field py-1 px-2 text-xs w-24 bg-[var(--bg-base)]"
            value={accMeta.target}
            onChange={(e) => onUpdateMeta(account.name, 'target', parseFloat(e.target.value) || 0)}
          />
        </td>
        <td className="p-3">
          <input 
            type="text" 
            className="input-field py-1 px-2 text-xs w-20 bg-[var(--bg-base)]"
            placeholder="e.g. 1%"
            value={accMeta.risk}
            onChange={(e) => onUpdateMeta(account.name, 'risk', e.target.value)}
          />
        </td>
      </tr>
    );
  };

  const renderTable = (accountList) => (
    <div className="table-container border border-[var(--border)] rounded-md overflow-hidden bg-[var(--bg-surface)]">
      <table className="table w-full text-left">
        <thead className="bg-[var(--bg-base)] border-b border-[var(--border)]">
          <tr>
            <th className="p-3 text-xs font-semibold text-muted">Account</th>
            <th className="p-3 text-xs font-semibold text-muted">Bucket</th>
            <th className="p-3 text-xs font-semibold text-muted">Status</th>
            <th className="p-3 text-xs font-semibold text-muted">Base Balance</th>
            <th className="p-3 text-xs font-semibold text-muted">Target</th>
            <th className="p-3 text-xs font-semibold text-muted">Risk Size</th>
          </tr>
        </thead>
        <tbody>
          {accountList.map(acc => <AccountRow key={acc.name} account={acc} />)}
          {accountList.length === 0 && (
            <tr><td colSpan="6" className="text-center text-muted py-8 text-sm">No accounts found.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="max-w-6xl mx-auto mt-8 flex flex-col gap-8">
      <div>
        <h2 className="text-h2 mb-2">Account Manager</h2>
        <p className="text-muted">Classify accounts, assign base balances, profit targets, and risk sizes.</p>
      </div>

      {unassigned.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex justify-between items-center">
            <h3 className="text-h3 text-[var(--danger)]">Unassigned Accounts ({unassigned.length})</h3>
            <span className="badge badge-danger">Action Required</span>
          </div>
          {renderTable(unassigned)}
        </div>
      )}

      <div className="flex flex-col gap-3">
        <h3 className="text-h3 text-[var(--primary)]">Evaluation Accounts ({evaluations.length})</h3>
        {renderTable(evaluations)}
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="text-h3 text-[var(--success)]">Funded Accounts ({funded.length})</h3>
        {renderTable(funded)}
      </div>
    </div>
  );
}
