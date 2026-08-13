// Per-account-type breakdowns for a client's daily import.
//
// Balance and PnL must NOT be shown as one combined total — a Funded account,
// a Cash account, and an Evaluation are separate pools. These helpers keep them
// split by type, and also list which prop firms (connections) the client runs
// on so a CAM can see what to enable.

import { ACCOUNT_TYPES, ACCOUNT_STATUSES, isCashType, isPropAccountType } from './reconcile';
import { ACCOUNT_NATURES, classifyAccountNature } from './simulationAccounts';

function accountMetaFor(client, dailyImport, accountName) {
  const lower = String(accountName || '').toLowerCase();
  const fromImport = Object.entries(dailyImport?.accounts || {}).find(([k]) => k.toLowerCase() === lower)?.[1] || {};
  const fromRegistry = Object.entries(client?.accountRegistry || {}).find(([k]) => k.toLowerCase() === lower)?.[1] || {};
  return { ...fromImport, ...fromRegistry };
}

function segmentKey(accountType) {
  if (accountType === ACCOUNT_TYPES.FUNDED) return 'funded';
  // IRA and straight cash run different algos and are measured differently, so
  // they get their own buckets. Legacy 'Cash' rows land in the combined bucket
  // until someone reclassifies them.
  if (accountType === ACCOUNT_TYPES.CASH_IRA) return 'cashIra';
  if (accountType === ACCOUNT_TYPES.CASH_STRAIGHT) return 'cashStraight';
  if (isCashType(accountType)) return 'cashLegacy';
  if (accountType === ACCOUNT_TYPES.EVALUATION_BULLET) return 'bulletBot';
  if (accountType === ACCOUNT_TYPES.EVALUATION_STANDARD) return 'evalStandard';
  return 'other';
}

// Balance + daily PnL split by account type (Funded / Cash / Eval-standard /
// Bullet Bot). Never combined. Each segment also lists its accounts with the
// per-account balance and PnL for the UI.
export function buildClientSegments(client, dailyImport) {
  const empty = () => ({ balance: 0, dailyPnl: 0, weeklyPnl: 0, count: 0, accounts: [] });
  const segments = {
    funded: empty(),
    // `cash` is every cash account combined; cashIra / cashStraight are the
    // separately reportable splits. A cash account lands in both.
    cash: empty(),
    cashIra: empty(),
    cashStraight: empty(),
    cashLegacy: empty(),
    evalStandard: empty(),
    bulletBot: empty(),
    other: empty(),
    // NOT money. These two are fed from dailyImport.simulation, never from
    // dailyImport.snapshots, and nothing in this file ever adds them to another
    // bucket — unlike cashIra/cashStraight, which deliberately roll into `cash`.
    simulation: empty(),
    undetermined: empty(),
  };

  // Live closes first. `dailyImport.snapshots` carries live money only: both
  // reconcile.js and buildCrmStateFromTables split before this is ever read.
  for (const snapshot of dailyImport?.snapshots || []) {
    const meta = accountMetaFor(client, dailyImport, snapshot.accountName);
    const key = segmentKey(meta.accountType);
    const buckets = [segments[key]];
    // An IRA or straight-cash account also rolls into the combined cash total so
    // every existing surface keeps showing one cash number.
    if (key === 'cashIra' || key === 'cashStraight' || key === 'cashLegacy') {
      buckets.push(segments.cash);
    }
    const balance = Number(snapshot.accountBalance) || 0;
    const dailyPnl = Number(snapshot.grossRealizedPnl) || 0;
    const weeklyPnl = Number(snapshot.weeklyPnl) || 0;
    const trailing = Number(snapshot.trailingMaxDrawdown) || 0;
    for (const seg of buckets) {
    seg.balance += balance;
    seg.dailyPnl += dailyPnl;
    seg.weeklyPnl += weeklyPnl;
    seg.count += 1;
    seg.accounts.push({
      accountName: snapshot.accountName,
      alias: meta.alias || snapshot.accountName,
      accountType: meta.accountType || '',
      balance,
      dailyPnl,
      weeklyPnl,
      trailing,
      connection: snapshot.connection || '',
    });
    }
  }

  // Then the closes that are not money, into buckets of their own. Each row
  // carries its nature and the reason it was given, so a UI can print
  // "simulated because the account is named Sim101" rather than a bare figure.
  const notMoney = [
    [segments.simulation, dailyImport?.simulation?.snapshots || [], ACCOUNT_NATURES.SIMULATION],
    [segments.undetermined, dailyImport?.simulation?.undetermined?.snapshots || [], ACCOUNT_NATURES.UNDETERMINED],
  ];
  for (const [bucket, snapshots, nature] of notMoney) {
    for (const snapshot of snapshots) {
      const meta = accountMetaFor(client, dailyImport, snapshot.accountName);
      const balance = Number(snapshot.accountBalance) || 0;
      const dailyPnl = Number(snapshot.grossRealizedPnl) || 0;
      const weeklyPnl = Number(snapshot.weeklyPnl) || 0;
      const classification = classifyAccountNature(meta, { accountName: snapshot.accountName });
      bucket.balance += balance;
      bucket.dailyPnl += dailyPnl;
      bucket.weeklyPnl += weeklyPnl;
      bucket.count += 1;
      bucket.accounts.push({
        accountName: snapshot.accountName,
        alias: meta.alias || snapshot.accountName,
        accountType: meta.accountType || '',
        balance,
        dailyPnl,
        weeklyPnl,
        // A simulator has no prop-firm trailing rule behind it — every real
        // Sim101 reports trailingMaxDrawdown = 0 on a six-figure balance — so
        // the field is null here rather than a 0 that reads as "no buffer left".
        trailing: null,
        connection: snapshot.connection || '',
        nature,
        natureReason: classification.reason,
        natureSource: classification.source,
        heuristic: classification.heuristic,
      });
    }
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

export const CLIENT_KINDS = { CASH: 'cash', PROP: 'prop', MIXED: 'mixed', NONE: 'none' };

// Client-level account mix, derived from the persistent account registry (NOT
// from a daily import) so every surface that lists clients can classify one
// without needing a CSV close that day. Cash clients are managed differently
// from funded/evaluation clients and must be distinguishable everywhere.
// A client can legitimately hold both, so "mixed" is a first-class state.
export function clientAccountMix(client) {
  let cash = 0;
  let prop = 0;
  // Counted, never mixed into cash or prop. A client running a SIM test is doing
  // something the CAM has to report on — 1 of the 11 clients in the real exports
  // was mid-engagement on 2026-08-06 — but a simulator is neither a cash pool nor
  // a prop-firm contract, so it cannot change `kind`.
  let simulation = 0;
  let undetermined = 0;
  for (const [accountName, meta] of Object.entries(client?.accountRegistry || {})) {
    if (!meta) continue;
    // Dead accounts do not define how a client is managed today.
    if (meta.status === ACCOUNT_STATUSES.INACTIVE || meta.status === ACCOUNT_STATUSES.FAILED) continue;
    const nature = classifyAccountNature(meta, { accountName }).nature;
    if (nature === ACCOUNT_NATURES.SIMULATION) { simulation += 1; continue; }
    if (nature === ACCOUNT_NATURES.UNDETERMINED) { undetermined += 1; continue; }
    if (isCashType(meta.accountType)) cash += 1;
    else if (isPropAccountType(meta.accountType)) prop += 1;
  }
  const kind = cash && prop
    ? CLIENT_KINDS.MIXED
    : cash
      ? CLIENT_KINDS.CASH
      : prop
        ? CLIENT_KINDS.PROP
        : CLIENT_KINDS.NONE;
  return {
    cash,
    prop,
    simulation,
    undetermined,
    hasSimulation: simulation > 0,
    kind,
    isCash: kind === CLIENT_KINDS.CASH || kind === CLIENT_KINDS.MIXED,
    label:
      kind === CLIENT_KINDS.CASH
        ? 'Cash'
        : kind === CLIENT_KINDS.MIXED
          ? 'Cash + Prop'
          : kind === CLIENT_KINDS.PROP
            ? 'Prop'
            : '',
  };
}
