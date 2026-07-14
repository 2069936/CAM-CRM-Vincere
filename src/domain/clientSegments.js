// Per-account-type breakdowns for a client's daily import.
//
// Balance and PnL must NOT be shown as one combined total — a Funded account,
// a Cash account, and an Evaluation are separate pools. These helpers keep them
// split by type, and also list which prop firms (connections) the client runs
// on so a CAM can see what to enable.

import { ACCOUNT_TYPES } from './reconcile';

function accountMetaFor(client, dailyImport, accountName) {
  const lower = String(accountName || '').toLowerCase();
  const fromImport = Object.entries(dailyImport?.accounts || {}).find(([k]) => k.toLowerCase() === lower)?.[1] || {};
  const fromRegistry = Object.entries(client?.accountRegistry || {}).find(([k]) => k.toLowerCase() === lower)?.[1] || {};
  return { ...fromImport, ...fromRegistry };
}

function segmentKey(accountType) {
  if (accountType === ACCOUNT_TYPES.FUNDED) return 'funded';
  if (accountType === ACCOUNT_TYPES.CASH) return 'cash';
  if (accountType === ACCOUNT_TYPES.EVALUATION_BULLET) return 'bulletBot';
  if (accountType === ACCOUNT_TYPES.EVALUATION_STANDARD) return 'evalStandard';
  return 'other';
}

// Balance + daily PnL split by account type (Funded / Cash / Eval-standard /
// Bullet Bot). Never combined. Each segment also lists its accounts with the
// per-account balance and PnL for the UI.
export function buildClientSegments(client, dailyImport) {
  const empty = () => ({ balance: 0, dailyPnl: 0, count: 0, accounts: [] });
  const segments = {
    funded: empty(),
    cash: empty(),
    evalStandard: empty(),
    bulletBot: empty(),
    other: empty(),
  };

  for (const snapshot of dailyImport?.snapshots || []) {
    const meta = accountMetaFor(client, dailyImport, snapshot.accountName);
    const seg = segments[segmentKey(meta.accountType)];
    const balance = Number(snapshot.accountBalance) || 0;
    const dailyPnl = Number(snapshot.grossRealizedPnl) || 0;
    const trailing = Number(snapshot.trailingMaxDrawdown) || 0;
    seg.balance += balance;
    seg.dailyPnl += dailyPnl;
    seg.count += 1;
    seg.accounts.push({
      accountName: snapshot.accountName,
      alias: meta.alias || snapshot.accountName,
      accountType: meta.accountType || '',
      balance,
      dailyPnl,
      trailing,
      connection: snapshot.connection || '',
    });
  }

  return segments;
}

// The prop firms (connections) a client runs on, grouped, so a CAM can see at a
// glance what to turn on. Sorted by account count.
export function buildClientPropFirms(client, dailyImport) {
  const firms = {};
  for (const snapshot of dailyImport?.snapshots || []) {
    const firm = snapshot.connection || 'Unknown';
    if (!firms[firm]) firms[firm] = { firm, count: 0, accounts: [] };
    firms[firm].count += 1;
    const meta = accountMetaFor(client, dailyImport, snapshot.accountName);
    firms[firm].accounts.push({
      accountName: snapshot.accountName,
      alias: meta.alias || snapshot.accountName,
      accountType: meta.accountType || '',
    });
  }
  return Object.values(firms).sort((a, b) => b.count - a.count);
}
