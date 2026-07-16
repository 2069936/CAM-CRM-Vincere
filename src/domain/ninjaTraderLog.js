// Parser for NinjaTrader daily log files (log.YYYYMMDD.NNNNN.txt / .en.txt).
//
// Unlike the four same-day CSV grid exports (accounts / strategies / orders /
// executions), NinjaTrader writes a dated log to disk every day and keeps it,
// so these files can backfill *historical* order and execution activity when a
// same-day export was never captured. This parser only extracts the raw events;
// deriving day-level state such as "fired" or "passed the target" is a separate
// step layered on top.
//
// Line format: `YYYY-MM-DD HH:MM:SS:mmm|<lvl>|<lvl>|<message>`
// Messages of interest:
//   Order='<id>/<account>' Name='...' New state='...' Instrument='...' Action='...' Quantity=N Type='...' Filled=N Fill price=X Error='...'
//   Execution='<id>' Instrument='...' Account='...' Price=X Quantity=N Market position=Long|Short|Flat Operation=Operation_Add|Remove|Update Order='<id>' Time='...'
//   Enabling|Disabling NinjaScript strategy '<name>/<account>'

import { computeExecutionPnl } from './executionPnl';
import { normalizeStrategyFamily } from './csvImport';

const LINE_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}:\d{3})\|[^|]*\|[^|]*\|(.*)$/;
const STRATEGY_RE = /^(Enabling|Disabling) NinjaScript strategy '([^']+)'/;

// Matches `Key(s)=value` pairs where the value is either a single-quoted string
// (may contain spaces) or a bare non-space token. Keys can be multi-word
// ("New state", "Fill price", "Market position"), so the key is non-greedy up to
// the first `=`.
function parseFields(message) {
  const fields = {};
  const re = /([A-Za-z][A-Za-z ]*?)=('[^']*'|[^ ]*)/g;
  let match;
  while ((match = re.exec(message)) !== null) {
    let value = match[2];
    if (value.length >= 2 && value[0] === "'" && value[value.length - 1] === "'") {
      value = value.slice(1, -1);
    }
    fields[match[1].trim()] = value;
  }
  return fields;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Split `<left>/<account>` (order id or strategy name, then account) on the
// first slash only; account ids do not contain slashes.
function splitOnFirstSlash(ref) {
  const text = String(ref || '');
  const i = text.indexOf('/');
  if (i < 0) return { left: text, right: '' };
  return { left: text.slice(0, i), right: text.slice(i + 1) };
}

function entryExitFromOperation(operation) {
  const op = String(operation || '').toLowerCase();
  if (op.includes('add')) return 'Entry';
  if (op.includes('remove')) return 'Exit';
  return '';
}

export function parseNinjaTraderLog(logText) {
  const orders = [];
  const executions = [];
  const strategyEvents = [];
  const lines = String(logText || '').split(/\r?\n/);

  for (const line of lines) {
    const lineMatch = LINE_RE.exec(line);
    if (!lineMatch) continue;
    const timestamp = lineMatch[1];
    const message = lineMatch[2];

    if (message.startsWith('Order=')) {
      const f = parseFields(message);
      const { left: id, right: accountName } = splitOnFirstSlash(f.Order);
      orders.push({
        id,
        accountName,
        name: f.Name || '',
        state: f['New state'] || '',
        instrument: f.Instrument || '',
        action: f.Action || '',
        quantity: toNumber(f.Quantity),
        orderType: f.Type || '',
        filled: toNumber(f.Filled),
        fillPrice: toNumber(f['Fill price']),
        error: f.Error || '',
        time: timestamp,
      });
    } else if (message.startsWith('Execution=')) {
      const f = parseFields(message);
      executions.push({
        id: f.Execution || '',
        instrument: f.Instrument || '',
        accountName: f.Account || '',
        price: toNumber(f.Price),
        quantity: toNumber(f.Quantity),
        position: f['Market position'] || '',
        operation: f.Operation || '',
        entryExit: entryExitFromOperation(f.Operation),
        orderId: f.Order || '',
        time: f.Time || timestamp,
      });
    } else {
      const s = STRATEGY_RE.exec(message);
      if (s) {
        const { left: strategyName, right: accountName } = splitOnFirstSlash(s[2]);
        strategyEvents.push({
          action: s[1] === 'Enabling' ? 'Enable' : 'Disable',
          strategyName,
          accountName,
          time: timestamp,
        });
      }
    }
  }

  return {
    orders,
    executions,
    strategyEvents,
    meta: {
      lines: lines.length,
      orders: orders.length,
      executions: executions.length,
      strategyEvents: strategyEvents.length,
    },
  };
}

// Extract the trading date from a NinjaTrader log/trace filename, e.g.
// "log.20260710.00000.txt" or "trace.20260710.00000.en.txt" -> "2026-07-10".
// These files are named with the date they cover, so the filename dates the
// backfilled history. Returns '' if no valid YYYYMMDD run is found.
export function dateFromLogFilename(filename) {
  const match = String(filename || '').match(/(20\d{2})(\d{2})(\d{2})/);
  if (!match) return '';
  const [, year, month, day] = match;
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) {
    return '';
  }
  return `${year}-${month}-${day}`;
}

// Parse one NinjaTrader log file (name + contents) into a dated activity record
// for historical backfill: the date comes from the filename, the events from the
// log body.
export function parseNinjaTraderLogFile(filename, logText) {
  return {
    filename: String(filename || ''),
    date: dateFromLogFilename(filename),
    ...parseNinjaTraderLog(logText),
  };
}

// Roll a parsed log day up into per-account activity for showing/storing as
// history. The log carries trade activity (fills, direction) but NOT account
// balances, so this summarizes what traded, not account state.
export function summarizeLogByAccount(parsedFile) {
  const byAccount = {};
  for (const execution of parsedFile.executions || []) {
    const name = execution.accountName;
    if (!name) continue;
    if (!byAccount[name]) {
      byAccount[name] = {
        accountName: name,
        date: parsedFile.date || '',
        fills: 0,
        contracts: 0,
        long: 0,
        short: 0,
        realizedPnl: 0,
        ticksMoved: 0,
        roundTrips: 0,
        unknownInstruments: [],
      };
    }
    const row = byAccount[name];
    row.fills += 1;
    row.contracts += Number(execution.quantity) || 0;
    if (/long/i.test(execution.position)) row.long += 1;
    else if (/short/i.test(execution.position)) row.short += 1;
  }
  // Realized PnL derived from the executions' price moves (no balances needed).
  for (const pnl of computeExecutionPnl(parsedFile.executions || [])) {
    if (!byAccount[pnl.accountName]) continue;
    Object.assign(byAccount[pnl.accountName], {
      realizedPnl: pnl.realizedPnl,
      ticksMoved: pnl.ticksMoved,
      roundTrips: pnl.roundTrips,
      unknownInstruments: pnl.unknownInstruments,
    });
  }
  return Object.values(byAccount);
}

// Roll a parsed log day up by algo family + direction, independent of any client
// (so accounts that no longer exist still contribute to team-wide algo/bullet-bot
// history). Family = the enabled strategies for that account (from strategyEvents);
// direction = the majority market position of its executions; PnL from executions.
export function summarizeLogByFamily(parsedFile) {
  const pnlByAccount = {};
  for (const row of computeExecutionPnl(parsedFile.executions || [])) {
    pnlByAccount[row.accountName] = row;
  }

  const famByAccount = {};
  for (const event of parsedFile.strategyEvents || []) {
    if (!event.accountName) continue;
    if (!famByAccount[event.accountName]) famByAccount[event.accountName] = new Set();
    const family = normalizeStrategyFamily(event.strategyName);
    if (family && family !== 'Unknown') famByAccount[event.accountName].add(family);
  }

  const dirByAccount = {};
  for (const ex of parsedFile.executions || []) {
    if (!ex.accountName) continue;
    if (!dirByAccount[ex.accountName]) dirByAccount[ex.accountName] = { long: 0, short: 0 };
    if (/long/i.test(ex.position)) dirByAccount[ex.accountName].long += 1;
    else if (/short/i.test(ex.position)) dirByAccount[ex.accountName].short += 1;
  }

  const accounts = new Set([...Object.keys(pnlByAccount), ...Object.keys(famByAccount)]);
  const rows = [];
  for (const account of accounts) {
    const fams = [...(famByAccount[account] || [])].sort();
    const family = fams.join(' + ') || 'Unknown';
    const dir = dirByAccount[account] || { long: 0, short: 0 };
    const direction = dir.long > dir.short ? 'Long' : dir.short > dir.long ? 'Short' : 'Mixed';
    const pnl = pnlByAccount[account] || {};
    rows.push({
      accountName: account,
      date: parsedFile.date || '',
      family,
      direction,
      realizedPnl: pnl.realizedPnl || 0,
      roundTrips: pnl.roundTrips || 0,
    });
  }
  return rows;
}

// Aggregate per-account-day family rows (summarizeLogByFamily, accumulated across
// all uploaded logs) into team-wide algo/bullet-bot history: PnL by family, split
// by direction, plus round trips, distinct accounts, and days.
export function aggregateLogFamilyHistory(rows = []) {
  const byFamily = {};
  for (const r of rows) {
    const fam = r.family || 'Unknown';
    if (!byFamily[fam]) {
      byFamily[fam] = {
        family: fam,
        totalPnl: 0,
        roundTrips: 0,
        byDirection: { Long: 0, Short: 0, Mixed: 0 },
        accounts: new Set(),
        dates: new Set(),
      };
    }
    const g = byFamily[fam];
    const pnl = Number(r.realizedPnl || 0);
    g.totalPnl += pnl;
    g.roundTrips += Number(r.roundTrips || 0);
    if (g.byDirection[r.direction] != null) g.byDirection[r.direction] += pnl;
    if (r.accountName) g.accounts.add(r.accountName);
    if (r.date) g.dates.add(r.date);
  }
  return Object.values(byFamily)
    .map((g) => ({
      family: g.family,
      totalPnl: Math.round(g.totalPnl * 100) / 100,
      roundTrips: g.roundTrips,
      byDirection: {
        Long: Math.round(g.byDirection.Long * 100) / 100,
        Short: Math.round(g.byDirection.Short * 100) / 100,
        Mixed: Math.round(g.byDirection.Mixed * 100) / 100,
      },
      accounts: g.accounts.size,
      days: g.dates.size,
    }))
    .sort((a, b) => b.totalPnl - a.totalPnl);
}
